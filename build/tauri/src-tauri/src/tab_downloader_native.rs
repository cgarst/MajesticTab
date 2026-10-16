use std::sync::Mutex;
use tauri::{App, AppHandle, Emitter, Manager, State, Wry};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{
    webview::WebviewBuilder, LogicalPosition, LogicalSize, WebviewUrl,
};

#[cfg(target_os = "macos")]
use objc2_foundation::NSString;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

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
    pub userscript: Option<String>,
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
    pub sources: Vec<TabSourceInfo>,
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

    // 11. Desktop Environment Spoofing & Viewport Enforcement
    try {
        const desktopUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        Object.defineProperty(navigator, 'userAgent', { get: () => desktopUa, configurable: true });
        Object.defineProperty(navigator, 'appVersion', { get: () => "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", configurable: true });
        Object.defineProperty(navigator, 'platform', { get: () => "Win32", configurable: true });
    } catch (e) {}

    function enforceDesktopViewport() {
        try {
            let meta = document.querySelector('meta[name="viewport"]');
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'viewport';
                (document.head || document.documentElement).appendChild(meta);
            }
            meta.content = 'width=1100, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes';
        } catch (e) {}
    }
    enforceDesktopViewport();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', enforceDesktopViewport);
    }

    // 12. Modeled In-App Shadow DOM Toolbar (for standalone webviews on Android or future native pivots)
    window.__initMajesticToolbar = function(config) {
        if (!config || !config.showToolbar) return;

        let host = document.getElementById('majestic-downloader-host');
        let shadow = null;
        let isNew = false;

        if (!host) {
            host = document.createElement('div');
            host.id = 'majestic-downloader-host';
            host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 100%; z-index: 2147483647; pointer-events: auto;';
            shadow = host.attachShadow({ mode: 'open' });
            isNew = true;
            const mount = document.body || document.documentElement;
            if (mount) {
                mount.appendChild(host);
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    if (!document.getElementById('majestic-downloader-host')) {
                        (document.body || document.documentElement).appendChild(host);
                    }
                });
            }
        } else {
            shadow = host.shadowRoot;
        }

        if (!shadow) return;

        const sources = config.sources || [];
        const activeSourceId = config.activeSourceId || (sources[0] ? sources[0].id : 'ug');
        const artist = (config.artist || '').trim();
        const song = (config.song || '').trim();
        const songText = (artist && song) ? (artist + ' — ' + song) : (song || artist || '');

        function buildSearchUrl(source, art, sng) {
            let term = '';
            if (source.queryFormat === 'song_only') {
                term = sng || art || '';
            } else {
                term = (art && sng) ? (art + ' ' + sng) : (sng || art || '');
            }
            term = term.trim();
            if (!term) {
                if (source.id === 'ug') return 'https://www.ultimate-guitar.com/';
                if (source.id === 'metaltabs') return 'https://metaltabs.org/';
                if (source.id === 'gprotab') return 'https://gprotab.net/';
                if (source.id === 'guitarprotabs') return 'https://guitarprotabs.org/';
                if (source.defaultUrl) return source.defaultUrl.replace('SEARCH+TERM', '').replace('{search}', '');
                return 'https://www.ultimate-guitar.com/';
            }
            const encodedPlus = encodeURIComponent(term).replace(/%20/g, '+');
            const encodedStandard = encodeURIComponent(term);
            let url = source.urlTemplate || '';
            if (url.includes('SEARCH+TERM')) {
                url = url.replace('SEARCH+TERM', encodedPlus);
            } else if (url.includes('{search}')) {
                url = url.replace('{search}', encodedStandard);
            } else {
                url = url + (url.includes('?') ? '&' : '?') + 'q=' + encodedStandard;
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
            if (h.includes('guitarprotabs.org')) return 'guitarprotabs';
            for (let i = 0; i < sources.length; i++) {
                const s = sources[i];
                try {
                    const u = new URL(s.defaultUrl || s.urlTemplate);
                    if (u.hostname && h.includes(u.hostname)) return s.id;
                } catch(e) {}
            }
            return activeSourceId;
        }

        if (isNew) {
            shadow.innerHTML = `
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                    :host {
                        all: initial;
                        display: block;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        z-index: 2147483647;
                    }
                    .toolbar-root {
                        width: 100%;
                        background: #0d0f15;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
                        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
                        color: #f1f5f9;
                        user-select: none;
                        display: flex;
                        flex-direction: column;
                        transform-origin: top left;
                    }
                    .nav-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 8px 12px;
                        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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
                        background: #334155;
                        color: #f8fafc;
                        padding: 4px 10px;
                        border-radius: 6px;
                        font-size: 13px;
                        font-weight: 500;
                        max-width: 260px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        flex-shrink: 0;
                    }
                    .url-group {
                        display: flex;
                        align-items: center;
                        flex-grow: 1;
                        min-width: 0;
                        background: #000000;
                        border: 1px solid rgba(255, 255, 255, 0.15);
                        border-radius: 6px;
                        padding: 0 8px;
                        height: 32px;
                        gap: 6px;
                    }
                    .url-input {
                        flex-grow: 1;
                        min-width: 0;
                        background: transparent;
                        border: none;
                        outline: none;
                        color: #cbd5e1;
                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                        font-size: 12px;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        overflow: hidden;
                    }
                    .close-btn {
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
                    }
                    .close-btn:hover {
                        background: rgba(239, 68, 68, 0.2);
                        border-color: rgba(239, 68, 68, 0.5);
                        color: #fca5a5;
                    }
                    .close-btn:active {
                        background: rgba(239, 68, 68, 0.35);
                    }
                    .tabs-row {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        padding: 6px 12px;
                        overflow-x: auto;
                        overflow-y: hidden;
                        white-space: nowrap;
                        scrollbar-width: none;
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
                    svg {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                        flex-shrink: 0;
                    }
                </style>
                <div class="toolbar-root" id="toolbar-root">
                    <div class="nav-row">
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

                        <div id="song-pill" class="song-pill" style="display: ${songText ? 'flex' : 'none'};" title="${escapeHtml(songText)}">
                            <svg viewBox="0 0 16 16"><path d="M9 13c0 1.105-1.12 2-2.5 2S4 14.105 4 13s1.12-2 2.5-2 2.5.895 2.5 2z"/><path fill-rule="evenodd" d="M9 3v10H8V3h1z"/><path d="M8 2.82a1 1 0 0 1 .804-.98l3-.6A1 1 0 0 1 13 2.22V4L8 5V2.82z"/></svg>
                            <span id="song-text">${escapeHtml(songText)}</span>
                        </div>

                        <div class="url-group">
                            <svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.87.21-1.688.508-2.428l-.008-.072H1.36a7.03 7.03 0 0 0 0 5h2.648a10.6 10.6 0 0 1-.508-2.428l.008-.072zm.76 3.5c.29 1.05.7 1.93 1.218 2.54.516.61 1.08.96 1.514 1.037V11H4.268zm4.232 0v3.577c.434-.077.998-.427 1.514-1.037.518-.61.928-1.49 1.218-2.54H8.5zm3.41-3.5a10.6 10.6 0 0 1-.508 2.428l.008.072h2.648a7.03 7.03 0 0 0 0-5h-2.648a10.6 10.6 0 0 1 .508 2.428l-.008.072zm-.178-4.5H9.5V1.077c.67.204 1.335.82 1.887 1.855.22.41.4.85.545 1.068zm.908-1.539A9.267 9.267 0 0 0 11.91 4h1.835a7.025 7.025 0 0 0-3.072-2.467c.18.27.38.58.58.928zM8.5 4h2.355a7.97 7.97 0 0 0-.468-1.068C9.835 1.897 9.17 1.28 8.5 1.077V4zM8.5 5v5h3.04a9.63 9.63 0 0 0 .428-2.5c0-.88-.15-1.72-.428-2.5H8.5zM7.5 5H4.46a9.63 9.63 0 0 0-.428 2.5c0 .88.15 1.72.428 2.5H7.5V5z"/></svg>
                            <input type="text" class="url-input" id="url-input" readonly value="${escapeHtml(window.location.href)}" title="${escapeHtml(window.location.href)}">
                        </div>

                        <button type="button" class="close-btn" id="btn-close" title="Close">
                            <svg viewBox="0 0 16 16"><path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/></svg>
                        </button>
                    </div>

                    <div class="tabs-row" id="tabs-row">
                        ${sources.map(s => `
                            <button type="button" class="tab-btn" data-source-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">
                                <svg viewBox="0 0 16 16"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.87.21-1.688.508-2.428l-.008-.072H1.36a7.03 7.03 0 0 0 0 5h2.648a10.6 10.6 0 0 1-.508-2.428l.008-.072zm.76 3.5c.29 1.05.7 1.93 1.218 2.54.516.61 1.08.96 1.514 1.037V11H4.268zm4.232 0v3.577c.434-.077.998-.427 1.514-1.037.518-.61.928-1.49 1.218-2.54H8.5zm3.41-3.5a10.6 10.6 0 0 1-.508 2.428l.008.072h2.648a7.03 7.03 0 0 0 0-5h-2.648a10.6 10.6 0 0 1 .508 2.428l-.008.072zm-.178-4.5H9.5V1.077c.67.204 1.335.82 1.887 1.855.22.41.4.85.545 1.068zm.908-1.539A9.267 9.267 0 0 0 11.91 4h1.835a7.025 7.025 0 0 0-3.072-2.467c.18.27.38.58.58.928zM8.5 4h2.355a7.97 7.97 0 0 0-.468-1.068C9.835 1.897 9.17 1.28 8.5 1.077V4zM8.5 5v5h3.04a9.63 9.63 0 0 0 .428-2.5c0-.88-.15-1.72-.428-2.5H8.5zM7.5 5H4.46a9.63 9.63 0 0 0-.428 2.5c0 .88.15 1.72.428 2.5H7.5V5z"/></svg>
                                <span>${escapeHtml(s.name)}</span>
                            </button>
                        `).join('')}
                    </div>
                </div>
            `;

            shadow.getElementById('btn-back')?.addEventListener('click', () => window.history.back());
            shadow.getElementById('btn-forward')?.addEventListener('click', () => window.history.forward());
            shadow.getElementById('btn-reload')?.addEventListener('click', () => window.location.reload());
            shadow.getElementById('btn-close')?.addEventListener('click', () => {
                window.location.href = 'majestictab://close';
            });

            shadow.getElementById('url-input')?.addEventListener('focus', function() {
                this.select();
            });

            shadow.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sid = btn.dataset.sourceId;
                    const src = sources.find(s => s.id === sid);
                    if (src) {
                        const nextUrl = buildSearchUrl(src, artist, song);
                        window.location.href = nextUrl;
                    }
                });
            });
        }

        const toolbarRoot = shadow.getElementById('toolbar-root');
        const urlInput = shadow.getElementById('url-input');
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
            if (urlInput) {
                const cur = window.location.href;
                urlInput.value = cur;
                urlInput.title = cur;
            }
            const currentActiveId = detectActiveSourceId();
            shadow.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.sourceId === currentActiveId);
            });

            if (toolbarRoot) {
                const screenW = Math.min(window.screen.width || 1100, window.screen.availWidth || 1100);
                const viewW = window.innerWidth || 1100;
                if (viewW > screenW && screenW > 0) {
                    const scale = Math.min(2.8, Math.max(1.0, viewW / screenW));
                    toolbarRoot.style.zoom = scale;
                } else {
                    toolbarRoot.style.zoom = '1';
                }

                const h = toolbarRoot.getBoundingClientRect().height;
                if (h > 0) {
                    let offStyle = document.getElementById('majestic-downloader-offset-style');
                    if (!offStyle) {
                        offStyle = document.createElement('style');
                        offStyle.id = 'majestic-downloader-offset-style';
                        (document.head || document.documentElement).appendChild(offStyle);
                    }
                    offStyle.textContent = 'html { margin-top: ' + Math.ceil(h) + 'px !important; }';
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
            setInterval(updateToolbarDisplay, 1000);
        }
    };

    if (window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__) {
        window.__initMajesticToolbar(window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__);
    }
})();"#;

#[derive(Default)]
#[allow(dead_code)]
pub struct TabDownloaderState {
    pub current_url: Mutex<Option<String>>,
    pub active_userscript: Mutex<Option<String>>,
    pub last_bounds: Mutex<Option<(i32, i32, u32, u32, bool)>>,
    pub pending_downloads: Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    pub last_destination: Mutex<Option<std::path::PathBuf>>,
}

pub fn wrap_userscript(raw_js: &str, config: Option<&TabDownloaderConfig>) -> String {
    let trimmed = raw_js.trim();
    let config_json = match config {
        Some(c) => serde_json::to_string(c).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };
    format!(
        "{}\n(function() {{\n    const cfg = {};\n    if (cfg) {{\n        window.__MAJESTIC_TAB_DOWNLOADER_CONFIG__ = cfg;\n        if (typeof window.__initMajesticToolbar === 'function') {{\n            window.__initMajesticToolbar(cfg);\n        }}\n    }}\n    window.__majesticActiveUserscript = function() {{\n        try {{\n            {}\n        }} catch (err) {{\n            console.error(\"[MajesticTab Userscript Error]\", err);\n        }}\n    }};\n\n    if (typeof window.__majesticActiveUserscript === 'function') {{\n        window.__majesticActiveUserscript();\n    }}\n    if (document.readyState === 'loading') {{\n        document.addEventListener('DOMContentLoaded', () => {{\n            if (window.__majesticActiveUserscript) window.__majesticActiveUserscript();\n        }});\n    }}\n    window.addEventListener('load', () => {{\n        if (window.__majesticActiveUserscript) window.__majesticActiveUserscript();\n    }});\n    if (!window.__majesticRunnerInit) {{\n        window.__majesticRunnerInit = true;\n        setInterval(() => {{\n            if (typeof window.__majesticActiveUserscript === 'function') {{\n                window.__majesticActiveUserscript();\n            }}\n        }}, 400);\n        try {{\n            const obs = new MutationObserver(() => {{\n                if (typeof window.__majesticActiveUserscript === 'function') {{\n                    window.__majesticActiveUserscript();\n                }}\n            }});\n            const target = document.body || document.documentElement;\n            if (target) {{\n                obs.observe(target, {{ childList: true, subtree: true }});\n            }} else {{\n                document.addEventListener('DOMContentLoaded', () => {{\n                    const t = document.body || document.documentElement;\n                    if (t) obs.observe(t, {{ childList: true, subtree: true }});\n                }});\n            }}\n        }} catch (e) {{}}\n    }}\n}})();",
        CORE_DOWNLOADER_SHIM, config_json, trimmed
    )
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
        if let Some(w) = app_handle.get_webview_window(DOWNLOADER_LABEL) {
            let _ = w.hide();
        }
        let _ = app_handle.emit("tab-downloader-closed", ());
        return false;
    }

    // 4. Direct client-side download capture scheme: majestictab://download?name=...&data=...
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
        let _ = app_handle.emit("tab-downloaded", payload);
        return false;
    }

    if url.scheme() == "http" || url.scheme() == "https" {
        let _ = app_handle.emit("tab-downloader-url-changed", url_str.to_string());
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
        handle_navigation(&app_handle_for_nav, &url)
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
                            let wrapped = wrap_userscript(js, None);
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

    let bounds_tuple = (left.round() as i32, top.round() as i32, width.round() as u32, height.round() as u32, visible);
    let bounds_changed = {
        let mut last_bounds_guard = state.last_bounds.lock().map_err(|e| e.to_string())?;
        if *last_bounds_guard != Some(bounds_tuple) {
            *last_bounds_guard = Some(bounds_tuple);
            true
        } else {
            false
        }
    };

    if !visible || width <= 0.0 || height <= 0.0 {
        if bounds_changed {
            let _ = downloader.set_position(LogicalPosition::new(-10000.0, -10000.0));
            let _ = downloader.set_size(LogicalSize::new(1.0, 1.0));
            let _ = downloader.hide();
        }
        return Ok(());
    }

    if bounds_changed {
        downloader
            .set_position(LogicalPosition::new(left, top))
            .map_err(|e| e.to_string())?;
        downloader
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        downloader.show().map_err(|e| e.to_string())?;
    }

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
            let wrapped = wrap_userscript(js, None);
            let _ = downloader.eval(&wrapped);
        }
    }

    if let Ok(mut stored_script) = state.active_userscript.lock() {
        *stored_script = userscript;
    }

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
                let wrapped = wrap_userscript(js, None);
                let _ = wv.eval(&wrapped);
            }
        }
    }

    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_nav(
    app: AppHandle,
    _state: State<'_, TabDownloaderState>,
    action: String,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
        match action.as_str() {
            "back" => {
                let _ = w.eval("window.history.back()");
            }
            "forward" => {
                let _ = w.eval("window.history.forward()");
            }
            "reload" => {
                let _ = w.eval("window.location.reload()");
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub fn tab_downloader_hide(app: AppHandle, state: State<'_, TabDownloaderState>) -> Result<(), String> {
    if let Ok(mut last_bounds_guard) = state.last_bounds.lock() {
        *last_bounds_guard = Some((-10000, -10000, 1, 1, false));
    }
    if let Some(wv) = app.get_webview(DOWNLOADER_LABEL) {
        let _ = wv.set_position(LogicalPosition::new(-10000.0, -10000.0));
        let _ = wv.set_size(LogicalSize::new(1.0, 1.0));
        let _ = wv.hide();
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn tab_downloader_hide(app: AppHandle, _state: State<'_, TabDownloaderState>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.hide();
    }
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
pub fn tab_downloader_eval(app: AppHandle, script: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(DOWNLOADER_LABEL) {
        let _ = w.eval(&script);
    }
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
