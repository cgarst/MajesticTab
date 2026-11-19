// looseFollow.js
// A Guitar Pro tab whose Original recording has no sync points cannot be followed beat by beat, but the page can still
// keep up with it roughly: the recording's length is laid over the score's length (repeats expanded, as the synth
// plays it) and a reading marker, the one the text tabs have, glides down the left edge of the score at that pace. It is
// not tied to a staff group: it sweeps down through the line of music the estimate is in and on into the next, the page
// scrolls to keep it in view (or turns when it reaches the end of the page), and there is no cursor, because the estimate
// is off by a few bars. "Fix position" lets the player tap the bar being heard, which adds an anchor (recording time to
// score time) and bends the estimate through it. Anchors are app-internal (localStorage), never part of an exported pack.

import { getActiveRecording } from './realAudioController.js';
import { getSongKey, playerState } from '../soundPlayer.js';
import { loadRecord } from './syncStore.js';
import { isJamGuestFollowing } from './jamBridge.js';
import { midiSynthActive } from '../classtab/midiSynth.js';
import { getMidiTickLookup, setScoreClickOverride } from '../gpProcessor/gpPlayer.js';
import { followTarget, glide } from '../textSync/readingLine.js';
import { buildBeatMap } from './beatMap.js';
import { createCursorGlide } from './cursorGlide.js';
import { buildScoreTimeline, playedBarsFromLookup, scoreMsToPosition, scoreMsToTick } from './scorePositions.js';
import { mediaToScore } from './syncMap.js';
import { addAnchor, estimatePoints } from './looseAnchors.js';

export const LOOSE_EVENT = 'majestictab:loose-follow';

const $ = (id) => document.getElementById(id);
const startOf = (b) => b.onNotesX ?? b.visualBounds?.x ?? b.realBounds?.x ?? 0;

let ctx = null;          // { api, lookup, timeline, map, glide, total }
let mark = null;
let shownKey = '';
let raf = 0;
let curRec = null;
let place = null;        // the line of music the marker is in: { parent, top, h, bars }
let drawnY = null;
let holdUntil = 0;
let lastScoreMs = -1;
let active = false;
let fixing = false;
let anchorsKey = '';
let anchors = [];

export const isLooseFollowing = () => active;
export const isFixingPosition = () => fixing;

const emit = () => window.dispatchEvent(new Event(LOOSE_EVENT));

// ---- Anchors ----
const storeKey = (rec) => `majestictab_loose_${getSongKey()}|${JSON.stringify(rec.media)}`;
function readAnchors(rec) {
    const key = storeKey(rec);
    if (key === anchorsKey) return anchors;
    anchorsKey = key;
    try { anchors = JSON.parse(localStorage.getItem(key) || '[]').filter((a) => Number.isFinite(a?.timeMs) && Number.isFinite(a?.scoreMs)); } catch (_) { anchors = []; }
    return anchors;
}
function writeAnchors(rec, list) {
    anchors = list;
    anchorsKey = storeKey(rec);
    try { localStorage.setItem(anchorsKey, JSON.stringify(list)); } catch (_) { /* private window: the anchors last for the session */ }
}
// ---- Context: the score's played bars and beats, rebuilt when the score or its layout changes ----
function context() {
    const api = window.gpApi;
    const lookup = api?.score && getMidiTickLookup(api);
    if (!lookup) return null;
    if (ctx && ctx.api === api && ctx.lookup === lookup) return ctx;
    ctx?.glide.destroy();
    const timeline = buildScoreTimeline(playedBarsFromLookup(lookup), api.score.tempo);
    const map = buildBeatMap(lookup);
    const bars = timeline.bars;
    ctx = { api, lookup, timeline, map, glide: createCursorGlide(api, map), total: bars.length ? bars[bars.length - 1].endMs : 0 };
    shownKey = '';
    api.renderFinished?.on(() => { shownKey = ''; });
    return ctx;
}

function systemBars(api, barIndex) {
    for (const sys of api.renderer?.boundsLookup?.staffSystems || []) {
        const bars = (sys.bars || []).map((b) => b.index);
        if (bars.includes(barIndex)) return bars;
    }
    return [barIndex];
}

function ensureMark() {
    if (mark) return mark;
    mark = document.createElement('div');
    mark.className = 'reading-line loose-line';
    mark.hidden = true;
    mark.setAttribute('aria-hidden', 'true');
    const output = $('output');
    (output?.parentElement || document.body).appendChild(mark);
    const hold = () => { holdUntil = performance.now() + 2000; };
    ['wheel', 'touchstart', 'touchmove'].forEach((type) => output?.addEventListener(type, hold, { passive: true }));
    return mark;
}

// ---- Fix position: tap the bar being heard ----
let offMouseDown = null;
function anchorAt(beat) {
    const c = ctx;
    const index = beat?.voice?.bar?.masterBar?.index;
    const current = getActiveRecording();
    if (!c || !current || index == null) return;
    const t = current.source.getTimeMs() || 0;
    const here = mediaToScore(estimatePoints(readAnchors(current), durationOf(current), c.total), t);
    const choices = c.timeline.bars.filter((b) => b.barIndex === index);
    if (!choices.length) return;
    const bar = choices.reduce((best, b) => (Math.abs(b.startMs - here) < Math.abs(best.startMs - here) ? b : best));
    writeAnchors(current, addAnchor(readAnchors(current), { timeMs: t, scoreMs: bar.startMs }));
    setFixing(false);
    shownKey = '';
}
function setFixing(on) {
    if (fixing === on) return;
    fixing = on;
    document.body.classList.toggle('loose-fixing', on);
    offMouseDown?.();
    offMouseDown = null;
    if (on) {
        // Scroll layout: the score's click goes to the override. Page layout: the beat press is heard here and the tap
        // is kept from turning the page (the same flag a click on a beat sets).
        setScoreClickOverride(anchorAt);
        const api = window.gpApi;
        const handler = (beat) => {
            if (!document.getElementById('pageModeRadio')?.checked || !beat) return;
            window.__lastBeatClickTime = Date.now();
            anchorAt(beat);
        };
        api?.beatMouseDown?.on(handler);
        offMouseDown = () => api?.beatMouseDown?.off?.(handler);
    } else {
        setScoreClickOverride(null);
    }
    emit();
}
export function toggleFixPosition() {
    setFixing(!fixing);
}

const durationOf = (rec) => rec.source.durationMs || (rec.kind === 'youtube' && playerState.duration ? playerState.duration * 1000 : null);

// ---- The loop ----
function eligible() {
    if (!window.gpApi?.score || midiSynthActive) return null;
    const body = document.body;
    if (!$('mobileYtToggleBtn')?.classList.contains('active-audio-mode')) return null;
    if (body.classList.contains('library-view-active') || body.classList.contains('sync-mode')) return null;
    const rec = getActiveRecording();
    if (!rec || rec.kind === 'embedded' || (rec.kind === 'youtube' && isJamGuestFollowing())) return null;
    if (loadRecord(getSongKey(), rec.media)?.points?.length) return null;
    return durationOf(rec) ? rec : null;
}

function stop() {
    if (fixing) setFixing(false);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mark) mark.hidden = true;
    curRec = null;
    place = null;
    drawnY = null;
    shownKey = '';
    document.body.classList.remove('loose-follow');
    if (active) { active = false; emit(); }
}

function tick() {
    const rec = eligible();
    const c = rec && context();
    if (!rec || !c || !c.total) return stop();
    curRec = rec;
    if (!active) { active = true; document.body.classList.add('loose-follow'); emit(); }
    if (!raf) { ensureMark(); lastAt = 0; raf = requestAnimationFrame(frame); }
}

let lastAt = 0;
function frame(now) {
    raf = requestAnimationFrame(frame);
    const rec = curRec;
    const c = ctx;
    const output = $('output');
    if (!rec || !c || !output) return;
    const dt = Math.min(0.1, lastAt ? (now - lastAt) / 1000 : 0.016);
    lastAt = now;

    const points = estimatePoints(readAnchors(rec), durationOf(rec), c.total);
    const scoreMs = Math.min(c.total, Math.max(0, mediaToScore(points, rec.source.getTimeMs() || 0)));
    const pos = scoreMsToPosition(c.timeline, scoreMs);
    if (!pos) return;
    const bars = systemBars(c.api, pos.barIndex);
    const key = `${bars[0]}|${pos.occurrence}`;
    if (key !== shownKey || !place?.parent?.isConnected) {
        // Placing the line's first beat turns the page and puts the (hidden) cursor in that line's block: it says where
        // the line is drawn. The marker does not follow the cursor, only borrows its place.
        const entries = c.map.bars.filter((b) => b.barIndex === bars[0]);
        const start = scoreMsToTickIn(c, scoreMs);
        const entry = [...entries].reverse().find((b) => b.startTick <= start) || entries[0];
        const line = entry && c.glide.locate(entry.startTick);
        if (!line?.from) return;
        c.api.customCursorHandler?.placeBeatCursorNow?.(null, line.from, startOf(line.from));
        const cursor = document.querySelector('.gp-page-cursor-beat') || document.querySelector('.gp-reader-cursor');
        if (!cursor?.parentElement) return;
        const from = drawnY;
        place = { parent: cursor.parentElement, top: parseFloat(cursor.style.top) || 0, h: parseFloat(cursor.style.height) || 100, bars };
        const was = shownKey;
        shownKey = key;
        // The marker eases from where it was to the new line instead of jumping
        if (was && from != null) place.ease = from - lineY(place, pos);
    }
    const y = lineY(place, pos) + (place.ease || 0);
    if (place.ease) place.ease *= Math.exp(-dt / 0.12);
    if (Math.abs(place.ease || 0) < 0.5) place.ease = 0;

    // The page follows the marker the way it follows a text tab's: it roams the upper part of the view, then the page glides
    const outR = output.getBoundingClientRect();
    let yDrawn = y;
    const scrollMode = output.classList.contains('continuous-mode');
    const moved = Math.abs(scoreMs - lastScoreMs) > 800;
    lastScoreMs = scoreMs;
    if (scrollMode && performance.now() > holdUntil && (rec.source.isPlaying() || moved || place.ease)) {
        const viewH = output.clientHeight;
        const lineDoc = y - outR.top + output.scrollTop;
        const target = followTarget({ lineY: lineDoc, viewH, scrollTop: output.scrollTop });
        if (target != null) {
            const before = output.scrollTop;
            const far = Math.abs(target - before) > viewH * 1.2 || matchMedia('(prefers-reduced-motion: reduce)').matches;
            output.scrollTop = far ? Math.max(0, lineDoc - viewH * 0.2) : glide(before, target, dt);
            yDrawn = y - (output.scrollTop - before);
        }
    }
    drawnY = yDrawn;

    const host = mark.parentElement;
    const hostR = host.getBoundingClientRect();
    // The arrow is drawn to the left of its origin: put the origin at the start of the line so the arrow sits in the paper margin
    const left = place.parent.getBoundingClientRect().left + 22;
    mark.hidden = false;
    mark.classList.toggle('is-off', yDrawn < outR.top || yDrawn > outR.bottom);
    mark.style.transform = `translate3d(${left - hostR.left + host.scrollLeft}px, ${yDrawn - hostR.top + host.scrollTop}px, 0)`;
}

/** Screen y of the marker: down through the line of music by how far through its bars the estimate is. */
function lineY(pl, pos) {
    const i = Math.max(0, pl.bars.indexOf(pos.barIndex));
    const f = Math.min(1, (i + pos.pos) / pl.bars.length);
    return pl.parent.getBoundingClientRect().top + pl.top + f * pl.h;
}

function scoreMsToTickIn(c, scoreMs) { return scoreMsToTick(c.timeline, scoreMs); }

export function initLooseFollow() {
    setInterval(tick, 250);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fixing) setFixing(false); });
}
