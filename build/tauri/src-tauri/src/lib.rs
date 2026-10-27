use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{LogicalPosition, LogicalSize};
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::RunEvent;

mod jam;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod icloud;
mod self_update;
mod tab_downloader_native;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod youtube_page;
#[cfg(target_os = "macos")]
mod youtube_macos;
#[cfg(target_os = "ios")]
mod youtube_ios;

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
    top_offset: Option<f64>,
) -> Result<(), String> {
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let downloader = app
        .get_webview(tab_downloader_native::DOWNLOADER_LABEL)
        .ok_or_else(|| "Tab downloader is unavailable".to_string())?;

    let offset = top_offset.unwrap_or(84.0);

    if let Some(state) = app.try_state::<tab_downloader_native::TabDownloaderState>() {
        if let Ok(mut g) = state.active_userscript.lock() {
            *g = userscript.clone();
        }
        if let Ok(mut g) = state.current_config.lock() {
            *g = config.clone();
        }
        if let Ok(mut g) = state.top_offset.lock() {
            *g = offset;
        }
        if let Ok(mut g) = state.is_open.lock() {
            *g = true;
        }
        if let Ok(mut g) = state.is_visible.lock() {
            *g = true;
        }
    }

    if let Some(main_win) = app.get_window("main") {
        let scale = main_win.scale_factor().unwrap_or(1.0);
        if let Ok(size) = main_win.inner_size() {
            let logical = size.to_logical::<f64>(scale);
            let _ = downloader.set_position(LogicalPosition::new(0.0, offset));
            let _ = downloader.set_size(LogicalSize::new(logical.width, (logical.height - offset).max(1.0)));
        }
    }

    let _ = downloader.navigate(parsed_url);
    tab_downloader_native::schedule_userscript_injection(&app);
    let _ = downloader.show();

    #[cfg(target_os = "macos")]
    {
        use objc2_web_kit::WKWebView;
        let app_handle_wv = app.clone();
        let _ = downloader.with_webview(move |platform| unsafe {
            let webview = &*platform.inner().cast::<WKWebView>();
            webview.setHidden(false);
            if let Some(superview) = webview.superview() {
                superview.addSubview(webview);
            } else if let Some(main_win) = app_handle_wv.get_window("main") {
                if let Ok(ns_win_ptr) = main_win.ns_window() {
                    let ns_window = &*(ns_win_ptr as *const objc2_app_kit::NSWindow);
                    if let Some(content_view) = ns_window.contentView() {
                        content_view.addSubview(webview);
                    }
                }
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
    top_offset: Option<f64>,
) -> Result<(), String> {
    if let Some(state) = app.try_state::<tab_downloader_native::TabDownloaderState>() {
        if let Some(offset) = top_offset {
            if let Ok(mut g) = state.top_offset.lock() {
                *g = offset;
            }
        }
        if let Ok(mut g) = state.is_visible.lock() {
            *g = true;
        }
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

    // The user agent is fixed when the webview is created, so a change in the
    // per-source "force desktop" setting requires rebuilding the window.
    static FORCED_DESKTOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let force_desktop = config.as_ref().map(|c| c.force_desktop).unwrap_or(false);
    if let Some(existing) = app.get_webview_window(tab_downloader_native::DOWNLOADER_LABEL) {
        if FORCED_DESKTOP.load(std::sync::atomic::Ordering::SeqCst) != force_desktop {
            let _ = existing.destroy();
            for _ in 0..20 {
                if app.get_webview_window(tab_downloader_native::DOWNLOADER_LABEL).is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    FORCED_DESKTOP.store(force_desktop, std::sync::atomic::Ordering::SeqCst);

    if let Some(existing) = app.get_webview_window(tab_downloader_native::DOWNLOADER_LABEL) {
        if let Ok(parsed_url) = url.parse::<tauri::Url>() {
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.eval("try { window.MajesticDownloaderNative?.show(); } catch(e) {}");
            }
            let _ = existing.eval("try { window.MajesticDownloaderNative?.show(); } catch(e) {}");
            // On iOS the webview was configured when created and now lives inside the main window.
            #[cfg(target_os = "ios")]
            tab_downloader_native::ios_place_downloader(&app, top_offset, true);
            #[cfg(target_os = "android")]
            {
                let _ = existing.show();
                let _ = existing.set_focus();
            }
            let _ = existing.navigate(parsed_url);
            tab_downloader_native::schedule_userscript_injection(&app);
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
    .initialization_script(tab_downloader_native::CORE_DOWNLOADER_SHIM);
    // iOS moves this webview into the main window, so its own window stays hidden.
    #[cfg(target_os = "ios")]
    {
        builder = builder.visible(false);
    }
    if force_desktop {
        builder = builder.user_agent(tab_downloader_native::DESKTOP_USER_AGENT);
    }

    let app_handle_for_nav = app.clone();
    builder = builder.on_navigation(move |nav_url| {
        tab_downloader_native::handle_navigation(&app_handle_for_nav, &nav_url)
    });

    let app_handle_for_load = app.clone();
    builder = builder.on_page_load(move |_webview, payload| {
        let s = payload.url().as_str();
        if s.starts_with("http://") || s.starts_with("https://") {
            let _ = app_handle_for_load.emit("tab-downloader-url-changed", s.to_string());
        }
        tab_downloader_native::schedule_userscript_injection(&app_handle_for_load);
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
                                if let Some(state) = app_handle.try_state::<tab_downloader_native::TabDownloaderState>() {
                                    if let Ok(mut g) = state.is_open.lock() {
                                        *g = false;
                                    }
                                }
                                tab_downloader_native::hide_downloader(&app_handle);
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
    #[cfg(target_os = "ios")]
    {
        tab_downloader_native::configure_ios_webview(&window, 13.0, 15.0, 21.0);
        let _ = window.hide();
        tab_downloader_native::ios_place_downloader(&app, top_offset, true);
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.set_focus();
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.eval("try { window.MajesticDownloaderNative?.show(); } catch(e) {}");
    }
    Ok(())
}

#[tauri::command]
fn configure_ios_main_window(_app: tauri::AppHandle) {
    #[cfg(target_os = "ios")]
    if let Some(main_win) = _app.get_webview_window("main") {
        tab_downloader_native::configure_ios_webview(&main_win, 6.0, 5.0, 10.0);
    }
}

#[tauri::command]
async fn youtube_search(query: String) -> Result<Option<String>, String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": "2.20240101.00.00"
            }
        },
        "query": query
    });
    let payload_str = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let res = client
        .post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .body(payload_str)
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = res.text().await.map_err(|e| e.to_string())?;

    for part in text.split("\"videoId\"") {
        let trimmed = part.trim_start();
        if let Some(rest) = trimmed.strip_prefix(':') {
            let inner = rest.trim();
            if inner.starts_with('"') {
                let id_candidate: String = inner[1..].chars().take_while(|c| *c != '"').collect();
                if id_candidate.len() == 11 && id_candidate.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                    return Ok(Some(id_candidate));
                }
            }
        }
    }
    Ok(None)
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

#[cfg(target_os = "macos")]
fn setup_macos_mouse_navigation(app_handle: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
    use std::ptr::NonNull;

    let app_handle = app_handle.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        let button = event_ref.buttonNumber();
        let event_type = event_ref.r#type();

        if button == 3 || button == 4 {
            if event_type == NSEventType::OtherMouseDown {
                let is_downloader_visible = app_handle
                    .try_state::<tab_downloader_native::TabDownloaderState>()
                    .and_then(|st| st.is_visible.lock().ok().map(|g| *g))
                    .unwrap_or(false);

                if is_downloader_visible {
                    let script = if button == 3 {
                        "window.history.back()"
                    } else {
                        "window.history.forward()"
                    };
                    if let Some(w) = app_handle.get_webview(tab_downloader_native::DOWNLOADER_LABEL) {
                        let _ = w.eval(script);
                    }
                } else {
                    let event_name = if button == 3 {
                        "mouse-nav-back"
                    } else {
                        "mouse-nav-forward"
                    };
                    let _ = app_handle.emit(event_name, ());
                }
            }
            std::ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });

    unsafe {
        let mask = NSEventMask::OtherMouseDown | NSEventMask::OtherMouseUp;
        if let Some(token) = NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) {
            std::mem::forget(token);
        }
    }
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
        .manage(jam::JamState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_google_auth::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                youtube_macos::install(_app)?;
                setup_macos_mouse_navigation(_app.handle().clone());
            }
            #[cfg(target_os = "ios")]
            youtube_ios::install(_app);
            tab_downloader_native::install(_app)?;

            #[cfg(feature = "debug-tools")]
            if let Some(main_wv) = _app.get_webview("main") {
                main_wv.open_devtools();
            }

            #[cfg(target_os = "ios")]
            if let Some(main_win) = _app.get_webview_window("main") {
                tab_downloader_native::configure_ios_webview(&main_win, 6.0, 5.0, 10.0);
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if let Some(window) = _app.get_window("main") {
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
                        let is_visible = app_handle_for_resize
                            .try_state::<tab_downloader_native::TabDownloaderState>()
                            .and_then(|st| st.is_visible.lock().ok().map(|g| *g))
                            .unwrap_or(true);
                        if is_open && is_visible {
                            if let Some(downloader) = app_handle_for_resize.get_webview(tab_downloader_native::DOWNLOADER_LABEL) {
                                if let Some(main_win) = app_handle_for_resize.get_window("main") {
                                    let scale = main_win.scale_factor().unwrap_or(1.0);
                                    let logical = size.to_logical::<f64>(scale);
                                    let top_offset = app_handle_for_resize
                                        .try_state::<tab_downloader_native::TabDownloaderState>()
                                        .and_then(|st| st.top_offset.lock().ok().map(|g| *g))
                                        .unwrap_or(84.0);
                                    let _ = downloader.set_position(LogicalPosition::new(0.0, top_offset));
                                    let _ = downloader.set_size(LogicalSize::new(logical.width, (logical.height - top_offset).max(1.0)));
                                }
                            }
                        }
                    }
                });
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

    // Folder chooser for local incremental backups. Persisted scope keeps the chosen folder
    // writable after a restart; it must come after the fs plugin.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        jam::jam_now_ms,
        jam::jam_debug_autostart,
        jam::jam_keep_awake,
        jam::jam_local_addresses,
        jam::jam_host_start,
        jam::jam_host_stop,
        jam::jam_host_send,
        jam::jam_host_kick,
        jam::jam_host_peers,
        jam::jam_discover,
        jam::jam_client_connect,
        jam::jam_client_send,
        jam::jam_client_disconnect,
        get_opened_file,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_drive_root,
        self_update::update_install_mode,
        self_update::install_update,
        open_tab_downloader,
        configure_ios_main_window,
        tab_downloader_native::tab_downloader_update,
        tab_downloader_native::tab_downloader_navigate,
        tab_downloader_native::tab_downloader_nav,
        tab_downloader_native::tab_downloader_hide,
        tab_downloader_native::tab_downloader_set_visible,
        tab_downloader_native::tab_downloader_open_devtools,
        tab_downloader_native::tab_downloader_is_debug_tools_enabled,
        youtube_search,
        youtube_macos::youtube_player_update,
        youtube_macos::youtube_player_command
    ]);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        jam::jam_now_ms,
        jam::jam_debug_autostart,
        jam::jam_keep_awake,
        jam::jam_local_addresses,
        jam::jam_host_start,
        jam::jam_host_stop,
        jam::jam_host_send,
        jam::jam_host_kick,
        jam::jam_host_peers,
        jam::jam_discover,
        jam::jam_client_connect,
        jam::jam_client_send,
        jam::jam_client_disconnect,
        get_opened_file,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_drive_root,
        self_update::update_install_mode,
        self_update::install_update,
        open_tab_downloader,
        configure_ios_main_window,
        tab_downloader_native::tab_downloader_update,
        tab_downloader_native::tab_downloader_navigate,
        tab_downloader_native::tab_downloader_nav,
        tab_downloader_native::tab_downloader_hide,
        tab_downloader_native::tab_downloader_set_visible,
        tab_downloader_native::tab_downloader_open_devtools,
        tab_downloader_native::tab_downloader_is_debug_tools_enabled,
        youtube_search,
        #[cfg(target_os = "ios")]
        youtube_ios::youtube_player_update,
        #[cfg(target_os = "ios")]
        youtube_ios::youtube_player_command
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

