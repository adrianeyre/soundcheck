fn main() {
    tauri_build::build();
    embed_manifest_in_tests();
}

/// Tauri embeds its Windows app manifest in the app binary only. A test that
/// links Tauri (`tests/http_scope.rs`, on the mock runtime) then loads Common
/// Controls v5, which has no `TaskDialogIndirect`, and dies before it runs
/// with `STATUS_ENTRYPOINT_NOT_FOUND`. The same Common Controls v6 dependency,
/// embedded in the test binaries, is what lets them start.
fn embed_manifest_in_tests() {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !(windows && msvc) {
        return;
    }
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}
