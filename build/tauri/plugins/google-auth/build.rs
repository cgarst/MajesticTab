fn main() {
    tauri_plugin::Builder::new(&["authorize"])
        .android_path("android")
        .build();
}