//! Tauri's updater takes the `latest.json` that `scripts/updater.ts
//! manifest` writes, finds this platform's package in it, and installs
//! nothing whose signature isn't by the app's key for the version announced.
//!
//! A stand-in package, signed by a throwaway key for version 1.2.3 (in
//! `scripts/fixtures/updater/`), is served from this machine; the updater
//! checks and downloads it but never installs it. Debug builds let the
//! updater use plain http, which a release build refuses.
//!
//! The page can't call the plugin's own commands, which would let it point
//! the updater at another address: only the app's `update_*` commands.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::thread;

use serde_json::json;
use tauri::WebviewWindowBuilder;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri_plugin_updater::UpdaterExt;

const THROWAWAY: &str = include_str!("../../scripts/fixtures/updater/throwaway.pub");
const OTHER: &str = include_str!("../../scripts/fixtures/updater/other-throwaway.pub");
const STAND_IN: &str = include_str!("../../scripts/fixtures/updater/stand-in-installer.txt");
const SIGNATURE: &str = include_str!("../../scripts/fixtures/updater/stand-in-installer.txt.sig");

/// The app's context. `generate_context!` embeds the Mac app's Info.plist
/// under one symbol, so a test binary may expand it only once.
fn context() -> tauri::Context<tauri::test::MockRuntime> {
    tauri::generate_context!()
}

/// Serves the `latest.json` made for its address, and the stand-in package
/// at `/package`, until the test ends; the address.
fn serve(manifest: impl FnOnce(&str) -> String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let manifest = manifest(&address);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = String::new();
            let mut reader = BufReader::new(&stream);
            reader.read_line(&mut request).unwrap_or_default();
            // The rest of the request, up to the blank line.
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                line.clear();
            }
            let body = if request.contains("/latest.json") {
                manifest.as_str()
            } else {
                STAND_IN
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    address
}

/// `latest.json` announcing `version`, with the stand-in as every platform's
/// package, as the script writes it.
fn manifest(address: &str, version: &str) -> String {
    let package = json!({ "signature": SIGNATURE.trim(), "url": format!("{address}/package") });
    let platforms: serde_json::Map<_, _> = [
        "windows-x86_64-nsis",
        "windows-x86_64",
        "darwin-aarch64-app",
        "darwin-aarch64",
        "linux-x86_64-appimage",
        "linux-x86_64",
        "linux-x86_64-deb",
    ]
    .into_iter()
    .map(|target| (target.to_owned(), package.clone()))
    .collect();
    json!({
        "version": version,
        "notes": "What's new",
        "pub_date": "2026-09-26T12:00:00Z",
        "platforms": platforms,
    })
    .to_string()
}

/// Checks for an update as this app (the version in package.json, below the
/// stand-in's 1.2.3, with the committed
/// updater config) built with `pubkey` would, as `target`, and downloads it;
/// what the check found and whether the download passed.
fn check_and_download(
    pubkey: &str,
    announced: &str,
    target: &str,
) -> (Option<String>, Result<usize, String>) {
    let address = serve(|address| manifest(address, announced));
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build())
        .build(context())
        .expect("the app builds");
    let updater = app
        .updater_builder()
        .target(target)
        .endpoints(vec![format!("{address}/latest.json").parse().unwrap()])
        .unwrap()
        .build()
        .unwrap();
    tauri::async_runtime::block_on(async {
        let update = updater
            .check()
            .await
            .expect("the check succeeds")
            .expect("there is an update");
        let found = Some(update.version.clone());
        let downloaded = update
            .download(|_, _| {}, || {})
            .await
            .map(|bytes| bytes.len())
            .map_err(|error| error.to_string());
        (found, downloaded)
    })
}

#[test]
fn a_package_signed_by_the_apps_key_for_the_version_announced_downloads() {
    for target in [
        "windows-x86_64-nsis",
        "darwin-aarch64-app",
        "linux-x86_64-deb",
        "linux-x86_64",
    ] {
        let (found, downloaded) = check_and_download(THROWAWAY, "1.2.3", target);
        assert_eq!(found.as_deref(), Some("1.2.3"), "{target}");
        assert_eq!(downloaded, Ok(STAND_IN.len()), "{target}");
    }
}

#[test]
fn a_package_signed_by_another_key_is_turned_away() {
    let (_, downloaded) = check_and_download(OTHER, "1.2.3", "windows-x86_64-nsis");
    assert!(
        downloaded
            .as_ref()
            .is_err_and(|error| error.contains("different key")),
        "{downloaded:?}"
    );
}

#[test]
fn a_package_signed_for_another_version_is_turned_away() {
    let (found, downloaded) = check_and_download(THROWAWAY, "1.2.4", "windows-x86_64-nsis");
    assert_eq!(found.as_deref(), Some("1.2.4"));
    assert!(
        downloaded
            .as_ref()
            .is_err_and(|error| error.contains("signed for version 1.2.3")),
        "requireSignedVersion lets it through: {downloaded:?}"
    );
}

#[test]
fn the_page_cant_call_the_updaters_own_commands() {
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context())
        .expect("the app builds");
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the main window opens");
    let request = InvokeRequest {
        cmd: "plugin:updater|check".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: InvokeBody::Json(json!({ "headers": [] })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    let refused = get_ipc_response(&window, request).unwrap_err().to_string();
    assert!(refused.contains("not allowed"), "{refused}");
}
