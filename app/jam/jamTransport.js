// jamTransport.js
// Thin wrapper over the Rust JamServer / JamClient (build/tauri/src-tauri/src/jam.rs).

import { parseMessage } from './jamProtocol.js';

let nowBase = 0;
let nowCalibrated = false;

function tauri() {
    return window.__TAURI__ || null;
}

export function isJamSupported() {
    return Boolean(tauri()?.core?.invoke && tauri()?.event?.listen);
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

export const jam = {
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

/** Subscribe to Rust events. Returns a promise of an unsubscribe function. */
export async function listenJamEvents({ onMessage, onPeers, onConnection }) {
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
