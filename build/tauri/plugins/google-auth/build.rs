fn main() {
    tauri_plugin::Builder::new(&["authorize"])
        .android_path("android")
        .ios_path("ios")
        .build();
}