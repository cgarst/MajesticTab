use std::sync::Mutex;
use tauri::{App, AppHandle, Manager, State, Wry};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{
    webview::WebviewBuilder, Emitter, LogicalPosition, LogicalSize, WebviewUrl,
};

#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::DownloadedTabPayload;

#[allow(dead_code)]
pub const DOWNLOADER_LABEL: &str = "tab-downloader";

pub const CORE_DOWNLOADER_SHIM: &str = r#"(function() {
    if (window.__majesticDownloaderShimInitialized) return;
    window.__majesticDownloaderShimInitialized = true;

    // 1. Force window.open to redirect in the single active webview
    const origOpen = window.open;
    window.open = function(url, target, features) {
        if (url) {
            try {
                window.location.href = url;
            } catch (e) {
                console.error('[MajesticTab] window.open redirect failed:', e);
            }
            return window;
        }
        return origOpen ? origOpen.call(window, url, target, features) : null;
    };

    // 2. Force HTMLFormElement.prototype.submit to always stay in the single webview (_self)
    const origFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function() {
        this.target = '_self';
        return origFormSubmit.apply(this, arguments);
    };

    // 3. Helper to send client-side captured binary data (e.g. blobs/data URLs) to MajesticTab shell
    function triggerMajesticDownload(filename, base64Data) {
        const a = document.createElement('a');
        a.href = 'majestictab://download?name=' + encodeURIComponent(filename) + '&data=' + encodeURIComponent(base64Data);
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 200);
    }

    // 4. Helper to read Blob, Data, or Object URLs and forward to native shell
    function handleBlobOrDataUrl(url, suggestedFilename) {
        fetch(url)
            .then(r => r.arrayBuffer())
            .then(buf => {
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const b64 = btoa(binary);
                const name = suggestedFilename || 'downloaded.gp';
                triggerMajesticDownload(name, b64);
            })
            .catch(err => {
                console.error('[MajesticTab] Failed to read blob download:', err);
            });
    }

    // 5. Intercept HTMLAnchorElement.prototype.click to catch dynamic JS downloads
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
        if (this.target && this.target !== '_self') {
            this.target = '_self';
        }
        const href = this.href || this.getAttribute('href') || '';
        const downloadAttr = this.getAttribute('download') || this.download;
        if (href.startsWith('blob:') || href.startsWith('data:')) {
            handleBlobOrDataUrl(href, downloadAttr);
            return;
        }
        return origAnchorClick.apply(this, arguments);
    };

    // 6. Generic DOM target sanitizer (neutralizes target="_blank" on any site)
    function sanitizeTargets(root) {
        try {
            if (!root || !root.querySelectorAll) return;
            const elements = root.querySelectorAll('a[target], form[target], area[target], base[target]');
            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const t = (el.getAttribute('target') || '').toLowerCase();
                if (t && t !== '_self') {
                    el.setAttribute('target', '_self');
                    el.target = '_self';
                }
            }
        } catch (e) {}
    }

    // 7. Global Capture Phase Click & Submit Listeners (executes BEFORE any website event handlers)
    window.addEventListener('click', function(e) {
        const el = e.target && e.target.closest ? e.target.closest('a, button, input[type="submit"], input[type="button"], form') : null;
        if (!el) return;

        if (el.tagName === 'A') {
            if (el.target && el.target !== '_self') {
                el.target = '_self';
                el.setAttribute('target', '_self');
            }
            const href = el.getAttribute('href') || el.href || '';
            const downloadAttr = el.getAttribute('download') || el.download;

            if (href.startsWith('blob:') || href.startsWith('data:')) {
                e.preventDefault();
                e.stopPropagation();
                handleBlobOrDataUrl(href, downloadAttr);
                return;
            }
        }

        if (el.form && el.form.target && el.form.target !== '_self') {
            el.form.target = '_self';
            el.form.setAttribute('target', '_self');
        }
    }, true);

    window.addEventListener('submit', function(e) {
        if (e.target && e.target.tagName === 'FORM') {
            if (e.target.target && e.target.target !== '_self') {
                e.target.target = '_self';
                e.target.setAttribute('target', '_self');
            }
        }
    }, true);

    // 8. Observe DOM mutations to sanitize any dynamically inserted links, buttons, and forms
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1) {
                        sanitizeTargets(node);
                    }
                }
            } else if (m.type === 'attributes' && m.attributeName === 'target') {
                if (m.target && m.target.getAttribute) {
                    const t = (m.target.getAttribute('target') || '').toLowerCase();
                    if (t && t !== '_self') {
                        m.target.setAttribute('target', '_self');
                        m.target.target = '_self';
                    }
                }
            }
        }
    });

    const initObserver = () => {
        sanitizeTargets(document);
        const target = document.body || document.documentElement;
        if (target) {
            observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['target'] });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initObserver);
    } else {
        initObserver();
    }
    window.addEventListener('load', initObserver);

    // 9. Webview URL change reporter to parent app
    function reportUrl() {
        try {
            const u = window.location.href;
            if (u && !u.startsWith('about:blank') && !u.startsWith('majestictab:')) {
                const img = new Image();
                img.src = 'majestictab://url?url=' + encodeURIComponent(u);
            }
        } catch (e) {}
    }

    const origPushState = history.pushState;
    history.pushState = function() {
        const ret = origPushState.apply(this, arguments);
        reportUrl();
        return ret;
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function() {
        const ret = origReplaceState.apply(this, arguments);
        reportUrl();
        return ret;
    };
    window.addEventListener('popstate', reportUrl);
    window.addEventListener('hashchange', reportUrl);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', reportUrl);
    } else {
        reportUrl();
    }
    window.addEventListener('load', reportUrl);

    // 10. Webview console log bridge to parent app
    function bridgeLog(type, args) {
        try {
            const msg = '[' + type.toUpperCase() + '] ' + Array.from(args).map(a => {
                if (typeof a === 'object') {
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }
                return String(a);
            }).join(' ');
            const img = new Image();
            img.src = 'majestictab://log?msg=' + encodeURIComponent(msg);
        } catch (e) {}
    }

    const origLog = console.log;
    console.log = function() {
        bridgeLog('log', arguments);
        origLog.apply(console, arguments);
    };
    const origWarn = console.warn;
    console.warn = function() {
        bridgeLog('warn', arguments);
        origWarn.apply(console, arguments);
    };
    const origError = console.error;
    console.error = function() {
        bridgeLog('error', arguments);
        origError.apply(console, arguments);
    };
})();"#;

#[derive(Default)]
#[allow(dead_code)]
pub struct TabDownloaderState {
    pub current_url: Mutex<Option<String>>,
    pub active_userscript: Mutex<Option<String>>,
    pub pending_downloads: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    pub last_destination: Mutex<Option<std::path::PathBuf>>,
}

pub fn wrap_userscript(raw_js: &str) -> String {
    let trimmed = raw_js.trim();
    format!(
        r#"{CORE_DOWNLOADER_SHIM}
(function() {{
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

/// Identifies if a downloaded file represents a supported tab/score format by extension or file header magic bytes
pub fn identify_tab_extension(bytes: &[u8], filename: &str) -> Option<&'static str> {
    let lower_name = filename.to_lowercase();

    // 1. Check known binary file magic headers first (handling Pascal-string 1-byte prefix \x18/\x19/\x1a)
    let is_gp_pascal = bytes.len() > 20 && (&bytes[1..]).starts_with(b"FICHIER GUITAR PRO");
    let is_gp_raw = bytes.starts_with(b"FICHIER GUITAR PRO");
    if is_gp_pascal || is_gp_raw {
        let gp_slice = if is_gp_pascal { &bytes[1..] } else { bytes };
        if gp_slice.starts_with(b"FICHIER GUITAR PRO v3") {
            return Some("gp3");
        }
        if gp_slice.starts_with(b"FICHIER GUITAR PRO v4") {
            return Some("gp4");
        }
        return Some("gp5");
    }
    if bytes.starts_with(b"BCFB") {
        return Some("gpx");
    }
    if bytes.starts_with(b"%PDF") {
        return Some("pdf");
    }
    // Zip container (Guitar Pro 7 .gp or .gpx container)
    if bytes.starts_with(b"PK\x03\x04") {
        if lower_name.ends_with(".gp") {
            return Some("gp");
        }
        return Some("gpx");
    }

    // 2. Check file extension for supported formats
    if lower_name.ends_with(".gp") {
        return Some("gp");
    }
    if lower_name.ends_with(".gp3") {
        return Some("gp3");
    }
    if lower_name.ends_with(".gp4") {
        return Some("gp4");
    }
    if lower_name.ends_with(".gp5") {
        return Some("gp5");
    }
    if lower_name.ends_with(".gpx") {
        return Some("gpx");
    }
    if lower_name.ends_with(".gp7") {
        return Some("gp7");
    }
    if lower_name.ends_with(".pdf") {
        return Some("pdf");
    }
    if lower_name.ends_with(".txt") {
        return Some("txt");
    }

    // 3. ASCII/UTF-8 Text containing tab notation (e.g. |-- or [Tab])
    if bytes.len() > 10 && bytes.len() < 10_000_000 {
        if let Ok(text) = std::str::from_utf8(bytes) {
            if text.contains("|--") || text.contains("| -") || text.contains("|- -") || text.contains("[Tab") || text.contains("[tab") {
                return Some("txt");
            }
        }
    }

    None
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn install(app: &mut App<Wry>) -> tauri::Result<()> {
    app.manage(TabDownloaderState::default());
    let window = app
        .get_window("main")
        .ok_or(tauri::Error::WebviewNotFound)?;

    let builder = WebviewBuilder::new(
        DOWNLOADER_LABEL,
        WebviewUrl::External("https://www.ultimate-guitar.com/".parse().unwrap()),
    )
    .initialization_script(CORE_DOWNLOADER_SHIM);

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

        // 2. URL update notification scheme: majestictab://url?url=...
        if url.scheme() == "majestictab" && (url.host_str() == Some("url") || url_str.starts_with("majestictab://url")) {
            let target_url = url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            if !target_url.is_empty() {
                let _ = app_handle_for_nav.emit("tab-downloader-url-changed", target_url);
            }
            return false;
        }

        // 3. Direct client-side download capture scheme: majestictab://download?name=...&data=...
        if url.scheme() == "majestictab" && (url.host_str() == Some("download") || url_str.starts_with("majestictab://download")) {
            let name = url
                .query_pairs()
                .find(|(k, _)| k == "name")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_else(|| "downloaded.gp".to_string());
            let b64_data = url
                .query_pairs()
                .find(|(k, _)| k == "data")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64_data).ok();
            eprintln!("[Tab Downloader] Captured client-side download: {} ({} bytes)", name, data.as_ref().map(|d| d.len()).unwrap_or(0));
            let payload = DownloadedTabPayload {
                name,
                path: None,
                data,
            };
            let _ = app_handle_for_nav.emit("tab-downloaded", payload);
            return false;
        }

        if url.scheme() == "http" || url.scheme() == "https" {
            let _ = app_handle_for_nav.emit("tab-downloader-url-changed", url_str.to_string());
        }

        true
    });

    let app_handle_for_load = app.handle().clone();
    let builder = builder.on_page_load(move |webview, payload| {
        if let tauri::webview::PageLoadEvent::Finished = payload.event() {
            if let Ok(cur_url) = webview.url() {
                let s = cur_url.to_string();
                if s.starts_with("http://") || s.starts_with("https://") {
                    let _ = app_handle_for_load.emit("tab-downloader-url-changed", s);
                }
            }
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
            tauri::webview::DownloadEvent::Requested { destination, url } => {
                let dest_dir = std::env::temp_dir().join("majestictab_downloads");
                let _ = std::fs::create_dir_all(&dest_dir);
                let mut filename = destination
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "downloaded.gp".to_string());

                if filename == "download" || !filename.contains('.') {
                    if let Some(segment) = url.path_segments().and_then(|s| s.last()) {
                        if segment.contains('.') {
                            filename = segment.to_string();
                        }
                    }
                }

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let unique_temp_name = format!("{}_{}", now_ms, filename);
                let final_dest = dest_dir.join(&unique_temp_name);
                *destination = final_dest.clone();

                if let Some(state) = app_handle_for_download.try_state::<TabDownloaderState>() {
                    if let Ok(mut pending) = state.pending_downloads.lock() {
                        pending.insert(url.to_string(), final_dest.clone());
                    }
                    if let Ok(mut last) = state.last_destination.lock() {
                        *last = Some(final_dest.clone());
                    }
                }

                eprintln!("[Tab Downloader] Native download requested -> destination={:?}, url={}", final_dest, url);
                true
            }
            tauri::webview::DownloadEvent::Finished { url, path, success, .. } => {
                eprintln!("[Tab Downloader] Native download finished: success={}, url={}, path={:?}", success, url, path);
                let resolved_path = path.or_else(|| {
                    if let Some(state) = app_handle_for_download.try_state::<TabDownloaderState>() {
                        if let Ok(mut pending) = state.pending_downloads.lock() {
                            if let Some(p) = pending.remove(&url.to_string()) {
                                return Some(p);
                            }
                        }
                        if let Ok(mut last) = state.last_destination.lock() {
                            return last.take();
                        }
                    }
                    None
                });

                if let Some(p) = resolved_path {
                    let raw_name = p
                        .file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| "downloaded.gp".to_string());
                    let mut filename = if let Some(idx) = raw_name.find('_') {
                        if raw_name[..idx].chars().all(|c| c.is_ascii_digit()) {
                            raw_name[idx + 1..].to_string()
                        } else {
                            raw_name
                        }
                    } else {
                        raw_name
                    };

                    let data = std::fs::read(&p).ok();
                    if let Some(ref bytes) = data {
                        if !bytes.is_empty() {
                            let identified_ext = identify_tab_extension(bytes, &filename);
                            if let Some(ext) = identified_ext {
                                if !filename.to_lowercase().ends_with(&format!(".{}", ext)) {
                                    if !filename.contains('.') || filename.starts_with("download") {
                                        filename = format!("{}.{}", filename, ext);
                                    }
                                }

                                eprintln!("[Tab Downloader] Ingested tab download: {:?} -> {} ({} bytes)", p, filename, bytes.len());
                                let payload = DownloadedTabPayload {
                                    name: filename,
                                    path: Some(p.to_string_lossy().to_string()),
                                    data: Some(bytes.clone()),
                                };
                                let _ = app_handle_for_download.emit("tab-downloaded", payload);
                            } else {
                                eprintln!("[Tab Downloader] Downloaded file {} ({} bytes) did not match tab requirements", filename, bytes.len());
                            }
                        }
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

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn install(app: &mut App<Wry>) -> tauri::Result<()> {
    app.manage(TabDownloaderState::default());
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
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

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_update(
    _app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    _url: String,
    _userscript: Option<String>,
    _left: f64,
    _top: f64,
    _width: f64,
    _height: f64,
    _visible: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
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

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_nav(
    _app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    _action: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn tab_downloader_hide(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
        let _ = wv.set_position(LogicalPosition::new(-10000.0, -10000.0));
        let _ = wv.set_size(LogicalSize::new(1.0, 1.0));
        let _ = wv.hide();
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn tab_downloader_hide(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn tab_downloader_eval(app: AppHandle, script: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
        wv.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_eval(_app: AppHandle, _script: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_open_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios"))))]
    {
        if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
            wv.open_devtools();
        }
    }
    #[cfg(not(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios")))))]
    {
        let _ = app;
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_is_debug_tools_enabled() -> bool {
    #[cfg(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios"))))]
    {
        true
    }
    #[cfg(not(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios")))))]
    {
        false
    }
}
