// chordStrum.js
// Plays a chord as a strummed acoustic guitar. It uses the app's SoundFont synth (chordSynth.js) when that is
// ready, and until then a built-in plucked-string model (Karplus-Strong through a small body resonance), so a
// click is never silent.

import { getTrackedAudioContext } from './iosAudioUnlock.js';
import { warmChordSynth, strumWithSoundFont } from './chordSynth.js';

/** Begin loading the SoundFont so the first strum already uses it. */
export function prepareChordSound() { warmChordSynth().catch(() => {}); }

let ctx = null;
const bufferCache = new Map();

function getContext() {
    if (typeof window === 'undefined') return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx || ctx.state === 'closed') ctx = getTrackedAudioContext() || new Ctor();
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { /* needs a gesture */ } }
    return ctx;
}

/** One plucked string as an AudioBuffer (cached per pitch and sample rate). */
function pluckBuffer(audio, midi) {
    const key = `${audio.sampleRate}|${midi}`;
    if (bufferCache.has(key)) return bufferCache.get(key);
    const sr = audio.sampleRate;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const seconds = midi < 52 ? 3.2 : 2.6;
    const length = Math.floor(sr * seconds);
    const period = sr / freq;
    const L = Math.floor(period);
    const frac = period - L; // fractional delay by linear interpolation keeps the string in tune
    const buf = audio.createBuffer(1, length, sr);
    const out = buf.getChannelData(0);

    // Excitation: noise softened by a one-pole low-pass (a pick on a string is not white noise)
    const line = new Float32Array(L + 2);
    let seed = (midi * 9301 + 49297) % 233280;
    let prev = 0;
    for (let i = 0; i < line.length; i++) {
        seed = (seed * 9301 + 49297) % 233280;
        const noise = seed / 233280 * 2 - 1;
        prev = prev + 0.55 * (noise - prev);
        line[i] = prev;
    }
    // Lower strings ring longer; high strings fade sooner
    const loss = 0.9965 + Math.min(0.0025, (80 - midi) * 0.00004);
    let idx = 0;
    let lastOut = 0;
    for (let n = 0; n < length; n++) {
        const a = line[idx];
        const b = line[(idx + 1) % line.length];
        const c = line[(idx + 2) % line.length];
        // Averaging two neighbouring samples is the loop low-pass; the fractional part tunes the delay
        const filtered = ((a + b) * 0.5) * (1 - frac) + ((b + c) * 0.5) * frac;
        const y = filtered * loss;
        line[idx] = y;
        idx = (idx + 1) % line.length;
        lastOut = y;
        out[n] = lastOut;
    }
    // Short fade in and out so the buffer never clicks
    const fadeIn = Math.floor(sr * 0.002);
    for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
    const fadeOut = Math.floor(sr * 0.25);
    for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut;
    bufferCache.set(key, buf);
    return buf;
}

/**
 * Strum a chord. `midiNotes` lists one MIDI note per sounding string, lowest string first; null or negative
 * entries (muted strings) are skipped.
 */
export function strumChord(midiNotes, { spread = 0.032, volume = 0.9 } = {}) {
    if (strumWithSoundFont(midiNotes || [])) return;
    prepareChordSound();
    const audio = getContext();
    if (!audio) return;
    const notes = (midiNotes || []).filter(n => Number.isFinite(n) && n >= 0);
    if (!notes.length) return;
    try {
        const now = audio.currentTime + 0.01;

        // Output chain shared by the strum: gentle body resonances and a soft high roll-off
        const master = audio.createGain();
        master.gain.value = volume * Math.min(0.32, 0.9 / Math.sqrt(notes.length) * 0.4);
        const body1 = audio.createBiquadFilter();
        body1.type = 'peaking'; body1.frequency.value = 105; body1.Q.value = 1.1; body1.gain.value = 5;
        const body2 = audio.createBiquadFilter();
        body2.type = 'peaking'; body2.frequency.value = 215; body2.Q.value = 1.4; body2.gain.value = 3;
        const air = audio.createBiquadFilter();
        air.type = 'lowpass'; air.frequency.value = 6500; air.Q.value = 0.5;
        master.connect(body1); body1.connect(body2); body2.connect(air); air.connect(audio.destination);

        notes.forEach((midi, i) => {
            const src = audio.createBufferSource();
            src.buffer = pluckBuffer(audio, midi);
            const g = audio.createGain();
            // Down-strum: each string a little later and a touch softer than the one before
            g.gain.value = 1 - i * 0.03;
            src.connect(g); g.connect(master);
            src.start(now + i * spread);
        });
    } catch (_) { /* audio unavailable */ }
}

/**
 * Play a single note, shorter than a full chord strum.
 * Uses the SoundFont synth when ready, and falls back to synthesized acoustic pluck.
 */
export function playNote(midiNote, { duration = 1.3, volume = 0.9 } = {}) {
    const midi = Number(midiNote);
    if (!Number.isFinite(midi) || midi < 0 || midi > 127) return;
    const holdTicks = Math.round(duration * 2 * 480);
    const releaseTicks = 576;
    if (strumWithSoundFont([midi], { holdTicks, releaseTicks })) return;
    prepareChordSound();
    const audio = getContext();
    if (!audio) return;
    try {
        const now = audio.currentTime + 0.01;

        // Output chain: gentle body resonances and a soft high roll-off
        const master = audio.createGain();
        master.gain.value = volume * 0.35;
        const body1 = audio.createBiquadFilter();
        body1.type = 'peaking'; body1.frequency.value = 105; body1.Q.value = 1.1; body1.gain.value = 5;
        const body2 = audio.createBiquadFilter();
        body2.type = 'peaking'; body2.frequency.value = 215; body2.Q.value = 1.4; body2.gain.value = 3;
        const air = audio.createBiquadFilter();
        air.type = 'lowpass'; air.frequency.value = 6500; air.Q.value = 0.5;
        master.connect(body1); body1.connect(body2); body2.connect(air); air.connect(audio.destination);

        const src = audio.createBufferSource();
        src.buffer = pluckBuffer(audio, midi);
        const g = audio.createGain();
        const sustainSec = Math.max(0.2, duration * 0.6);
        const totalSec = duration + 0.5;
        g.gain.setValueAtTime(1, now);
        g.gain.setValueAtTime(1, now + sustainSec);
        g.gain.exponentialRampToValueAtTime(0.0001, now + totalSec);
        src.connect(g);
        g.connect(master);
        src.start(now);
        src.stop(now + totalSec + 0.05);
    } catch (_) { /* audio unavailable */ }
}
