use std::sync::Mutex;
use tauri::{App, AppHandle, Emitter, Manager, State, Wry};

#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

use crate::DownloadedTabPayload;

pub const DOWNLOADER_LABEL: &str = "tab-downloader";

pub const DESKTOP_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSourceInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub url_template: String,
    #[serde(default)]
    pub default_url: String,
    #[serde(default)]
    pub query_format: Option<String>,
    #[serde(default)]
    pub userscript_enabled: bool,
    #[serde(default)]
    pub force_desktop: bool,
    #[serde(default)]
    pub userscript: Option<String>,
    #[serde(default)]
    pub default_userscript: Option<String>,
    #[serde(default)]
    pub is_seed: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDownloaderConfig {
    #[serde(default)]
    pub active_source_id: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub song: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub is_debug_tools_enabled: bool,
    #[serde(default)]
    pub sources: Vec<TabSourceInfo>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub force_desktop: bool,
}

impl Default for TabDownloaderConfig {
    fn default() -> Self {
        Self {
            active_source_id: None,
            artist: None,
            song: None,
            query: None,
            is_debug_tools_enabled: false,
            sources: Vec::new(),
            platform: None,
            force_desktop: false,
        }
    }
}

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

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    // 3. Helper to send client-side captured binary data (e.g. blobs/data URLs) to MajesticTab shell
    function triggerMajesticDownload(filename, base64Data) {
        if (!base64Data) return;
        try {
            if (window.MajesticDownloaderNative && typeof window.MajesticDownloaderNative.onTabDownloaded === 'function') {
                window.MajesticDownloaderNative.onTabDownloaded(filename || 'downloaded.gp', base64Data);
                return;
            }
            if (window.MajesticDownloaderNative && typeof window.MajesticDownloaderNative.close === 'function') {
                window.MajesticDownloaderNative.close();
            }
        } catch(e) {}

        const safeFilename = filename || 'downloaded.gp';
        const CHUNK_SIZE = 32000;
        if (base64Data.length <= CHUNK_SIZE) {
            window.location.href = 'majestictab://download?name=' + encodeURIComponent(safeFilename) + '&data=' + encodeURIComponent(base64Data);
        } else {
            const transferId = Math.random().toString(36).substring(2, 9);
            const totalChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
            let idx = 0;
            function sendNextChunk() {
                if (idx >= totalChunks) return;
                const chunk = base64Data.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
                const isLast = (idx === totalChunks - 1);
                const url = 'majestictab://download-chunk?id=' + transferId +
                    '&name=' + encodeURIComponent(safeFilename) +
                    '&idx=' + idx +
                    '&total=' + totalChunks +
                    '&data=' + encodeURIComponent(chunk);
                idx++;
                window.location.href = url;
                if (!isLast) {
                    setTimeout(sendNextChunk, 60);
                }
            }
            sendNextChunk();
        }
    }

    // 4. Helper to read Blob, Data, or Object URLs and forward to native shell
    function handleBlobOrDataUrl(url, suggestedFilename) {
        fetch(url)
            .then(r => r.arrayBuffer())
            .then(buf => {
                const b64 = arrayBufferToBase64(buf);
                const name = suggestedFilename || 'downloaded.gp';
                triggerMajesticDownload(name, b64);
            })
            .catch(err => {
                console.error('[MajesticTab] Failed to read blob download:', err);
            });
    }

    async function handleFormDownload(form, e) {
        if (!form) return false;
        const action = (form.action || form.getAttribute('action') || '').toLowerCase();
        if (!action.includes('download')) return false;

        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        try {
            const formData = new FormData(form);
            const method = (form.method || 'GET').toUpperCase();
            let res;
            if (method === 'POST') {
                res = await fetch(form.action, { method: 'POST', body: formData, credentials: 'include' });
            } else {
                const params = new URLSearchParams(formData).toString();
                const url = form.action + (form.action.includes('?') ? '&' : '?') + params;
                res = await fetch(url, { method: 'GET', credentials: 'include' });
            }

            if (!res.ok) throw new Error('HTTP ' + res.status);
            const buf = await res.arrayBuffer();
            if (buf.byteLength < 20) throw new Error('Empty response');

            const b64 = arrayBufferToBase64(buf);
            let filename = '';
            const disp = res.headers.get('content-disposition') || '';
            const match = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(disp);
            if (match && match[1]) {
                filename = decodeURIComponent(match[1].trim());
            }
            if (!filename) {
                const heading = document.querySelector('h1')?.textContent?.trim();
                filename = heading ? (heading.replace(/[/\\?%*:|"<>]/g, '_') + '.gp') : 'downloaded.gp';
            }

            triggerMajesticDownload(filename, b64);
            return true;
        } catch (err) {
            console.error('[MajesticTab] Form download intercept error:', err);
            return false;
        }
    }

    function isDownloadLinkElement(a) {
        if (!a) return false;
        const href = (a.getAttribute('href') || a.href || '').toLowerCase();
        if (href.startsWith('javascript:') || href === '#' || href === '') return false;

        const isTabFile = /\.(gp\d?|gpx|pdf|txt|mid|midi|cap)(\?|$)/i.test(href);
        const isDownloadEndpoint = href.includes('download') || href.includes('action=download') || href.includes('get_tab');
        const hasDownloadAttr = a.hasAttribute('download');
        const textAndClasses = ((a.innerText || a.textContent || '') + ' ' + (a.getAttribute('title') || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.className || '')).toLowerCase();
        const hasDownloadWord = textAndClasses.includes('download') && (textAndClasses.includes('tab') || textAndClasses.includes('pro') || textAndClasses.includes('gp') || textAndClasses.includes('file') || textAndClasses.includes('guitar') || isDownloadEndpoint);

        return isTabFile || isDownloadEndpoint || hasDownloadAttr || hasDownloadWord;
    }

    async function handleLinkDownload(a, e) {
        if (!a) return false;
        if (!isDownloadLinkElement(a)) return false;

        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        try {
            const res = await fetch(a.href, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            const disp = res.headers.get('content-disposition') || '';

            // If it's HTML without an attachment header and doesn't end in a tab extension, it's an intermediate page -> navigate to it
            const href = (a.getAttribute('href') || a.href || '').toLowerCase();
            const isTabExt = /\.(gp\d?|gpx|pdf|txt|mid|midi|cap)(\?|$)/i.test(href);
            if (contentType.includes('text/html') && !disp.includes('attachment') && !isTabExt) {
                window.location.href = a.href;
                return true;
            }

            const buf = await res.arrayBuffer();
            if (buf.byteLength < 20) throw new Error('Empty response');

            const b64 = arrayBufferToBase64(buf);
            let filename = a.getAttribute('download') || a.download || '';
            if (!filename) {
                const match = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(disp);
                if (match && match[1]) {
                    filename = decodeURIComponent(match[1].trim());
                } else {
                    try {
                        const seg = (new URL(a.href)).pathname.split('/').pop();
                        if (seg && /\.[a-z0-9]+$/i.test(seg)) filename = seg;
                    } catch(e) {}
                    if (!filename) {
                        const heading = document.querySelector('h1')?.textContent?.trim();
                        filename = heading ? (heading.replace(/[/\\?%*:|"<>]/g, '_') + '.gp') : 'downloaded.gp';
                    }
                }
            }

            triggerMajesticDownload(filename, b64);
            return true;
        } catch (err) {
            console.error('[MajesticTab] Link download intercept error:', err);
            window.location.href = a.href;
            return false;
        }
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
        if (isDownloadLinkElement(this)) {
            handleLinkDownload(this, null);
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
        const el = e.target && e.target.closest ? e.target.closest('a, button, input[type="submit"], input[type="button"], [role="button"], form') : null;
        if (!el) return;

        const a = el.tagName === 'A' ? el : el.closest('a');
        if (a) {
            if (isDownloadLinkElement(a)) {
                handleLinkDownload(a, e);
                return;
            }
            if (a.target && a.target !== '_self') {
                a.target = '_self';
                a.setAttribute('target', '_self');
            }
            const href = (a.getAttribute('href') || a.href || '').toLowerCase();
            const downloadAttr = a.getAttribute('download') || a.download;

            if (href.startsWith('blob:') || href.startsWith('data:')) {
                e.preventDefault();
                e.stopPropagation();
                handleBlobOrDataUrl(href, downloadAttr);
                return;
            }
        }

        if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) || el.getAttribute('role') === 'button') {
            const form = el.form || el.closest('form');
            if (form) {
                const action = (form.action || form.getAttribute('action') || '').toLowerCase();
                if (action.includes('download')) {
                    handleFormDownload(form, e);
                    return;
                }
            }
            const btnText = ((el.innerText || el.textContent || '') + ' ' + (el.className || '')).toLowerCase();
            if (btnText.includes('download')) {
                const targetUrl = el.getAttribute('data-url') || el.getAttribute('data-href') || el.getAttribute('data-link');
                if (targetUrl) {
                    e.preventDefault();
                    e.stopPropagation();
                    handleLinkDownload({ href: targetUrl, getAttribute: () => targetUrl }, e);
                    return;
                }
            }
        }

        if (el.form && el.form.target && el.form.target !== '_self') {
            el.form.target = '_self';
            el.form.setAttribute('target', '_self');
        }
    }, true);

    window.addEventListener('submit', function(e) {
        const form = e.target;
        if (form && form.tagName === 'FORM') {
            const action = (form.action || form.getAttribute('action') || '').toLowerCase();
            if (action.includes('download')) {
                handleFormDownload(form, e);
                return;
            }
            if (form.target && form.target !== '_self') {
                form.target = '_self';
                form.setAttribute('target', '_self');
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
})();"#;

#[derive(Clone, Debug)]
pub struct DownloadChunkState {
    pub name: String,
    pub chunks: Vec<Option<String>>,
}

#[derive(Default)]
pub struct TabDownloaderState {
    pub active_userscript: Mutex<Option<String>>,
    pub current_config: Mutex<Option<TabDownloaderConfig>>,
    pub is_open: Mutex<bool>,
    pub is_visible: Mutex<bool>,
    pub top_offset: Mutex<f64>,
    pub download_chunks: Mutex<std::collections::HashMap<String, DownloadChunkState>>,
}

pub fn wrap_userscript(raw_js: &str, config: Option<&TabDownloaderConfig>) -> String {
    let trimmed = raw_js.trim();
    let mut cfg = config.cloned().unwrap_or_default();
    if cfg.platform.is_none() {
        #[cfg(target_os = "macos")]
        {
            cfg.platform = Some("macos".to_string());
        }
        #[cfg(target_os = "windows")]
        {
            cfg.platform = Some("windows".to_string());
        }
        #[cfg(target_os = "linux")]
        {
            cfg.platform = Some("linux".to_string());
        }
        #[cfg(target_os = "android")]
        {
            cfg.platform = Some("android".to_string());
        }
        #[cfg(target_os = "ios")]
        {
            cfg.platform = Some("ios".to_string());
        }
    }
    let config_json = serde_json::to_string(&cfg).unwrap_or_else(|_| "null".to_string());
    format!(
        r#"{core_shim}
(function() {{
    const cfg = {config_json};
    if (cfg) {{
        window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__ = cfg;
    }}
    window.__majesticActiveUserscript = function() {{
        try {{
            {userscript}
        }} catch (err) {{
            console.error("[MajesticTab Userscript Error]", err);
        }}
    }};

    let isExecuting = false;
    let scheduledTimer = null;
    function scheduleUserscriptRun() {{
        if (scheduledTimer) return;
        scheduledTimer = setTimeout(() => {{
            scheduledTimer = null;
            if (isExecuting) return;
            isExecuting = true;
            try {{
                if (typeof window.__majesticActiveUserscript === 'function') {{
                    window.__majesticActiveUserscript();
                }}
            }} catch (e) {{
            }} finally {{
                isExecuting = false;
            }}
        }}, 300);
    }}

    scheduleUserscriptRun();
    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', scheduleUserscriptRun);
    }}
    window.addEventListener('load', scheduleUserscriptRun);

    if (!window.__majesticRunnerInit) {{
        window.__majesticRunnerInit = true;
        setInterval(scheduleUserscriptRun, 2000);
        try {{
            const obs = new MutationObserver((mutations) => {{
                let relevant = false;
                for (let i = 0; i < mutations.length; i++) {{
                    const m = mutations[i];
                    const target = m.target;
                    if (target && target.id === 'majestic-downloader-host') continue;
                    if (target && target.id === 'majestic-downloader-offset-style') continue;
                    relevant = true;
                    break;
                }}
                if (relevant) {{
                    scheduleUserscriptRun();
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
}})();"#,
        core_shim = CORE_DOWNLOADER_SHIM,
        config_json = config_json,
        userscript = trimmed
    )
}

pub fn schedule_userscript_injection(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
        let js_opt = state.active_userscript.lock().ok().and_then(|g| g.clone());
        let cfg_opt = state.current_config.lock().ok().and_then(|g| g.clone());
        let wrapped = wrap_userscript(js_opt.as_deref().unwrap_or(""), cfg_opt.as_ref());
        let handle = app_handle.clone();
        std::thread::spawn(move || {
            for delay in [25, 80, 200, 500, 1000, 2000, 3500] {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                if let Some(state) = handle.try_state::<TabDownloaderState>() {
                    if let Ok(g) = state.is_open.lock() {
                        if !*g {
                            break;
                        }
                    }
                }
                if let Some(w) = handle.get_webview(DOWNLOADER_LABEL) {
                    let _ = w.eval(&wrapped);
                } else if let Some(w) = handle.get_webview_window(DOWNLOADER_LABEL) {
                    let _ = w.eval(&wrapped);
                }
            }
        });
    }
}

/// iOS has no Tauri child webviews, so the downloader's WKWebView (still created and wired up by Tauri
/// as its own hidden window) is moved into the main webview's parent view, below the app's top bar.
/// That keeps pinch zoom on the site inside its own frame instead of scaling the bar.
#[cfg(target_os = "ios")]
pub fn ios_place_downloader(app: &AppHandle, top_offset: Option<f64>, visible: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let (Some(main), Some(downloader)) = (
        app.get_webview_window("main"),
        app.get_webview_window(DOWNLOADER_LABEL),
    ) else {
        return;
    };
    let top = top_offset
        .or_else(|| {
            app.try_state::<TabDownloaderState>()
                .and_then(|state| state.top_offset.lock().ok().map(|g| *g))
        })
        .unwrap_or(84.0);

    let _ = main.with_webview(move |main_platform| {
        let main_view = main_platform.inner().cast::<AnyObject>();
        let parent: *mut AnyObject = unsafe { msg_send![main_view, superview] };
        let parent_addr = parent as usize;
        let _ = downloader.with_webview(move |platform| unsafe {
            let webview = platform.inner().cast::<AnyObject>();
            let parent = parent_addr as *mut AnyObject;
            if parent.is_null() {
                return;
            }
            if !visible {
                let _: () = msg_send![webview, setHidden: true];
                return;
            }
            let current: *mut AnyObject = msg_send![webview, superview];
            if current != parent {
                if !current.is_null() {
                    let _: () = msg_send![webview, removeFromSuperview];
                }
                let _: () = msg_send![parent, addSubview: webview];
            }
            let _: () = msg_send![parent, bringSubviewToFront: webview];
            let bounds: NSRect = msg_send![parent, bounds];
            let frame = NSRect::new(
                NSPoint::new(0.0, top),
                NSSize::new(bounds.size.width, (bounds.size.height - top).max(1.0)),
            );
            let _: () = msg_send![webview, setFrame: frame];
            // UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight keeps it below the bar on rotation.
            let _: () = msg_send![webview, setAutoresizingMask: 18usize];
            let _: () = msg_send![webview, setClipsToBounds: true];
            let _: () = msg_send![webview, setHidden: false];
        });
    });
}

/// Unload the site once the downloader is hidden so its scripts, timers and media stop using resources
/// while a tab plays. The webview itself is kept so the next open stays fast.
fn blank_downloader_page(navigate: impl FnOnce(tauri::Url) -> tauri::Result<()>) {
    if let Ok(blank) = tauri::Url::parse("about:blank") {
        let _ = navigate(blank);
    }
}

pub fn hide_downloader(app_handle: &AppHandle) {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(w) = app_handle.get_webview(DOWNLOADER_LABEL) {
        let _ = w.eval("try { window.MajesticDownloaderNative?.close(); } catch(e) {}");
        let _ = w.set_position(tauri::LogicalPosition::new(-10000.0, -10000.0));
        let _ = w.set_size(tauri::LogicalSize::new(1.0, 1.0));
        let _ = w.hide();
        blank_downloader_page(|url| w.navigate(url));
        return;
    }
    if let Some(w) = app_handle.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.eval("try { window.MajesticDownloaderNative?.close(); } catch(e) {}");
        let _ = w.hide();
        blank_downloader_page(|url| w.navigate(url));
    }
    #[cfg(target_os = "ios")]
    ios_place_downloader(app_handle, None, false);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    if let Some(main) = app_handle.get_webview_window("main") {
        let _ = main.eval("try { window.MajesticDownloaderNative?.close(); } catch(e) {}");
        let _ = main.show();
        let _ = main.set_focus();
    }
}

pub fn handle_navigation(app_handle: &AppHandle, url: &tauri::Url) -> bool {
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
        let _ = app_handle.emit("tab-downloader-log", msg);
        return false;
    }

    // 5. Chunked download capture scheme: majestictab://download-chunk?id=...&name=...&idx=...&total=...&data=...
    if url.scheme() == "majestictab" && (url.host_str() == Some("download-chunk") || url_str.starts_with("majestictab://download-chunk?") || url_str.starts_with("majestictab://download-chunk/")) {
        let id = url.query_pairs().find(|(k, _)| k == "id").map(|(_, v)| v.into_owned()).unwrap_or_default();
        let name = url.query_pairs().find(|(k, _)| k == "name").map(|(_, v)| v.into_owned()).unwrap_or_else(|| "downloaded.gp".to_string());
        let idx: usize = url.query_pairs().find(|(k, _)| k == "idx").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        let total: usize = url.query_pairs().find(|(k, _)| k == "total").and_then(|(_, v)| v.parse().ok()).unwrap_or(1);
        let chunk_data = url.query_pairs().find(|(k, _)| k == "data").map(|(_, v)| v.into_owned()).unwrap_or_default();

        let mut completed: Option<(String, String)> = None;
        if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            if let Ok(mut lock) = state.download_chunks.lock() {
                let entry = lock.entry(id.clone()).or_insert_with(|| DownloadChunkState {
                    name: name.clone(),
                    chunks: vec![None; total],
                });
                if idx < entry.chunks.len() {
                    entry.chunks[idx] = Some(chunk_data);
                }
                if entry.chunks.iter().all(|c| c.is_some()) {
                    let full_b64: String = entry.chunks.iter().filter_map(|c| c.as_ref()).cloned().collect();
                    completed = Some((entry.name.clone(), full_b64));
                    lock.remove(&id);
                }
            }
        }

        if let Some((tab_name, b64_data)) = completed {
            let sanitized_b64 = b64_data.replace(' ', "+");
            let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &sanitized_b64).ok();
            let mut final_name = tab_name;
            if let Some(ref bytes) = data {
                if let Some(ext) = identify_tab_extension(bytes, &final_name) {
                    if !final_name.to_lowercase().ends_with(&format!(".{}", ext)) {
                        if !final_name.contains('.') || final_name.starts_with("download") {
                            final_name = format!("{}.{}", final_name, ext);
                        }
                    }
                }
            }
            eprintln!("[Tab Downloader] Reassembled chunked download: {} ({} bytes)", final_name, data.as_ref().map(|d| d.len()).unwrap_or(0));
            hide_downloader(app_handle);
            if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
                if let Ok(mut g) = state.is_open.lock() {
                    *g = false;
                }
            }
            let escaped_name = serde_json::to_string(&final_name).unwrap_or_default();
            let escaped_b64 = serde_json::to_string(&sanitized_b64).unwrap_or_default();
            let eval_script = format!("window.__onTabDownloaded && window.__onTabDownloaded({}, {});", escaped_name, escaped_b64);
            if let Some(main_win) = app_handle.get_webview_window("main") {
                let _ = main_win.eval(&eval_script);
                let _ = main_win.show();
                let _ = main_win.set_focus();
            } else if let Some(main_wv) = app_handle.get_webview("main") {
                let _ = main_wv.eval(&eval_script);
            }
            let payload = DownloadedTabPayload {
                name: final_name,
                path: None,
                data,
            };
            let _ = app_handle.emit("tab-downloaded", payload);
        }
        return false;
    }

    // 5b. Direct client-side download capture scheme: majestictab://download?name=...&data=...
    if url.scheme() == "majestictab" && (url.host_str() == Some("download") || url_str.starts_with("majestictab://download?") || url_str.starts_with("majestictab://download/")) {
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
        let sanitized_b64 = b64_data.replace(' ', "+");
        let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &sanitized_b64).ok();
        let mut final_name = name;
        if let Some(ref bytes) = data {
            if let Some(ext) = identify_tab_extension(bytes, &final_name) {
                if !final_name.to_lowercase().ends_with(&format!(".{}", ext)) {
                    if !final_name.contains('.') || final_name.starts_with("download") {
                        final_name = format!("{}.{}", final_name, ext);
                    }
                }
            }
        }
        eprintln!("[Tab Downloader] Captured client-side download: {} ({} bytes)", final_name, data.as_ref().map(|d| d.len()).unwrap_or(0));
        hide_downloader(app_handle);
        if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            if let Ok(mut g) = state.is_open.lock() {
                *g = false;
            }
        }
        let escaped_name = serde_json::to_string(&final_name).unwrap_or_default();
        let escaped_b64 = serde_json::to_string(&sanitized_b64).unwrap_or_default();
        let eval_script = format!("window.__onTabDownloaded && window.__onTabDownloaded({}, {});", escaped_name, escaped_b64);
        if let Some(main_win) = app_handle.get_webview_window("main") {
            let _ = main_win.eval(&eval_script);
            let _ = main_win.show();
            let _ = main_win.set_focus();
        } else if let Some(main_wv) = app_handle.get_webview("main") {
            let _ = main_wv.eval(&eval_script);
        }
        let payload = DownloadedTabPayload {
            name: final_name,
            path: None,
            data,
        };
        let _ = app_handle.emit("tab-downloaded", payload);
        return false;
    }

    if url.scheme() == "majestictab" {
        return false;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        // The bar URL is emitted from on_page_load, which only reports the top-level frame; this handler also sees iframes (ads)
        if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            if let Some(host) = url.host_str().map(|h| h.to_lowercase()) {
                let mut matched_sid: Option<String> = None;
                let mut matched_script: Option<String> = None;
                if let Ok(mut cfg_guard) = state.current_config.lock() {
                    if let Some(ref mut cfg) = *cfg_guard {
                        for s in &cfg.sources {
                            let matches = if let Ok(u) = tauri::Url::parse(if !s.default_url.is_empty() { &s.default_url } else { &s.url_template }) {
                                u.host_str().map(|h| host.contains(h)).unwrap_or(false)
                            } else {
                                false
                            };
                            if matches {
                                matched_sid = Some(s.id.clone());
                                if s.userscript_enabled {
                                    matched_script = s.userscript.clone().or_else(|| s.default_userscript.clone());
                                }
                                break;
                            }
                        }
                        if let Some(ref msid) = matched_sid {
                            cfg.active_source_id = Some(msid.clone());
                        }
                    }
                }
                if matched_sid.is_some() {
                    if let Ok(mut js_guard) = state.active_userscript.lock() {
                        *js_guard = matched_script;
                    }
                }
            }
        }
        schedule_userscript_injection(app_handle);
    }

    true
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
    let window = app
        .get_window("main")
        .ok_or(tauri::Error::WebviewNotFound)?;

    let app_handle_for_nav = app.handle().clone();
    let app_handle_for_load = app.handle().clone();
    let app_handle_for_download = app.handle().clone();

    let blank_url = tauri::Url::parse("about:blank").map_err(tauri::Error::InvalidUrl)?;

    let mut builder = tauri::webview::WebviewBuilder::new(
        DOWNLOADER_LABEL,
        tauri::WebviewUrl::External(blank_url),
    )
    .user_agent(DESKTOP_USER_AGENT)
    .initialization_script(CORE_DOWNLOADER_SHIM);

    #[cfg(feature = "debug-tools")]
    {
        builder = builder.devtools(true);
    }

    builder = builder.on_navigation(move |url| {
        handle_navigation(&app_handle_for_nav, &url)
    });

    builder = builder.on_page_load(move |_webview, payload| {
        let s = payload.url().as_str();
        if s.starts_with("http://") || s.starts_with("https://") {
            let _ = app_handle_for_load.emit("tab-downloader-url-changed", s.to_string());
        }
        schedule_userscript_injection(&app_handle_for_load);
    });

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
                            if let Some(ext) = identify_tab_extension(bytes, &filename) {
                                if !filename.to_lowercase().ends_with(&format!(".{}", ext)) {
                                    if !filename.contains('.') || filename.starts_with("download") {
                                        filename = format!("{}.{}", filename, ext);
                                    }
                                }
                                if let Some(state) = app_handle_for_download.try_state::<TabDownloaderState>() {
                                    if let Ok(mut g) = state.is_open.lock() {
                                        *g = false;
                                    }
                                }
                                let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
                                let escaped_name = serde_json::to_string(&filename).unwrap_or_default();
                                let escaped_b64 = serde_json::to_string(&b64).unwrap_or_default();
                                let escaped_path = serde_json::to_string(&p.to_string_lossy()).unwrap_or_default();
                                let eval_script = format!("window.__onTabDownloaded && window.__onTabDownloaded({}, {}, {});", escaped_name, escaped_b64, escaped_path);
                                if let Some(main_wv) = app_handle_for_download.get_webview("main") {
                                    let _ = main_wv.eval(&eval_script);
                                } else if let Some(main_win) = app_handle_for_download.get_webview_window("main") {
                                    let _ = main_win.eval(&eval_script);
                                }
                                if let Some(downloader) = app_handle_for_download.get_webview(DOWNLOADER_LABEL) {
                                    let _ = downloader.set_position(tauri::LogicalPosition::new(-10000.0, -10000.0));
                                    let _ = downloader.set_size(tauri::LogicalSize::new(1.0, 1.0));
                                    let _ = downloader.hide();
                                }
                                let payload = DownloadedTabPayload {
                                    name: filename,
                                    path: Some(p.to_string_lossy().to_string()),
                                    data: Some(bytes.clone()),
                                };
                                let _ = app_handle_for_download.emit("tab-downloaded", payload);
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
        tauri::LogicalPosition::new(-10000.0, -10000.0),
        tauri::LogicalSize::new(1.0, 1.0),
    )?;

    #[cfg(target_os = "macos")]
    downloader.with_webview(|platform| unsafe {
        let webview = &*platform.inner().cast::<WKWebView>();
        webview.setWantsLayer(true);
        if let Some(layer) = webview.layer() {
            layer.setCornerRadius(8.0);
            layer.setMasksToBounds(true);
        }
        let ua = NSString::from_str(DESKTOP_USER_AGENT);
        webview.setCustomUserAgent(Some(&ua));
    })?;

    downloader.hide()?;
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn install(_app: &mut App<Wry>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "ios")]
pub fn configure_ios_webview(window: &tauri::WebviewWindow, r: f64, g: f64, b: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_ui_kit::UIColor;

    let _ = window.with_webview(move |platform| unsafe {
        let webview_ptr = platform.inner().cast::<AnyObject>();
        let bg_color = UIColor::colorWithRed_green_blue_alpha(r / 255.0, g / 255.0, b / 255.0, 1.0);

        let _: () = msg_send![webview_ptr, setBackgroundColor: &*bg_color];
        let scroll_view: *mut AnyObject = msg_send![webview_ptr, scrollView];
        if !scroll_view.is_null() {
            let _: () = msg_send![scroll_view, setBackgroundColor: &*bg_color];
            // UIScrollViewContentInsetAdjustmentNever = 2
            let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2isize];
        }

        // UIUserInterfaceStyleDark = 2
        let _: () = msg_send![webview_ptr, setOverrideUserInterfaceStyle: 2isize];
        #[cfg(feature = "debug-tools")]
        {
            let _: () = msg_send![webview_ptr, setInspectable: true];
        }
        #[cfg(not(feature = "debug-tools"))]
        {
            let _: () = msg_send![webview_ptr, setInspectable: true];
        }
        let superview: *mut AnyObject = msg_send![webview_ptr, superview];
        if !superview.is_null() {
            let _: () = msg_send![superview, setBackgroundColor: &*bg_color];
            let _: () = msg_send![superview, setOverrideUserInterfaceStyle: 2isize];
        }
    });
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn tab_downloader_update(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    top_offset: f64,
) -> Result<(), String> {
    if let Ok(mut g) = state.top_offset.lock() {
        *g = top_offset;
    }
    let is_open = state.is_open.lock().map(|g| *g).unwrap_or(false);
    let is_visible = state.is_visible.lock().map(|g| *g).unwrap_or(true);
    if is_open && is_visible {
        if let Some(main_win) = app.get_window("main") {
            let scale = main_win.scale_factor().unwrap_or(1.0);
            if let Ok(size) = main_win.inner_size() {
                let logical = size.to_logical::<f64>(scale);
                if let Some(downloader) = app.get_webview(DOWNLOADER_LABEL) {
                    let _ = downloader.set_position(tauri::LogicalPosition::new(0.0, top_offset));
                    let _ = downloader.set_size(tauri::LogicalSize::new(logical.width, (logical.height - top_offset).max(1.0)));
                }
            }
        }
    }
    Ok(())
}

// Android lays the downloader out natively; the app calls MajesticDownloaderNative.setTopInsetPx instead.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn tab_downloader_update(
    _app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    _top_offset: f64,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn tab_downloader_update(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    top_offset: f64,
) -> Result<(), String> {
    if let Ok(mut g) = state.top_offset.lock() {
        *g = top_offset;
    }
    let is_open = state.is_open.lock().map(|g| *g).unwrap_or(false);
    let is_visible = state.is_visible.lock().map(|g| *g).unwrap_or(true);
    if is_open && is_visible {
        ios_place_downloader(&app, Some(top_offset), true);
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn tab_downloader_set_visible(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    visible: bool,
) -> Result<(), String> {
    if let Ok(mut g) = state.is_visible.lock() {
        *g = visible;
    }
    let is_open = state.is_open.lock().map(|g| *g).unwrap_or(false);
    if !is_open {
        return Ok(());
    }

    if let Some(downloader) = app.get_webview(DOWNLOADER_LABEL) {
        if visible {
            if let Some(main_win) = app.get_window("main") {
                let scale = main_win.scale_factor().unwrap_or(1.0);
                if let Ok(size) = main_win.inner_size() {
                    let logical = size.to_logical::<f64>(scale);
                    let top_offset = state.top_offset.lock().map(|g| *g).unwrap_or(84.0);
                    let _ = downloader.set_position(tauri::LogicalPosition::new(0.0, top_offset));
                    let _ = downloader.set_size(tauri::LogicalSize::new(logical.width, (logical.height - top_offset).max(1.0)));
                }
            }
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
            let _ = downloader.show();
            let _ = downloader.set_focus();
        } else {
            let _ = downloader.set_position(tauri::LogicalPosition::new(-10000.0, -10000.0));
            let _ = downloader.set_size(tauri::LogicalSize::new(1.0, 1.0));
            let _ = downloader.hide();
        }
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_set_visible(
    _app: AppHandle,
    state: State<'_, TabDownloaderState>,
    visible: bool,
) -> Result<(), String> {
    if let Ok(mut g) = state.is_visible.lock() {
        *g = visible;
    }
    // Android toggles its downloader view from the app through MajesticDownloaderNative.setVisible.
    #[cfg(target_os = "ios")]
    if state.is_open.lock().map(|g| *g).unwrap_or(false) {
        ios_place_downloader(&_app, None, visible);
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_navigate(
    app: AppHandle,
    state: State<'_, TabDownloaderState>,
    url: String,
    userscript: Option<String>,
) -> Result<(), String> {
    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    if let Ok(mut g) = state.active_userscript.lock() {
        *g = userscript;
    }
    if let Some(w) = app.get_webview(DOWNLOADER_LABEL) {
        let _ = w.navigate(parsed_url);
    } else if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.navigate(parsed_url);
    }
    schedule_userscript_injection(&app);
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_nav(
    app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    action: String,
) -> Result<(), String> {
    let script = match action.as_str() {
        "back" => "window.history.back()",
        "forward" => "window.history.forward()",
        "reload" => "window.location.reload()",
        _ => "",
    };
    if !script.is_empty() {
        if let Some(w) = app.get_webview(DOWNLOADER_LABEL) {
            let _ = w.eval(script);
        } else if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
            let _ = w.eval(script);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_hide(app: AppHandle, state: State<'_, TabDownloaderState>) -> Result<(), String> {
    let was_open = if let Ok(mut g) = state.is_open.lock() {
        let prev = *g;
        *g = false;
        prev
    } else {
        true
    };

    if let Ok(mut g) = state.is_visible.lock() {
        *g = false;
    }

    if !was_open {
        return Ok(());
    }

    hide_downloader(&app);
    let _ = app.emit("tab-downloader-closed", ());
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_open_devtools(app: AppHandle) -> Result<(), String> {
    #[cfg(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios"))))]
    {
        if let Some(w) = app.get_webview(DOWNLOADER_LABEL) {
            w.open_devtools();
        } else if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
            w.open_devtools();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_download_chunk_vs_direct_download_routing() {
        let chunk_url_str = "majestictab://download-chunk?id=abc123&name=Nil%20By%20Mouth.gp&idx=0&total=3&data=SGVsbG8=";
        let chunk_url = tauri::Url::parse(chunk_url_str).expect("Valid chunk URL");

        // download-chunk condition
        let is_chunk = chunk_url.scheme() == "majestictab"
            && (chunk_url.host_str() == Some("download-chunk")
                || chunk_url_str.starts_with("majestictab://download-chunk?")
                || chunk_url_str.starts_with("majestictab://download-chunk/"));
        assert!(is_chunk, "Should match download-chunk condition");

        // direct download condition MUST NOT match chunk URL
        let is_direct = chunk_url.scheme() == "majestictab"
            && (chunk_url.host_str() == Some("download")
                || chunk_url_str.starts_with("majestictab://download?")
                || chunk_url_str.starts_with("majestictab://download/"));
        assert!(!is_direct, "Chunk URL must NOT match direct download condition");

        let direct_url_str = "majestictab://download?name=Nil%20By%20Mouth.gp&data=SGVsbG8=";
        let direct_url = tauri::Url::parse(direct_url_str).expect("Valid direct URL");

        let direct_is_direct = direct_url.scheme() == "majestictab"
            && (direct_url.host_str() == Some("download")
                || direct_url_str.starts_with("majestictab://download?")
                || direct_url_str.starts_with("majestictab://download/"));
        assert!(direct_is_direct, "Direct URL must match direct download condition");

        let direct_is_chunk = direct_url.scheme() == "majestictab"
            && (direct_url.host_str() == Some("download-chunk")
                || direct_url_str.starts_with("majestictab://download-chunk?")
                || direct_url_str.starts_with("majestictab://download-chunk/"));
        assert!(!direct_is_chunk, "Direct URL must NOT match chunk condition");
    }

    #[test]
    fn test_chunk_reassembly_and_decode() {
        // Construct a sample binary score header and test multi-chunk reassembly
        let sample_bytes = b"FICHIER GUITAR PRO v5.10\0\0\0\0\0\0\0\0\0\0Some test score content";
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, sample_bytes);

        // Split into 3 chunks
        let chunk_size = 10;
        let chunks: Vec<String> = b64.as_bytes().chunks(chunk_size).map(|c| std::str::from_utf8(c).unwrap().to_string()).collect();
        let total = chunks.len();

        let mut entry = DownloadChunkState {
            name: "Haken - Nil By Mouth.gp".to_string(),
            chunks: vec![None; total],
        };

        for (idx, ch) in chunks.into_iter().enumerate() {
            entry.chunks[idx] = Some(ch);
        }

        assert!(entry.chunks.iter().all(|c| c.is_some()), "All chunks must be present");
        let full_b64: String = entry.chunks.iter().filter_map(|c| c.as_ref()).cloned().collect();
        assert_eq!(full_b64, b64);

        let sanitized_b64 = full_b64.replace(' ', "+");
        let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &sanitized_b64).expect("Valid base64");
        assert_eq!(decoded.as_slice(), sample_bytes);

        // Extension check
        let ext = identify_tab_extension(&decoded, &entry.name);
        assert_eq!(ext, Some("gp5"));
    }
}


