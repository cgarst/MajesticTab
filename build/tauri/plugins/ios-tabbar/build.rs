fn main() {
    // Commands are handled by the Swift plugin (see ios/Sources), so there is no Rust handler.
    tauri_plugin::Builder::new(&["configure", "select", "visibility", "appearance"])
        .ios_path("ios")
        .build();
}
