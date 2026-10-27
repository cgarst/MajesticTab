fn main() {
    println!("cargo:rerun-if-changed=../frontend-dist");
    println!("cargo:rerun-if-changed=../flatpak");
    // Android 15+ devices may use 16 KB pages, and Google Play requires 16 KB
    // aligned LOAD segments. NDK r27 links at 4 KB by default.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
