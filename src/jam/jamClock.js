// jamClock.js
// Pure helpers for clock sync and drift correction. No DOM / Tauri access so they can be
// unit tested in Node (see tests/jam/jamClock.test.mjs).

export function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * NTP-lite offset estimation.
 * Sample: t0 = client send, t1 = host receive, t1b = host transmit, t2 = client receive.
 * offset = host clock minus client clock.
 */
export function computeSample(t0, t1, t1b, t2) {
    const rtt = (t2 - t0) - ((t1b ?? t1) - t1);
    const offset = ((t1 - t0) + ((t1b ?? t1) - t2)) / 2;
    return { rtt, offset };
}

export class ClockSync {
    constructor({ maxSamples = 20, keepFraction = 0.7, emaAlpha = 0.2 } = {}) {
        this.maxSamples = maxSamples;
        this.keepFraction = keepFraction;
        this.emaAlpha = emaAlpha;
        this.samples = [];
        this.offset = 0;
        this.rtt = 0;
        this.synced = false;
    }

    reset() {
        this.samples = [];
        this.offset = 0;
        this.rtt = 0;
        this.synced = false;
    }

    addSample(t0, t1, t1b, t2) {
        const sample = computeSample(t0, t1, t1b, t2);
        if (!Number.isFinite(sample.rtt) || !Number.isFinite(sample.offset) || sample.rtt < 0) return this.offset;
        this.samples.push(sample);
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Discard the worst (1 - keepFraction) by RTT, then take the median offset.
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const keep = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length * this.keepFraction)));
        const medianOffset = median(keep.map((s) => s.offset));
        const medianRtt = median(keep.map((s) => s.rtt));

        if (!this.synced) {
            this.offset = medianOffset;
            this.rtt = medianRtt;
            this.synced = true;
        } else {
            this.offset += (medianOffset - this.offset) * this.emaAlpha;
            this.rtt += (medianRtt - this.rtt) * this.emaAlpha;
        }
        return this.offset;
    }

    hostFromLocal(localMs) { return localMs + this.offset; }
    localFromHost(hostMs) { return hostMs - this.offset; }
}

export const DRIFT_IGNORE_MS = 20;
export const DRIFT_HARD_SEEK_MS = 120;
// Used when nudging can't correct drift on this device (WebKit ignores small speed changes).
export const DRIFT_SEEK_NO_NUDGE_MS = 40;
export const NUDGE_FRACTION = 0.02;

/**
 * Drift policy. `driftMs` is client position minus expected position (positive = client ahead).
 * Returns { action: 'none' | 'nudge' | 'seek', speedFactor }.
 * Nudge slows a client that is ahead and speeds up one that is behind.
 */
export function decideDriftAction(driftMs, { allowNudge = true, hardSeekMs = DRIFT_HARD_SEEK_MS } = {}) {
    const abs = Math.abs(driftMs);
    if (abs < DRIFT_IGNORE_MS) return { action: 'none', speedFactor: 1 };
    if (abs >= hardSeekMs) return { action: 'seek', speedFactor: 1 };
    if (!allowNudge) return { action: 'none', speedFactor: 1 };
    return { action: 'nudge', speedFactor: driftMs > 0 ? 1 - NUDGE_FRACTION : 1 + NUDGE_FRACTION };
}

/**
 * Watches whether speed nudges actually reduce drift. A nudge should close drift at
 * NUDGE_FRACTION x speed song-ms per wall-ms; after `windowMs` of continuous nudging, closing
 * less than `minFraction` of that marks nudging ineffective. `update` returns true when it does.
 */
export class NudgeMonitor {
    constructor({ windowMs = 3000, minFraction = 0.25 } = {}) {
        this.windowMs = windowMs;
        this.minFraction = minFraction;
        this.start = null;
    }
    reset() { this.start = null; }
    /** Call on each drift sample (song ms); `nudging` false restarts the window. */
    update(nowMs, driftMs, nudging, speed = 1) {
        if (!nudging) { this.start = null; return false; }
        if (!this.start) { this.start = { at: nowMs, abs: Math.abs(driftMs) }; return false; }
        const elapsed = nowMs - this.start.at;
        if (elapsed < this.windowMs) return false;
        const expected = NUDGE_FRACTION * (speed || 1) * elapsed;
        const closed = this.start.abs - Math.abs(driftMs);
        this.start = { at: nowMs, abs: Math.abs(driftMs) };
        return closed < this.minFraction * expected;
    }
}

/** Smooths noisy heartbeat drift with a short sliding median. */
export class DriftFilter {
    constructor(size = 5) {
        this.size = size;
        this.values = [];
    }
    push(v) {
        this.values.push(v);
        if (this.values.length > this.size) this.values.shift();
        return median(this.values);
    }
    reset() { this.values = []; }
}

/** Host lead time before a scheduled start: max(default, worst RTT/2 + margin), clamped. */
export function computeLeadMs(peerRttsMs, { override = 0, margin = 70, min = 80, max = 400, base = 150 } = {}) {
    if (override > 0) return Math.min(max, Math.max(min, override));
    const worst = peerRttsMs.reduce((m, r) => Math.max(m, (Number(r) || 0) / 2 + margin), 0);
    return Math.min(max, Math.max(min, Math.max(base, worst)));
}
