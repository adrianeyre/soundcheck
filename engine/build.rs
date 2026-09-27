//! The version the engine reports is the app's: `version` in the root
//! `package.json`, read at build time so bumping it there is enough.

use std::fs;

fn main() {
    let path = "../package.json";
    println!("cargo:rerun-if-changed={path}");
    let json = fs::read_to_string(path).expect("the root package.json");
    let package: serde_json::Value = serde_json::from_str(&json).expect("package.json is JSON");
    let version = package["version"]
        .as_str()
        .expect("package.json has a version");
    println!("cargo:rustc-env=SOUNDCHECK_VERSION={version}");
}
