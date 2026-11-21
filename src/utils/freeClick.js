/**
 * The free click: a metronome and count-in for a tab that has no tempo of its own.
 *
 * A Guitar Pro score has a tempo map, a synced recording has sync points and a linked MIDI file has its own clicks. A PDF,
 * a text tab with no MIDI, and a recording with no map have none of these, so they get a steady pulse: a BPM and a number
 * of beats per bar, kept per tab. The beats sit on a grid in the transport's own time (the recording's media time, or the
 * auto-scroll clock's base time), so a change of speed moves the beats with the music and a seek never has to be repaired.
 *
 * The grid starts where playing starts, so beat 1 is the moment Play is pressed. Tap sets the BPM from the taps and, when
 * the transport is running, moves the grid so that the tap falls on a beat: tap along once to line it up.
 *
 * textSync.js says when this is the click source (`setFreeClickSource`); the metronome switch and the count-in switch
 * are the ones Practice already has (`synthPlayerState`). Pure parts are exported for tests/freeClick.test.mjs.
 */

export const FREE_EVENT = 'majestictab:free-click';
export const BPM_MIN = 30;
export const BPM_MAX = 240;
export const BPM_DEFAULT = 100;
export const BEAT_CHOICES = [3, 4, 6];
const STORE = 'majestic_free_click_';
const LOOKAHEAD_MS = 120;
const TAP_RESET_MS = 2000;
const TAP_KEEP = 6;

export const clampBpm = (v) => Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(Number(v) || BPM_DEFAULT)));

/** Beat `k` of the grid is at `phase + k * beatMs`. The first beat at or after `timeMs`, as an index. */
export function firstBeatAtOrAfter(timeMs, phase, beatMs) {
    return Math.ceil((timeMs - phase - 1e-6) / beatMs) + 0;
}

/** Beat 1 of a bar is an accent. Works for negative indices, which a seek before the grid's start gives. */
export function isAccent(k, beats) {
    return (((k % beats) + beats) % beats) === 0;
}

/** BPM from tap times (ms), using the last few taps; null until there are two. */
export function bpmFromTaps(times) {
    const t = times.slice(-TAP_KEEP);
    if (t.length < 2) return null;
    return clampBpm(60000 / ((t[t.length - 1] - t[0]) / (t.length - 1)));
}

/** The grid phase that puts a beat at `tapMs`, kept near the old one so it stays a small number. */
export function phaseForTap(tapMs, beatMs) {
    return ((tapMs % beatMs) + beatMs) % beatMs;
}

// ---- State ----

let hooks = null;      // { playClick, isMetronomeOn, isCountInOn }
let source = null;     // the transport the grid is laid over; null when the tab has a click source of its own
let rateOf = () => 1;  // real seconds per transport second, inverted: how fast the transport runs
let tabKey = '';
let bpm = BPM_DEFAULT;
let beats = 4;
let phase = 0;
let tapped = false;
let taps = [];
let timer = 0;
let nextBeat = 0;
let lastNow = null;
let wasPlaying = false;
let countInTimer = 0;

const emit = () => window.dispatchEvent(new Event(FREE_EVENT));

function load(key) {
    bpm = BPM_DEFAULT; beats = 4;
    try {
        const o = JSON.parse(localStorage.getItem(STORE + key) || 'null');
        if (o) { bpm = clampBpm(o.bpm); if (BEAT_CHOICES.includes(o.beats)) beats = o.beats; }
        else {
            const last = Number(localStorage.getItem(STORE + '_last'));
            if (last) bpm = clampBpm(last);
        }
    } catch { /* storage blocked */ }
}
function save() {
    try {
        localStorage.setItem(STORE + tabKey, JSON.stringify({ bpm, beats }));
        localStorage.setItem(STORE + '_last', String(bpm));
    } catch { /* storage full or blocked */ }
}

export const isFreeClick = () => Boolean(source);
export const getFreeTempo = () => ({ bpm, beats });
const beatMs = () => 60000 / bpm;

/** Real milliseconds between beats at the speed the transport runs now. */
const intervalMs = () => beatMs() / (rateOf() || 1);

export function initFreeClick(h) { hooks = h; }

/**
 * textSync says which transport the free click rides, or null when the tab has a click of its own.
 * `getRate` gives how fast the transport runs against the clock (1 at normal speed).
 */
export function setFreeClickSource(src, key = '', getRate = () => 1) {
    const changed = src !== source || (src && key !== tabKey);
    if (src && key !== tabKey) { tabKey = key; load(key); tapped = false; taps = []; }
    if (src !== source) { cancelCountIn(); lastNow = null; wasPlaying = false; }
    source = src || null;
    rateOf = getRate;
    syncTimer();
    if (changed) emit();
}

export function setBpm(v) { bpm = clampBpm(v); save(); lastNow = null; emit(); }
export function stepBpm(dir) { setBpm(bpm + dir); }
export function setBeats(n) { if (!BEAT_CHOICES.includes(n)) return; beats = n; save(); lastNow = null; emit(); }

/** One tap. Sets the BPM once there are two, and the phase when the transport is running. */
export function tap(nowPerf = performance.now()) {
    if (taps.length && nowPerf - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
    taps.push(nowPerf);
    const next = bpmFromTaps(taps);
    if (next) { bpm = next; save(); }
    if (source?.isPlaying?.()) { phase = phaseForTap(source.getTimeMs(), beatMs()); tapped = true; lastNow = null; }
    emit();
}

// ---- The metronome ----

function syncTimer() {
    if (source && !timer) timer = setInterval(tick, 25);
    else if (!source && timer) { clearInterval(timer); timer = 0; }
}

function tick() {
    if (!source || !hooks) return;
    const playing = source.isPlaying() && !source.isBuffering?.();
    if (playing && !wasPlaying && !tapped) { phase = source.getTimeMs(); lastNow = null; }
    wasPlaying = playing;
    if (!playing || !hooks.isMetronomeOn()) { lastNow = null; return; }
    const rate = rateOf() || 1;
    const nowMs = source.getTimeMs();
    const bm = beatMs();
    if (lastNow === null || nowMs < lastNow || nowMs - lastNow > 400 * rate) nextBeat = firstBeatAtOrAfter(nowMs, phase, bm);
    lastNow = nowMs;
    for (let guard = 0; guard < 8; guard++) {
        const at = phase + nextBeat * bm;
        if (at > nowMs + LOOKAHEAD_MS * rate) break;
        if (at >= nowMs - 5) hooks.playClick(isAccent(nextBeat, beats), Math.max(0, (at - nowMs) / rate / 1000));
        nextBeat++;
    }
}

// ---- The count-in ----

export const isCountingIn = () => countInTimer !== 0;

function cancelCountIn() {
    if (countInTimer) { clearTimeout(countInTimer); countInTimer = 0; }
}

/**
 * Plays a bar of clicks and then `start()`. Returns true when it took over (the caller must not start the transport);
 * false when the count-in is off, there is no free click or the transport already runs. A second press cancels it.
 */
export function countInThen(start) {
    if (countInTimer) { cancelCountIn(); return true; }
    if (!source || !hooks?.isCountInOn() || source.isPlaying()) return false;
    let n = 0;
    const step = () => {
        if (n >= beats) { countInTimer = 0; start(); return; }
        hooks.playClick(n === 0);
        n++;
        countInTimer = setTimeout(step, intervalMs());
    };
    step();
    return true;
}

export function stopFreeClick() { cancelCountIn(); }
