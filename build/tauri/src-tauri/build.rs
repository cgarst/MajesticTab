// tauri.conf.json is the only place the app version is set.
fn app_version() -> String {
    let conf = std::fs::read_to_string("tauri.conf.json").expect("read tauri.conf.json");
    let rest = &conf[conf.find("\"version\"").expect("version in tauri.conf.json")..];
    let rest = &rest[rest.find(':').unwrap() + 1..];
    let rest = &rest[rest.find('"').unwrap() + 1..];
    rest[..rest.find('"').unwrap()].to_string()
}

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rustc-env=MAJESTICTAB_VERSION={}", app_version());
    println!("cargo:rerun-if-changed=../frontend-dist");
    println!("cargo:rerun-if-changed=../flatpak");
    // Android 15+ devices may use 16 KB pages, and Google Play requires 16 KB
    // aligned LOAD segments. NDK r27 links at 4 KB by default.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        // Play pairs the native debug symbols zip with the bundle by GNU build ID.
        println!("cargo:rustc-link-arg-cdylib=-Wl,--build-id=sha1");
    }
    tauri_build::build()
}
