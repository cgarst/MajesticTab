// chordSynth.js
// Plays a strummed chord through the app's own SoundFont synth (the one the reader uses, with the SoundFont the
// player picked, or the built-in SONiVOX), on the Acoustic Guitar (steel) program. A hidden AlphaTab player holds
// the SoundFont; each strum is a one-off MIDI file handed to that player, so it never touches a song that is open.

import { readMidiFile } from '../classtab/midiReader.js';

const PROGRAM_STEEL_GUITAR = 25;
const DIVISION = 480;   // ticks per quarter note; at 120 bpm one tick is a little over a millisecond
const STRUM_TICKS = 28; // delay between strings of a down-strum
const HOLD_TICKS = 2400;

let api = null;
let hostEl = null;
let ready = false;
let starting = null;

const vlq = (n) => {
    const out = [n & 127];
    while ((n >>= 7)) out.unshift((n & 127) | 128);
    return out;
};

/** A one-track Standard MIDI File: steel guitar program, then each string a little after the last. */
function buildStrumMidi(notes, { holdTicks = HOLD_TICKS } = {}) {
    const events = [{ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }, { tick: 0, bytes: [0xc0, PROGRAM_STEEL_GUITAR] }];
    notes.forEach((n, i) => {
        const on = i * STRUM_TICKS;
        events.push({ tick: on, bytes: [0x90, n, Math.max(60, 104 - i * 3)] });
        events.push({ tick: on + holdTicks, bytes: [0x80, n, 0] });
    });
    events.sort((a, b) => a.tick - b.tick);
    const body = [];
    let last = 0;
    for (const e of events) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0, 0xff, 0x2f, 0);
    const len = body.length;
    return new Uint8Array([
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, DIVISION >> 8, DIVISION & 255,
        0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body
    ]);
}

/** Start the hidden player and load the SoundFont. Safe to call often; resolves true once strums can play. */
export function warmChordSynth() {
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    const at = globalThis.alphaTab;
    if (!at || typeof document === 'undefined') return Promise.resolve(false);
    starting = new Promise(async (resolve) => {
        try {
            hostEl = document.createElement('div');
            hostEl.setAttribute('aria-hidden', 'true');
            hostEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:160px;overflow:hidden;pointer-events:none';
            document.body.appendChild(hostEl);
            api = new at.AlphaTabApi(hostEl, {
                core: { tex: true },
                player: { enablePlayer: true, playerMode: at.PlayerMode.EnabledSynthesizer, enableCursor: false, enableElementHighlighting: false, scrollMode: at.ScrollMode.Off }
            });
            api.tex('\\tempo 120 . 3.3.4');
            const done = () => { ready = true; resolve(true); };
            api.soundFontLoaded?.on(done);
            api.playerReady?.on(done);
            const { applySoundFontsToApi } = await import('../soundFontStore.js');
            await applySoundFontsToApi(api);
            // Give up waiting after a while; a later strum falls back to the built-in sound
            setTimeout(() => resolve(ready), 15000);
        } catch (e) {
            console.warn('[chord synth]', e);
            resolve(false);
        }
    });
    return starting;
}

/** True while the SoundFont player can strum. */
export function chordSynthReady() {
    return ready && Boolean(api?.player);
}

/** Strum MIDI notes (lowest string first) on the SoundFont's steel guitar. Returns false when it is not ready. */
export function strumWithSoundFont(midiNotes, { holdTicks = HOLD_TICKS } = {}) {
    if (!chordSynthReady()) return false;
    try {
        const notes = midiNotes.filter((n) => Number.isFinite(n) && n >= 0 && n <= 127);
        if (!notes.length) return true;
        const { file } = readMidiFile(buildStrumMidi(notes, { holdTicks }), globalThis.alphaTab);
        api.player.playOneTimeMidiFile(file);
        return true;
    } catch (e) {
        console.warn('[chord synth]', e);
        return false;
    }
}

export function releaseChordSynth() {
    try { api?.destroy(); } catch (_) { /* already gone */ }
    hostEl?.remove();
    api = null; hostEl = null; ready = false; starting = null;
}
