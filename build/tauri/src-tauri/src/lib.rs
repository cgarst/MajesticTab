#[cfg(feature = "debug-tools")]
use tauri::Manager;
#[cfg(target_os = "macos")]
mod youtube_macos;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "debug-tools")]
    let mut context = tauri::generate_context!();
    #[cfg(not(feature = "debug-tools"))]
    let context = tauri::generate_context!();
    #[cfg(feature = "debug-tools")]
    if let Some(window_config) = context.config_mut().app.windows.first_mut() {
        window_config.devtools = Some(true);
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            youtube_macos::install(_app)?;
            #[cfg(feature = "debug-tools")]
            if let Some(window) = _app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        });

    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        youtube_macos::youtube_player_update,
        youtube_macos::youtube_player_command
    ]);

    builder
        .run(context)
        .expect("error while running MajesticTab");
}
