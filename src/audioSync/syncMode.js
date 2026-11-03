// syncMode.js
// Tap to sync: play a recording and click each bar (or beat) of the tab as you hear it, and every click records a
// sync point at the recording's current time. Two modes: Step Sync walks the score bar by bar (click the target or
// press J, arrow keys skip ahead); Patch Sync is for fixing a stretch of a mostly synced song: the cursor follows the
// current points while it plays, a click on any bar pins that bar to now and replaces the points it contradicts, and
// Fix Range takes two taps (start and end of a bad stretch) and clears the points between them. The recording is the clock, so the taps only need to be roughly right;
// the refine tools tighten them: select a point to nudge it and audition 2 s around it, snap taps (or a point) to the
// nearest sound in a local file, re-tap a range of bars, or pause on a sound and click a beat to put a point there.
// While active, the score switches to scroll view, the follower is suspended (except while auditioning), and score
// clicks are taps instead of cursor moves.

import { getAudioLatencyMs, setScoreClickOverride, pauseSynthPlayer, clearSynthHighlights, getMidiTickLookup, onTransportEvent } from '../gpProcessor/gpPlayer.js';
import { getSongKey, pauseYouTube } from '../youtubePlayer.js';
import { showToast } from '../utils/toast.js';
import { getScoreContext, setAudioSyncSuspended, startAudioSync, stopAudioSync, getAudioSyncSession } from './audioSyncController.js';
import { resolvePoints } from './pointCheck.js';
import { positionToScoreMs, scoreMsToTick } from './scorePositions.js';
import { buildBeatMap, candidatesForBeat, entryAt, nextTarget, firstUnsyncedTarget } from './beatMap.js';
import { chooseTap, patchPlan, rangePlan } from './tapRules.js';
import { loadRecord, saveRecord } from './syncStore.js';
import { makeId, formatTime } from './syncEdit.js';
import { SYNC_CHANGED_EVENT } from './audioSyncEditor.js';
import { createSyncTimeline } from './syncTimeline.js';
import { decodeOnsets, nearestOnset } from './onsets.js';
import { nudgePoint, wholeBarRange, retapWindow } from './refine.js';
import { openTapCalibration } from './tapCalibrationModal.js';
import { isTvMode } from '../tvMode.js';
import { isJamGuestFollowing } from './jamBridge.js';

const OFFSET_KEY = 'audio_sync_tap_offset';
const TIMELINE_KEY = 'audio_sync_timeline';
const SNAP_KEY = 'audio_sync_snap';
const MODE_KEY = 'audio_sync_mode';
const AUDITION_LEAD_MS = 1000;
const AUDITION_TAIL_MS = 1000;
const RETAP_LEAD_MS = 4000;
const RETAP_TAIL_MS = 1500;
const NUDGE_MERGE_MS = 1500;
const YOUTUBE_DEFAULT_RATE = 0.75;
const HISTORY_LIMIT = 100;
const SCROLL_IDLE_MS = 600;

/** Where Step Sync starts: the first bar without a point, but never bar 1, which the recording starts on. */
function startTarget(map, points) {
    const first = map.bars[0];
    return firstUnsyncedTarget(map, first ? [...points, { barIndex: first.barIndex, occurrence: first.occurrence }] : points);
}

const $ = (id) => document.getElementById(id);

let session = null;

export function isSyncModeActive() {
    return Boolean(session);
}

function readOffset() {
    try {
        const n = Number(localStorage.getItem(OFFSET_KEY));
        return Number.isFinite(n) ? Math.min(500, Math.max(0, n)) : 0;
    } catch { return 0; }
}

function readTimelinePref() {
    try {
        const v = localStorage.getItem(TIMELINE_KEY);
        // Closed by default on a phone, where the toolbar already takes a lot of the screen
        return v === null ? window.innerHeight >= 760 && window.innerWidth >= 700 : v === '1';
    } catch { return false; }
}

function readSnapPref() {
    try { return localStorage.getItem(SNAP_KEY) === '1'; } catch { return false; }
}

/** Patch Sync suits a song that already has points; a new song starts with Step Sync. */
function initialMode(hasPoints) {
    if (!hasPoints) return 'step';
    try { return localStorage.getItem(MODE_KEY) === 'step' ? 'step' : 'patch'; } catch { return 'patch'; }
}

function writeOffset(ms) {
    try { localStorage.setItem(OFFSET_KEY, String(ms)); } catch { /* per-viewer convenience only */ }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Switch to scroll view and wait for the score to lay out there. Returns whether it was in page view before. */
async function ensureScrollView() {
    const pageRadio = $('pageModeRadio');
    const scrollRadio = $('continuousModeRadio');
    const wasPage = Boolean(pageRadio?.checked);
    if (wasPage && scrollRadio) {
        scrollRadio.click();
        for (let i = 0; i < 40; i++) {
            await sleep(100);
            const lookup = window.gpApi?.renderer?.boundsLookup;
            if ($('output')?.classList.contains('continuous-mode') && lookup?.staffSystems?.length) break;
        }
        await nextFrame();
    }
    return wasPage;
}

/**
 * Starts tap mode for `source`.
 * @param {object} opts
 * @param {object} opts.source MediaSource
 * @param {object} opts.media the media descriptor the points are stored under
 * @param {Uint8Array|null} [opts.peaks] the waveform, for a local file
 * @param {() => Promise<ArrayBuffer|null>} [opts.getAudioData] the audio of a local file, to find the sounds taps can snap to
 */
export async function enterSyncMode({ source, media, peaks = null, getAudioData = null }) {
    if (session || isTvMode() || (media.kind === 'youtube' && isJamGuestFollowing())) return;
    if (!getScoreContext()) {
        showToast('Open a tab first', 'info', 2000);
        return;
    }
    session = { entering: true };
    const wasPage = await ensureScrollView();
    const ctx = getScoreContext();
    const map = ctx && buildBeatMap(getMidiTickLookup(ctx.api));
    if (!ctx || !map.entries.length) {
        session = null;
        showToast('This tab has nothing to tap yet', 'info', 2000);
        return;
    }

    const container = window.gpState?.canvases?.[0]?.container;
    const output = $('output');
    if (!container || !output) {
        session = null;
        return;
    }
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const overlay = document.createElement('div');
    overlay.className = 'sync-overlay';
    container.append(overlay);

    const songKey = getSongKey();
    const s = session = {
        source, media, peaks, ctx, map, container, output, overlay, songKey, wasPage,
        prevRate: source.getRate?.() ?? 1,
        points: loadRecord(songKey, media)?.points || [],
        undo: [], redo: [],
        granularity: 'bar',
        mode: 'step',
        ghosts: [],
        rangeArmed: false,
        rangeStart: null,
        offsetMs: readOffset(),
        lastTick: null,
        target: null,
        lastUserScrollAt: 0,
        lastTapId: null,
        selectedId: null,
        timelineOpen: readTimelinePref(),
        timeline: null,
        onsets: null,
        snapOn: readSnapPref(),
        lastSnap: null,
        lastCommit: null,
        audition: null,
        retap: null,
        cleanup: []
    };
    s.timeline = createSyncTimeline({
        host: $('smTimeline'),
        getData: () => ({
            timeline: s.ctx.timeline, points: s.points, source: s.source, peaks: s.peaks,
            durationMs: s.source.durationMs ?? null, selectedId: s.selectedId
        }),
        onChangePoints: (next) => { commit(next); retarget(); },
        onSeek: ({ mediaMs }) => { endAudition(); s.source.seek(mediaMs); },
        onSelect: (id) => selectPoint(id),
        onRetap: startRetap
    });
    s.cleanup.push(() => s.timeline.destroy());

    // One audio source at a time, and the cursor must not be moved by the points being edited
    pauseSynthPlayer();
    clearSynthHighlights();
    if (source.kind !== 'youtube') pauseYouTube();
    setAudioSyncSuspended(true);
    s.mode = initialMode(s.points.length > 0);
    setScoreClickOverride(onBeatClick);
    source.setRate(source.kind === 'youtube' ? YOUTUBE_DEFAULT_RATE : 1);

    wireToolbar(s);
    s.target = s.mode === 'step' ? startTarget(map, s.points) : null;
    document.body.classList.add('sync-mode');
    $('syncModeBar').hidden = false;
    // The toolbar docks over the bottom of the score: pad the score by the overlap so every system can be scrolled clear of it
    s.prevPadding = output.style.paddingBottom;
    const padForBar = () => {
        const need = output.getBoundingClientRect().bottom - $('syncModeBar').getBoundingClientRect().top + 8;
        output.style.paddingBottom = `${Math.max(0, Math.round(need))}px`;
    };
    const barObserver = new ResizeObserver(padForBar);
    barObserver.observe($('syncModeBar'));
    s.cleanup.push(() => { barObserver.disconnect(); output.style.paddingBottom = s.prevPadding; });
    padForBar();
    showTimeline(s.timelineOpen);
    applyFollower();
    renderOverlay();
    updateToolbar();
    scrollToTarget(true);
    if (source.capabilities?.waveform && getAudioData) loadOnsets(s, getAudioData);

    const api = ctx.api;
    const onRender = () => { s.rects = null; renderOverlay(); };
    api.renderFinished?.on(onRender);
    s.cleanup.push(() => api.renderFinished?.off?.(onRender));
    const markUserScroll = () => { s.lastUserScrollAt = performance.now(); };
    for (const ev of ['wheel', 'touchmove']) {
        output.addEventListener(ev, markUserScroll, { passive: true });
        s.cleanup.push(() => output.removeEventListener(ev, markUserScroll));
    }
    s.cleanup.push(source.on(() => updateToolbar()));
    s.cleanup.push(onTransportEvent((e) => { if (e.type === 'detached') exitSyncMode(); }));
    const timer = setInterval(updateToolbar, 300);
    s.cleanup.push(() => clearInterval(timer));
    const onKey = (e) => handleKey(e);
    document.addEventListener('keydown', onKey, true);
    s.cleanup.push(() => document.removeEventListener('keydown', onKey, true));
}

export function exitSyncMode() {
    const s = session;
    if (!s || s.entering) return;
    endAudition();
    session = null;
    s.cleanup.forEach((fn) => { try { fn(); } catch { /* already gone */ } });
    s.source.pause();
    s.source.setRate(s.prevRate);
    setScoreClickOverride(null);
    stopAudioSync();
    s.overlay.remove();
    $('syncModeBar').hidden = true;
    document.body.classList.remove('sync-mode');
    setAudioSyncSuspended(false);
    if (s.wasPage) $('pageModeRadio')?.click();
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
}

// --- Taps ----------------------------------------------------------------------------------------------------------

function onBeatClick(beat) {
    const s = session;
    if (!s || s.entering || s.audition) return;
    if (s.source.isBuffering?.()) {
        flash(beat, 'Waiting for the recording');
        return;
    }
    registerTap(withScoreMs(candidatesForBeat(s.map, beat)), beat);
}

/** Step Sync's J key: taps the highlighted target bar. */
function tapTarget() {
    const s = session;
    if (!s || s.entering || s.audition || s.mode !== 'step' || !s.target) return;
    const t = s.target;
    if (s.source.isBuffering?.()) {
        showToast('Waiting for the recording', 'info', 1500);
        return;
    }
    registerTap(withScoreMs([{ barIndex: t.barIndex, occurrence: t.occurrence, pos: t.pos, tick: t.tick }]), t.beat);
}

function withScoreMs(candidates) {
    const s = session;
    return candidates
        .map((c) => ({ ...c, scoreMs: positionToScoreMs(s.ctx.timeline, c) }))
        .filter((c) => c.scoreMs !== null);
}

function registerTap(candidates, beat) {
    const s = session;
    // The clock leads what the user hears by the output latency, and a tap lands a reaction time after the sound
    let timeMs = Math.max(0, Math.round(s.source.getTimeMs() - getAudioLatencyMs() - s.offsetMs));
    // With snap on, a tap that is a little early or late moves to the sound it was meant for
    s.lastSnap = null;
    if (s.snapOn && s.onsets) {
        const hit = nearestOnset(s.onsets, timeMs);
        if (hit) {
            timeMs = Math.max(0, Math.round(hit.timeMs));
            s.lastSnap = Math.round(hit.deltaMs);
        }
    }
    if (s.mode === 'patch') patchTap(candidates, beat, timeMs);
    else stepTap(candidates, beat, timeMs);
}

function stepTap(candidates, beat, timeMs) {
    const s = session;
    const choice = chooseTap(resolvePoints(s.ctx.timeline, s.points), candidates, timeMs);
    if (!choice) {
        flash(beat, 'That bar does not fit between the points around it. Undo, or fix it in Sync Points.');
        return;
    }
    const { candidate, replaceId } = choice;
    const point = {
        id: makeId(), barIndex: candidate.barIndex, occurrence: candidate.occurrence, pos: candidate.pos, timeMs, source: 'tap'
    };
    commit([...s.points.filter((p) => p.id !== replaceId), point].sort((a, b) => a.timeMs - b.timeMs));
    s.lastTick = candidate.tick;
    s.lastTapId = point.id;
    s.target = nextTarget(s.map, s.lastTick, s.granularity);
    navigator.vibrate?.(8);
    renderOverlay(point.id);
    updateToolbar();
    scrollToTarget(false);
}

const pointAt = (c, timeMs) => ({ id: makeId(), barIndex: c.barIndex, occurrence: c.occurrence, pos: c.pos, timeMs, source: 'tap' });

/** Patch Sync: the bar is pinned to now, and the points that contradict it are replaced (one undo step). */
function patchTap(candidates, beat, timeMs) {
    const s = session;
    const resolved = resolvePoints(s.ctx.timeline, s.points);
    if (s.rangeArmed) {
        rangeTap(resolved, candidates, beat, timeMs);
        return;
    }
    const plan = patchPlan(resolved, candidates, timeMs);
    if (!plan) {
        flash(beat, 'That bar is not played in this score');
        return;
    }
    const gone = new Set([...plan.replaceIds, ...plan.dropIds]);
    const dropped = s.points.filter((p) => plan.dropIds.includes(p.id));
    s.ghosts.push(...dropped);
    const point = pointAt(plan.candidate, timeMs);
    commit([...s.points.filter((p) => !gone.has(p.id)), point].sort((a, b) => a.timeMs - b.timeMs));
    s.lastTapId = point.id;
    navigator.vibrate?.(8);
    if (dropped.length) showToast(`Replaced ${dropped.length} conflicting point${dropped.length === 1 ? '' : 's'}. Undo brings them back.`, 'info', 2500);
    renderOverlay(point.id);
    updateToolbar();
}

/** Fix Range: the first tap marks the start of the bad stretch, the second its end. */
function rangeTap(resolved, candidates, beat, timeMs) {
    const s = session;
    if (!s.rangeStart) {
        s.rangeStart = { candidates, timeMs };
        renderOverlay();
        updateToolbar();
        return;
    }
    const plan = rangePlan(resolved, s.rangeStart.candidates, s.rangeStart.timeMs, candidates, timeMs);
    if (!plan) {
        flash(beat, 'The end must be a later bar, heard later in the recording. Tap it again, or press Escape.');
        return;
    }
    const gone = new Set(plan.removeIds);
    s.ghosts.push(...s.points.filter((p) => gone.has(p.id)));
    const pins = [pointAt(plan.a, s.rangeStart.timeMs), pointAt(plan.b, timeMs)];
    commit([...s.points.filter((p) => !gone.has(p.id)), ...pins].sort((a, b) => a.timeMs - b.timeMs));
    cancelRange();
    showToast(`Fixed bars ${plan.a.barIndex + 1} to ${plan.b.barIndex + 1}${plan.clearedCount ? `, cleared ${plan.clearedCount} point${plan.clearedCount === 1 ? '' : 's'}` : ''}`, 'info', 2200);
    renderOverlay(pins[1].id);
    updateToolbar();
}

function cancelRange() {
    const s = session;
    if (!s || (!s.rangeArmed && !s.rangeStart)) return;
    s.rangeArmed = false;
    s.rangeStart = null;
    renderOverlay();
    updateToolbar();
}

/** Step Sync: moves the target bar (arrow keys), to skip ahead or back. */
function moveTarget(bars) {
    const s = session;
    if (!s || s.mode !== 'step' || s.audition) return;
    const current = s.target ? s.target.barEntry : s.map.bars.length;
    const next = Math.min(s.map.bars.length - 1, Math.max(0, current + bars));
    const entry = s.map.entries[s.map.bars[next]?.firstEntry];
    if (!entry) return;
    s.target = entry;
    renderOverlay();
    updateToolbar();
    scrollToTarget(true);
}

/** Switches between Step Sync and Patch Sync. */
function setMode(mode) {
    const s = session;
    if (!s || s.entering || s.mode === mode) return;
    endAudition();
    s.retap = null;
    s.mode = mode;
    s.ghosts = [];
    s.rangeArmed = false;
    s.rangeStart = null;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* per-viewer convenience only */ }
    applyFollower();
    if (mode === 'patch') {
        s.target = null;
        s.lastTick = null;
    } else {
        retarget();
    }
    renderOverlay();
    updateToolbar();
}

/** Step Sync keeps the cursor still; Patch Sync lets it follow the current points so the drift can be seen. */
function applyFollower() {
    const s = session;
    if (s?.mode === 'patch') {
        setAudioSyncSuspended(false);
        startAudioSync({ source: s.source, points: s.points });
    } else {
        setAudioSyncSuspended(true);
    }
}

/**
 * Records an edit for undo. Edits with the same `mergeKey` close together (nudging one point several times) are
 * one undo step.
 */
function commit(next, mergeKey = null) {
    const s = session;
    const now = performance.now();
    const merge = mergeKey && s.lastCommit?.key === mergeKey && now - s.lastCommit.at < NUDGE_MERGE_MS && s.undo.length;
    if (!merge) {
        s.undo.push(s.points);
        if (s.undo.length > HISTORY_LIMIT) s.undo.shift();
    }
    s.redo = [];
    s.lastCommit = { key: mergeKey, at: now };
    setPoints(next);
}

function showTimeline(open) {
    const s = session;
    s.timelineOpen = open;
    $('smTimeline').hidden = !open;
    $('smTimelineBtn').classList.toggle('active', open);
    try { localStorage.setItem(TIMELINE_KEY, open ? '1' : '0'); } catch { /* per-viewer convenience only */ }
    if (open) s.timeline.refresh();
}

function setPoints(next) {
    const s = session;
    s.points = next;
    saveRecord(s.songKey, s.media, s.points);
    if (s.mode === 'patch' && !s.audition) getAudioSyncSession()?.setPoints(next);
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    if (s.timelineOpen) s.timeline.refresh();
}

/** After undo or redo, aim at the beat after the latest point in the recording. */
function retarget() {
    const s = session;
    if (s.mode === 'patch') {
        s.target = null;
        renderOverlay();
        updateToolbar();
        return;
    }
    const latest = s.points.reduce((a, p) => (!a || p.timeMs > a.timeMs ? p : a), null);
    const entry = latest && entryAt(s.map, latest);
    s.lastTick = entry ? entry.tick : null;
    s.target = entry ? nextTarget(s.map, entry.tick, s.granularity) : startTarget(s.map, s.points);
    renderOverlay();
    updateToolbar();
    scrollToTarget(false);
}

function undo() {
    const s = session;
    if (!s?.undo.length) return;
    s.redo.push(s.points);
    s.ghosts = [];
    setPoints(s.undo.pop());
    retarget();
}

function redo() {
    const s = session;
    if (!s?.redo.length) return;
    s.undo.push(s.points);
    s.ghosts = [];
    setPoints(s.redo.pop());
    retarget();
}

// --- Refine ----------------------------------------------------------------------------------------------------------

function selectedPoint() {
    const s = session;
    return s?.selectedId ? s.points.find((p) => p.id === s.selectedId) || null : null;
}

/** Selects a point (null clears it) for nudging, auditioning, snapping or deleting. */
function selectPoint(id, { seek = false } = {}) {
    const s = session;
    if (!s) return;
    s.selectedId = id && s.points.some((p) => p.id === id) ? id : null;
    const point = selectedPoint();
    if (point && seek) {
        endAudition();
        s.source.seek(Math.max(0, point.timeMs));
    }
    renderOverlay();
    updateToolbar();
    if (s.timelineOpen) s.timeline.refresh();
}

function nudge(deltaMs) {
    const s = session;
    const point = selectedPoint();
    if (!point) return;
    const next = nudgePoint(s.points, point.id, deltaMs);
    if (!next) {
        showToast('That point cannot move further without passing its neighbour', 'info', 1800);
        return;
    }
    commit(next, `nudge:${point.id}`);
    updateToolbar();
}

function deleteSelected() {
    const s = session;
    const point = selectedPoint();
    if (!point) return;
    s.selectedId = null;
    commit(s.points.filter((p) => p.id !== point.id));
    retarget();
}

/** Moves the selected point to the nearest sound in the recording. */
function snapSelected() {
    const s = session;
    const point = selectedPoint();
    if (!point || !s.onsets) return;
    const hit = nearestOnset(s.onsets, point.timeMs);
    if (!hit) {
        showToast('No clear sound within 80 ms of this point', 'info', 1800);
        return;
    }
    const next = nudgePoint(s.points, point.id, hit.timeMs - point.timeMs);
    if (!next) {
        showToast('That sound is past a neighbouring point', 'info', 1800);
        return;
    }
    commit(next, `snap:${point.id}`);
    showToast(`Moved ${Math.abs(Math.round(hit.deltaMs))} ms ${hit.deltaMs < 0 ? 'earlier' : 'later'}`, 'info', 1500);
    updateToolbar();
}

/** Plays two seconds either side of the selected point with the cursor following the points, to hear and see it. */
function audition() {
    const s = session;
    const point = selectedPoint();
    if (!point) return;
    endAudition();
    pauseSynthPlayer();
    clearSynthHighlights();
    if (s.source.kind !== 'youtube') pauseYouTube();
    s.retap = null;
    setAudioSyncSuspended(false);
    startAudioSync({ source: s.source, points: s.points });
    s.audition = { until: point.timeMs + AUDITION_TAIL_MS, timer: setInterval(() => {
        if (!s.audition || s.source.getTimeMs() >= s.audition.until || !s.source.isPlaying()) endAudition();
    }, 80) };
    s.source.seek(Math.max(0, point.timeMs - AUDITION_LEAD_MS));
    s.source.play();
    updateToolbar();
}

/** Stops an audition: the cursor goes back to being driven by taps, and the recording pauses. */
function endAudition({ keepPlaying = false } = {}) {
    const s = session;
    if (!s?.audition) return;
    clearInterval(s.audition.timer);
    s.audition = null;
    applyFollower();
    if (!keepPlaying) s.source.pause();
    updateToolbar();
}

/**
 * Re-tap the whole bars around a range of score time: the points inside go (as one undo step), the recording starts a
 * few seconds before the range, and it stops a little after it. Points outside are untouched.
 */
function startRetap(range) {
    const s = session;
    if (!s || !range) return;
    const bars = wholeBarRange(s.ctx.timeline, range.scoreFrom, range.scoreTo);
    if (!bars) return;
    setMode('step');
    endAudition();
    const resolved = resolvePoints(s.ctx.timeline, s.points);
    const window_ = retapWindow(resolved, bars.scoreFrom, bars.scoreTo);
    const inside = new Set(window_.ids);
    if (inside.size) commit(s.points.filter((p) => !inside.has(p.id)));
    s.selectedId = null;
    s.retap = { mediaEnd: window_.mediaTo + RETAP_TAIL_MS, scoreFrom: bars.scoreFrom, scoreTo: bars.scoreTo };
    s.lastTick = null;
    s.target = nextTarget(s.map, scoreMsToTick(s.ctx.timeline, bars.scoreFrom) - 1, s.granularity);
    s.source.seek(Math.max(0, window_.mediaFrom - RETAP_LEAD_MS));
    renderOverlay();
    updateToolbar();
    scrollToTarget(true);
    playSource();
}

/** Looks for the sounds in a local file, for snapping. */
async function loadOnsets(s, getAudioData) {
    try {
        const data = await getAudioData();
        const found = data && await decodeOnsets(data);
        if (session !== s || !found) return;
        s.onsets = found;
        updateToolbar();
    } catch (e) {
        console.warn('[Sync Mode] could not analyse the audio for snapping:', e);
    }
}

// --- Overlay -------------------------------------------------------------------------------------------------------

/**
 * Screen rectangles of the beats on the page, by bar: `Map(barIndex -> [{ rel, rect }])`, from the top staff of each
 * bar. AlphaTab's `findBeat` only resolves beats of tracks that are drawn, and the tick lookup's beats belong to the
 * first track, so beats are matched by their offset in the bar (`rel`, in ticks) instead.
 */
function buildRectIndex(api) {
    const index = new Map();
    for (const system of api.renderer?.boundsLookup?.staffSystems || []) {
        for (const masterBar of system.bars || []) {
            const trackBar = masterBar.bars?.[0];
            if (!trackBar?.beats?.length) continue;
            const beats = trackBar.beats
                .map((b) => ({ rel: b.beat?.playbackStart ?? 0, rect: b.realBounds ?? b.visualBounds }))
                .filter((b) => b.rect);
            if (beats.length) index.set(masterBar.index, beats);
        }
    }
    return index;
}

function beatRect(entry) {
    const s = session;
    s.rects ||= buildRectIndex(s.ctx.api);
    const beats = s.rects.get(entry.barIndex);
    if (!beats) return null;
    const rel = entry.tick - s.map.bars[entry.barEntry].startTick;
    let best = beats[0];
    for (const b of beats) {
        if (Math.abs(b.rel - rel) < Math.abs(best.rel - rel)) best = b;
    }
    const { x, y, w, h } = best.rect;
    return { x, y, w, h };
}

function renderOverlay(newPointId = null) {
    const s = session;
    if (!s) return;
    const els = [];
    for (const p of s.points) {
        const entry = entryAt(s.map, p);
        const rect = entry && beatRect(entry);
        if (!rect) continue;
        const dot = document.createElement('div');
        dot.className = 'sync-marker';
        if (p.id === newPointId) dot.classList.add('is-new');
        if (p.id === s.selectedId) dot.classList.add('is-selected');
        // A click on a dot selects its point; it must not also tap the beat under it
        dot.addEventListener('click', (e) => { e.stopPropagation(); selectPoint(p.id, { seek: true }); });
        dot.style.left = `${rect.x + rect.w / 2}px`;
        dot.style.top = `${rect.y}px`;
        dot.title = `Bar ${p.barIndex + 1}${p.occurrence ? ` (pass ${p.occurrence + 1})` : ''} at ${formatTime(p.timeMs)}`;
        els.push(dot);
    }
    for (const p of s.ghosts) {
        const entry = entryAt(s.map, p);
        const gr = entry && beatRect(entry);
        if (!gr) continue;
        const ghost = document.createElement('div');
        ghost.className = 'sync-marker is-ghost';
        ghost.style.left = `${gr.x + gr.w / 2}px`;
        ghost.style.top = `${gr.y}px`;
        ghost.title = `Replaced point at bar ${p.barIndex + 1}`;
        els.push(ghost);
    }
    const startEntry = s.rangeStart && entryAt(s.map, s.rangeStart.candidates[0]);
    const startRect = startEntry && beatRect(startEntry);
    if (startRect) {
        const dot = document.createElement('div');
        dot.className = 'sync-marker is-range-start';
        dot.style.left = `${startRect.x + startRect.w / 2}px`;
        dot.style.top = `${startRect.y}px`;
        els.push(dot);
    }
    const rect = s.target && beatRect(s.target);
    if (rect) {
        const box = document.createElement('div');
        box.className = 'sync-target';
        box.style.left = `${rect.x - 4}px`;
        box.style.top = `${rect.y - 4}px`;
        box.style.width = `${Math.max(rect.w, 16) + 8}px`;
        box.style.height = `${rect.h + 8}px`;
        els.push(box);
    }
    s.overlay.replaceChildren(...els);
}

function flash(beat, message) {
    const s = session;
    const bounds = s.ctx.api.renderer?.boundsLookup?.findBeat(beat);
    const r = bounds?.realBounds ?? bounds?.visualBounds;
    if (r) {
        const box = document.createElement('div');
        box.className = 'sync-reject';
        box.style.left = `${r.x - 4}px`;
        box.style.top = `${r.y - 4}px`;
        box.style.width = `${Math.max(r.w, 16) + 8}px`;
        box.style.height = `${r.h + 8}px`;
        s.overlay.append(box);
        setTimeout(() => box.remove(), 800);
    }
    showToast(message, 'info', 2200);
}

/** Scroll so the target beat sits clear above the bottom toolbar, unless the user is scrolling by hand. */
function scrollToTarget(force) {
    const s = session;
    const rect = s?.target && beatRect(s.target);
    if (!rect) return;
    if (!force && performance.now() - s.lastUserScrollAt < SCROLL_IDLE_MS) return;
    const viewH = s.output.clientHeight;
    const barH = Math.max(0, s.output.getBoundingClientRect().bottom - $('syncModeBar').getBoundingClientRect().top);
    const containerTop = s.container.getBoundingClientRect().top - s.output.getBoundingClientRect().top + s.output.scrollTop;
    const beatTop = containerTop + rect.y;
    const visibleTop = s.output.scrollTop + 8;
    const visibleBottom = s.output.scrollTop + Math.min(viewH * 0.8, viewH - barH - 8);
    if (!force && beatTop >= visibleTop && beatTop + rect.h <= visibleBottom) return;
    s.output.scrollTo({ top: Math.max(0, beatTop - 40), behavior: force ? 'auto' : 'smooth' });
}

// --- Toolbar -------------------------------------------------------------------------------------------------------

function wireToolbar(s) {
    const on = (id, handler) => {
        const el = $(id);
        el.addEventListener('click', handler);
        s.cleanup.push(() => el.removeEventListener('click', handler));
    };
    on('smPlayBtn', () => togglePlay());
    on('smBack5Btn', () => s.source.seek(Math.max(0, s.source.getTimeMs() - 5000)));
    on('smBack10Btn', () => s.source.seek(Math.max(0, s.source.getTimeMs() - 10000)));
    on('smUndoBtn', undo);
    on('smRedoBtn', redo);
    on('smAuditionBtn', audition);
    on('smCalibrateBtn', () => {
        endAudition();
        s.source.pause();
        openTapCalibration({
            latencyMs: getAudioLatencyMs(),
            onApply: (ms) => {
                const field = $('smOffset');
                field.value = String(ms);
                field.dispatchEvent(new Event('change'));
                showToast(`Tap offset set to ${session ? session.offsetMs : ms} ms`, 'info', 2200);
            }
        });
    });
    on('smSnapPointBtn', snapSelected);
    on('smDeletePointBtn', deleteSelected);
    on('smSnapBtn', () => {
        s.snapOn = !s.snapOn;
        try { localStorage.setItem(SNAP_KEY, s.snapOn ? '1' : '0'); } catch { /* per-viewer convenience only */ }
        updateToolbar();
    });
    document.querySelectorAll('#smRefine [data-sm-nudge]').forEach((b) => {
        const handler = () => nudge(Number(b.dataset.smNudge));
        b.addEventListener('click', handler);
        s.cleanup.push(() => b.removeEventListener('click', handler));
    });
    on('smTapBtn', tapTarget);
    // A press moves the target a bar; holding moves it 4, for touch screens without arrow keys
    for (const [id, dir] of [['smPrevBarBtn', -1], ['smNextBarBtn', 1]]) {
        const btn = $(id);
        let timer = 0;
        let held = false;
        const down = () => { held = false; timer = setTimeout(() => { held = true; moveTarget(dir * 4); }, 500); };
        const up = () => clearTimeout(timer);
        const click = () => { if (held) held = false; else moveTarget(dir); };
        btn.addEventListener('pointerdown', down);
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, up);
        btn.addEventListener('click', click);
        s.cleanup.push(() => {
            clearTimeout(timer);
            btn.removeEventListener('pointerdown', down);
            for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.removeEventListener(ev, up);
            btn.removeEventListener('click', click);
        });
    }
    on('smRangeBtn', () => {
        if (s.rangeArmed) cancelRange();
        else { s.rangeArmed = true; s.rangeStart = null; updateToolbar(); }
    });
    document.querySelectorAll('#smMode [data-sm-mode]').forEach((b) => {
        const handler = () => setMode(b.dataset.smMode);
        b.addEventListener('click', handler);
        s.cleanup.push(() => b.removeEventListener('click', handler));
    });
    on('smDoneBtn', exitSyncMode);
    on('smTimelineBtn', () => showTimeline(!s.timelineOpen));
    document.querySelectorAll('#smRates [data-sm-rate]').forEach((b) => {
        const handler = () => { s.source.setRate(Number(b.dataset.smRate)); updateToolbar(); };
        b.addEventListener('click', handler);
        s.cleanup.push(() => b.removeEventListener('click', handler));
    });
    document.querySelectorAll('#smGranularity [data-sm-granularity]').forEach((b) => {
        const handler = () => {
            s.granularity = b.dataset.smGranularity;
            s.target = s.lastTick === null ? startTarget(s.map, s.points) : nextTarget(s.map, s.lastTick, s.granularity);
            renderOverlay();
            updateToolbar();
        };
        b.addEventListener('click', handler);
        s.cleanup.push(() => b.removeEventListener('click', handler));
    });
    const offset = $('smOffset');
    offset.value = String(s.offsetMs);
    const onOffset = () => {
        const n = Math.min(500, Math.max(0, Math.round(Number(offset.value) || 0)));
        s.offsetMs = n;
        offset.value = String(n);
        writeOffset(n);
    };
    offset.addEventListener('change', onOffset);
    s.cleanup.push(() => offset.removeEventListener('change', onOffset));
}

async function togglePlay() {
    const s = session;
    if (!s) return;
    if (s.audition) {
        endAudition();
        return;
    }
    if (s.source.isPlaying()) {
        s.source.pause();
        return;
    }
    await playSource();
}

async function playSource() {
    const s = session;
    if (!s) return;
    pauseSynthPlayer();
    clearSynthHighlights();
    if (s.source.kind !== 'youtube') pauseYouTube();
    try {
        await s.source.play();
    } catch (e) {
        showToast('Press play again to start the recording', 'info', 2000);
    }
}

function handleKey(e) {
    const s = session;
    if (!s) return;
    // A dialog (calibration, Sync Points) has its own keys
    if (document.body.classList.contains('modal-open')) return;
    const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space' && !mod) {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlay();
    } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) redo(); else undo();
    } else if (!mod && e.key === 'Escape' && (s.rangeArmed || s.rangeStart)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelRange();
    } else if (!mod && !e.repeat && s.mode === 'step' && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        e.stopImmediatePropagation();
        tapTarget();
    } else if (!mod && s.mode === 'step' && !selectedPoint() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        moveTarget((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 4 : 1));
    } else if (!mod && selectedPoint()) {
        // Keys for the selected point
        const step = e.shiftKey ? 50 : 10;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopImmediatePropagation();
            nudge(e.key === 'ArrowLeft' ? -step : step);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            e.stopImmediatePropagation();
            deleteSelected();
        } else if (e.key.toLowerCase() === 'a') {
            e.preventDefault();
            e.stopImmediatePropagation();
            audition();
        } else if (e.key === 'Escape') {
            selectPoint(null);
        }
    }
}

function updateToolbar() {
    const s = session;
    if (!s || s.entering) return;
    const playing = s.source.isPlaying();
    if (s.retap && playing && s.source.getTimeMs() > s.retap.mediaEnd) {
        s.source.pause();
        s.retap = null;
        showToast('Re-tap finished', 'info', 1500);
    }
    $('smPlayIcon').className = playing ? 'bi-pause-fill' : 'bi-play-fill';
    const rate = s.source.getRate?.() ?? 1;
    document.querySelectorAll('#smRates [data-sm-rate]').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.smRate) - rate) < 0.01));
    document.querySelectorAll('#smGranularity [data-sm-granularity]').forEach((b) => b.classList.toggle('active', b.dataset.smGranularity === s.granularity));
    document.querySelectorAll('#smMode [data-sm-mode]').forEach((b) => b.classList.toggle('active', b.dataset.smMode === s.mode));
    $('smGranularity').style.display = s.mode === 'patch' ? 'none' : '';
    $('smRangeBtn').hidden = s.mode !== 'patch';
    document.querySelectorAll('#syncModeBar [data-sm-step]').forEach((b) => { b.style.display = s.mode === 'step' ? '' : 'none'; });
    const tapBtn = $('smTapBtn');
    if (tapBtn) {
        tapBtn.disabled = !s.target;
        const barNum = s.target ? s.target.barIndex + 1 : '';
        tapBtn.innerHTML = s.mode === 'step'
            ? (s.target ? `Tap bar <b>${barNum}</b> <kbd>J</kbd>` : 'All bars covered')
            : `Pin bar <b>${barNum}</b> to now <kbd>J</kbd>`;
    }
    $('smRangeBtn').classList.toggle('active', s.rangeArmed);
    $('smUndoBtn').disabled = !s.undo.length;
    $('smRedoBtn').disabled = !s.redo.length;
    if (s.timelineOpen) s.timeline.wake();

    // Snap works on a local file, once its sounds have been found
    const snapBtn = $('smSnapBtn');
    snapBtn.hidden = !s.source.capabilities?.waveform;
    snapBtn.disabled = !s.onsets;
    snapBtn.classList.toggle('active', s.snapOn && Boolean(s.onsets));
    snapBtn.title = s.onsets ? 'Move each tap to the nearest sound in the recording, up to 80 ms away' : 'Finding the sounds in the recording...';

    // The selected point and its tools
    const point = selectedPoint();
    $('smRefine').hidden = !point;
    if (point) {
        const entry = entryAt(s.map, point);
        $('smSelectedLabel').textContent = `Bar ${point.barIndex + 1}${point.occurrence ? ` (pass ${point.occurrence + 1})` : ''} at ${formatTime(point.timeMs)}${entry ? '' : ' (not in this score)'}`;
        $('smSnapPointBtn').hidden = !s.onsets;
        $('smAuditionBtn').textContent = s.audition ? 'Stop' : 'Audition';
    }
    $('smCount').textContent = `${s.points.length} point${s.points.length === 1 ? '' : 's'} · ${formatTime(s.source.getTimeMs())}`;
    let hint;
    if (s.source.isBuffering?.()) hint = 'Waiting for the recording...';
    else if (s.audition) hint = 'Auditioning: the cursor follows the points. Press Stop when you have heard enough.';
    else if (s.mode === 'patch') {
        if (s.rangeArmed && !s.rangeStart) hint = 'Fix Range: while it plays, click the bar where the bad stretch starts. Escape cancels.';
        else if (s.rangeArmed) hint = 'Now click the bar where the bad stretch ends.';
        else if (playing) hint = 'Click any bar at the moment you hear it start. The points it contradicts are replaced.';
        else hint = 'Press play. When the cursor drifts, click the bar you hear. Use Fix Range for a longer stretch.';
    }
    else if (s.retap && !s.target) hint = 'That is the whole range. Press pause, or keep going to fix more bars.';
    else if (!s.target) hint = 'Every bar has a point. Select a dot to adjust it, or press Done.';
    else {
        const where = `bar ${s.target.barIndex + 1}${s.target.occurrence ? ` (pass ${s.target.occurrence + 1})` : ''}${s.granularity === 'beat' ? `, beat at ${Math.round(s.target.pos * 100)}%` : ''}`;
        if (s.retap) hint = `Re-tapping from bar ${(s.ctx.timeline.bars.find((b) => b.startMs >= s.retap.scoreFrom) || s.ctx.timeline.bars[0]).barIndex + 1}: tap ${where} when you hear it.`;
        else if (playing) hint = `Tap ${where} when you hear it (J, the Tap button or a click). Arrow keys or the arrow buttons skip bars.`;
        else hint = `Press play, then tap ${where} when you hear it (J, the Tap button or a click). Arrow keys or the arrow buttons skip bars. Or pause on a sound and click a beat to put a point there.`;
    }
    if (s.lastSnap !== null && !s.audition) hint += ` (Last tap snapped ${Math.abs(s.lastSnap)} ms ${s.lastSnap < 0 ? 'earlier' : 'later'}.)`;
    $('smHint').textContent = hint;
}
