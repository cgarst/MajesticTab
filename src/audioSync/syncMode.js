// syncMode.js
// Tap to sync: play a recording and click each bar (or beat) of the tab as you hear it, and every click records a
// sync point at the recording's current time. The cursor follows the current points while it plays, a click on any bar
// pins that bar to now and replaces the points it contradicts, and Fix Range takes two taps (start and end of a bad stretch)
// and clears the points between them. The recording is the clock, so the taps only need to be roughly right;
// the refine tools tighten them: select a point to nudge it and audition 2 s around it, snap taps (or a point) to the
// nearest sound in a local file, re-tap a range of bars, or pause on a sound and click a beat to put a point there.
// While active, the score switches to scroll view, the follower is active, and score clicks are taps instead of cursor moves.

import { getAudioLatencyMs, setScoreClickOverride, pauseSynthPlayer, clearSynthHighlights, getMidiTickLookup, onTransportEvent } from '../gpProcessor/gpPlayer.js';
import { getSongKey, pauseYouTube } from '../youtubePlayer.js';
import { showToast } from '../utils/toast.js';
import { getScoreContext, setAudioSyncSuspended, startAudioSync, stopAudioSync, getAudioSyncSession } from './audioSyncController.js';
import { resolvePoints } from './pointCheck.js';
import { positionToScoreMs } from './scorePositions.js';
import { buildBeatMap, candidatesForBeat, entryAt } from './beatMap.js';
import { patchPlan, rangePlan } from './tapRules.js';
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
const AUDITION_LEAD_MS = 1000;
const AUDITION_TAIL_MS = 1000;
const RETAP_LEAD_MS = 4000;
const RETAP_TAIL_MS = 1500;
const NUDGE_MERGE_MS = 1500;
const HISTORY_LIMIT = 100;

const $ = (id) => document.getElementById(id);

let session = null;

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
        // A new song starts with a point at 0:00 on beat 1. It stays in memory until the first tap saves the list
        points: loadRecord(songKey, media)?.points?.length
            ? loadRecord(songKey, media).points
            : [{ id: makeId(), barIndex: map.bars[0]?.barIndex ?? 0, occurrence: map.bars[0]?.occurrence ?? 0, pos: 0, timeMs: 0, source: 'tap' }],
        undo: [], redo: [],
        ghosts: [],
        rangeArmed: false,
        rangeStart: null,
        offsetMs: readOffset(),
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
            timeline: s.ctx.timeline, points: s.points, source: s.source, peaks: s.peaks, showWave: false,
            durationMs: s.source.durationMs ?? null, selectedId: s.selectedId
        }),
        onChangePoints: (next) => { commit(next); renderOverlay(); updateToolbar(); },
        onSeek: ({ mediaMs }) => { endAudition(); s.source.seek(mediaMs); },
        onSelect: (id) => selectPoint(id),
        onRetap: startRetap
    });
    s.cleanup.push(() => s.timeline.destroy());

    // One audio source at a time, and the cursor follows the sync points being edited
    pauseSynthPlayer();
    clearSynthHighlights();
    if (source.kind !== 'youtube') pauseYouTube();
    setAudioSyncSuspended(false);
    startAudioSync({ source: s.source, points: s.points });
    setScoreClickOverride(onBeatClick);
    source.setRate(1);

    wireToolbar(s);
    document.body.classList.add('sync-mode');
    $('syncModeBar').hidden = false;
    // The toolbar docks over the bottom of the score: pad the score by the overlap so every system can be scrolled clear of it
    const padForBar = () => {
        const barRect = $('syncModeBar')?.getBoundingClientRect();
        if (!barRect) return;
        // Phones: the bar shrinks the score area (design.css) rather than padding it
        if (document.body.classList.contains('phone-reader')) {
            document.documentElement.style.setProperty('--sync-bar-h', `${Math.round(barRect.height)}px`);
            output.style.removeProperty('padding-bottom');
            return;
        }
        document.documentElement.style.removeProperty('--sync-bar-h');
        const need = Math.max(0, Math.round(window.innerHeight - barRect.top + 32));
        output.style.setProperty('padding-bottom', `${need}px`, 'important');
    };
    const barObserver = new ResizeObserver(padForBar);
    barObserver.observe($('syncModeBar'));
    const bodyObserver = new MutationObserver(() => padForBar());
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', padForBar);
    $('syncModeBar')?.addEventListener('transitionend', padForBar);
    s.cleanup.push(() => {
        barObserver.disconnect();
        bodyObserver.disconnect();
        window.removeEventListener('resize', padForBar);
        $('syncModeBar')?.removeEventListener('transitionend', padForBar);
        output.style.removeProperty('padding-bottom');
        document.documentElement.style.removeProperty('--sync-bar-h');
    });
    padForBar();
    showTimeline(s.timelineOpen);
    renderOverlay();
    updateToolbar();
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
    s.output?.style.removeProperty('padding-bottom');
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
    patchTap(candidates, beat, timeMs);
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
    if (!s.audition) getAudioSyncSession()?.setPoints(next);
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    if (s.timelineOpen) s.timeline.refresh();
}

function undo() {
    const s = session;
    if (!s?.undo.length) return;
    s.redo.push(s.points);
    s.ghosts = [];
    setPoints(s.undo.pop());
    renderOverlay();
    updateToolbar();
}

function redo() {
    const s = session;
    if (!s?.redo.length) return;
    s.undo.push(s.points);
    s.ghosts = [];
    setPoints(s.redo.pop());
    renderOverlay();
    updateToolbar();
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
    renderOverlay();
    updateToolbar();
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
    setAudioSyncSuspended(false);
    startAudioSync({ source: s.source, points: s.points });
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
    endAudition();
    const resolved = resolvePoints(s.ctx.timeline, s.points);
    const window_ = retapWindow(resolved, bars.scoreFrom, bars.scoreTo);
    const inside = new Set(window_.ids);
    if (inside.size) commit(s.points.filter((p) => !inside.has(p.id)));
    s.selectedId = null;
    s.retap = { mediaEnd: window_.mediaTo + RETAP_TAIL_MS, scoreFrom: bars.scoreFrom, scoreTo: bars.scoreTo };
    s.source.seek(Math.max(0, window_.mediaFrom - RETAP_LEAD_MS));
    renderOverlay();
    updateToolbar();
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
            const beats = [];
            for (const trackBar of masterBar.bars || []) {
                for (const b of trackBar.beats || []) {
                    const rect = b.realBounds ?? b.visualBounds;
                    if (rect) beats.push({ rel: b.beat?.playbackStart ?? 0, rect });
                }
            }
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
    on('smRangeBtn', () => {
        if (s.rangeArmed) cancelRange();
        else { s.rangeArmed = true; s.rangeStart = null; updateToolbar(); }
    });
    on('smDoneBtn', exitSyncMode);
    on('smAdjustBtn', () => {
        // Hand over to the point editor of the same recording
        const editBtn = $(`${s.media.kind === 'youtube' ? 'yt' : 'af'}SyncEditBtn`);
        exitSyncMode();
        editBtn?.click();
    });
    on('smTimelineBtn', () => showTimeline(!s.timelineOpen));
    document.querySelectorAll('#smRates [data-sm-rate]').forEach((b) => {
        const handler = () => { s.source.setRate(Number(b.dataset.smRate)); updateToolbar(); };
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
    const rangeBtn = $('smRangeBtn');
    if (rangeBtn) rangeBtn.classList.toggle('active', s.rangeArmed);
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
    else if (s.rangeArmed && !s.rangeStart) hint = 'Fix Range: while it plays, click the bar where the bad stretch starts. Escape cancels.';
    else if (s.rangeArmed) hint = 'Now click the bar where the bad stretch ends.';
    else if (playing) hint = 'Click any bar at the moment you hear it start. The points it contradicts are replaced.';
    else hint = 'Press play. When the cursor drifts, click the bar you hear. Use Fix Range for a longer stretch.';
    if (s.lastSnap !== null && !s.audition) hint += ` (Last tap snapped ${Math.abs(s.lastSnap)} ms ${s.lastSnap < 0 ? 'earlier' : 'later'}.)`;
    $('smHint').textContent = hint;
}
