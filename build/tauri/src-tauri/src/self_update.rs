// In-app updates through tauri-plugin-updater (Windows, macOS, Linux AppImage).
// The JS updater (src/updater.js) decides whether a newer build exists on the user's channel;
// this module only downloads, verifies the signature, installs and relaunches.

#[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
const REPO_DOWNLOADS: &str = "https://github.com/cgarst/MajesticTab/releases";

/// "native" when this build can replace itself, otherwise "manual".
#[tauri::command]
pub fn update_install_mode() -> &'static str {
    #[cfg(not(feature = "self-update"))]
    return "manual";
    #[cfg(all(feature = "self-update", any(target_os = "windows", target_os = "macos")))]
    return "native";
    #[cfg(all(feature = "self-update", target_os = "linux"))]
    return if std::env::var_os("APPIMAGE").is_some() { "native" } else { "manual" };
    #[cfg(all(feature = "self-update", any(target_os = "android", target_os = "ios")))]
    return "manual";
}

/// Token for reading releases while the repo is private: MAJESTICTAB_UPDATE_TOKEN, else the GitHub CLI's login.
/// None on phones, or when neither is available (the repo is then assumed public).
#[tauri::command]
pub fn update_auth_token() -> Option<String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return None;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Ok(token) = std::env::var("MAJESTICTAB_UPDATE_TOKEN") {
            let token = token.trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
        // GUI apps on macOS do not inherit the shell PATH, so try the usual install locations too.
        for gh in ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"] {
            if let Ok(out) = std::process::Command::new(gh).args(["auth", "token"]).output() {
                let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if out.status.success() && !token.is_empty() {
                    return Some(token);
                }
            }
        }
        None
    }
}

#[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
const REPO_API: &str = "https://api.github.com/repos/cgarst/MajesticTab";

/// Asset name -> API URL for the channel's release. Private repos only serve assets through the API.
#[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
async fn release_asset_urls(token: &str, channel: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let path = match channel {
        "canary" => "releases/tags/canary",
        "stable" => "releases/latest",
        other => return Err(format!("Unknown update channel: {other}")),
    };
    let body = reqwest::Client::new()
        .get(format!("{REPO_API}/{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "MajesticTab")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let release: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut urls = std::collections::HashMap::new();
    for asset in release["assets"].as_array().into_iter().flatten() {
        if let (Some(name), Some(url)) = (asset["name"].as_str(), asset["url"].as_str()) {
            urls.insert(name.to_string(), url.to_string());
        }
    }
    Ok(urls)
}

#[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let token = update_auth_token();
    let mut asset_urls = None;
    let mut builder = app.updater_builder();
    let endpoint = if let Some(token) = &token {
        let urls = release_asset_urls(token, &channel).await?;
        let manifest = urls.get("latest.json").cloned().ok_or("The release has no latest.json")?;
        asset_urls = Some(urls);
        builder = builder
            .header("Authorization", format!("Bearer {token}"))
            .map_err(|e| e.to_string())?
            .header("Accept", "application/octet-stream")
            .map_err(|e| e.to_string())?;
        manifest
    } else {
        match channel.as_str() {
            "canary" => format!("{REPO_DOWNLOADS}/download/canary/latest.json"),
            "stable" => format!("{REPO_DOWNLOADS}/latest/download/latest.json"),
            other => return Err(format!("Unknown update channel: {other}")),
        }
    };
    let endpoint = endpoint.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let updater = builder
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        // The JS side already confirmed the manifest is newer; canary versions are not ordered semver.
        .version_comparator(|_current, _remote| true)
        .build()
        .map_err(|e| e.to_string())?;

    let mut update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is available".to_string())?;

    // The manifest links browser download URLs, which a private repo rejects; swap in the API asset URL.
    if let Some(urls) = &asset_urls {
        let name = update.download_url.path_segments().and_then(|mut s| s.next_back()).unwrap_or_default();
        let name = percent_encoding::percent_decode_str(name).decode_utf8_lossy().into_owned();
        if let Some(url) = urls.get(&name) {
            update.download_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
        }
    }

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
        .map_err(|e| {
            eprintln!("[self_update] download_and_install failed: {e:?}");
            e.to_string()
        })?;

    // Windows exits for the installer inside download_and_install; other platforms relaunch here.
    app.restart();
}

#[cfg(not(all(feature = "self-update", not(any(target_os = "android", target_os = "ios")))))]
#[tauri::command]
pub async fn install_update(_channel: String) -> Result<(), String> {
    Err("In-app updates are not supported in this build".to_string())
}
