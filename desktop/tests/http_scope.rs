//! The main window's capability lets the Assistant's fetch through the HTTP
//! plugin reach any http(s) base URL the musician chooses, and nothing else.
//!
//! `plugin:http|fetch` only builds the request and checks it against the
//! scope; nothing is sent until `fetch_send`, so no test touches the network.

use serde_json::json;
use tauri::WebviewWindowBuilder;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

/// Where the app's own pages are served from, so the request counts as local:
/// Windows' webview can't use a custom scheme and serves them over http.
const APP_ORIGIN: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

fn fetch(url: &str) -> Result<(), String> {
    let app = mock_builder()
        .plugin(tauri_plugin_http::init())
        .build(tauri::generate_context!())
        .expect("the app builds");
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("the main window opens");
    let request = InvokeRequest {
        cmd: "plugin:http|fetch".into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: APP_ORIGIN.parse().unwrap(),
        body: InvokeBody::Json(json!({
            "clientConfig": {
                "method": "POST",
                "url": url,
                "headers": [["x-api-key", "sk-test"]],
                "data": null,
            }
        })),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(&window, request)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[test]
fn the_api_and_any_gateway_are_allowed() {
    for url in [
        "https://api.anthropic.com/v1/messages",
        "https://llm-gateway.internal/v1/messages",
        "https://gateway.example.com:8443/anthropic/v1/messages?beta=true",
        "http://localhost:8080/v1/messages",
    ] {
        assert_eq!(fetch(url), Ok(()), "{url}");
    }
}

#[test]
fn other_schemes_are_not() {
    let refused = fetch("file:///etc/passwd").unwrap_err();
    assert!(refused.contains("not supported"), "{refused}");
}
