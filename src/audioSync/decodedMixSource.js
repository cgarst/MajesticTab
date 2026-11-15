// decodedMixSource.js
// A MediaSource (see mediaSource.js) that plays several audio files at once from decoded samples: a backing track plus
// the stems that its audio lacks (Music Pack SPEC section 8, `without`). All parts start on the same context time and
// run on one clock, each through its own gain, into one bus. Slow-down practice stretches that bus once with
// SoundTouch, as decodedAudioSource.js does for one file, so a mix of four parts costs one stretcher.
//
// Memory: a decoded stereo track is about 21 MB a minute as 32-bit floats. The base part is decoded when the source is
// made ready. A stem is decoded when it is switched on and its samples are released when it is switched off, so only
// the parts that are heard are held. Each part's file bytes stay in memory.
//
// The parts must be time-aligned at offset 0 (SPEC section 8), so one position is the position of every part.

import { getMasterVolume, onMasterVolume } from '../utils/masterVolume.js';
import {
    getContext, loadSoundTouch, stretchDelayMs, MAX_DECODED_SECONDS,
    MIN_RATE, MAX_RATE, START_LEAD_S, TIME_EVENT_MS, MAX_EXTRAPOLATE_MS
} from './decodedAudioSource.js';

export const MAX_LEVEL = 1.5;

/**
 * @param {object} spec `{ id, base, stems, context?, loadStretcher? }`
 *   base:  `{ id, name, type, data: ArrayBuffer, durationMs }`, always on, decoded by `ready()`
 *   stems: `[{ id, name, type, data, durationMs, level? }]`, off until `setPartEnabled`
 *   context, loadStretcher: injected for tests (default: the shared AudioContext and SoundTouch)
 * @returns the MediaSource, with `ready()`, `destroy()`, `parts()`, `setPartEnabled(id, on)` and `setPartLevel(id, level)`
 */
export function createDecodedMixSource({ id, base, stems = [], context, loadStretcher } = {}) {
    const ctx = context || getContext();
    const bus = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = getMasterVolume();
    bus.connect(master);
    master.connect(ctx.destination);
    const offVolume = onMasterVolume((v) => { master.gain.value = v; });

    const listeners = new Set();
    const emit = (type, detail = {}) => listeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[Audio Mix] listener error:', e); }
    });

    const clampLevel = (v) => Math.min(MAX_LEVEL, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : 1));
    const parts = [base, ...stems].map((file, i) => ({
        file, base: i === 0, enabled: i === 0, level: clampLevel(file.level ?? 1),
        buffer: null, loading: null, gain: null, node: null,
    }));
    const byId = (partId) => parts.find((p) => p.file.id === partId);

    let SoundTouchNode = null;
    let playing = false;
    let rate = 1;
    let offsetSec = 0;
    let anchorCtxTime = 0;
    let anchorDelaySec = 0;
    let stretch = null;
    let timeTimer = null;
    let lastCtxTime = -1;
    let lastPerf = 0;
    let lastMs = 0;
    let destroyed = false;

    const baseBuffer = () => parts[0].buffer;
    const durationSec = () => (baseBuffer() ? baseBuffer().duration : (base.durationMs || 0) / 1000);

    function contentSec() {
        if (!playing) return offsetSec;
        let t = ctx.currentTime;
        const now = performance.now();
        if (t !== lastCtxTime) { lastCtxTime = t; lastPerf = now; }
        else t += Math.min(now - lastPerf, MAX_EXTRAPOLATE_MS) / 1000;
        return Math.min(offsetSec + Math.max(0, t - anchorCtxTime - anchorDelaySec) * rate, durationSec());
    }

    /** The content position that a part started at context time `when` has to start from. */
    const contentAt = (when) => offsetSec + Math.max(0, when - anchorCtxTime) * rate;

    function stopPart(p) {
        if (!p.node) return;
        p.node.onended = null;
        try { p.node.stop(); } catch { /* not started */ }
        p.node.disconnect();
        p.node = null;
    }

    function stopNodes() {
        parts.forEach(stopPart);
        if (stretch) { stretch.disconnect(); stretch = null; }
    }

    function startPart(p, when, from) {
        if (!p.enabled || !p.buffer || from >= p.buffer.duration) return;
        if (!p.gain) { p.gain = ctx.createGain(); p.gain.connect(bus); }
        p.gain.gain.value = p.level;
        const src = ctx.createBufferSource();
        src.buffer = p.buffer;
        src.playbackRate.value = rate;
        src.connect(p.gain);
        if (p.base) {
            src.onended = () => {
                if (p.node !== src || !playing) return;
                offsetSec = durationSec();
                finish();
            };
        }
        src.start(when, from);
        p.node = src;
    }

    function startNodes() {
        stopNodes();
        bus.disconnect();
        if (rate !== 1 && SoundTouchNode) {
            stretch = new SoundTouchNode({ context: ctx });
            stretch.playbackRate.value = rate;
            stretch.pitch.value = 1;
            bus.connect(stretch);
            stretch.connect(master);
            anchorDelaySec = stretchDelayMs(rate) / 1000;
        } else {
            bus.connect(master);
            anchorDelaySec = 0;
        }
        const when = ctx.currentTime + START_LEAD_S;
        anchorCtxTime = when;
        lastCtxTime = -1;
        for (const p of parts) startPart(p, when, offsetSec);
    }

    function finish() {
        playing = false;
        stopNodes();
        clearInterval(timeTimer);
        timeTimer = null;
        emit('state', { playing: false });
        emit('ended');
    }

    function decodePart(p) {
        if (p.buffer) return Promise.resolve();
        p.loading ||= (async () => {
            if (p.file.durationMs && p.file.durationMs / 1000 > MAX_DECODED_SECONDS) {
                throw new Error('This recording is too long to hold in memory');
            }
            let buffer;
            try {
                // decodeAudioData detaches the bytes it is given, so hand it a copy and keep the file
                buffer = await ctx.decodeAudioData(p.file.data.slice(0));
            } catch {
                throw new Error('This audio format is not supported on this device');
            }
            if (buffer.duration > MAX_DECODED_SECONDS) throw new Error('This recording is too long to hold in memory');
            p.buffer = buffer;
        })().finally(() => { p.loading = null; });
        return p.loading;
    }

    return {
        kind: 'local',
        id,
        get durationMs() { return durationSec() ? durationSec() * 1000 : null; },
        capabilities: { waveform: false, preciseClock: true, pitchPreservedRate: true, multiPart: true },
        getTimeMs() {
            const ms = contentSec() * 1000;
            if (playing && ms < lastMs && lastMs - ms < 40) return lastMs;
            lastMs = ms;
            return ms;
        },
        seek(ms) {
            offsetSec = Math.min(Math.max(0, ms) / 1000, durationSec());
            lastMs = offsetSec * 1000;
            if (playing) startNodes();
            emit('time');
        },
        async play() {
            if (!baseBuffer()) throw new Error('The audio is not ready');
            if (ctx.state !== 'running') await ctx.resume();
            if (playing) return;
            if (offsetSec >= durationSec() - 0.01) offsetSec = 0;
            playing = true;
            startNodes();
            clearInterval(timeTimer);
            timeTimer = setInterval(() => emit('time'), TIME_EVENT_MS);
            emit('state', { playing: true });
        },
        pause() {
            if (!playing) return;
            offsetSec = contentSec();
            playing = false;
            stopNodes();
            clearInterval(timeTimer);
            timeTimer = null;
            emit('state', { playing: false });
        },
        setRate(r) {
            const next = Math.min(MAX_RATE, Math.max(MIN_RATE, Number(r) || 1));
            if (next === rate) return;
            offsetSec = contentSec();
            rate = next;
            if (playing) startNodes();
            emit('rate', { rate });
        },
        getRate: () => rate,
        isPlaying: () => playing,
        isBuffering: () => parts.some((p) => p.loading),
        on(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        error: null,

        /** The parts, base first: `[{ id, name, base, enabled, level, loading }]`. */
        parts: () => parts.map((p) => ({ id: p.file.id, name: p.file.name, base: p.base, enabled: p.enabled, level: p.level, loading: Boolean(p.loading) })),

        /**
         * Switches a stem on or off. Switching on decodes it first (the audio goes on without it until it is ready), then
         * starts it in step with the others. Switching off releases its samples. The base part cannot be switched off.
         * Rejects when the stem cannot be decoded, and then it stays off.
         */
        async setPartEnabled(partId, on) {
            const p = byId(partId);
            if (!p || p.base || p.enabled === Boolean(on)) return;
            if (!on) {
                p.enabled = false;
                stopPart(p);
                p.buffer = null;
                emit('parts');
                return;
            }
            p.enabled = true;
            emit('buffering');
            try {
                await decodePart(p);
            } catch (e) {
                p.enabled = false;
                emit('parts');
                throw e;
            }
            if (destroyed || !p.enabled) { p.buffer = null; return; }
            if (playing) startPart(p, ctx.currentTime + START_LEAD_S, contentAt(ctx.currentTime + START_LEAD_S));
            emit('parts');
        },

        setPartLevel(partId, level) {
            const p = byId(partId);
            if (!p) return;
            p.level = clampLevel(level);
            if (p.gain) p.gain.gain.value = p.level;
            emit('parts');
        },

        async ready() {
            if (baseBuffer()) return this.durationMs;
            SoundTouchNode = await (loadStretcher ? loadStretcher(ctx) : loadSoundTouch(ctx));
            await decodePart(parts[0]);
            return this.durationMs;
        },
        destroy() {
            destroyed = true;
            playing = false;
            stopNodes();
            clearInterval(timeTimer);
            parts.forEach((p) => { if (p.gain) p.gain.disconnect(); p.buffer = null; });
            bus.disconnect();
            master.disconnect();
            listeners.clear();
            offVolume();
        }
    };
}
