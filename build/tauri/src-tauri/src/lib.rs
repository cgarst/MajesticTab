use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::RunEvent;

mod tab_downloader_native;

#[cfg(target_os = "macos")]
mod youtube_macos;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct OpenedFilePayload {
    pub name: String,
    pub data: Vec<u8>,
}

pub struct OpenedFilesState(pub Mutex<Vec<OpenedFilePayload>>);

fn load_file_from_path_or_url(target: &str) -> Option<OpenedFilePayload> {
    let path = if let Ok(url) = tauri::Url::parse(target) {
        if url.scheme() == "file" {
            url.to_file_path().ok()?
        } else {
            std::path::PathBuf::from(target)
        }
    } else {
        std::path::PathBuf::from(target)
    };

    if path.is_file() {
        let name = path.file_name()?.to_string_lossy().into_owned();
        let data = std::fs::read(&path).ok()?;
        Some(OpenedFilePayload { name, data })
    } else {
        None
    }
}

#[tauri::command]
fn get_opened_file(state: tauri::State<'_, OpenedFilesState>) -> Option<OpenedFilePayload> {
    state.0.lock().ok()?.pop()
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DownloadedTabPayload {
    pub name: String,
    pub path: Option<String>,
    pub data: Option<Vec<u8>>,
}

#[tauri::command]
async fn open_tab_downloader(
    app: tauri::AppHandle,
    url: String,
    userscript: Option<String>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("tab-downloader") {
        if let Ok(parsed_url) = url.parse::<tauri::Url>() {
            let _ = existing.navigate(parsed_url);
            let _ = existing.show();
            let _ = existing.set_focus();
            if let Some(js) = userscript {
                if !js.is_empty() {
                    let wrapped = tab_downloader_native::wrap_userscript(&js);
                    let _ = existing.eval(&wrapped);
                }
            }
            return Ok(());
        }
    }

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        "tab-downloader",
        tauri::WebviewUrl::External(parsed_url),
    )
    .title("Tab Downloader - MajesticTab")
    .inner_size(1100.0, 750.0);

    if let Some(ref js) = userscript {
        if !js.is_empty() {
            let wrapped = tab_downloader_native::wrap_userscript(js);
            builder = builder.initialization_script(&wrapped);
        }
    }

    let app_handle = app.clone();
    builder = builder.on_download(move |_webview, event| {
        match event {
            tauri::webview::DownloadEvent::Requested { destination, .. } => {
                let dest_dir = std::env::temp_dir().join("majestictab_downloads");
                let _ = std::fs::create_dir_all(&dest_dir);
                let filename = destination
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "downloaded.gp".to_string());
                *destination = dest_dir.join(&filename);
                true
            }
            tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                if success {
                    if let Some(p) = path {
                        let filename = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "downloaded.gp".to_string());
                        let data = std::fs::read(&p).ok();
                        let payload = DownloadedTabPayload {
                            name: filename,
                            path: Some(p.to_string_lossy().to_string()),
                            data,
                        };
                        let _ = app_handle.emit("tab-downloaded", payload);
                    } else {
                        let payload = DownloadedTabPayload {
                            name: "downloaded.tab".to_string(),
                            path: None,
                            data: None,
                        };
                        let _ = app_handle.emit("tab-downloaded", payload);
                    }
                }
                true
            }
            _ => true,
        }
    });

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
async fn youtube_open_auth(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    let auth_url = url
        .unwrap_or_else(|| "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F".to_string())
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;

    let label = "youtube-auth";
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.navigate(auth_url);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let app_handle = app.clone();
    #[cfg(target_os = "macos")]
    let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    #[cfg(target_os = "windows")]
    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::External(auth_url),
    )
    .title("Sign In - YouTube")
    .inner_size(650.0, 780.0)
    .center()
    .user_agent(ua);

    let window = builder.build().map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();

    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            #[cfg(target_os = "macos")]
            if let Some(player) = app_handle.get_webview("youtubeplayer") {
                let _ = player.eval("if (player && player.src) { player.src = player.src; }");
            }
            let _ = app_handle.emit("youtube-auth-completed", ());
        }
    });

    Ok(())
}

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

    let initial_files: Vec<OpenedFilePayload> = std::env::args()
        .skip(1)
        .filter_map(|arg| load_file_from_path_or_url(&arg))
        .collect();

    let builder = tauri::Builder::default()
        .manage(OpenedFilesState(Mutex::new(initial_files)))
        .manage(tab_downloader_native::TabDownloaderState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_google_auth::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            youtube_macos::install(_app)?;
            tab_downloader_native::install(_app)?;
            #[cfg(feature = "debug-tools")]
            if let Some(window) = _app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        });

    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_opened_file,
        open_tab_downloader,
        youtube_open_auth,
        tab_downloader_native::tab_downloader_update,
        tab_downloader_native::tab_downloader_nav,
        tab_downloader_native::tab_downloader_hide,
        tab_downloader_native::tab_downloader_eval,
        tab_downloader_native::tab_downloader_open_devtools,
        tab_downloader_native::tab_downloader_is_debug_tools_enabled,
        youtube_macos::youtube_player_update,
        youtube_macos::youtube_player_command
    ]);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_opened_file,
        open_tab_downloader,
        youtube_open_auth,
        tab_downloader_native::tab_downloader_update,
        tab_downloader_native::tab_downloader_nav,
        tab_downloader_native::tab_downloader_hide,
        tab_downloader_native::tab_downloader_eval,
        tab_downloader_native::tab_downloader_open_devtools,
        tab_downloader_native::tab_downloader_is_debug_tools_enabled
    ]);

    let app = builder
        .build(context)
        .expect("error while building MajesticTab");

    app.run(|_app_handle, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Some(payload) = load_file_from_path_or_url(url.as_str()) {
                    if let Some(state) = _app_handle.try_state::<OpenedFilesState>() {
                        if let Ok(mut lock) = state.0.lock() {
                            lock.push(payload.clone());
                        }
                    }
                    let _ = _app_handle.emit("app-open-file", payload);
                }
            }
        }
    });
}

