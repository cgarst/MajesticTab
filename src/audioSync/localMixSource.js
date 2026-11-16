// localMixSource.js
// A MediaSource (see mediaSource.js) that plays several audio files at once through HTMLAudioElements, streaming each
// enabled part from an object URL. This is the fallback for decodedMixSource.js when a recording is too long to hold
// in memory as decoded PCM (e.g. >15 minutes) or when AudioWorklet/WebAudio decoding is unavailable.
//
// The base part (index 0) keeps the clock, length and `ended` event. Other parts are created lazily when enabled and
// torn down when muted so muted stems do not hold open decoders. Secondary parts are kept in sync with the base
// element on play, seek, rate change and periodic drift checks.

import { getMasterVolume, onMasterVolume } from '../utils/masterVolume.js';
import { getContext, MIN_RATE, MAX_RATE } from './decodedAudioSource.js';
import { MAX_LEVEL } from './decodedMixSource.js';

const MAX_EXTRAPOLATE_MS = 100;
const BACKWARD_SLACK_MS = 80;
const DRIFT_THRESHOLD_S = 0.04;

const clampLevel = (v) => Math.min(MAX_LEVEL, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 1));

function defaultCreateAudio() {
    const audio = new Audio();
    audio.preload = 'auto';
    for (const prop of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) {
        if (prop in audio) audio[prop] = true;
    }
    return audio;
}

function waitMetadata(audio) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onReady = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('This audio format is not supported on this device')); };
        const cleanup = () => {
            audio.removeEventListener('loadedmetadata', onReady);
            audio.removeEventListener('error', onError);
        };
        audio.addEventListener('loadedmetadata', onReady, { once: true });
        audio.addEventListener('error', onError, { once: true });
    });
}

/**
 * @param {object} spec `{ id, base, stems, mutableBase?, context?, createAudio? }`
 *   base:  `{ id, name, type, data: ArrayBuffer, durationMs }`, keeps the clock, loaded by `ready()`
 *   stems: `[{ id, name, type, data, durationMs, level? }]`, off until `setPartEnabled`
 *   mutableBase: true for a stem set with no full mix, where the base part can be muted (silenced while keeping the clock)
 *   context, createAudio: injected for tests
 * @returns the MediaSource, with `ready()`, `destroy()`, `parts()`, `setPartEnabled(id, on)` and `setPartLevel(id, level)`
 */
export function createLocalMixSource({ id, base, stems = [], mutableBase = false, context, createAudio = defaultCreateAudio } = {}) {
    let ctx = context || null;
    if (!ctx && typeof globalThis.AudioContext === 'function') {
        try { ctx = getContext(); } catch { ctx = null; }
    }

    let master = null;
    if (ctx && typeof ctx.createGain === 'function') {
        master = ctx.createGain();
        master.gain.value = getMasterVolume();
        master.connect(ctx.destination);
    }

    const parts = [base, ...stems].map((file, i) => ({
        file, base: i === 0, enabled: i === 0, level: clampLevel(file.level ?? 1),
        audio: null, url: null, mediaSource: null, gain: null, loading: null,
    }));
    const byId = (partId) => parts.find((p) => p.file.id === partId);
    const gainOf = (p) => (p.enabled ? p.level : 0);

    function applyPartOutput(p) {
        if (!p.audio) return;
        if (p.gain) {
            p.gain.gain.value = gainOf(p);
            p.audio.muted = false;
        } else {
            p.audio.muted = !p.enabled;
            try { p.audio.volume = Math.min(1, p.level * getMasterVolume()); } catch { /* read-only on iOS */ }
        }
    }

    const offVolume = onMasterVolume((v) => {
        if (master) master.gain.value = v;
        else parts.forEach(applyPartOutput);
    });

    const listeners = new Set();
    const emit = (type, detail = {}) => listeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[Audio Mix] listener error:', e); }
    });

    let rate = 1;
    let buffering = false;
    let destroyed = false;
    let lastReadMs = -1;
    let lastChangeAt = 0;
    let lastEstimate = 0;

    const leadAudio = () => parts[0].audio;
    const durationSec = () => {
        const a = leadAudio();
        if (a && Number.isFinite(a.duration)) return a.duration;
        return base.durationMs ? base.durationMs / 1000 : null;
    };
    const resetClock = () => {
        const a = leadAudio();
        lastReadMs = -1;
        lastEstimate = (a ? a.currentTime : 0) * 1000;
    };

    function syncDrift() {
        const lead = leadAudio();
        if (!lead) return;
        const target = lead.currentTime;
        for (const p of parts) {
            if (p.base || !p.audio || !p.enabled || p.audio.seeking) continue;
            if (Math.abs(p.audio.currentTime - target) > DRIFT_THRESHOLD_S) {
                p.audio.currentTime = target;
            }
        }
    }

    function teardownPart(p) {
        if (p.mediaSource) { try { p.mediaSource.disconnect(); } catch { /* ignore */ } p.mediaSource = null; }
        if (p.gain) { try { p.gain.disconnect(); } catch { /* ignore */ } p.gain = null; }
        if (p.audio) {
            p.audio.pause();
            p.audio.removeAttribute('src');
            if (typeof p.audio.load === 'function') p.audio.load();
            p.audio = null;
        }
        if (p.url) {
            try { URL.revokeObjectURL(p.url); } catch { /* ignore */ }
            p.url = null;
        }
    }

    function attachLeadEvents(audio) {
        audio.addEventListener('play', () => { resetClock(); emit('state', { playing: true }); });
        audio.addEventListener('pause', () => {
            if (audio.ended) return;
            resetClock();
            emit('state', { playing: false });
        });
        audio.addEventListener('ended', () => {
            for (const p of parts) { if (!p.base && p.audio) p.audio.pause(); }
            emit('state', { playing: false });
            emit('ended');
        });
        audio.addEventListener('ratechange', () => { resetClock(); emit('rate', { rate: audio.playbackRate }); });
        audio.addEventListener('seeked', () => { resetClock(); emit('time'); });
        audio.addEventListener('timeupdate', () => { syncDrift(); emit('time'); });
        audio.addEventListener('waiting', () => { buffering = true; emit('buffering', { buffering: true }); });
        for (const t of ['playing', 'canplay']) {
            audio.addEventListener(t, () => {
                if (buffering) { buffering = false; emit('buffering', { buffering: false }); }
            });
        }
    }

    function loadPart(p) {
        if (p.audio) return Promise.resolve();
        p.loading ||= (async () => {
            const url = URL.createObjectURL(new Blob([p.file.data], { type: p.file.type || 'audio/mpeg' }));
            const audio = createAudio();
            audio.playbackRate = rate;
            audio.src = url;
            p.url = url;
            p.audio = audio;
            if (p.base) attachLeadEvents(audio);

            if (master && ctx && typeof ctx.createMediaElementSource === 'function') {
                try {
                    const mediaSource = ctx.createMediaElementSource(audio);
                    const gain = ctx.createGain();
                    mediaSource.connect(gain);
                    gain.connect(master);
                    p.mediaSource = mediaSource;
                    p.gain = gain;
                } catch { /* fall back to element volume/muted */ }
            }
            applyPartOutput(p);
            try {
                await waitMetadata(audio);
            } catch (e) {
                teardownPart(p);
                throw e;
            }
            if (destroyed || (!p.base && !p.enabled)) {
                teardownPart(p);
            }
        })().finally(() => { p.loading = null; });
        return p.loading;
    }

    return {
        kind: 'local',
        id,
        get durationMs() {
            const s = durationSec();
            return s !== null ? s * 1000 : null;
        },
        capabilities: { waveform: true, preciseClock: true, pitchPreservedRate: true, multiPart: true },
        getTimeMs() {
            const audio = leadAudio();
            if (!audio) return 0;
            const reported = audio.currentTime * 1000;
            const now = performance.now();
            if (reported !== lastReadMs) {
                lastReadMs = reported;
                lastChangeAt = now;
            }
            if (audio.paused || audio.ended) {
                lastEstimate = reported;
                return reported;
            }
            let estimate = reported + Math.min(now - lastChangeAt, MAX_EXTRAPOLATE_MS) * audio.playbackRate;
            if (estimate < lastEstimate && lastEstimate - estimate < BACKWARD_SLACK_MS) estimate = lastEstimate;
            lastEstimate = estimate;
            return estimate;
        },
        seek(ms) {
            const maxSec = durationSec();
            const sec = maxSec !== null ? Math.min(Math.max(0, ms) / 1000, maxSec) : Math.max(0, ms) / 1000;
            for (const p of parts) {
                if (p.audio) p.audio.currentTime = sec;
            }
            resetClock();
            emit('time');
        },
        async play() {
            const lead = leadAudio();
            if (!lead) throw new Error('The audio is not ready');
            if (ctx && ctx.state && ctx.state !== 'running' && typeof ctx.resume === 'function') {
                await ctx.resume();
            }
            const target = lead.currentTime;
            for (const p of parts) {
                if (!p.base && p.audio && p.enabled && Math.abs(p.audio.currentTime - target) > 0.02) {
                    p.audio.currentTime = target;
                }
            }
            const active = parts.filter((p) => p.audio && (p.base || p.enabled));
            await Promise.all(active.map((p) => p.audio.play()));
        },
        pause() {
            for (const p of parts) {
                if (p.audio) p.audio.pause();
            }
        },
        setRate(r) {
            const next = Math.min(MAX_RATE, Math.max(MIN_RATE, Number(r) || 1));
            if (next === rate) return;
            rate = next;
            for (const p of parts) {
                if (p.audio) p.audio.playbackRate = rate;
            }
            resetClock();
            emit('rate', { rate });
        },
        getRate: () => rate,
        isPlaying: () => {
            const a = leadAudio();
            return Boolean(a && !a.paused && !a.ended);
        },
        isBuffering: () => buffering || parts.some((p) => Boolean(p.loading)),
        on(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        get error() { return leadAudio()?.error || null; },
        parts: () => parts.map((p) => ({
            id: p.file.id, name: p.file.name, base: p.base, enabled: p.enabled, level: p.level, loading: Boolean(p.loading),
        })),
        async setPartEnabled(partId, on) {
            const p = byId(partId);
            if (!p || p.enabled === Boolean(on)) return;
            if (p.base) {
                if (!mutableBase) return;
                p.enabled = Boolean(on);
                applyPartOutput(p);
                emit('parts');
                return;
            }
            if (!on) {
                p.enabled = false;
                teardownPart(p);
                emit('parts');
                return;
            }
            p.enabled = true;
            emit('buffering');
            try {
                await loadPart(p);
            } catch (e) {
                p.enabled = false;
                emit('parts');
                throw e;
            }
            if (destroyed || !p.enabled || !p.audio) { teardownPart(p); return; }
            const lead = leadAudio();
            if (lead) {
                p.audio.currentTime = lead.currentTime;
                if (!lead.paused && !lead.ended) {
                    try { await p.audio.play(); } catch { /* ignore */ }
                }
            }
            emit('parts');
        },
        setPartLevel(partId, level) {
            const p = byId(partId);
            if (!p) return;
            p.level = clampLevel(level);
            applyPartOutput(p);
            emit('parts');
        },
        async ready() {
            if (parts[0].audio) return this.durationMs;
            await loadPart(parts[0]);
            return this.durationMs;
        },
        destroy() {
            destroyed = true;
            for (const p of parts) teardownPart(p);
            if (master) { try { master.disconnect(); } catch { /* ignore */ } master = null; }
            listeners.clear();
            offVolume();
        }
    };
}
