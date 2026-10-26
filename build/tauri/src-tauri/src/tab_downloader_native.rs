use std::sync::Mutex;
use tauri::{App, AppHandle, Emitter, Manager, State, Wry};

#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[cfg(target_os = "macos")]
pub fn drag_window_macos(main_win: &tauri::Window) {
    use objc2_app_kit::{NSApplication, NSEvent, NSEventType};
    use objc2_foundation::{MainThreadMarker, NSPoint};

    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let current_event = app.currentEvent();
        if let Ok(ns_win_ptr) = main_win.ns_window() {
            unsafe {
                let raw_win = &*(ns_win_ptr as *const objc2_app_kit::NSWindow);
                let screen_loc: NSPoint = NSEvent::mouseLocation();
                let win_loc: NSPoint = raw_win.convertPointFromScreen(screen_loc);
                let mod_flags = current_event
                    .as_ref()
                    .map(|e| e.modifierFlags())
                    .unwrap_or(objc2_app_kit::NSEventModifierFlags(0));
                let timestamp = current_event.as_ref().map(|e| e.timestamp()).unwrap_or(0.0);
                let win_num = raw_win.windowNumber();

                let event_to_use = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                    NSEventType::LeftMouseDown,
                    win_loc,
                    mod_flags,
                    timestamp,
                    win_num,
                    None,
                    0,
                    1,
                    1.0,
                );

                if let Some(ev) = event_to_use {
                    raw_win.performWindowDragWithEvent(&ev);
                }
            }
        }
    }
}

use crate::DownloadedTabPayload;

#[allow(dead_code)]
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
    pub show_toolbar: bool,
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
            show_toolbar: false,
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

    function ensureDarkStatusBarMeta() {
        try {
            let tc = document.querySelector('meta[name="theme-color"]');
            if (!tc) {
                tc = document.createElement('meta');
                tc.name = 'theme-color';
                (document.head || document.documentElement).appendChild(tc);
            }
            tc.content = '#0d0f15';

            let sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
            if (!sb) {
                sb = document.createElement('meta');
                sb.name = 'apple-mobile-web-app-status-bar-style';
                (document.head || document.documentElement).appendChild(sb);
            }
            sb.content = 'black-translucent';
        } catch(e) {}
    }
    ensureDarkStatusBarMeta();

    // 9. Modeled In-App Shadow DOM Toolbar & Source Configuration Panel
    window.__initMajesticToolbar = function(config) {
        ensureDarkStatusBarMeta();
        if (!config || !config.showToolbar) return;

        let host = document.getElementById('majestic-downloader-host');
        let shadow = null;

        if (!host) {
            host = document.createElement('div');
            host.id = 'majestic-downloader-host';
            host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 100%; z-index: 2147483647; pointer-events: auto; touch-action: none;';
            shadow = host.attachShadow({ mode: 'open' });
            const mount = document.body || document.documentElement;
            if (mount) {
                mount.appendChild(host);
            }
        } else {
            shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
        }

        if (!shadow) return;

        if (host && !host.isConnected) {
            const mount = document.body || document.documentElement;
            if (mount) mount.appendChild(host);
        }

        let sources = config.sources || [];
        let localSources = JSON.parse(JSON.stringify(sources));
        const activeSourceId = config.activeSourceId || (sources[0] ? sources[0].id : 'ug');
        const artist = (config.artist || '').trim();
        const song = (config.song || '').trim();
        const query = (config.query || '').trim();
        const songText = (artist && song) ? (artist + ' — ' + song) : (song || query || artist || '');
        const isDebugTools = Boolean(config.isDebugToolsEnabled);
        let editingSourceId = activeSourceId;

        function buildSearchUrl(source, art, sng, qry) {
            if (!source) return 'https://www.ultimate-guitar.com/';
            let term = '';
            if (source.queryFormat === 'song_only') {
                term = sng || qry || art || '';
            } else {
                term = (art && sng) ? (art + ' ' + sng) : (qry || sng || art || '');
            }
            term = term.trim();
            let template = (source.urlTemplate || '').trim();
            if (template && !/^https?:\/\//i.test(template)) {
                template = 'https://' + template;
            }
            const hasPlaceholder = template.includes('SEARCH+TERM') || template.includes('{search}');

            if (template && !hasPlaceholder) {
                return template;
            }

            if (!term) {
                if (source.id === 'ug') return 'https://www.ultimate-guitar.com/';
                if (source.id === 'metaltabs') return 'https://metaltabs.org/';
                if (source.id === 'gprotab') return 'https://gprotab.net/';
                if (source.id === 'songsterr') return 'https://www.songsterr-downloader.com/';
                if (source.id === 'classtab') return 'https://www.classtab.org/';
                if (source.defaultUrl) return source.defaultUrl.replace(/SEARCH\+TERM/g, '').replace(/\{search\}/g, '').replace(/[?&]$/, '');
                if (template) {
                    try {
                        const u = new URL(template);
                        return u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : '/');
                    } catch {
                        return template.replace(/SEARCH\+TERM/g, '').replace(/\{search\}/g, '').replace(/[?&]$/, '');
                    }
                }
                return 'https://www.ultimate-guitar.com/';
            }
            const encodedPlus = encodeURIComponent(term).replace(/%20/g, '+');
            const encodedStandard = encodeURIComponent(term);
            let url = template;
            if (url.includes('SEARCH+TERM')) {
                url = url.replace(/SEARCH\+TERM/g, encodedPlus);
            } else if (url.includes('{search}')) {
                url = url.replace(/\{search\}/g, encodedStandard);
            }
            return url;
        }

        function escapeHtml(str) {
            return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function detectActiveSourceId() {
            const h = (window.location.hostname || '').toLowerCase();
            if (h.includes('ultimate-guitar.com')) return 'ug';
            if (h.includes('metaltabs.org')) return 'metaltabs';
            if (h.includes('gprotab.net')) return 'gprotab';
            if (h.includes('songsterr-downloader.com')) return 'songsterr';
            if (h.includes('classtab.org')) return 'classtab';
            for (let i = 0; i < sources.length; i++) {
                const s = sources[i];
                try {
                    const u = new URL(s.defaultUrl || s.urlTemplate);
                    if (u.hostname && h.includes(u.hostname)) return s.id;
                } catch(e) {}
            }
            return activeSourceId;
        }

        function persistSources(updatedSources) {
            const payload = {
                sources: updatedSources
            };
            const jsonStr = JSON.stringify(payload);
            try {
                if (window.MajesticDownloaderNative && typeof window.MajesticDownloaderNative.saveSources === 'function') {
                    window.MajesticDownloaderNative.saveSources(jsonStr);
                }
            } catch(e) {}
            window.location.href = 'majestictab://save-sources?payload=' + encodeURIComponent(jsonStr);
        }

        const detectedPlatform = config.platform || (/iphone|ipad|ipod/i.test(navigator.userAgent || '') ? 'ios' : (/android/i.test(navigator.userAgent || '') ? 'android' : (/mac/i.test(navigator.platform || navigator.userAgent) ? 'macos' : (/win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : 'other'))));
        const isNew = !shadow.getElementById('toolbar-root');

        if (isNew) {
            shadow.innerHTML = `
                <style>
                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        -webkit-user-select: none;
                        user-select: none;
                        -webkit-user-drag: none;
                        user-drag: none;
                    }
                    :host {
                        all: initial;
                        display: block;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        z-index: 2147483647;
                        -webkit-user-select: none;
                        user-select: none;
                        touch-action: none;
                    }
                    .toolbar-root {
                        width: 100%;
                        background: #0d0f15;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
                        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
                        color: #f1f5f9;
                        -webkit-user-select: none;
                        user-select: none;
                        display: flex;
                        flex-direction: column;
                        transform-origin: top left;
                        cursor: default;
                        -webkit-app-region: drag;
                        app-region: drag;
                        touch-action: none;
                    }
                    .nav-row {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        padding: max(env(safe-area-inset-top), 8px) max(env(safe-area-inset-right), 12px) 8px max(env(safe-area-inset-left), 12px);
                        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                        -webkit-app-region: drag;
                        app-region: drag;
                        cursor: default;
                        touch-action: none;
                    }
                    .toolbar-root.platform-ios .nav-row {
                        padding-top: max(env(safe-area-inset-top), 54px);
                    }
                    .toolbar-root.platform-macos .nav-row {
                        padding-left: 88px;
                    }
                    .toolbar-root.platform-windows .nav-row {
                        padding-right: 152px;
                    }
                    .toolbar-root.is-mobile-screen .nav-row {
                        gap: 6px;
                        padding: max(env(safe-area-inset-top), 8px) max(env(safe-area-inset-right), 8px) 6px max(env(safe-area-inset-left), 8px);
                    }
                    .toolbar-root.platform-ios.is-mobile-screen .nav-row {
                        padding-top: max(env(safe-area-inset-top), 54px);
                    }
                    .toolbar-root.is-mobile-screen .nav-left {
                        flex: 1 1 auto;
                        min-width: 0;
                        gap: 6px;
                    }
                    .toolbar-root.is-mobile-screen .nav-center {
                        display: none;
                    }
                    .toolbar-root.is-mobile-screen .nav-center.show-fallback {
                        display: flex;
                        flex: 1 1 0;
                        min-width: 0;
                        padding: 0 4px;
                    }
                    /* The URL takes the remaining width; the nav buttons keep their own size instead of being squeezed under it */
                    .toolbar-root.is-mobile-screen.url-fallback .nav-left {
                        flex: 0 0 auto;
                    }
                    .toolbar-root.is-mobile-screen .nav-right {
                        gap: 6px;
                    }
                    .toolbar-root.is-mobile-screen .url-group {
                        max-width: none;
                        min-width: 0;
                        height: 30px;
                        padding: 0 8px;
                    }
                    .toolbar-root.is-mobile-screen .song-pill {
                        max-width: none;
                        flex: 1 1 auto;
                        min-width: 0;
                        height: 30px;
                        font-size: 11.5px;
                        padding: 0 8px;
                        justify-content: center;
                    }
                    .toolbar-root.is-mobile-screen .tool-btn {
                        height: 30px;
                        padding: 4px 7px;
                    }
                    .toolbar-root.is-mobile-screen .icon-btn {
                        width: 30px;
                        height: 30px;
                    }
                    .toolbar-root.is-mobile-screen .back-btn span {
                        display: none;
                    }
                    .toolbar-root.is-mobile-screen .back-btn {
                        padding: 0;
                        width: 30px;
                        height: 30px;
                        justify-content: center;
                    }
                    .toolbar-root.is-mobile-screen .tabs-row {
                        padding: 4px max(env(safe-area-inset-right), 8px) 5px max(env(safe-area-inset-left), 8px);
                        gap: 5px;
                    }
                    .toolbar-root.is-mobile-screen .tab-btn {
                        height: 26px;
                        padding: 3px 8px;
                        font-size: 11px;
                        gap: 4px;
                    }
                    .nav-left {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        flex-shrink: 0;
                        -webkit-app-region: drag;
                        app-region: drag;
                    }
                    .nav-center {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        flex: 1 1 auto;
                        min-width: 0;
                        padding: 0 16px;
                        -webkit-app-region: drag;
                        app-region: drag;
                        cursor: default;
                    }
                    .nav-right {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        flex-shrink: 0;
                        margin-left: auto;
                        -webkit-app-region: drag;
                        app-region: drag;
                    }
                    button, input, select, textarea, .btn-group, .tab-btn, .pill-btn, .back-btn, #settings-overlay {
                        -webkit-app-region: no-drag;
                        app-region: no-drag;
                    }
                    .btn-group {
                        display: flex;
                        align-items: center;
                        border-radius: 6px;
                        overflow: hidden;
                        border: 1px solid rgba(255, 255, 255, 0.15);
                        background: rgba(255, 255, 255, 0.04);
                        flex-shrink: 0;
                    }
                    .tool-btn {
                        background: transparent;
                        border: none;
                        border-right: 1px solid rgba(255, 255, 255, 0.15);
                        color: #e2e8f0;
                        padding: 6px 10px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        height: 32px;
                        transition: background 0.15s ease, color 0.15s ease;
                    }
                    .tool-btn:last-child {
                        border-right: none;
                    }
                    .tool-btn:hover {
                        background: rgba(255, 255, 255, 0.12);
                        color: #ffffff;
                    }
                    .tool-btn:active {
                        background: rgba(255, 255, 255, 0.2);
                    }
                    .song-pill {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        background: rgba(255, 255, 255, 0.06);
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        color: #f8fafc;
                        padding: 0 10px;
                        border-radius: 6px;
                        height: 32px;
                        font-size: 12px;
                        font-weight: 500;
                        max-width: 220px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        flex-shrink: 0;
                        cursor: default;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .song-pill svg {
                        color: #38bdf8;
                    }
                    .url-group {
                        display: flex;
                        align-items: center;
                        width: 100%;
                        max-width: 360px;
                        min-width: 140px;
                        background: rgba(255, 255, 255, 0.04);
                        border: 1px solid rgba(255, 255, 255, 0.09);
                        border-radius: 8px;
                        padding: 0 12px;
                        height: 32px;
                        gap: 8px;
                        cursor: default;
                        user-select: none;
                        -webkit-user-select: none;
                        transition: all 0.15s ease;
                    }
                    .url-group svg {
                        color: #64748b;
                        opacity: 0.85;
                        flex-shrink: 0;
                    }
                    .url-text {
                        flex-grow: 1;
                        min-width: 0;
                        color: #94a3b8;
                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                        font-size: 11.5px;
                        letter-spacing: -0.2px;
                        text-align: center;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        overflow: hidden;
                        cursor: default;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .icon-btn {
                        background: rgba(255, 255, 255, 0.06);
                        border: 1px solid rgba(255, 255, 255, 0.15);
                        color: #f1f5f9;
                        width: 32px;
                        height: 32px;
                        border-radius: 6px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        flex-shrink: 0;
                        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .icon-btn:hover {
                        background: rgba(255, 255, 255, 0.15);
                        color: #ffffff;
                    }
                    .back-btn {
                        background: rgba(255, 255, 255, 0.08);
                        border: 1px solid rgba(255, 255, 255, 0.18);
                        color: #f1f5f9;
                        height: 32px;
                        padding: 0 12px;
                        border-radius: 6px;
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 500;
                        flex-shrink: 0;
                        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .back-btn:hover {
                        background: rgba(255, 255, 255, 0.16);
                        border-color: rgba(255, 255, 255, 0.32);
                        color: #ffffff;
                    }
                    .back-btn:active {
                        background: rgba(255, 255, 255, 0.22);
                    }
                    .back-btn svg {
                        width: 14px;
                        height: 14px;
                        flex-shrink: 0;
                    }
                    .tabs-row {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 6px max(env(safe-area-inset-right), 12px) 6px max(env(safe-area-inset-left), 12px);
                        overflow-x: auto;
                        overflow-y: hidden;
                        white-space: nowrap;
                        scrollbar-width: none;
                        cursor: default;
                        -webkit-app-region: drag;
                        app-region: drag;
                        touch-action: pan-x;
                    }
                    .tabs-row::-webkit-scrollbar {
                        display: none;
                    }
                    .tab-btn {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        padding: 5px 12px;
                        border-radius: 6px;
                        font-size: 13px;
                        font-weight: 500;
                        background: rgba(255, 255, 255, 0.05);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        color: #94a3b8;
                        cursor: pointer;
                        transition: all 0.15s ease;
                        flex-shrink: 0;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .tab-btn:hover {
                        background: rgba(255, 255, 255, 0.1);
                        color: #ffffff;
                        border-color: rgba(255, 255, 255, 0.2);
                    }
                    .tab-btn.active {
                        background: rgba(56, 189, 248, 0.15);
                        color: #ffffff;
                        border-color: #38bdf8;
                        box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
                    }
                    .tab-btn-add {
                        border-style: dashed;
                        color: #38bdf8;
                    }
                    .pill-btn {
                        display: inline-flex;
                        align-items: center;
                        padding: 5px 12px;
                        border-radius: 6px;
                        font-size: 12px;
                        font-weight: 500;
                        background: rgba(255, 255, 255, 0.05);
                        border: 1px solid rgba(255, 255, 255, 0.12);
                        color: #cbd5e1;
                        cursor: pointer;
                        transition: all 0.15s ease;
                        user-select: none;
                        -webkit-user-select: none;
                    }
                    .pill-btn:hover {
                        background: rgba(255, 255, 255, 0.1);
                        color: #ffffff;
                    }
                    .pill-btn.active {
                        background: rgba(56, 189, 248, 0.2);
                        border-color: #38bdf8;
                        color: #ffffff;
                        font-weight: 600;
                    }
                    #settings-overlay input,
                    #settings-overlay textarea {
                        -webkit-user-select: text;
                        user-select: text;
                        cursor: text;
                    }
                    svg {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                        flex-shrink: 0;
                    }
                </style>
                <div class="toolbar-root platform-${detectedPlatform}" id="toolbar-root" data-tauri-drag-region>
                    <div class="nav-row" data-tauri-drag-region>
                        <div class="nav-left" data-tauri-drag-region>
                            <div class="btn-group">
                                <button type="button" class="tool-btn" id="btn-back" title="Go Back">
                                    <svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/></svg>
                                </button>
                                <button type="button" class="tool-btn" id="btn-forward" title="Go Forward">
                                    <svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
                                </button>
                                <button type="button" class="tool-btn" id="btn-reload" title="Reload Page">
                                    <svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
                                </button>
                            </div>

                            <div id="song-pill" class="song-pill" style="display: ${songText ? 'flex' : 'none'};" title="${escapeHtml(songText)}" data-tauri-drag-region>
                                <svg viewBox="0 0 16 16"><path d="M9 13c0 1.105-1.12 2-2.5 2S4 14.105 4 13s1.12-2 2.5-2 2.5.895 2.5 2z"/><path fill-rule="evenodd" d="M9 3v10H8V3h1z"/><path d="M8 2.82a1 1 0 0 1 .804-.98l3-.6A1 1 0 0 1 13 2.22V4L8 5V2.82z"/></svg>
                                <span id="song-text">${escapeHtml(songText)}</span>
                            </div>
                        </div>

                        <div class="nav-center" data-tauri-drag-region>
                            <div class="url-group" id="url-group" title="${escapeHtml(window.location.href)}" data-tauri-drag-region>
                                <svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.87.21-1.688.508-2.428l-.008-.072H1.36a7.03 7.03 0 0 0 0 5h2.648a10.6 10.6 0 0 1-.508-2.428l.008-.072zm.76 3.5c.29 1.05.7 1.93 1.218 2.54.516.61 1.08.96 1.514 1.037V11H4.268zm4.232 0v3.577c.434-.077.998-.427 1.514-1.037.518-.61.928-1.49 1.218-2.54H8.5zm3.41-3.5a10.6 10.6 0 0 1-.508 2.428l.008.072h2.648a7.03 7.03 0 0 0 0-5h-2.648a10.6 10.6 0 0 1 .508 2.428l-.008.072zm-.178-4.5H9.5V1.077c.67.204 1.335.82 1.887 1.855.22.41.4.85.545 1.068zm.908-1.539A9.267 9.267 0 0 0 11.91 4h1.835a7.025 7.025 0 0 0-3.072-2.467c.18.27.38.58.58.928zM8.5 4h2.355a7.97 7.97 0 0 0-.468-1.068C9.835 1.897 9.17 1.28 8.5 1.077V4zM8.5 5v5h3.04a9.63 9.63 0 0 0 .428-2.5c0-.88-.15-1.72-.428-2.5H8.5zM7.5 5H4.46a9.63 9.63 0 0 0-.428 2.5c0 .88.15 1.72.428 2.5H7.5V5z"/></svg>
                                <span class="url-text" id="url-text">${escapeHtml(window.location.href)}</span>
                            </div>
                        </div>

                        <div class="nav-right" data-tauri-drag-region>
                            ${isDebugTools ? `
                            <button type="button" class="icon-btn" id="btn-debug" title="Toggle Webview Debug Console">
                                <svg viewBox="0 0 16 16"><path d="M6 12.5a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-8a.5.5 0 0 0-.5.5v9zM1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9zm2.146 4.854a.5.5 0 0 1 0-.708l2-2a.5.5 0 1 1 .708.708L4.207 8l1.647 1.646a.5.5 0 0 1-.708.708l-2-2zM8.5 9.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1H9a.5.5 0 0 1-.5-.5z"/></svg>
                            </button>
                            ` : ''}

                            <button type="button" class="icon-btn" id="btn-settings" title="Configure Tab Sources">
                                <svg viewBox="0 0 16 16"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319z"/></svg>
                            </button>

                            <button type="button" class="back-btn" id="btn-close" title="Back to MajesticTab (Esc)">
                                <svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z"/></svg>
                                <span>Back to App</span>
                            </button>
                        </div>
                    </div>

                    <!-- Live Debug Drawer (if enabled) -->
                    <div id="debug-drawer" style="display: none; background: #0b0f19; color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; border-bottom: 1px solid rgba(255,255,255,0.12); max-height: 140px; overflow-y: auto; padding: 6px 12px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.08);">
                            <span style="color: #38bdf8; font-weight: 600;">Webview Debug Console</span>
                            <div style="display: flex; gap: 6px;">
                                <button type="button" id="btn-clear-logs" style="background: none; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #94a3b8; font-size: 11px; padding: 2px 6px; cursor: pointer;">Clear Logs</button>
                                <button type="button" id="btn-devtools" style="background: none; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #cbd5e1; font-size: 11px; padding: 2px 6px; cursor: pointer;">DevTools</button>
                            </div>
                        </div>
                        <div id="debug-logs-content" style="display: flex; flex-direction: column; gap: 2px;"></div>
                    </div>

                    <!-- Tabs row -->
                    <div class="tabs-row" id="tabs-row"></div>
                </div>

                <!-- Modal Overlay for Configure Tab Sources -->
                <div id="settings-overlay" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); align-items: center; justify-content: center; z-index: 2147483647; padding: 16px; backdrop-filter: blur(4px); box-sizing: border-box;">
                    <div style="background: #141721; border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; width: 100%; max-width: 580px; max-height: 90vh; overflow-y: auto; box-shadow: 0 16px 40px rgba(0,0,0,0.8); color: #f1f5f9; display: flex; flex-direction: column;">
                        
                        <!-- Header -->
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="width: 32px; height: 32px; border-radius: 8px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; display: flex; align-items: center; justify-content: center;">
                                    <svg viewBox="0 0 16 16"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319z"/></svg>
                                </div>
                                <div>
                                    <div style="font-weight: 600; font-size: 15px;">Configure Tab Sources</div>
                                    <div style="font-size: 12px; color: #94a3b8;">Manage search providers and custom userscripts</div>
                                </div>
                            </div>
                            <button type="button" class="icon-btn" id="cfg-close-btn" style="width: 28px; height: 28px;">
                                <svg viewBox="0 0 16 16"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
                            </button>
                        </div>

                        <!-- Body -->
                        <div style="padding: 16px; display: flex; flex-direction: column; gap: 14px;">
                            <div>
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                                    <label style="font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">Select Source</label>
                                    <button type="button" id="cfg-btn-new-source" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #38bdf8; font-size: 12px; padding: 4px 10px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                                        <svg viewBox="0 0 16 16" style="width: 12px; height: 12px;"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
                                        <span>New Source</span>
                                    </button>
                                </div>
                                <div id="cfg-source-pills" style="display: flex; flex-wrap: wrap; gap: 6px;"></div>
                            </div>

                            <div style="display: flex; flex-direction: column; gap: 12px;">
                                <div>
                                    <label style="display: block; font-size: 12px; font-weight: 500; color: #cbd5e1; margin-bottom: 4px;">Source Name</label>
                                    <input type="text" id="cfg-source-name" style="width: 100%; box-sizing: border-box; background: #0b0f19; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #ffffff; font-size: 13px; outline: none;">
                                </div>

                                <div>
                                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                                        <label style="font-size: 12px; font-weight: 500; color: #cbd5e1;">Search URL Template</label>
                                        <button type="button" id="cfg-reset-url-btn" style="background: none; border: none; color: #38bdf8; font-size: 11px; cursor: pointer; padding: 0;">Reset URL</button>
                                    </div>
                                    <input type="text" id="cfg-source-url" style="width: 100%; box-sizing: border-box; background: #0b0f19; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #cbd5e1; font-family: ui-monospace, monospace; font-size: 12px; outline: none;">
                                    <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Use <code style="color: #38bdf8;">SEARCH+TERM</code> where search keywords should be inserted.</div>
                                </div>

                                <div>
                                    <label style="display: block; font-size: 12px; font-weight: 500; color: #cbd5e1; margin-bottom: 4px;">Search Query Format</label>
                                    <select id="cfg-query-format" style="width: 100%; box-sizing: border-box; background: #0b0f19; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #ffffff; font-size: 13px; outline: none;">
                                        <option value="artist_song">Artist + Song Name (e.g. Metallica Master of Puppets)</option>
                                        <option value="song_only">Song Name Only (e.g. Master of Puppets)</option>
                                    </select>
                                    <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Controls whether search queries sent to this provider include artist name or only song title.</div>
                                </div>

                                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px;">
                                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                                        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: #cbd5e1; cursor: pointer;">
                                            <input type="checkbox" id="cfg-userscript-enabled" style="accent-color: #38bdf8; cursor: pointer;">
                                            <span>Inject Userscript (In-App Webview)</span>
                                        </label>
                                        <button type="button" id="cfg-reset-script-btn" style="background: none; border: none; color: #38bdf8; font-size: 11px; cursor: pointer; padding: 0;">Reset Script</button>
                                    </div>
                                    <textarea id="cfg-userscript-code" rows="5" style="width: 100%; box-sizing: border-box; background: #0b0f19; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 7px 10px; color: #cbd5e1; font-family: ui-monospace, monospace; font-size: 12px; outline: none; resize: vertical;" placeholder="// Custom JavaScript injected into webview"></textarea>
                                </div>

                            </div>

                            <!-- Footer -->
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.08);">
                                <button type="button" id="cfg-delete-btn" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5; border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                                    <svg viewBox="0 0 16 16" style="width: 13px; height: 13px; fill: currentColor;"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
                                    <span>Delete</span>
                                </button>
                                <div style="display: flex; gap: 8px; margin-left: auto;">
                                    <button type="button" id="cfg-cancel-btn" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; border-radius: 6px; padding: 7px 16px; font-size: 13px; cursor: pointer;">Cancel</button>
                                    <button type="button" id="cfg-save-btn" style="background: linear-gradient(135deg, #0284c7, #0369a1); border: 1px solid #38bdf8; color: #ffffff; border-radius: 6px; padding: 7px 18px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 0 12px rgba(56, 189, 248, 0.35);">Save Changes</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            shadow.getElementById('btn-back')?.addEventListener('click', () => window.history.back());
            shadow.getElementById('btn-forward')?.addEventListener('click', () => window.history.forward());
            shadow.getElementById('btn-reload')?.addEventListener('click', () => window.location.reload());
            shadow.getElementById('btn-close')?.addEventListener('click', () => {
                try {
                    if (window.MajesticDownloaderNative && typeof window.MajesticDownloaderNative.close === 'function') {
                        window.MajesticDownloaderNative.close();
                    }
                } catch(e) {}
                window.location.href = 'majestictab://close';
            });

            shadow.getElementById('btn-settings')?.addEventListener('click', () => {
                localSources = JSON.parse(JSON.stringify(sources));
                editingSourceId = detectActiveSourceId();
                renderSettingsPills();
                renderSettingsForm(editingSourceId);
                const overlay = shadow.getElementById('settings-overlay');
                if (overlay) overlay.style.display = 'flex';
            });

            shadow.getElementById('btn-debug')?.addEventListener('click', () => {
                const drawer = shadow.getElementById('debug-drawer');
                if (drawer) {
                    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
                    updateToolbarDisplay();
                }
            });

            shadow.getElementById('btn-clear-logs')?.addEventListener('click', () => {
                const content = shadow.getElementById('debug-logs-content');
                if (content) content.innerHTML = '';
            });

            shadow.getElementById('btn-devtools')?.addEventListener('click', () => {
                window.location.href = 'majestictab://devtools';
            });

            const toolbarRootEl = shadow.getElementById('toolbar-root');
            if (toolbarRootEl) {
                toolbarRootEl.addEventListener('selectstart', (e) => {
                    if (!e.target.closest('#settings-overlay')) {
                        e.preventDefault();
                    }
                });

                toolbarRootEl.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    const interactive = e.target.closest('button, input, select, textarea, a, .tab-btn, .tool-btn, .icon-btn, .back-btn, #settings-overlay');
                    if (interactive) return;

                    e.preventDefault();
                    if (e.detail === 2) {
                        window.location.href = 'majestictab://toggle-maximize';
                        return;
                    }
                    window.location.href = 'majestictab://drag';
                });
            }

            // Settings modal interactions
            shadow.getElementById('cfg-close-btn')?.addEventListener('click', () => {
                const overlay = shadow.getElementById('settings-overlay');
                if (overlay) overlay.style.display = 'none';
            });
            shadow.getElementById('cfg-cancel-btn')?.addEventListener('click', () => {
                const overlay = shadow.getElementById('settings-overlay');
                if (overlay) overlay.style.display = 'none';
            });

            shadow.getElementById('cfg-btn-new-source')?.addEventListener('click', () => {
                saveCurrentFormValues();
                const newId = 'source_' + Date.now();
                const newSrc = {
                    id: newId,
                    name: 'Custom Source',
                    urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
                    defaultUrl: '',
                    queryFormat: 'artist_song',
                    userscriptEnabled: false,
                    userscript: '',
                    defaultUserscript: '',
                    isSeed: false
                };
                localSources.push(newSrc);
                editingSourceId = newId;
                renderSettingsPills();
                renderSettingsForm(newId);
            });

            shadow.getElementById('cfg-delete-btn')?.addEventListener('click', () => {
                const src = localSources.find(s => s.id === editingSourceId);
                if (!src || src.isSeed) return;
                localSources = localSources.filter(s => s.id !== editingSourceId);
                editingSourceId = localSources[0]?.id || null;
                renderSettingsPills();
                if (editingSourceId) renderSettingsForm(editingSourceId);
            });

            shadow.getElementById('cfg-reset-url-btn')?.addEventListener('click', () => {
                const src = localSources.find(s => s.id === editingSourceId);
                if (src && src.defaultUrl) {
                    const inp = shadow.getElementById('cfg-source-url');
                    if (inp) inp.value = src.defaultUrl;
                }
            });

            shadow.getElementById('cfg-reset-script-btn')?.addEventListener('click', () => {
                const src = localSources.find(s => s.id === editingSourceId);
                if (src && src.defaultUserscript) {
                    const txt = shadow.getElementById('cfg-userscript-code');
                    const chk = shadow.getElementById('cfg-userscript-enabled');
                    if (txt) txt.value = src.defaultUserscript;
                    if (chk) chk.checked = true;
                }
            });

            shadow.getElementById('cfg-save-btn')?.addEventListener('click', () => {
                saveCurrentFormValues();
                sources = JSON.parse(JSON.stringify(localSources));
                config.sources = sources;
                persistSources(sources);
                renderSourceTabs();
                const overlay = shadow.getElementById('settings-overlay');
                if (overlay) overlay.style.display = 'none';
            });
        }

        function renderSourceTabs() {
            const tabsRow = shadow.getElementById('tabs-row');
            if (!tabsRow) return;
            const currentActiveId = detectActiveSourceId();
            let html = sources.map(s => `
                <button type="button" class="tab-btn ${s.id === currentActiveId ? 'active' : ''}" data-source-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
                    <svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.87.21-1.688.508-2.428l-.008-.072H1.36a7.03 7.03 0 0 0 0 5h2.648a10.6 10.6 0 0 1-.508-2.428l.008-.072zm.76 3.5c.29 1.05.7 1.93 1.218 2.54.516.61 1.08.96 1.514 1.037V11H4.268zm4.232 0v3.577c.434-.077.998-.427 1.514-1.037.518-.61.928-1.49 1.218-2.54H8.5zm3.41-3.5a10.6 10.6 0 0 1-.508 2.428l.008.072h2.648a7.03 7.03 0 0 0 0-5h-2.648a10.6 10.6 0 0 1 .508 2.428l-.008.072zm-.178-4.5H9.5V1.077c.67.204 1.335.82 1.887 1.855.22.41.4.85.545 1.068zm.908-1.539A9.267 9.267 0 0 0 11.91 4h1.835a7.025 7.025 0 0 0-3.072-2.467c.18.27.38.58.58.928zM8.5 4h2.355a7.97 7.97 0 0 0-.468-1.068C9.835 1.897 9.17 1.28 8.5 1.077V4zM8.5 5v5h3.04a9.63 9.63 0 0 0 .428-2.5c0-.88-.15-1.72-.428-2.5H8.5zM7.5 5H4.46a9.63 9.63 0 0 0-.428 2.5c0 .88.15 1.72.428 2.5H7.5V5z"/></svg>
                    <span>${escapeHtml(s.name)}</span>
                </button>
            `).join('');

            html += `
                <button type="button" class="tab-btn tab-btn-add" id="btn-add-source" title="Add New Tab Source">
                    <svg viewBox="0 0 16 16"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
                    <span>Add Source</span>
                </button>
            `;
            tabsRow.innerHTML = html;

            tabsRow.querySelectorAll('.tab-btn:not(.tab-btn-add)').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sid = btn.dataset.sourceId;
                    const src = sources.find(s => s.id === sid);
                    if (src) {
                        tabsRow.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
                        const urlText = shadow.getElementById('url-text');
                        const urlGroup = shadow.getElementById('url-group');
                        if (urlText) {
                            urlText.textContent = 'Loading ' + src.name + '...';
                        }
                        if (urlGroup) {
                            urlGroup.title = 'Loading ' + src.name + '...';
                        }
                        config.activeSourceId = sid;
                        const nextUrl = buildSearchUrl(src, artist, song, query);
                        window.location.href = 'majestictab://switch-source?sourceId=' + encodeURIComponent(src.id) + '&url=' + encodeURIComponent(nextUrl);
                    }
                });
            });

            tabsRow.querySelector('#btn-add-source')?.addEventListener('click', () => {
                saveCurrentFormValues();
                const newId = 'source_' + Date.now();
                const newSrc = {
                    id: newId,
                    name: 'Custom Source',
                    urlTemplate: 'https://www.ultimate-guitar.com/search.php?title=SEARCH+TERM',
                    defaultUrl: '',
                    queryFormat: 'artist_song',
                    userscriptEnabled: false,
                    userscript: '',
                    defaultUserscript: '',
                    isSeed: false
                };
                localSources.push(newSrc);
                editingSourceId = newId;
                renderSettingsPills();
                renderSettingsForm(newId);
                const overlay = shadow.getElementById('settings-overlay');
                if (overlay) overlay.style.display = 'flex';
            });
        }

        function renderSettingsPills() {
            const container = shadow.getElementById('cfg-source-pills');
            if (!container) return;
            container.innerHTML = localSources.map(s => `
                <button type="button" class="pill-btn ${s.id === editingSourceId ? 'active' : ''}" data-source-id="${escapeHtml(s.id)}">
                    ${escapeHtml(s.name)}
                </button>
            `).join('');

            container.querySelectorAll('.pill-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    saveCurrentFormValues();
                    editingSourceId = btn.dataset.sourceId;
                    renderSettingsPills();
                    renderSettingsForm(editingSourceId);
                });
            });
        }

        function saveCurrentFormValues() {
            if (!editingSourceId) return;
            const src = localSources.find(s => s.id === editingSourceId);
            if (!src) return;
            const nameInput = shadow.getElementById('cfg-source-name');
            const urlInput = shadow.getElementById('cfg-source-url');
            const queryFormatSelect = shadow.getElementById('cfg-query-format');
            const userscriptEnabledCheckbox = shadow.getElementById('cfg-userscript-enabled');
            const userscriptCodeTextarea = shadow.getElementById('cfg-userscript-code');

            if (nameInput) src.name = nameInput.value.trim() || src.name;
            if (urlInput) {
                let uVal = urlInput.value.trim() || src.urlTemplate;
                if (uVal && !/^https?:\/\//i.test(uVal)) {
                    uVal = 'https://' + uVal;
                }
                src.urlTemplate = uVal;
                if (!src.defaultUrl) {
                    src.defaultUrl = src.urlTemplate;
                }
            }
            if (queryFormatSelect) src.queryFormat = queryFormatSelect.value;
            if (userscriptEnabledCheckbox) src.userscriptEnabled = userscriptEnabledCheckbox.checked;
            if (userscriptCodeTextarea) src.userscript = userscriptCodeTextarea.value;
        }

        function renderSettingsForm(sourceId) {
            const src = localSources.find(s => s.id === sourceId) || localSources[0];
            if (!src) return;
            editingSourceId = src.id;

            const nameInput = shadow.getElementById('cfg-source-name');
            const urlInput = shadow.getElementById('cfg-source-url');
            const resetUrlBtn = shadow.getElementById('cfg-reset-url-btn');
            const queryFormatSelect = shadow.getElementById('cfg-query-format');
            const userscriptEnabledCheckbox = shadow.getElementById('cfg-userscript-enabled');
            const resetScriptBtn = shadow.getElementById('cfg-reset-script-btn');
            const userscriptCodeTextarea = shadow.getElementById('cfg-userscript-code');
            const deleteBtn = shadow.getElementById('cfg-delete-btn');

            if (nameInput) nameInput.value = src.name || '';
            if (urlInput) urlInput.value = src.urlTemplate || '';
            if (resetUrlBtn) resetUrlBtn.style.display = src.defaultUrl ? 'inline-block' : 'none';
            if (queryFormatSelect) queryFormatSelect.value = src.queryFormat || 'artist_song';
            if (userscriptEnabledCheckbox) userscriptEnabledCheckbox.checked = Boolean(src.userscriptEnabled);
            if (resetScriptBtn) resetScriptBtn.style.display = src.defaultUserscript ? 'inline-block' : 'none';
            if (userscriptCodeTextarea) userscriptCodeTextarea.value = src.userscript || '';
            if (deleteBtn) deleteBtn.style.display = src.isSeed ? 'none' : 'flex';
        }

        renderSourceTabs();

        const toolbarRoot = shadow.getElementById('toolbar-root');
        const urlGroup = shadow.getElementById('url-group');
        const urlText = shadow.getElementById('url-text');
        const songPill = shadow.getElementById('song-pill');
        const songTextSpan = shadow.getElementById('song-text');

        if (songPill && songTextSpan) {
            if (songText) {
                songPill.style.display = 'flex';
                songTextSpan.textContent = songText;
                songPill.title = songText;
            } else {
                songPill.style.display = 'none';
            }
        }

        function updateToolbarDisplay() {
            if (host && !host.isConnected) {
                const mount = document.body || document.documentElement;
                if (mount) mount.appendChild(host);
            }
            const cur = window.location.href;
            if (urlText && urlText.textContent !== cur) {
                urlText.textContent = cur;
            }
            if (urlGroup && urlGroup.title !== cur) {
                urlGroup.title = cur;
            }
            const currentActiveId = detectActiveSourceId();
            shadow.querySelectorAll('.tab-btn:not(.tab-btn-add)').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.sourceId === currentActiveId);
            });

            if (toolbarRoot) {
                toolbarRoot.classList.toggle('platform-macos', detectedPlatform === 'macos');
                toolbarRoot.classList.toggle('platform-windows', detectedPlatform === 'windows');
                toolbarRoot.classList.toggle('platform-ios', detectedPlatform === 'ios');
                toolbarRoot.classList.toggle('platform-android', detectedPlatform === 'android');

                // Determine orientation and true physical screen width in current orientation
                const isLandscape = (window.orientation === 90 || window.orientation === -90 || window.innerWidth > window.innerHeight);
                const s1 = window.screen ? (window.screen.width || 0) : 0;
                const s2 = window.screen ? (window.screen.height || 0) : 0;
                let deviceScreenW = 0;
                if (s1 && s2) {
                    deviceScreenW = isLandscape ? Math.max(s1, s2) : Math.min(s1, s2);
                } else {
                    deviceScreenW = window.innerWidth || 1100;
                }

                const isMobileScreen = (detectedPlatform === 'ios' || detectedPlatform === 'android' || (deviceScreenW > 0 && deviceScreenW <= 700));
                toolbarRoot.classList.toggle('is-mobile-screen', isMobileScreen);
                const navCenter = shadow.querySelector('.nav-center');
                if (navCenter) {
                    navCenter.classList.toggle('show-fallback', isMobileScreen && !songText);
                }
                toolbarRoot.classList.toggle('url-fallback', isMobileScreen && !songText);

                const vv = window.visualViewport;
                const vvScale = (vv && vv.scale) ? vv.scale : 1.0;
                const effectiveScale = (vvScale > 0) ? (1.0 / vvScale) : 1.0;
                const isScaled = Math.abs(effectiveScale - 1.0) > 0.02;

                if (isScaled && vv) {
                    // Pinned to visual viewport bounds and zoomed using native CSS zoom
                    // so the toolbar stays crisp at native high-DPI resolution without
                    // raster blur caused by transform: scale.
                    host.style.position = 'fixed';
                    host.style.left = (vv.offsetLeft || 0) + 'px';
                    host.style.top = (vv.offsetTop || 0) + 'px';
                    host.style.width = (vv.width || window.innerWidth) + 'px';
                    host.style.transformOrigin = '0 0';
                    host.style.transform = 'none';
                    toolbarRoot.style.width = ((vv.width || window.innerWidth) / effectiveScale) + 'px';
                    toolbarRoot.style.zoom = effectiveScale;
                } else {
                    // Standard unscaled viewport (1:1 scale)
                    host.style.position = 'fixed';
                    host.style.left = '0px';
                    host.style.top = '0px';
                    host.style.transform = 'none';
                    host.style.width = '100%';
                    toolbarRoot.style.width = '100%';
                    toolbarRoot.style.zoom = '1';
                }

                // Keep page body padded down so content starts below the toolbar.
                // Only re-measure at 1:1 scale; resizing the padding during a pinch
                // reflows the page and makes content jump along with the bar.
                const rect = toolbarRoot.getBoundingClientRect();
                const effectiveH = isScaled
                    ? (window.__majesticToolbarBaseH || 0)
                    : Math.ceil(rect.height || toolbarRoot.offsetHeight);
                if (!isScaled && effectiveH > 0) window.__majesticToolbarBaseH = effectiveH;
                if (effectiveH > 0 && !isScaled) {
                    let offStyle = document.getElementById('majestic-downloader-offset-style');
                    if (!offStyle) {
                        offStyle = document.createElement('style');
                        offStyle.id = 'majestic-downloader-offset-style';
                        (document.head || document.documentElement).appendChild(offStyle);
                    }
                    const targetCss = 'body { padding-top: ' + effectiveH + 'px !important; }';
                    if (offStyle.textContent !== targetCss) {
                        offStyle.textContent = targetCss;
                    }
                }
            }
        }

        updateToolbarDisplay();

        if (!window.__majesticToolbarListenersAttached) {
            window.__majesticToolbarListenersAttached = true;
            window.addEventListener('popstate', updateToolbarDisplay);
            window.addEventListener('hashchange', updateToolbarDisplay);
            window.addEventListener('resize', updateToolbarDisplay);
            window.addEventListener('orientationchange', updateToolbarDisplay);
            if (window.visualViewport) {
                let vvRaf = 0;
                const scheduleUpdate = () => {
                    if (vvRaf) return;
                    vvRaf = requestAnimationFrame(() => { vvRaf = 0; updateToolbarDisplay(); });
                };
                window.visualViewport.addEventListener('resize', scheduleUpdate);
                window.visualViewport.addEventListener('scroll', scheduleUpdate);
            }
            setInterval(updateToolbarDisplay, 1500);

            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    const overlay = shadow.getElementById('settings-overlay');
                    if (overlay && overlay.style.display !== 'none') {
                        overlay.style.display = 'none';
                    } else {
                        try {
                            if (window.MajesticDownloaderNative && typeof window.MajesticDownloaderNative.close === 'function') {
                                window.MajesticDownloaderNative.close();
                            }
                        } catch(err) {}
                        window.location.href = 'majestictab://close';
                    }
                }
            });
        }
    };

    if (window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__) {
        window.__initMajesticToolbar(window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__);
    }
})();"#;

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct DownloadChunkState {
    pub name: String,
    pub total: usize,
    pub chunks: Vec<Option<String>>,
}

#[derive(Default)]
#[allow(dead_code)]
pub struct TabDownloaderState {
    pub current_url: Mutex<Option<String>>,
    pub active_userscript: Mutex<Option<String>>,
    pub current_config: Mutex<Option<TabDownloaderConfig>>,
    pub is_open: Mutex<bool>,
    pub is_visible: Mutex<bool>,
    pub top_offset: Mutex<f64>,
    pub last_bounds: Mutex<Option<(i32, i32, u32, u32, bool)>>,
    pub pending_downloads: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    pub last_destination: Mutex<Option<std::path::PathBuf>>,
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
        if (typeof window.__initMajesticToolbar === 'function') {{
            window.__initMajesticToolbar(cfg);
        }}
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

pub fn schedule_toolbar_injection(app_handle: &AppHandle) {
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

pub fn hide_downloader(app_handle: &AppHandle) {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(w) = app_handle.get_webview(DOWNLOADER_LABEL) {
        let _ = w.eval("try { window.MajesticDownloaderNative?.close(); } catch(e) {}");
        let _ = w.set_position(tauri::LogicalPosition::new(-10000.0, -10000.0));
        let _ = w.set_size(tauri::LogicalSize::new(1.0, 1.0));
        let _ = w.hide();
        return;
    }
    if let Some(w) = app_handle.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.eval("try { window.MajesticDownloaderNative?.close(); } catch(e) {}");
        let _ = w.hide();
    }
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

    // 2. URL update notification scheme: majestictab://url?url=...
    if url.scheme() == "majestictab" && (url.host_str() == Some("url") || url_str.starts_with("majestictab://url")) {
        let target_url = url
            .query_pairs()
            .find(|(k, _)| k == "url")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        if !target_url.is_empty() {
            let _ = app_handle.emit("tab-downloader-url-changed", target_url);
        }
        return false;
    }

    // 3. Close webview window scheme: majestictab://close
    if url.scheme() == "majestictab" && (url.host_str() == Some("close") || url_str.starts_with("majestictab://close")) {
        eprintln!("[Tab Downloader] Close requested via majestictab://close");
        let was_open = if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            state.is_open.lock().map(|mut g| {
                let prev = *g;
                *g = false;
                prev
            }).unwrap_or(true)
        } else {
            true
        };
        if was_open {
            hide_downloader(app_handle);
            let _ = app_handle.emit("tab-downloader-closed", ());
        }
        return false;
    }

    // 4. Source switch scheme: majestictab://switch-source?sourceId=...&url=...
    if url.scheme() == "majestictab" && (url.host_str() == Some("switch-source") || url_str.starts_with("majestictab://switch-source")) {
        let sid = url
            .query_pairs()
            .find(|(k, _)| k == "sourceId")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        let target_url = url
            .query_pairs()
            .find(|(k, _)| k == "url")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();

        eprintln!("[Tab Downloader] Switch source requested: sid={}, target={}", sid, target_url);

        if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            let mut matched_userscript: Option<String> = None;
            if let Ok(mut cfg_guard) = state.current_config.lock() {
                if let Some(ref mut cfg) = *cfg_guard {
                    cfg.active_source_id = Some(sid.clone());
                    if let Some(src) = cfg.sources.iter().find(|s| s.id == sid) {
                        if src.userscript_enabled {
                            matched_userscript = src.userscript.clone().or_else(|| src.default_userscript.clone());
                        }
                    }
                }
            }
            if let Ok(mut js_guard) = state.active_userscript.lock() {
                *js_guard = matched_userscript;
            }
        }

        if let Ok(parsed_target) = tauri::Url::parse(&target_url) {
            if let Some(w) = app_handle.get_webview(DOWNLOADER_LABEL) {
                let _ = w.navigate(parsed_target);
            } else if let Some(w) = app_handle.get_webview_window(DOWNLOADER_LABEL) {
                let _ = w.navigate(parsed_target);
            }
            schedule_toolbar_injection(app_handle);
        }
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
                    total,
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

    // 6. Source configuration persistence: majestictab://save-sources?payload=... or sources=...
    if url.scheme() == "majestictab" && (url.host_str() == Some("save-sources") || url_str.starts_with("majestictab://save-sources")) {
        let payload_json = url
            .query_pairs()
            .find(|(k, _)| k == "payload")
            .map(|(_, v)| v.into_owned());
        let sources_json = url
            .query_pairs()
            .find(|(k, _)| k == "sources")
            .map(|(_, v)| v.into_owned());

        let raw_json = payload_json.or(sources_json).unwrap_or_default();
        if !raw_json.is_empty() {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SaveSourcesPayload {
                sources: Option<Vec<TabSourceInfo>>,
            }


            if let Ok(payload) = serde_json::from_str::<SaveSourcesPayload>(&raw_json) {
                if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
                    if let Ok(mut cfg_guard) = state.current_config.lock() {
                        if let Some(ref mut cfg) = *cfg_guard {
                            if let Some(sources) = payload.sources {
                                cfg.sources = sources;
                            }
                        }
                    }
                }
            } else if let Ok(updated_sources) = serde_json::from_str::<Vec<TabSourceInfo>>(&raw_json) {
                if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
                    if let Ok(mut cfg_guard) = state.current_config.lock() {
                        if let Some(ref mut cfg) = *cfg_guard {
                            cfg.sources = updated_sources;
                        }
                    }
                }
            }

            let escaped_json = serde_json::to_string(&raw_json).unwrap_or_default();
            let eval_script = format!("window.__onSaveSources && window.__onSaveSources({});", escaped_json);
            if let Some(main_wv) = app_handle.get_webview("main") {
                let _ = main_wv.eval(&eval_script);
            } else if let Some(main_win) = app_handle.get_webview_window("main") {
                let _ = main_win.eval(&eval_script);
            }
            let _ = app_handle.emit("tab-downloader-save-sources", raw_json);
        }
        return false;
    }

    // 7. DevTools request: majestictab://devtools
    if url.scheme() == "majestictab" && (url.host_str() == Some("devtools") || url_str.starts_with("majestictab://devtools")) {
        #[cfg(all(feature = "debug-tools", not(any(target_os = "android", target_os = "ios"))))]
        if let Some(w) = app_handle.get_webview(DOWNLOADER_LABEL) {
            w.open_devtools();
        } else if let Some(w) = app_handle.get_webview_window(DOWNLOADER_LABEL) {
            w.open_devtools();
        }
        return false;
    }

    // 8. Window drag scheme: majestictab://drag
    if url.scheme() == "majestictab" && (url.host_str() == Some("drag") || url_str.starts_with("majestictab://drag")) {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let Some(main_win) = app_handle.get_window("main") {
            #[cfg(target_os = "macos")]
            drag_window_macos(&main_win);
            #[cfg(not(target_os = "macos"))]
            let _ = main_win.start_dragging();
        }
        return false;
    }

    // 9. Window toggle-maximize scheme: majestictab://toggle-maximize
    if url.scheme() == "majestictab" && (url.host_str() == Some("toggle-maximize") || url_str.starts_with("majestictab://toggle-maximize")) {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let Some(main_win) = app_handle.get_window("main") {
            if let Ok(is_max) = main_win.is_maximized() {
                if is_max {
                    let _ = main_win.unmaximize();
                } else {
                    let _ = main_win.maximize();
                }
            }
        }
        return false;
    }

    if url.scheme() == "majestictab" {
        return false;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = app_handle.emit("tab-downloader-url-changed", url_str.to_string());
        if let Some(state) = app_handle.try_state::<TabDownloaderState>() {
            if let Some(host) = url.host_str().map(|h| h.to_lowercase()) {
                let mut matched_sid: Option<String> = None;
                let mut matched_script: Option<String> = None;
                if let Ok(mut cfg_guard) = state.current_config.lock() {
                    if let Some(ref mut cfg) = *cfg_guard {
                        for s in &cfg.sources {
                            let matches = if s.id == "ug" && host.contains("ultimate-guitar.com") {
                                true
                            } else if s.id == "metaltabs" && host.contains("metaltabs.org") {
                                true
                            } else if s.id == "gprotab" && host.contains("gprotab.net") {
                                true
                            } else if s.id == "songsterr" && host.contains("songsterr-downloader.com") {
                                true
                            } else if s.id == "classtab" && host.contains("classtab.org") {
                                true
                            } else if let Ok(u) = tauri::Url::parse(if !s.default_url.is_empty() { &s.default_url } else { &s.url_template }) {
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
        schedule_toolbar_injection(app_handle);
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
        schedule_toolbar_injection(&app_handle_for_load);
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

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_update(
    _app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    _top_offset: f64,
) -> Result<(), String> {
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
    schedule_toolbar_injection(&app);
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
pub fn tab_downloader_eval(app: AppHandle, script: String) -> Result<(), String> {
    if let Some(w) = app.get_webview(DOWNLOADER_LABEL) {
        let _ = w.eval(&script);
    } else if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.eval(&script);
    }
    Ok(())
}

#[tauri::command]
pub fn tab_downloader_save_sources(app: AppHandle, sources_json: String) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveSourcesPayload {
        sources: Option<Vec<TabSourceInfo>>,
    }


    if let Ok(payload) = serde_json::from_str::<SaveSourcesPayload>(&sources_json) {
        if let Some(state) = app.try_state::<TabDownloaderState>() {
            if let Ok(mut cfg_guard) = state.current_config.lock() {
                if let Some(ref mut cfg) = *cfg_guard {
                    if let Some(sources) = payload.sources {
                        cfg.sources = sources;
                    }
                }
            }
        }
    } else if let Ok(updated_sources) = serde_json::from_str::<Vec<TabSourceInfo>>(&sources_json) {
        if let Some(state) = app.try_state::<TabDownloaderState>() {
            if let Ok(mut cfg_guard) = state.current_config.lock() {
                if let Some(ref mut cfg) = *cfg_guard {
                    cfg.sources = updated_sources;
                }
            }
        }
    }

    let escaped_json = serde_json::to_string(&sources_json).unwrap_or_default();
    let eval_script = format!("window.__onSaveSources && window.__onSaveSources({});", escaped_json);
    if let Some(main_wv) = app.get_webview("main") {
        let _ = main_wv.eval(&eval_script);
    } else if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.eval(&eval_script);
    }
    let _ = app.emit("tab-downloader-save-sources", sources_json);
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
            total,
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


