use std::sync::Mutex;
use tauri::{
    webview::WebviewBuilder, App, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
    State, WebviewUrl, Wry,
};

#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

use crate::DownloadedTabPayload;

pub const DOWNLOADER_LABEL: &str = "tab-downloader";

#[derive(Default)]
pub struct TabDownloaderState {
    pub current_url: Mutex<Option<String>>,
    pub active_userscript: Mutex<Option<String>>,
}

pub fn wrap_userscript(raw_js: &str) -> String {
    let trimmed = raw_js.trim();
    format!(
        r#"(function() {{
    if (!window.__majesticWindowOpenOverridden) {{
        window.__majesticWindowOpenOverridden = true;
        const origOpen = window.open;
        window.open = function(url, target, features) {{
            if (url) {{
                window.location.href = url;
                return window;
            }}
            return origOpen ? origOpen.call(window, url, target, features) : null;
        }};

        // Form submit override to avoid _blank popup loss
        const origFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function() {{
            this.target = '_self';
            return origFormSubmit.apply(this, arguments);
        }};

        document.addEventListener('submit', function(e) {{
            if (e.target && e.target.tagName === 'FORM') {{
                e.target.target = '_self';
            }}
        }}, true);

        document.addEventListener('click', function(e) {{
            const el = e.target && e.target.closest ? e.target.closest('a, button, input[type="submit"]') : null;
            if (el) {{
                if (el.tagName === 'A') {{
                    if (el.target === '_blank') el.target = '_self';
                    const href = el.getAttribute('href') || '';
                    const downloadAttr = el.getAttribute('download');
                    
                    // Capture blob: or data: client-side downloads generically
                    if (href.startsWith('blob:') || href.startsWith('data:')) {{
                        e.preventDefault();
                        e.stopPropagation();
                        const filename = downloadAttr || 'downloaded.gp';
                        fetch(href)
                            .then(r => r.arrayBuffer())
                            .then(buf => {{
                                const bytes = new Uint8Array(buf);
                                let binary = '';
                                for (let i = 0; i < bytes.byteLength; i++) {{
                                    binary += String.fromCharCode(bytes[i]);
                                }}
                                const base64 = btoa(binary);
                                const a = document.createElement('a');
                                a.href = 'majestictab://download?name=' + encodeURIComponent(filename) + '&data=' + encodeURIComponent(base64);
                                document.body.appendChild(a);
                                a.click();
                                setTimeout(() => a.remove(), 200);
                            }})
                            .catch(err => console.error('[MajesticTab] Blob capture error:', err));
                        return;
                    }}

                    if (href.match(/\\.(gp|gp3|gp4|gp5|gpx|ptb|cap|tg|mid|midi|pdf)($|\\?)/i) || href.includes('/download') || downloadAttr) {{
                        el.target = '_self';
                    }}
                }}
                if (el.form && el.form.target === '_blank') el.form.target = '_self';
            }}
        }}, true);

        // Webview console log bridge to parent app
        function bridgeLog(type, args) {{
            try {{
                const msg = '[' + type.toUpperCase() + '] ' + Array.from(args).map(a => {{
                    if (typeof a === 'object') {{
                        try {{ return JSON.stringify(a); }} catch (e) {{ return String(a); }}
                    }}
                    return String(a);
                }}).join(' ');
                const img = new Image();
                img.src = 'majestictab://log?msg=' + encodeURIComponent(msg);
            }} catch (e) {{}}
        }}

        const origLog = console.log;
        console.log = function() {{
            bridgeLog('log', arguments);
            origLog.apply(console, arguments);
        }};
        const origWarn = console.warn;
        console.warn = function() {{
            bridgeLog('warn', arguments);
            origWarn.apply(console, arguments);
        }};
        const origError = console.error;
        console.error = function() {{
            bridgeLog('error', arguments);
            origError.apply(console, arguments);
        }};
    }}

    window.__majesticActiveUserscript = function() {{
        try {{
            {trimmed}
        }} catch (err) {{
            console.error("[MajesticTab Userscript Error]", err);
        }}
    }};

    if (typeof window.__majesticActiveUserscript === 'function') {{
        window.__majesticActiveUserscript();
    }}
    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', () => {{
            if (window.__majesticActiveUserscript) window.__majesticActiveUserscript();
        }});
    }}
    window.addEventListener('load', () => {{
        if (window.__majesticActiveUserscript) window.__majesticActiveUserscript();
    }});
    if (!window.__majesticRunnerInit) {{
        window.__majesticRunnerInit = true;
        setInterval(() => {{
            if (typeof window.__majesticActiveUserscript === 'function') {{
                window.__majesticActiveUserscript();
            }}
        }}, 400);
        try {{
            const obs = new MutationObserver(() => {{
                if (typeof window.__majesticActiveUserscript === 'function') {{
                    window.__majesticActiveUserscript();
                }}
            }});
            const target = document.body || document.documentElement;
            if (target) {{
                obs.observe(target, {{ childList: true, subtree: true }});
            }} else {{
                document.addEventListener('DOMContentLoaded', () => {{
                    const t = document.body || document.documentElement;
                    if (t) obs.observe(t, {{ childList: true, subtree: true }});
                }});
            }}
        }} catch (e) {{}}
    }}
}})();"#
    )
}

pub fn install(app: &mut App<Wry>) -> tauri::Result<()> {
    app.manage(TabDownloaderState::default());
    let window = app
        .get_window("main")
        .ok_or(tauri::Error::WebviewNotFound)?;

    let builder = WebviewBuilder::new(
        DOWNLOADER_LABEL,
        WebviewUrl::External("https://www.ultimate-guitar.com/".parse().unwrap()),
    );
    #[cfg(feature = "debug-tools")]
    let builder = builder.devtools(true);

    let app_handle_for_nav = app.handle().clone();
    let builder = builder.on_navigation(move |url| {
        let url_str = url.as_str();
        eprintln!("[Tab Downloader] Navigation requested: {}", url_str);

        // 1. Console log forwarding scheme: majestictab://log?msg=...
        if url.scheme() == "majestictab" && (url.host_str() == Some("log") || url_str.starts_with("majestictab://log")) {
            let msg = url
                .query_pairs()
                .find(|(k, _)| k == "msg")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            eprintln!("[Tab Downloader Webview Log] {}", msg);
            let _ = app_handle_for_nav.emit("tab-downloader-log", msg);
            return false;
        }

        true
    });

    let app_handle_for_load = app.handle().clone();
    let builder = builder.on_page_load(move |webview, payload| {
        if let tauri::webview::PageLoadEvent::Finished = payload.event() {
            if let Some(state) = app_handle_for_load.try_state::<TabDownloaderState>() {
                if let Ok(guard) = state.active_userscript.lock() {
                    if let Some(ref js) = *guard {
                        if !js.is_empty() {
                            let wrapped = wrap_userscript(js);
                            let _ = webview.eval(&wrapped);
                        }
                    }
                }
            }
        }
    });

    let app_handle_for_download = app.handle().clone();
    let builder = builder.on_download(move |_webview, event| {
        match event {
            tauri::webview::DownloadEvent::Requested { destination, .. } => {
                let dest_dir = std::env::temp_dir().join("majestictab_downloads");
                let _ = std::fs::create_dir_all(&dest_dir);
                let filename = destination
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "downloaded.gp".to_string());
                *destination = dest_dir.join(&filename);
                eprintln!("[Tab Downloader] Native download requested -> {:?}", destination);
                true
            }
            tauri::webview::DownloadEvent::Finished { path, success, .. } => {
                if success {
                    if let Some(p) = path {
                        let mut filename = p
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_else(|| "downloaded.gp".to_string());
                        let data = std::fs::read(&p).ok();

                        if let Some(ref bytes) = data {
                            if !filename.contains('.') || filename == "download" {
                                if bytes.starts_with(b"FICHIER GUITAR PRO") {
                                    filename.push_str(".gp5");
                                } else if bytes.starts_with(b"%PDF") {
                                    filename.push_str(".pdf");
                                } else if bytes.starts_with(b"BCFB") || bytes.starts_with(b"PK\x03\x04") {
                                    filename.push_str(".gpx");
                                } else if bytes.starts_with(b"PTAB") {
                                    filename.push_str(".ptb");
                                } else {
                                    filename.push_str(".gp");
                                }
                            }
                        }

                        eprintln!("[Tab Downloader] Native download finished: {:?} -> {} ({} bytes)", p, filename, data.as_ref().map(|d| d.len()).unwrap_or(0));
                        let payload = DownloadedTabPayload {
                            name: filename,
                            path: Some(p.to_string_lossy().to_string()),
                            data,
                        };
                        let _ = app_handle_for_download.emit("tab-downloaded", payload);
                    }
                }
                true
            }
            _ => true,
        }
    });

    let downloader = window.add_child(
        builder,
        LogicalPosition::new(-10000.0, -10000.0),
        LogicalSize::new(1.0, 1.0),
    )?;

    #[cfg(target_os = "macos")]
    downloader.with_webview(|platform| unsafe {
        let webview = &*platform.inner().cast::<WKWebView>();
        webview.setWantsLayer(true);
        if let Some(layer) = webview.layer() {
            layer.setCornerRadius(8.0);
            layer.setMasksToBounds(true);
        }
        let ua = NSString::from_str("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15");
        webview.setCustomUserAgent(Some(&ua));
    })?;

    downloader.hide()?;
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_update(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    url: String,
    userscript: Option<String>,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
    visible: bool,
) -> Result<(), String> {
    let downloader = app
        .get_webview(DOWNLOADER_LABEL)
        .ok_or_else(|| "Tab downloader webview is unavailable".to_string())?;

    if !visible || width <= 0.0 || height <= 0.0 {
        downloader
            .set_position(LogicalPosition::new(-10000.0, -10000.0))
            .map_err(|e| e.to_string())?;
        downloader
            .set_size(LogicalSize::new(1.0, 1.0))
            .map_err(|e| e.to_string())?;
        downloader.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }

    downloader
        .set_position(LogicalPosition::new(left, top))
        .map_err(|e| e.to_string())?;
    downloader
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;

    let mut current_url = state
        .current_url
        .lock()
        .map_err(|e| e.to_string())?;

    if current_url.as_deref() != Some(url.as_str()) {
        *current_url = Some(url.clone());
        downloader.navigate(parsed_url).map_err(|e| e.to_string())?;
    }

    if let Some(ref js) = userscript {
        if !js.is_empty() {
            let wrapped = wrap_userscript(js);
            let _ = downloader.eval(&wrapped);
        }
    }

    if let Ok(mut stored_script) = state.active_userscript.lock() {
        *stored_script = userscript;
    }

    downloader.show().map_err(|e| e.to_string())?;
    let _ = downloader.set_focus();
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_nav(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    action: String,
) -> Result<(), String> {
    let wv = app
        .get_webview(DOWNLOADER_LABEL)
        .ok_or_else(|| "Tab downloader webview is not active".to_string())?;

    match action.as_str() {
        "back" => {
            wv.eval("window.history.back()")
                .map_err(|e| e.to_string())?;
        }
        "forward" => {
            wv.eval("window.history.forward()")
                .map_err(|e| e.to_string())?;
        }
        "reload" => {
            wv.eval("window.location.reload()")
                .map_err(|e| e.to_string())?;
        }
        _ => {}
    }

    // Re-inject active userscript if applicable
    if let Ok(guard) = state.active_userscript.lock() {
        if let Some(ref js) = *guard {
            if !js.is_empty() {
                let wrapped = wrap_userscript(js);
                let _ = wv.eval(&wrapped);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn tab_downloader_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
        let _ = wv.set_position(LogicalPosition::new(-10000.0, -10000.0));
        let _ = wv.set_size(LogicalSize::new(1.0, 1.0));
        let _ = wv.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_eval(app: AppHandle, script: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
        wv.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_open_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(feature = "debug-tools")]
    {
        if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
            wv.open_devtools();
        }
    }
    #[cfg(not(feature = "debug-tools"))]
    {
        let _ = app;
    }
    Ok(())
}
