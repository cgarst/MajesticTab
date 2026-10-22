// jamCommon.js — small shared helpers for the Jam Mode host and client adapters.

import { jamPlayerControl } from '../gpProcessor/gpPlayer.js';
import { nowMs } from './jamTransport.js';

export async function sha256Hex(buffer) {
    if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback (non-secure contexts): FNV-1a 64-bit-ish, only used as an identity key.
    const bytes = new Uint8Array(buffer);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
        h2 = Math.imul(h2 + bytes[i], 2246822519) >>> 0;
    }
    return `fnv-${bytes.length}-${h1.toString(16)}${h2.toString(16)}`;
}

/**
 * Jam song identity: content hash, plus the page range for a PDF opened as a library tab
 * (same file, different song).
 */
export async function jamSongId(buffer, file = {}) {
    const hash = await sha256Hex(buffer);
    return file.startPage ? `${hash}:p${file.startPage}-${file.endPage || file.startPage}` : hash;
}

export function songTitleFromName(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
}

let latencyCtx = null;

/**
 * Best-effort audio output latency in ms from AudioContext. WKWebView / WebView2 values are
 * unreliable, so callers add a manual trim on top (stored per device).
 */
export function estimateOutputLatencyMs() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return 0;
        if (!latencyCtx) latencyCtx = new Ctx({ latencyHint: 'interactive' });
        const out = Number(latencyCtx.outputLatency) || 0;
        const base = Number(latencyCtx.baseLatency) || 0;
        const total = (out + base) * 1000;
        return Number.isFinite(total) && total < 1000 ? total : 0;
    } catch (_) {
        return 0;
    }
}

export function loadSetting(key, fallback) {
    try {
        const raw = localStorage.getItem(`jam.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
        return fallback;
    }
}

export function saveSetting(key, value) {
    try { localStorage.setItem(`jam.${key}`, JSON.stringify(value)); } catch (_) {}
}

/** Coalesce rapid calls to at most one per `intervalMs`, always delivering the final value. */
export function createCoalescer(fn, intervalMs = 100) {
    let last = 0;
    let timer = null;
    let pendingArgs = null;
    return (...args) => {
        pendingArgs = args;
        const now = performance.now();
        const wait = Math.max(0, last + intervalMs - now);
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            last = performance.now();
            const a = pendingArgs;
            pendingArgs = null;
            fn(...a);
        }, wait);
    };
}

/** Create / resume the shared AudioContext inside a user gesture (join / host start). */
export function primeAudio() {
    try {
        estimateOutputLatencyMs();
        latencyCtx?.resume?.();
    } catch (_) {}
}

let wakeLock = null;
let wakeLockWanted = false;

async function requestWakeLock() {
    if (!wakeLockWanted || wakeLock || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock?.request('screen');
        wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
    } catch (_) {
        wakeLock = null;
    }
}

document.addEventListener('visibilitychange', requestWakeLock);

/** Keep the screen on during a jam session (the browser drops the lock when hidden; re-acquired on return). */
export function setScreenWakeLock(on) {
    wakeLockWanted = Boolean(on);
    window.__TAURI__?.core?.invoke?.('jam_keep_awake', { on: wakeLockWanted }).catch(() => {});
    if (wakeLockWanted) {
        requestWakeLock();
    } else if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

export function waitForPlayerReady(timeoutMs = 25000) {
    return new Promise((resolve) => {
        const started = performance.now();
        const iv = setInterval(() => {
            if (jamPlayerControl.isReady() || performance.now() - started > timeoutMs) {
                clearInterval(iv);
                resolve(jamPlayerControl.isReady());
            }
        }, 100);
    });
}

const START_LAG_MAX_MS = 300;
const START_LAG_MEASURE_AFTER_MS = 400;
const clampLag = (v) => Math.min(START_LAG_MAX_MS, Math.max(0, Number(v) || 0));

const START_LAG_SAMPLES = 7;

function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Learned delay between calling play() and the synth actually advancing on this device
 * (worker hand-off, buffer fill, audio output start). Starts are issued this much early.
 * Median of recent starts, so a one-off slow start (e.g. while the score renders) can't skew it.
 */
export const startLag = {
    samples: (loadSetting('startLagSamples', []) || []).filter(Number.isFinite).slice(-START_LAG_SAMPLES),
    get() { return this.samples.length ? clampLag(medianOf(this.samples)) : 0; },
    record(observedMs) {
        if (!Number.isFinite(observedMs) || observedMs < -100 || observedMs > START_LAG_MAX_MS + 100) return;
        this.samples.push(Math.round(clampLag(observedMs) * 10) / 10);
        if (this.samples.length > START_LAG_SAMPLES) this.samples.shift();
        saveSetting('startLagSamples', this.samples);
    }
};

/**
 * After a scheduled start, compare where the player is with where it should be and refine
 * `startLag`. `targetLocalMs` is when (local clock) the player should have been at `timeMs`;
 * `usedLagMs` is how early play() was actually called. Returns a timer id (cancel with clearTimeout).
 */
export function measureStartLag({ timeMs, targetLocalMs, usedLagMs, speed = 1, isStillValid = () => true, onDone }) {
    const wait = Math.max(0, targetLocalMs - nowMs()) + START_LAG_MEASURE_AFTER_MS;
    return setTimeout(() => {
        if (isStillValid() && jamPlayerControl.snapshot().playing) {
            const expected = timeMs + (nowMs() - targetLocalMs) * speed;
            const residualMs = (expected - jamPlayerControl.timeMs()) / (speed || 1);
            startLag.record(usedLagMs + residualMs);
        }
        onDone?.();
    }, wait);
}

/**
 * The track restrictions one device gets from the host's assignments. `selfKey` is the
 * client id, or 'host' for the host itself. Devices without an assignment are unrestricted.
 */
export function trackPolicyFor(state, selfKey) {
    const mine = state?.trackAssignments?.[selfKey];
    const has = Array.isArray(mine) && mine.length > 0;
    return {
        audio: has && state.assignedAudioOnly ? mine : null,
        view: has && state.assignedViewOnly ? mine : null
    };
}
