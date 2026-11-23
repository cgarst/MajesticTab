use std::sync::Mutex;
use tauri::Manager;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::Emitter;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::RunEvent;

#[cfg(feature = "debug-tools")]
mod debug_bridge;
#[cfg(feature = "debug-tools")]
mod debug_restore;
mod jam;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod google_picker_desktop;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod icloud;
mod secrets;
mod self_update;
#[cfg(target_os = "ios")]
mod ios_webview;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod youtube_page;
#[cfg(target_os = "macos")]
mod youtube_macos;
#[cfg(target_os = "ios")]
mod youtube_ios;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct OpenedFilePayload {
    pub name: String,
    /// The file's bytes. Empty for a song bundle (.mpak), which can hold hours of audio: it is handed over as `path`
    /// and `size` and the page reads it piece by piece with `read_opened_file_range`.
    pub data: Option<Vec<u8>>,
    pub path: Option<String>,
    pub size: u64,
}

/// Paths the operating system opened the app with; the only files `read_opened_file_range` will read.
static OPENED_PATHS: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());

pub struct OpenedFilesState(pub Mutex<Vec<OpenedFilePayload>>);
pub struct OpenedUrlsState(pub Mutex<Vec<String>>);

fn extract_deep_link_url(target: &str) -> Option<String> {
    let url = tauri::Url::parse(target).ok()?;
    if url.scheme() == "majestictab" {
        Some(url.to_string())
    } else {
        None
    }
}

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
        let size = std::fs::metadata(&path).ok()?.len();
        let is_bundle = path
            .extension()
            .map_or(false, |e| e.eq_ignore_ascii_case("mpak"));
        if is_bundle {
            OPENED_PATHS.lock().ok()?.push(path.clone());
            return Some(OpenedFilePayload {
                name,
                data: None,
                path: Some(path.to_string_lossy().into_owned()),
                size,
            });
        }
        let data = std::fs::read(&path).ok()?;
        Some(OpenedFilePayload { name, data: Some(data), path: None, size })
    } else {
        None
    }
}

#[tauri::command]
fn get_opened_file(state: tauri::State<'_, OpenedFilesState>) -> Option<OpenedFilePayload> {
    state.0.lock().ok()?.pop()
}

#[tauri::command]
fn get_opened_url(state: tauri::State<'_, OpenedUrlsState>) -> Option<String> {
    state.0.lock().ok()?.pop()
}

/// Reads `len` bytes from `start` of a file the app was opened with (see `OPENED_PATHS`), as raw bytes.
#[tauri::command]
fn read_opened_file_range(path: String, start: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let requested = std::path::PathBuf::from(&path);
    let allowed = OPENED_PATHS
        .lock()
        .map_err(|_| "state unavailable".to_string())?
        .iter()
        .any(|p| *p == requested);
    if !allowed {
        return Err("That file was not opened with the app".into());
    }
    let mut file = std::fs::File::open(&requested).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

/// Whether this is a desktop debug build (the `debug-tools` feature); the page shows the debug switches only then.
#[tauri::command]
fn is_debug_tools_enabled() -> bool {
    cfg!(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios"))))
}

#[tauri::command]
fn configure_ios_main_window(_app: tauri::AppHandle) {
    #[cfg(target_os = "ios")]
    if let Some(main_win) = _app.get_webview_window("main") {
        ios_webview::configure_ios_webview(&main_win, 6.0, 5.0, 10.0);
    }
}

#[tauri::command]
async fn youtube_search(query: String) -> Result<Option<String>, String> {
    let client = reqwest_webpki::Client::new();
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
    // Only a real Gaming Mode (gamescope) session counts. Steam Deck hardware or Steam's own variables also show up
    // in Desktop Mode, where the window should stay a normal one with its fullscreen button.
    if std::env::var("GAMESCOPE_WAYLAND_DISPLAY").is_ok()
        || std::env::var("GAMESCOPE_WIDTH").is_ok()
        || std::env::var("GAMESCOPE_HEIGHT").is_ok()
    {
        return true;
    }

    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let l = desktop.to_lowercase();
        if l.contains("gamescope") {
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
                let event_name = if button == 3 {
                    "mouse-nav-back"
                } else {
                    "mouse-nav-forward"
                };
                let _ = app_handle.emit(event_name, ());
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

    let mut context = tauri::generate_context!();
    #[cfg(feature = "debug-tools")]
    if let Some(window_config) = context.config_mut().app.windows.first_mut() {
        window_config.devtools = Some(true);
    }
    // Tauri's built-in dev server sets dev_url to http://127.0.0.1:1430, and YouTube rejects
    // embeds whose Referer is an IP literal ("This video is unavailable"). Rewriting the host to
    // localhost hits the same server and passes YouTube's embed check.
    if let Some(dev_url) = context.config_mut().build.dev_url.as_mut() {
        if dev_url.host_str() == Some("127.0.0.1") {
            let _ = dev_url.set_host(Some("localhost"));
        }
    }

    let initial_files: Vec<OpenedFilePayload> = std::env::args()
        .skip(1)
        .filter_map(|arg| load_file_from_path_or_url(&arg))
        .collect();
    let initial_urls: Vec<String> = std::env::args()
        .skip(1)
        .filter_map(|arg| extract_deep_link_url(&arg))
        .collect();

    let builder = tauri::Builder::default()
        .manage(OpenedFilesState(Mutex::new(initial_files)))
        .manage(OpenedUrlsState(Mutex::new(initial_urls)))
        .manage(jam::JamState::default())
        // Launched with a file (open with, CLI argument), the window comes up without the webview holding keyboard
        // focus on macOS and Linux, so Space and the arrows do nothing until the first click. Hand it focus once loaded.
        .on_page_load(|webview, payload| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = webview.set_focus();
            }
            #[cfg(any(target_os = "android", target_os = "ios"))]
            let _ = (webview, payload);
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                youtube_macos::install(_app)?;
                setup_macos_mouse_navigation(_app.handle().clone());
            }
            #[cfg(target_os = "ios")]
            youtube_ios::install(_app);

            // The YouTube mark and title in the embedded player open a new window; WebKitGTK ignores it unless we
            // answer. Send YouTube links to the default browser and never create a window.
            #[cfg(target_os = "linux")]
            if let Some(main_wv) = _app.get_webview("main") {
                let _ = main_wv.with_webview(|wv| {
                    use webkit2gtk::WebViewExt;
                    wv.inner().connect_create(|_, action| {
                        let uri = action.clone().request().and_then(|r| {
                            use webkit2gtk::URIRequestExt;
                            r.uri().map(|u| u.to_string())
                        });
                        if let Some(uri) = uri {
                            if let Ok(url) = tauri::Url::parse(&uri) {
                                let host = url.host_str().unwrap_or_default();
                                if matches!(url.scheme(), "http" | "https")
                                    && (host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com"))
                                {
                                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                                }
                            }
                        }
                        None
                    });
                });
            }

            #[cfg(feature = "debug-tools")]
            if let Some(main_wv) = _app.get_webview("main") {
                main_wv.open_devtools();
                #[cfg(target_os = "macos")]
                {
                    let _ = main_wv.with_webview(|wv| unsafe {
                        use objc2::msg_send;
                        use objc2::runtime::AnyObject;
                        let wk: *const AnyObject = wv.inner() as _;
                        let tool: *mut AnyObject = msg_send![wk, _inspector];
                        if !tool.is_null() {
                            let () = msg_send![tool, detach];
                        }
                    });
                }
                debug_bridge::start(_app.handle().clone());
            }

            #[cfg(target_os = "ios")]
            if let Some(main_win) = _app.get_webview_window("main") {
                ios_webview::configure_ios_webview(&main_win, 6.0, 5.0, 10.0);
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            if let Some(window) = _app.get_window("main") {
                if let Some(icon) = _app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
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

    // Folder chooser for local incremental backups. Persisted scope keeps the chosen folder
    // writable after a restart; it must come after the fs plugin.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_persisted_scope::init());
    // The dev server's auto-reload script opens ws://127.0.0.1:<port>/__tauri_cli, but the page
    // now loads from localhost, so the browser's Origin no longer matches the Host and the CLI
    // answers 403 (a console error repeated every few seconds). Point the socket at the page host.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry, ()>::new("dev-reload-host")
            .js_init_script(
                r#"(function(){var W=window.WebSocket;if(!W||location.hostname!=='localhost')return;
function P(u,p){try{var x=new URL(u,location.href);if(x.hostname==='127.0.0.1'&&x.port===location.port){x.hostname='localhost';u=x.href}}catch(e){}
return p===undefined?new W(u):new W(u,p)}
P.prototype=W.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){P[k]=W[k]});window.WebSocket=P})();"#
                    .to_string(),
            )
            .build(),
    );

    // Google Drive sign-in; pulls in Google Play services on Android, so the F-Droid channel builds without it.
    #[cfg(feature = "google-auth")]
    let builder = builder.plugin(tauri_plugin_google_auth::init());

    // System navigation chrome for the library destinations (Liquid Glass on iOS 26+ and macOS Tahoe+); see plugins/apple-nav.
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_apple_nav::init());

    // Fold and hinge state for the iPhone Duo (tabletop mode); see plugins/ios-fold.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ios_fold::init());

    #[cfg(all(feature = "self-update", not(any(target_os = "android", target_os = "ios"))))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

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
        jam::jam_host_set_locked,
        jam::jam_host_peers,
        jam::jam_discover,
        jam::jam_client_connect,
        jam::jam_client_send,
        jam::jam_client_disconnect,
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        google_picker_desktop::desktop_pick_drive_file,
        get_opened_file,
        get_opened_url,
        read_opened_file_range,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_drive_root,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_download,
        self_update::update_install_mode,
        secrets::secret_supported,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        self_update::update_auth_token,
        self_update::install_update,
        configure_ios_main_window,
        is_debug_tools_enabled,
        #[cfg(feature = "debug-tools")]
        debug_bridge::debug_bridge_result,
        #[cfg(feature = "debug-tools")]
        debug_restore::debug_restore_request,
        #[cfg(feature = "debug-tools")]
        debug_restore::debug_restore_data,
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
        jam::jam_host_set_locked,
        jam::jam_host_peers,
        jam::jam_discover,
        jam::jam_client_connect,
        jam::jam_client_send,
        jam::jam_client_disconnect,
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        google_picker_desktop::desktop_pick_drive_file,
        get_opened_file,
        get_opened_url,
        read_opened_file_range,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_drive_root,
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        icloud::icloud_download,
        self_update::update_install_mode,
        secrets::secret_supported,
        secrets::secret_get,
        secrets::secret_set,
        secrets::secret_delete,
        self_update::update_auth_token,
        self_update::install_update,
        configure_ios_main_window,
        is_debug_tools_enabled,
        #[cfg(feature = "debug-tools")]
        debug_bridge::debug_bridge_result,
        #[cfg(feature = "debug-tools")]
        debug_restore::debug_restore_request,
        #[cfg(feature = "debug-tools")]
        debug_restore::debug_restore_data,
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
                if url.scheme() == "majestictab" {
                    let s = url.as_str().to_string();
                    if let Some(state) = _app_handle.try_state::<OpenedUrlsState>() {
                        if let Ok(mut lock) = state.0.lock() {
                            lock.push(s.clone());
                        }
                    }
                    let _ = _app_handle.emit("app-open-url", s);
                } else if let Some(payload) = load_file_from_path_or_url(url.as_str()) {
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

