// decodedAudioSource.js
// A MediaSource (see mediaSource.js) that plays an audio file the person supplied from decoded samples instead of
// through an HTMLAudioElement. The reason is the clock. An <audio> element places a seek from an estimate it makes of
// the file (a variable-bitrate MP3's header table, an Ogg file's length), and some webviews get that estimate wrong:
// WebKit reports an Ogg Opus file 26 s too long and lands a seek up to 24 s off, and a VBR MP3 lands a second or two
// off in Chromium and WebKit alike. The sync points are in the file's real time, so every cursor position after such
// a seek is wrong. Decoded samples have no estimate: a position is a sample number, in every format and engine.
//
// Slow-down practice keeps its pitch with SoundTouch (an AudioWorklet): the source plays at the practice rate, which
// lowers the pitch, and the node puts the pitch back. At 100% there is no stretcher in the path. The stretcher holds
// its output back by a fixed amount, which the clock subtracts (see STRETCH_DELAY_MS).
//
// Third-party: @soundtouchjs/audio-worklet (SoundTouchJS, MPL-2.0), loaded unmodified. The build copies it into
// vendor/ and replaces these addresses (build/tauri/prepare-tauri-frontend.mjs).

import { getMasterVolume, onMasterVolume } from '../utils/masterVolume.js';

const SOUNDTOUCH_NODE_URL = 'https://cdn.jsdelivr.net/npm/@soundtouchjs/audio-worklet@2.1.1/.dist/SoundTouchNode.js';
const SOUNDTOUCH_PROCESSOR_URL = 'https://cdn.jsdelivr.net/npm/@soundtouchjs/audio-worklet@2.1.1/.dist/soundtouch-processor.js';

/**
 * A decoded stereo song is about 10.5 MB a minute as 32-bit floats. Past this the decode is not attempted and the
 * caller falls back to the audio element, whose clock can be off after a seek but which streams the file.
 */
export const MAX_DECODED_SECONDS = 15 * 60;

/**
 * How long SoundTouch holds its output back, by practice rate, measured with a noise burst at a known position in
 * WebKit (macOS) at 44.1 kHz: 89 ms at 50%, then 117 to 134 ms from 60% to 95%. Linear between the points; it is the
 * processor's own buffering, so it does not depend on the song.
 */
const STRETCH_DELAY_MS = [[0.5, 89], [0.6, 117], [0.7, 124], [0.75, 130], [0.8, 124], [0.9, 130], [0.95, 129]];

export function stretchDelayMs(rate) {
    if (rate >= 0.995) return 0;
    const table = STRETCH_DELAY_MS;
    if (rate <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (rate <= table[i][0]) {
            const [x0, y0] = table[i - 1];
            const [x1, y1] = table[i];
            return y0 + (y1 - y0) * (rate - x0) / (x1 - x0);
        }
    }
    return table[table.length - 1][1];
}

/** Whether this webview has what decoded playback needs. */
export function decodedPlaybackSupported() {
    try {
        const Ctx = globalThis.AudioContext;
        return typeof Ctx === 'function' && 'audioWorklet' in Ctx.prototype && typeof globalThis.WebAssembly !== 'undefined';
    } catch { return false; }
}

let sharedContext = null;
function getContext() {
    if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext();
    return sharedContext;
}

let soundTouchLoad = null;
/** Loads SoundTouch and registers its processor once for the shared context. Resolves with the node class. */
function loadSoundTouch(ctx) {
    soundTouchLoad ||= (async () => {
        const { SoundTouchNode } = await import(SOUNDTOUCH_NODE_URL);
        // Fetched and handed over as a blob so it loads the same way under every address scheme the app is served on
        const code = await (await fetch(SOUNDTOUCH_PROCESSOR_URL)).text();
        const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        try { await SoundTouchNode.register(ctx, blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
        return SoundTouchNode;
    })().catch((e) => { soundTouchLoad = null; throw e; });
    return soundTouchLoad;
}

const MIN_RATE = 0.25;
const MAX_RATE = 2;
const START_LEAD_S = 0.02;
const TIME_EVENT_MS = 250;
const MAX_EXTRAPOLATE_MS = 50;

/**
 * @param {object} file `{ id, name, type, data: ArrayBuffer, durationMs }`
 * @returns the MediaSource, with `ready()` (decodes) and `destroy()`
 */
export function createDecodedAudioSource(file) {
    const ctx = getContext();
    const gain = ctx.createGain();
    gain.gain.value = getMasterVolume();
    gain.connect(ctx.destination);
    const offVolume = onMasterVolume((v) => { gain.gain.value = v; });

    const listeners = new Set();
    const emit = (type, detail = {}) => listeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[Audio Sync] listener error:', e); }
    });

    let buffer = null;
    let SoundTouchNode = null;
    let playing = false;
    let rate = 1;
    let offsetSec = 0;      // content position at the anchor
    let anchorCtxTime = 0;  // context time the anchor was played from
    let anchorDelaySec = 0; // stretcher delay for the node playing now
    let source = null;
    let stretch = null;
    let timeTimer = null;
    let lastCtxTime = -1;
    let lastPerf = 0;
    let lastMs = 0;

    const durationSec = () => (buffer ? buffer.duration : (file.durationMs || 0) / 1000);

    function contentSec() {
        if (!playing) return offsetSec;
        let t = ctx.currentTime;
        const now = performance.now();
        if (t !== lastCtxTime) { lastCtxTime = t; lastPerf = now; }
        else t += Math.min(now - lastPerf, MAX_EXTRAPOLATE_MS) / 1000;
        const sec = offsetSec + Math.max(0, t - anchorCtxTime - anchorDelaySec) * rate;
        return Math.min(sec, durationSec());
    }

    function stopNodes() {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch { /* not started */ }
            source.disconnect();
            source = null;
        }
        if (stretch) { stretch.disconnect(); stretch = null; }
    }

    function startNodes() {
        stopNodes();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        if (rate !== 1 && SoundTouchNode) {
            stretch = new SoundTouchNode({ context: ctx });
            stretch.playbackRate.value = rate;
            stretch.pitch.value = 1;
            src.connect(stretch);
            stretch.connect(gain);
            anchorDelaySec = stretchDelayMs(rate) / 1000;
        } else {
            src.connect(gain);
            anchorDelaySec = 0;
        }
        const when = ctx.currentTime + START_LEAD_S;
        anchorCtxTime = when;
        lastCtxTime = -1;
        src.onended = () => {
            if (src !== source || !playing) return;
            offsetSec = durationSec();
            finish();
        };
        src.start(when, offsetSec);
        source = src;
    }

    function finish() {
        playing = false;
        stopNodes();
        clearInterval(timeTimer);
        timeTimer = null;
        emit('state', { playing: false });
        emit('ended');
    }

    function beginTimeEvents() {
        clearInterval(timeTimer);
        timeTimer = setInterval(() => emit('time'), TIME_EVENT_MS);
    }

    function reanchor() {
        offsetSec = contentSec();
        if (playing) startNodes();
    }

    return {
        kind: 'local',
        id: file.id,
        get durationMs() { return durationSec() ? durationSec() * 1000 : null; },
        capabilities: { waveform: true, preciseClock: true, pitchPreservedRate: true },
        getTimeMs() {
            const ms = contentSec() * 1000;
            // Hold steady rather than step back by the rounding of the context clock
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
            if (!buffer) throw new Error('The audio is not ready');
            if (ctx.state !== 'running') await ctx.resume();
            if (playing) return;
            if (offsetSec >= durationSec() - 0.01) offsetSec = 0;
            playing = true;
            startNodes();
            beginTimeEvents();
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
        isBuffering: () => false,
        on(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        error: null,
        /** Decodes the file. Resolves with the duration in ms, or rejects if this webview cannot decode the format. */
        async ready() {
            if (buffer) return this.durationMs;
            if (file.durationMs && file.durationMs / 1000 > MAX_DECODED_SECONDS) {
                throw new Error('This recording is too long to hold in memory');
            }
            SoundTouchNode = await loadSoundTouch(ctx);
            try {
                // decodeAudioData takes the bytes it is given, so hand it a copy and keep the stored file intact
                buffer = await ctx.decodeAudioData(file.data.slice(0));
            } catch {
                throw new Error('This audio format is not supported on this device');
            }
            if (buffer.duration > MAX_DECODED_SECONDS) {
                buffer = null;
                throw new Error('This recording is too long to hold in memory');
            }
            return this.durationMs;
        },
        destroy() {
            playing = false;
            stopNodes();
            clearInterval(timeTimer);
            gain.disconnect();
            listeners.clear();
            offVolume();
            buffer = null;
        }
    };
}
