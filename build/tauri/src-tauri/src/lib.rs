use std::sync::Mutex;
use tauri::{Emitter, LogicalPosition, Manager};
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn open_tab_downloader(
    app: tauri::AppHandle,
    url: String,
    userscript: Option<String>,
    config: Option<tab_downloader_native::TabDownloaderConfig>,
) -> Result<(), String> {
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let downloader = app
        .get_webview(tab_downloader_native::DOWNLOADER_LABEL)
        .ok_or_else(|| "Tab downloader is unavailable".to_string())?;

    if let Some(state) = app.try_state::<tab_downloader_native::TabDownloaderState>() {
        if let Ok(mut g) = state.active_userscript.lock() {
            *g = userscript.clone();
        }
        if let Ok(mut g) = state.current_config.lock() {
            *g = config.clone();
        }
        if let Ok(mut g) = state.is_open.lock() {
            *g = true;
        }
    }

    if let Some(main_win) = app.get_window("main") {
        let scale = main_win.scale_factor().unwrap_or(1.0);
        if let Ok(size) = main_win.inner_size() {
            let logical = size.to_logical::<f64>(scale);
            let _ = downloader.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = downloader.set_size(logical);
        }
    }

    let _ = downloader.navigate(parsed_url);
    let wrapped = tab_downloader_native::wrap_userscript(
        userscript.as_deref().unwrap_or(""),
        config.as_ref(),
    );
    let _ = downloader.eval(&wrapped);
    let _ = downloader.show();

    #[cfg(target_os = "macos")]
    {
        use objc2_web_kit::WKWebView;
        let _ = downloader.with_webview(|platform| unsafe {
            let webview = &*platform.inner().cast::<WKWebView>();
            if let Some(superview) = webview.superview() {
                superview.addSubview(webview);
            }
        });
    }

    let _ = downloader.set_focus();
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn open_tab_downloader(
    app: tauri::AppHandle,
    url: String,
    userscript: Option<String>,
    config: Option<tab_downloader_native::TabDownloaderConfig>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(tab_downloader_native::DOWNLOADER_LABEL) {
        if let Ok(parsed_url) = url.parse::<tauri::Url>() {
            let _ = existing.navigate(parsed_url);
            let _ = existing.eval("try { window.MajesticDownloaderNative?.show(); } catch(e) {}");
            let _ = existing.show();
            let _ = existing.set_focus();
            let wrapped = tab_downloader_native::wrap_userscript(
                userscript.as_deref().unwrap_or(""),
                config.as_ref(),
            );
            let _ = existing.eval(&wrapped);
            return Ok(());
        }
    }

    static CREATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if CREATING.compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_err() {
        return Ok(());
    }
    struct CreatingGuard;
    impl Drop for CreatingGuard {
        fn drop(&mut self) {
            CREATING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _guard = CreatingGuard;

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        tab_downloader_native::DOWNLOADER_LABEL,
        tauri::WebviewUrl::External(parsed_url),
    )
    .title("Tab Downloader - MajesticTab")
    .user_agent(tab_downloader_native::DESKTOP_USER_AGENT);

    let wrapped = tab_downloader_native::wrap_userscript(
        userscript.as_deref().unwrap_or(""),
        config.as_ref(),
    );
    builder = builder.initialization_script(&wrapped);

    let app_handle_for_nav = app.clone();
    builder = builder.on_navigation(move |nav_url| {
        tab_downloader_native::handle_navigation(&app_handle_for_nav, &nav_url)
    });

    let app_handle_for_load = app.clone();
    let config_clone = config.clone();
    let userscript_clone = userscript.clone();
    builder = builder.on_page_load(move |webview, payload| {
        if let tauri::webview::PageLoadEvent::Finished = payload.event() {
            let s = payload.url().as_str();
            if s.starts_with("http://") || s.starts_with("https://") {
                let _ = app_handle_for_load.emit("tab-downloader-url-changed", s.to_string());
            }
            let wrapped = tab_downloader_native::wrap_userscript(
                userscript_clone.as_deref().unwrap_or(""),
                config_clone.as_ref(),
            );
            let _ = webview.eval(&wrapped);
        }
    });

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
                        let mut filename = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "downloaded.gp".to_string());
                        let data = std::fs::read(&p).ok();
                        if let Some(ref bytes) = data {
                            if let Some(ext) = tab_downloader_native::identify_tab_extension(bytes, &filename) {
                                if !filename.to_lowercase().ends_with(&format!(".{}", ext)) {
                                    if !filename.contains('.') || filename.starts_with("download") {
                                        filename = format!("{}.{}", filename, ext);
                                    }
                                }
                                if let Some(main_win) = app_handle.get_webview_window("main") {
                                    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
                                    let escaped_name = serde_json::to_string(&filename).unwrap_or_default();
                                    let escaped_b64 = serde_json::to_string(&b64).unwrap_or_default();
                                    let escaped_path = serde_json::to_string(&p.to_string_lossy()).unwrap_or_default();
                                    let eval_script = format!("window.__onTabDownloaded && window.__onTabDownloaded({}, {}, {});", escaped_name, escaped_b64, escaped_path);
                                    let _ = main_win.eval(&eval_script);
                                }
                                if let Some(downloader_win) = app_handle.get_webview_window(tab_downloader_native::DOWNLOADER_LABEL) {
                                    let _ = downloader_win.hide();
                                }
                                let payload = DownloadedTabPayload {
                                    name: filename,
                                    path: Some(p.to_string_lossy().to_string()),
                                    data: Some(bytes.clone()),
                                };
                                let _ = app_handle.emit("tab-downloaded", payload);
                            }
                        }
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

    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::External(auth_url),
    )
    .title("Sign In - YouTube")
    .user_agent(ua);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.inner_size(650.0, 780.0).center();
    }

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

#[cfg(target_os = "linux")]
fn is_gamescope_or_steam_deck() -> bool {
    if std::env::var("GAMESCOPE_WAYLAND_DISPLAY").is_ok()
        || std::env::var("GAMESCOPE_WIDTH").is_ok()
        || std::env::var("GAMESCOPE_HEIGHT").is_ok()
        || std::env::var("STEAM_DECK").is_ok()
        || std::env::var("SteamDeck").is_ok()
        || std::env::var("STEAM_ZEN").is_ok()
    {
        return true;
    }

    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let l = desktop.to_lowercase();
        if l.contains("gamescope") || l.contains("steamos") {
            return true;
        }
    }

    if let Ok(product) = std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name") {
        let p = product.trim();
        if p == "Jupiter" || p == "Galileo" || p.contains("Steam Deck") {
            return true;
        }
    }

    false
}

#[cfg(target_os = "linux")]
extern "C" {
    fn g_set_prgname(prgname: *const std::ffi::c_char);
    fn g_set_application_name(application_name: *const std::ffi::c_char);
    fn gtk_window_set_default_icon_name(name: *const std::ffi::c_char);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    unsafe {
        g_set_prgname(b"net.zathu.majestictab\0".as_ptr() as *const _);
        g_set_application_name(b"MajesticTab\0".as_ptr() as *const _);
        gtk_window_set_default_icon_name(b"net.zathu.majestictab\0".as_ptr() as *const _);
    }

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
            if let Some(main_wv) = _app.get_webview("main") {
                main_wv.open_devtools();
            }

            if let Some(window) = _app.get_window("main") {
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                {
                    if let Some(icon) = _app.default_window_icon() {
                        let _ = window.set_icon(icon.clone());
                    }
                    let app_handle_for_resize = _app.handle().clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Resized(size) = event {
                            let is_open = app_handle_for_resize
                                .try_state::<tab_downloader_native::TabDownloaderState>()
                                .and_then(|st| st.is_open.lock().ok().map(|g| *g))
                                .unwrap_or(false);
                            if is_open {
                                if let Some(downloader) = app_handle_for_resize.get_webview(tab_downloader_native::DOWNLOADER_LABEL) {
                                    if let Some(main_win) = app_handle_for_resize.get_window("main") {
                                        let scale = main_win.scale_factor().unwrap_or(1.0);
                                        let logical = size.to_logical::<f64>(scale);
                                        let _ = downloader.set_position(LogicalPosition::new(0.0, 0.0));
                                        let _ = downloader.set_size(logical);
                                    }
                                }
                            }
                        }
                    });
                }
                #[cfg(target_os = "linux")]
                if is_gamescope_or_steam_deck() {
                    let _ = window.set_decorations(false);
                    let _ = window.set_fullscreen(true);
                    if let Some(main_wv) = _app.get_webview("main") {
                        let _ = main_wv.eval(
                            "document.documentElement.classList.add('tauri-gamescope'); \
                            try { \
                                if (localStorage.getItem('gpDefaultView') === null) localStorage.setItem('gpDefaultView', 'page'); \
                                if (localStorage.getItem('txtDefaultView') === null) localStorage.setItem('txtDefaultView', 'page'); \
                                if (localStorage.getItem('pdfDefaultView') === null) localStorage.setItem('pdfDefaultView', 'page'); \
                                if (localStorage.getItem('landscapePageLayout') === null) localStorage.setItem('landscapePageLayout', 'single'); \
                            } catch {}"
                        );
                    }
                }
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
        tab_downloader_native::tab_downloader_save_sources,
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
        tab_downloader_native::tab_downloader_is_debug_tools_enabled,
        tab_downloader_native::tab_downloader_save_sources
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

