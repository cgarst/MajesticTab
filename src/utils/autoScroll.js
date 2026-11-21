/**
 * Auto-scroll for a text or PDF tab that has no sound and no map points.
 *
 * Play moves the reading marker down the tab at a steady pace and the page follows it the way it follows a recording: the
 * same marker, the same paged turn, the same page strip (`src/textSync/textSync.js`). It does that by being a recording
 * of its own, a clock that never touches audio, with points laid evenly over the tab's lines (or pages).
 *
 * The clock runs in "base time", where one text line or staff system takes UNIT_MS and a PDF page PDF_PAGE_MS at 1.0x.
 * The pace multiplies how fast the clock runs, so a change of pace needs no new points and never moves the marker.
 * The pace is kept per tab.
 */

export const AUTO_EVENT = 'majestictab:auto-scroll';
export const PACE_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];
export const UNIT_MS = 5000;
export const PDF_PAGE_MS = 30000;
const STORE = 'majestic_autoscroll_pace_';

/** The step next to `cur` (dir -1 slower, +1 faster), clamped. A value between steps moves to the one beyond it. */
export function stepPace(cur, dir) {
    let i = 0;
    for (let k = 0; k < PACE_STEPS.length; k++) if (Math.abs(PACE_STEPS[k] - cur) < Math.abs(PACE_STEPS[i] - cur)) i = k;
    if (Math.abs(PACE_STEPS[i] - cur) > 1e-6) i = dir > 0 ? (PACE_STEPS[i] > cur ? i : i + 1) : (PACE_STEPS[i] < cur ? i : i - 1);
    else i += dir;
    return PACE_STEPS[Math.max(0, Math.min(PACE_STEPS.length - 1, i))];
}

/** "1.0×", "0.75×", "1.5×" */
export function formatPace(x) {
    const r = Math.round(x * 100) / 100;
    return `${Number.isInteger(r) ? r.toFixed(1) : String(r)}×`;
}

/** One point per unit, evenly timed; `total` is where the last unit ends. */
export function buildAutoPoints(ids, unitMs) {
    const points = ids.map((id, i) => ({ id: `auto-${i}`, barIndex: id, occurrence: 0, pos: 0, timeMs: i * unitMs }));
    return { points, total: ids.length * unitMs };
}

// ---- The clock ----

let available = false;
let tabKey = '';
let speed = 1;
let base = 0;          // base time at `since` (or where it rests while paused)
let since = null;      // performance.now() when it last started, null while paused
let total = 0;

const emit = () => window.dispatchEvent(new Event(AUTO_EVENT));
const clamp = (v) => Math.max(0, Math.min(total || 0, v));

function readSpeed(key) {
    try {
        const v = Number(localStorage.getItem(STORE + key));
        return PACE_STEPS.includes(v) ? v : 1;
    } catch { return 1; }
}

export const isAutoScrollAvailable = () => available;
export const isAutoScrolling = () => since !== null;
export const getAutoPace = () => speed;

/** textSync says whether the open tab has nothing else to play. `key` names the tab for the remembered pace. */
export function setAutoScrollAvailable(on, key = '') {
    const changed = on !== available || (on && key !== tabKey);
    if (on && key !== tabKey) { tabKey = key; speed = readSpeed(key); }
    if (!on && since !== null) pause(false);
    available = Boolean(on);
    if (changed) emit();
}

export function setAutoTotal(ms) {
    if (ms === total) return;
    total = ms;
    if (base > total) base = total;
}

function now() { return performance.now(); }
function timeMs() {
    if (since === null) return base;
    const t = base + (now() - since) * speed;
    if (total && t >= total) { base = total; since = null; emit(); return base; }
    return t;
}
function pause(announce = true) {
    if (since === null) return;
    base = clamp(timeMs());
    since = null;
    if (announce) emit();
}
function play() {
    if (since !== null || !available) return;
    if (total && base >= total - 1) base = 0;
    since = now();
    emit();
}
function seek(ms) {
    const was = since !== null;
    base = clamp(ms);
    since = was ? now() : null;
    emit();
}

export function toggleAutoScroll() { if (since !== null) pause(); else play(); }
/** Back 10 seconds of reading at the current pace. */
export function rewindAutoScroll() { seek(timeMs() - 10000 * speed); }
export function resetAutoScroll() { const was = since !== null || base !== 0; base = 0; since = null; if (was) emit(); }

export function stepAutoPace(dir) {
    const next = stepPace(speed, dir);
    if (next === speed) return;
    base = clamp(timeMs());
    if (since !== null) since = now();
    speed = next;
    try { localStorage.setItem(STORE + tabKey, String(speed)); } catch { /* storage full or blocked */ }
    emit();
}

/** The recording the tab follows, shaped like the other sources in textSync.js. */
export const autoSource = {
    kind: 'auto',
    id: 'auto',
    get durationMs() { return total || null; },
    getTimeMs: timeMs,
    seek,
    play,
    pause: () => pause(),
    isPlaying: () => since !== null,
    isBuffering: () => false
};

// ---- The dock's Slower / Faster group ----

export function initAutoScrollDock() {
    const slower = document.getElementById('dockPaceSlower');
    const faster = document.getElementById('dockPaceFaster');
    const value = document.getElementById('dockPaceValue');
    if (!slower || !faster || !value) return;
    const paint = () => {
        document.body.classList.toggle('auto-scroll-on', available);
        value.textContent = formatPace(speed);
        slower.disabled = speed <= PACE_STEPS[0];
        faster.disabled = speed >= PACE_STEPS[PACE_STEPS.length - 1];
    };
    slower.addEventListener('click', (e) => { e.stopPropagation(); stepAutoPace(-1); });
    faster.addEventListener('click', (e) => { e.stopPropagation(); stepAutoPace(1); });
    window.addEventListener(AUTO_EVENT, paint);
    paint();
}
