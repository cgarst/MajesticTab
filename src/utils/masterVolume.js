// masterVolume.js
// The app's master volume (0 to 1), set by the dock's Volume slider. The synth, YouTube and local audio files all
// follow it. Persisted under the key the synth has always used, so existing saved volumes carry over.

export const MASTER_VOLUME_KEY = 'majestic_synth_volume';

let volume = 1;
try {
    const stored = localStorage.getItem(MASTER_VOLUME_KEY);
    if (stored !== null && Number.isFinite(parseFloat(stored))) volume = Math.max(0, Math.min(1, parseFloat(stored)));
} catch (_) {}

const listeners = new Set();

export const getMasterVolume = () => volume;

export function setMasterVolume(v) {
    if (!Number.isFinite(v)) return;
    volume = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(MASTER_VOLUME_KEY, String(volume)); } catch (_) {}
    listeners.forEach((cb) => { try { cb(volume); } catch (_) {} });
}

/** Calls `cb(volume)` on every change; returns an unsubscribe function. */
export function onMasterVolume(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
}
