// looseFollow.js
// A Guitar Pro tab whose Original recording has no sync points cannot be followed beat by beat, but the page can still
// keep up with it roughly: the recording's length is laid over the score's length (repeats expanded, as the synth
// plays it) and a reading marker, the one the text tabs have, glides down the left edge of the score at that pace. It is
// not tied to a staff group: it sweeps down through the line of music the estimate is in and on into the next, the page
// scrolls to keep it in view (or turns when it reaches the end of the page), and there is no cursor, because the estimate
// is off by a few bars. Nothing is stored: a recording that needs to be exact gets sync points (Sync).

import { getActiveRecording } from './realAudioController.js';
import { getSongKey, playerState } from '../soundPlayer.js';
import { loadRecord } from './syncStore.js';
import { isJamGuestFollowing } from './jamBridge.js';
import { midiSynthActive } from '../classtab/midiSynth.js';
import { getMidiTickLookup, emitEstimatedPosition, onUserSeekTick } from '../gpProcessor/gpPlayer.js';
import { followTarget, glide } from '../textSync/readingLine.js';
import { buildBeatMap } from './beatMap.js';
import { createCursorGlide } from './cursorGlide.js';
import { buildScoreTimeline, playedBarsFromLookup, scoreMsToPosition, scoreMsToTick, tickToScoreMs } from './scorePositions.js';

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
let offsetMs = 0;        // Earlier / Later: a shift of the estimate, kept until the recording is sought or changes
let offsetRec = '';
let lastT = null;
let lastEst = 0;
let lastEmitTick = -1;
let seekGuardUntil = 0;
let ends = [false, false]; // whether there is a line before / after the one the estimate is in
let active = false;

export const isLooseFollowing = () => active;
/** [a line before, a line after] the current one, for Earlier and Later */
export const nudgeEnds = () => ends;

const emit = () => window.dispatchEvent(new Event(LOOSE_EVENT));

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

function systemIndexOf(api, barIndex) {
    const systems = api.renderer?.boundsLookup?.staffSystems || [];
    return { i: systems.findIndex((sys) => (sys.bars || []).some((b) => b.index === barIndex)), n: systems.length };
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
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (mark) mark.hidden = true;
    curRec = null;
    place = null;
    drawnY = null;
    scrollPos = null;
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
let scrollPos = null;    // the page's scroll as a fraction: the browser rounds what is written to scrollTop, which eats a slow glide's small steps
function frame(now) {
    raf = requestAnimationFrame(frame);
    const rec = curRec;
    const c = ctx;
    const output = $('output');
    if (!rec || !c || !output) return;
    const dt = Math.min(0.1, lastAt ? (now - lastAt) / 1000 : 0.016);
    lastAt = now;

    const t = rec.source.getTimeMs() || 0;
    const recKey = JSON.stringify(rec.media);
    // A different recording, or a seek (the clock jumps), starts the estimate afresh
    if (recKey !== offsetRec || (lastT != null && Math.abs(t - lastT) > 1500 && performance.now() > seekGuardUntil)) offsetMs = 0;
    offsetRec = recKey;
    lastT = t;
    const scoreMs = Math.min(c.total, Math.max(0, t / durationOf(rec) * c.total + offsetMs));
    lastEst = scoreMs;
    // The bar ruler and the bar readout follow the estimate too
    const estTick = scoreMsToTick(c.timeline, scoreMs);
    if (estTick !== lastEmitTick) { lastEmitTick = estTick; emitEstimatedPosition(estTick); }
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
        const si = systemIndexOf(c.api, pos.barIndex);
        const next = [si.i > 0, si.i >= 0 && si.i < si.n - 1];
        if (next[0] !== ends[0] || next[1] !== ends[1]) { ends = next; emit(); }
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
            // Keep our own fractional position unless something else (the user, a seek) moved the page
            if (scrollPos == null || Math.abs(scrollPos - before) > 1.5) scrollPos = before;
            scrollPos = far ? Math.max(0, lineDoc - viewH * 0.2) : glide(scrollPos, target, dt);
            output.scrollTop = scrollPos;
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

/** Moves the estimate to the start of the next (dir 1) or previous (dir -1) line of music. */
export function nudgeLine(dir) {
    const c = ctx;
    if (!c || !curRec) return;
    const systems = c.api.renderer?.boundsLookup?.staffSystems || [];
    const pos = scoreMsToPosition(c.timeline, lastEst);
    const i = systems.findIndex((sys) => (sys.bars || []).some((b) => b.index === pos?.barIndex));
    const first = systems[i + dir]?.bars?.[0]?.index;
    if (i < 0 || first == null) return;
    const starts = c.timeline.bars.filter((b) => b.barIndex === first).map((b) => b.startMs);
    const ahead = starts.filter((ms) => (dir > 0 ? ms > lastEst : ms < lastEst));
    if (!ahead.length) return;
    const target = dir > 0 ? Math.min(...ahead) : Math.max(...ahead);
    offsetMs += target + 1 - lastEst;
}

function scoreMsToTickIn(c, scoreMs) { return scoreMsToTick(c.timeline, scoreMs); }

/**
 * The bar ruler (or a click on the score) was moved to `tick`: the recording goes to where the estimate would put that
 * bar, keeping any Earlier / Later shift, so the score and the ruler stay where they were put and play on from there.
 */
function seekToEstimate(tick) {
    const rec = curRec;
    const c = ctx;
    if (!active || !rec || !c) return;
    const dur = durationOf(rec);
    const target = tickToScoreMs(c.timeline, tick);
    const ms = Math.min(dur, Math.max(0, (target - offsetMs) / c.total * dur));
    seekGuardUntil = performance.now() + 800; // the clock jumps here: it is not a seek that drops the shift
    lastT = ms;
    rec.source.seek(ms);
}

export function initLooseFollow() {
    onUserSeekTick(seekToEstimate);
    setInterval(tick, 250);
}
