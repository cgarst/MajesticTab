use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_plugin::Builder::new(&["configure", "select", "visibility", "appearance", "search"])
        .ios_path("ios")
        .build();

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let swift_src = manifest_dir
            .join("macos")
            .join("Sources")
            .join("MacNavPlugin.swift");
        let lib_out = out_dir.join("libapple_nav_mac.a");

        println!("cargo:rerun-if-changed={}", swift_src.display());

        let target = env::var("TARGET").unwrap_or_else(|_| "arm64-apple-darwin".to_string());
        let swift_target = if target.contains("x86_64") {
            "x86_64-apple-macosx14.0"
        } else {
            "arm64-apple-macosx14.0"
        };

        let status = Command::new("swiftc")
            .args(&[
                "-emit-library",
                "-static",
                "-target",
                swift_target,
                swift_src.to_str().unwrap(),
                "-o",
                lib_out.to_str().unwrap(),
            ])
            .status()
            .expect("Failed to execute swiftc for macos plugin");

        if !status.success() {
            panic!("swiftc failed to compile MacNavPlugin.swift");
        }

        println!("cargo:rustc-link-search=native={}", out_dir.display());
        println!("cargo:rustc-link-lib=static=apple_nav_mac");
    }
}
