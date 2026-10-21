// jamTransport.js
// Thin wrapper over the Rust JamServer / JamClient (build/tauri/src-tauri/src/jam.rs).
// A browser that loaded the app from a native Jam host (which injects the
// `majestictab-jam-host` meta tag) joins as a guest over a same-origin WebSocket instead.

import { parseMessage } from './jamProtocol.js';

let nowBase = 0;
let nowCalibrated = false;

function tauri() {
    return window.__TAURI__ || null;
}

const isNative = () => Boolean(tauri()?.core?.invoke && tauri()?.event?.listen);

/** True when this page was served by a native Jam host and can only join, not host. */
export function isJamWebGuest() {
    return !isNative() && Boolean(document.querySelector('meta[name="majestictab-jam-host"]'));
}

export function isJamSupported() {
    return isNative() || isJamWebGuest();
}

function invoke(cmd, args) {
    return tauri().core.invoke(cmd, args);
}

/**
 * Align `performance.now()` with the Rust monotonic clock. The sample with the lowest IPC
 * round trip wins. `nowMs()` is then synchronous and cheap; ping/pong timestamps themselves
 * are stamped in Rust, so IPC jitter does not enter clock sync.
 */
export async function calibrateNow(samples = 5) {
    if (!isNative()) {
        // Web guests stamp ping/pong in JS, so `performance.now()` is the clock.
        nowCalibrated = true;
        return;
    }
    let best = null;
    for (let i = 0; i < samples; i++) {
        const before = performance.now();
        const rust = await invoke('jam_now_ms');
        const after = performance.now();
        const rtt = after - before;
        if (!best || rtt < best.rtt) best = { rtt, base: rust - (before + after) / 2 };
    }
    if (best) {
        nowBase = best.base;
        nowCalibrated = true;
    }
}

export function nowMs() {
    return performance.now() + nowBase;
}

export function isNowCalibrated() {
    return nowCalibrated;
}

/** Android filters multicast (mDNS) unless a MulticastLock is held; no-op elsewhere. */
export function setMulticastEnabled(on) {
    try { window.AndroidJam?.setMulticast?.(Boolean(on)); } catch (_) {}
}

// ---- Web guest transport ---------------------------------------------------

const web = { socket: null, handlers: null };
const WEB_CONNECT_TIMEOUT_MS = 5000;

function emitWeb(kind, payload) {
    const h = web.handlers;
    if (kind === 'message') h?.onMessage?.('host', payload);
    else if (kind === 'connection') h?.onConnection?.(payload);
}

function webConnect(pin, name) {
    webDisconnect();
    emitWeb('connection', { state: 'connecting', reason: '' });
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/jam`);
    web.socket = socket;
    let opened = false;
    let localClose = false;
    let rejectReason = '';
    socket.localClose = () => { localClose = true; };

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Connection timed out'));
            try { socket.close(); } catch (_) {}
        }, WEB_CONNECT_TIMEOUT_MS);
        socket.onopen = () => {
            clearTimeout(timer);
            opened = true;
            socket.send(JSON.stringify({ v: 1, type: 'hello', name, pin: pin || '', protocol: 1, appVersion: 'web' }));
            resolve();
        };
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Connection failed'));
        };
        socket.onmessage = (event) => {
            if (web.socket !== socket || typeof event.data !== 'string') return;
            const rxTs = nowMs();
            const msg = parseMessage(event.data);
            if (!msg) return;
            msg.rxTs = rxTs;
            if (msg.type === 'welcome') emitWeb('connection', { state: 'connected', reason: '' });
            if (msg.type === 'reject') rejectReason = `reject:${msg.reason || ''}`;
            emitWeb('message', msg);
        };
        socket.onclose = () => {
            clearTimeout(timer);
            if (web.socket !== socket) return;
            web.socket = null;
            // A failed connect attempt reports through the rejected promise, like the native client.
            if (!opened) return;
            emitWeb('connection', { state: 'disconnected', reason: rejectReason || (localClose ? 'local' : 'closed') });
        };
    });
}

function webDisconnect() {
    const socket = web.socket;
    if (!socket) return;
    socket.localClose?.();
    try { socket.close(); } catch (_) {}
}

function webSend(msg) {
    const socket = web.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Not connected');
    // Like the native client, stamp the ping at send time so sync excludes queueing delay.
    socket.send(JSON.stringify(msg.type === 'ping' ? { ...msg, t0: nowMs() } : msg));
}

const webJam = {
    debugAutostart: async () => null,
    localAddresses: async () => [],
    hostStart: async () => { throw new Error('Hosting is only available in the MajesticTab app'); },
    hostStop: async () => {},
    hostSend: async () => {},
    hostKick: async () => {},
    discover: async () => [],
    clientConnect: (_addr, pin, name) => webConnect(pin, name),
    clientSend: async (msg) => webSend(msg),
    clientDisconnect: async () => webDisconnect()
};

const nativeJam = {
    debugAutostart: () => invoke('jam_debug_autostart'),
    localAddresses: () => invoke('jam_local_addresses'),
    hostStart: (name, pin, port = null) => invoke('jam_host_start', { name, pin: pin || null, port }),
    hostStop: () => invoke('jam_host_stop'),
    hostSend: (msg, to = null) => invoke('jam_host_send', { to, msg: JSON.stringify(msg) }),
    hostKick: (id) => invoke('jam_host_kick', { id }),
    discover: (timeoutMs = 2500) => invoke('jam_discover', { timeoutMs }),
    clientConnect: (addr, pin, name) => invoke('jam_client_connect', { addr, pin: pin || null, name }),
    clientSend: (msg) => invoke('jam_client_send', { msg: JSON.stringify(msg) }),
    clientDisconnect: () => invoke('jam_client_disconnect')
};

export const jam = new Proxy({}, {
    get: (_, key) => (isNative() ? nativeJam : webJam)[key]
});

/** Subscribe to Rust events. Returns a promise of an unsubscribe function. */
export async function listenJamEvents({ onMessage, onPeers, onConnection }) {
    if (!isNative()) {
        web.handlers = { onMessage, onPeers, onConnection };
        return () => { web.handlers = null; };
    }
    const { listen } = tauri().event;
    const unlisten = [];
    unlisten.push(await listen('jam-message', (e) => {
        const msg = parseMessage(e.payload?.msg);
        if (msg) onMessage?.(e.payload.from, msg);
    }));
    unlisten.push(await listen('jam-peers-changed', (e) => onPeers?.(e.payload)));
    unlisten.push(await listen('jam-connection-state', (e) => onConnection?.(e.payload)));
    return () => unlisten.forEach((fn) => { try { fn(); } catch (_) {} });
}
