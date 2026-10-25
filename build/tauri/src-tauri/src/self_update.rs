// In-app updates through tauri-plugin-updater (Windows, macOS, Linux AppImage).
// The JS updater (app/updater.js) decides whether a newer build exists on the user's channel;
// this module only downloads, verifies the signature, installs and relaunches.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const REPO_DOWNLOADS: &str = "https://github.com/cgarst/MajesticTab/releases";

/// "native" when this build can replace itself, otherwise "manual".
#[tauri::command]
pub fn update_install_mode() -> &'static str {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    return "native";
    #[cfg(target_os = "linux")]
    return if std::env::var_os("APPIMAGE").is_some() { "native" } else { "manual" };
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return "manual";
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let endpoint = match channel.as_str() {
        "canary" => format!("{REPO_DOWNLOADS}/download/canary/latest.json"),
        "stable" => format!("{REPO_DOWNLOADS}/latest/download/latest.json"),
        other => return Err(format!("Unknown update channel: {other}")),
    };
    let endpoint = endpoint.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        // The JS side already confirmed the manifest is newer; canary versions are not ordered semver.
        .version_comparator(|_current, _remote| true)
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is available".to_string())?;

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // Windows exits for the installer inside download_and_install; other platforms relaunch here.
    app.restart();
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub async fn install_update(_channel: String) -> Result<(), String> {
    Err("In-app updates are not supported on this platform".to_string())
}
