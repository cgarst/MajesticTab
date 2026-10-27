// Runs user extensions in isolation. A hidden sandboxed iframe (opaque origin: no app storage, no
// parent access) loads extensionSandbox/frame.html, whose own CSP forbids network access and remote
// scripts, and which spawns one Worker per extension (see extensionSandbox/frame.js).
// Extensions can run any JS on the files they are handed; they just can't reach anything else.
//
// The frame is a separate document, not srcdoc, so it does not inherit the app's CSP: the app can keep
// a strict policy while the sandbox alone allows 'unsafe-eval' (extension source runs via new Function).
// Native builds serve it from the `mtsandbox` URI scheme (src-tauri/src/lib.rs), which sets that CSP as
// a response header; the web build loads the same files by relative URL.

const SANDBOX_PATH = 'extensionSandbox/frame.html';
const READY_TIMEOUT_MS = 10000;

function getSandboxUrl() {
    if (window.__TAURI__) {
        // Tauri serves custom schemes as <scheme>.localhost on Windows and Android. Windows is configured
        // for https (tauri.windows.conf.json useHttpsScheme) so the frame is a secure context and its
        // workers get crypto.subtle; Android stays on http.
        const userAgent = navigator.userAgent || '';
        if (/windows/i.test(userAgent)) return `https://mtsandbox.localhost/${SANDBOX_PATH}`;
        return /android/i.test(userAgent)
            ? `http://mtsandbox.localhost/${SANDBOX_PATH}`
            : `mtsandbox://localhost/${SANDBOX_PATH}`;
    }
    return new URL(SANDBOX_PATH, import.meta.url).href;
}

let libSourcePromise = null;

/** Source of the fflate UMD build the page already loads, so extensions keep `globalThis.fflate`. */
export function getSandboxLibSource() {
    if (!libSourcePromise) {
        const src = document.querySelector('script[src*="fflate"]')?.src;
        libSourcePromise = src
            ? fetch(src).then(response => (response.ok ? response.text() : null)).catch(() => null)
            : Promise.resolve(null);
    }
    return libSourcePromise;
}

export function createExtensionSandbox() {
    const frame = document.createElement('iframe');
    const pending = new Map();
    let nextId = 1;
    let disposed = false;
    let markReady;
    let readyTimer;
    const ready = new Promise(resolve => { markReady = resolve; });

    const failAll = error => {
        pending.forEach(waiting => waiting.reject(error));
        pending.clear();
    };

    const onMessage = ({ source, data }) => {
        if (source !== frame.contentWindow || !data) return;
        if (data.op === 'ready') {
            clearTimeout(readyTimer);
            markReady();
            return;
        }
        const waiting = pending.get(data.id);
        if (!waiting) return;
        pending.delete(data.id);
        if (data.ok) waiting.resolve(data.result);
        else waiting.reject(new Error(data.error));
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(readyTimer);
        window.removeEventListener('message', onMessage);
        frame.remove();
        failAll(new Error('Extension sandbox was shut down'));
    };

    const request = async (message, timeoutMs) => {
        if (disposed) throw new Error('Extension sandbox was shut down');
        await ready;
        if (disposed) throw new Error('Extension sandbox did not start');
        return new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                dispose();
                const error = new Error('Extension timed out');
                error.fatal = true;
                reject(error);
            }, timeoutMs);
            pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); }
            });
            frame.contentWindow.postMessage({ ...message, id }, '*');
        });
    };

    window.addEventListener('message', onMessage);
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    frame.src = getSandboxUrl();
    document.body.append(frame);

    readyTimer = setTimeout(() => {
        dispose();
        markReady();
    }, READY_TIMEOUT_MS);

    return {
        /** Compiles each { id, source } in its own Worker; resolves per extension to { id, ids } or { id, error }. */
        load: (extensions, lib, timeoutMs) => request({ op: 'load', extensions, lib }, timeoutMs),
        call: (message, timeoutMs) => request(message, timeoutMs),
        dispose
    };
}
