// syncMode.js
// Tap to sync: play a recording and click each bar (or beat) of the tab as you hear it, and every click records a
// sync point at the recording's current time. The recording is the clock, so the taps only need to be roughly right;
// the Sync Points editor and later refine tools tighten them. While active, the score switches to scroll view, the
// follower is suspended, and score clicks are taps instead of cursor moves.

import { getAudioLatencyMs, setScoreClickOverride, pauseSynthPlayer, clearSynthHighlights, getMidiTickLookup, onTransportEvent } from '../gpProcessor/gpPlayer.js';
import { getSongKey, pauseYouTube } from '../youtubePlayer.js';
import { showToast } from '../utils/toast.js';
import { getScoreContext, setAudioSyncSuspended } from './audioSyncController.js';
import { resolvePoints } from './pointCheck.js';
import { positionToScoreMs } from './scorePositions.js';
import { buildBeatMap, candidatesForBeat, entryAt, nextTarget, firstUnsyncedTarget } from './beatMap.js';
import { chooseTap } from './tapRules.js';
import { loadRecord, saveRecord } from './syncStore.js';
import { makeId, formatTime } from './syncEdit.js';
import { SYNC_CHANGED_EVENT } from './audioSyncEditor.js';
import { createSyncTimeline } from './syncTimeline.js';

const OFFSET_KEY = 'audio_sync_tap_offset';
const TIMELINE_KEY = 'audio_sync_timeline';
const YOUTUBE_DEFAULT_RATE = 0.75;
const HISTORY_LIMIT = 100;
const SCROLL_IDLE_MS = 600;

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
 */
export async function enterSyncMode({ source, media, peaks = null }) {
    if (session) return;
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
        offsetMs: readOffset(),
        lastTick: null,
        target: null,
        lastUserScrollAt: 0,
        lastTapId: null,
        selectedId: null,
        timelineOpen: readTimelinePref(),
        timeline: null,
        cleanup: []
    };
    s.timeline = createSyncTimeline({
        host: $('smTimeline'),
        getData: () => ({
            timeline: s.ctx.timeline, points: s.points, source: s.source, peaks: s.peaks,
            durationMs: s.source.durationMs ?? null, selectedId: s.selectedId
        }),
        onChangePoints: (next) => { commit(next); retarget(); },
        onSeek: ({ mediaMs }) => s.source.seek(mediaMs),
        onSelect: (id) => { s.selectedId = id; }
    });
    s.cleanup.push(() => s.timeline.destroy());

    // One audio source at a time, and the cursor must not be moved by the points being edited
    pauseSynthPlayer();
    clearSynthHighlights();
    if (source.kind !== 'youtube') pauseYouTube();
    setAudioSyncSuspended(true);
    setScoreClickOverride(onBeatClick);
    source.setRate(source.kind === 'youtube' ? YOUTUBE_DEFAULT_RATE : 1);

    wireToolbar(s);
    s.target = firstUnsyncedTarget(map, s.points);
    document.body.classList.add('sync-mode');
    $('syncModeBar').hidden = false;
    // The toolbar floats over the top of the score: pad the score by its height so every system can be scrolled clear of it
    s.prevPadding = output.style.paddingTop;
    const padForBar = () => {
        const need = $('syncModeBar').getBoundingClientRect().bottom - output.getBoundingClientRect().top + 8;
        output.style.paddingTop = `${Math.max(0, Math.round(need))}px`;
    };
    const barObserver = new ResizeObserver(padForBar);
    barObserver.observe($('syncModeBar'));
    s.cleanup.push(() => { barObserver.disconnect(); output.style.paddingTop = s.prevPadding; });
    padForBar();
    showTimeline(s.timelineOpen);
    renderOverlay();
    updateToolbar();
    scrollToTarget(true);

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
    session = null;
    s.cleanup.forEach((fn) => { try { fn(); } catch { /* already gone */ } });
    s.source.pause();
    s.source.setRate(s.prevRate);
    setScoreClickOverride(null);
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
    if (!s || s.entering) return;
    if (s.source.isBuffering?.()) {
        flash(beat, 'Waiting for the recording');
        return;
    }
    // The clock leads what the user hears by the output latency, and a tap lands a reaction time after the sound
    const timeMs = Math.max(0, Math.round(s.source.getTimeMs() - getAudioLatencyMs() - s.offsetMs));
    const candidates = candidatesForBeat(s.map, beat)
        .map((c) => ({ ...c, scoreMs: positionToScoreMs(s.ctx.timeline, c) }))
        .filter((c) => c.scoreMs !== null);
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

function commit(next) {
    const s = session;
    s.undo.push(s.points);
    if (s.undo.length > HISTORY_LIMIT) s.undo.shift();
    s.redo = [];
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
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    if (s.timelineOpen) s.timeline.refresh();
}

/** After undo or redo, aim at the beat after the latest point in the recording. */
function retarget() {
    const s = session;
    const latest = s.points.reduce((a, p) => (!a || p.timeMs > a.timeMs ? p : a), null);
    const entry = latest && entryAt(s.map, latest);
    s.lastTick = entry ? entry.tick : null;
    s.target = entry ? nextTarget(s.map, entry.tick, s.granularity) : firstUnsyncedTarget(s.map, s.points);
    renderOverlay();
    updateToolbar();
    scrollToTarget(false);
}

function undo() {
    const s = session;
    if (!s?.undo.length) return;
    s.redo.push(s.points);
    setPoints(s.undo.pop());
    retarget();
}

function redo() {
    const s = session;
    if (!s?.redo.length) return;
    s.undo.push(s.points);
    setPoints(s.redo.pop());
    retarget();
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
        dot.style.left = `${rect.x + rect.w / 2}px`;
        dot.style.top = `${rect.y}px`;
        dot.title = `Bar ${p.barIndex + 1}${p.occurrence ? ` (pass ${p.occurrence + 1})` : ''} at ${formatTime(p.timeMs)}`;
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

/** Scroll so the target beat sits clear below the toolbar, unless the user is scrolling by hand. */
function scrollToTarget(force) {
    const s = session;
    const rect = s?.target && beatRect(s.target);
    if (!rect) return;
    if (!force && performance.now() - s.lastUserScrollAt < SCROLL_IDLE_MS) return;
    const viewH = s.output.clientHeight;
    const barBottom = Math.max(0, $('syncModeBar').getBoundingClientRect().bottom - s.output.getBoundingClientRect().top);
    const containerTop = s.container.getBoundingClientRect().top - s.output.getBoundingClientRect().top + s.output.scrollTop;
    const beatTop = containerTop + rect.y;
    const visibleTop = s.output.scrollTop + barBottom + 8;
    const visibleBottom = s.output.scrollTop + viewH * 0.8;
    if (!force && beatTop >= visibleTop && beatTop + rect.h <= visibleBottom) return;
    s.output.scrollTo({ top: Math.max(0, beatTop - barBottom - 40), behavior: force ? 'auto' : 'smooth' });
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
            s.target = s.lastTick === null ? firstUnsyncedTarget(s.map, s.points) : nextTarget(s.map, s.lastTick, s.granularity);
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
    if (s.source.isPlaying()) {
        s.source.pause();
        return;
    }
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
    }
}

function updateToolbar() {
    const s = session;
    if (!s || s.entering) return;
    const playing = s.source.isPlaying();
    $('smPlayIcon').className = playing ? 'bi-pause-fill' : 'bi-play-fill';
    const rate = s.source.getRate?.() ?? 1;
    document.querySelectorAll('#smRates [data-sm-rate]').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.smRate) - rate) < 0.01));
    document.querySelectorAll('#smGranularity [data-sm-granularity]').forEach((b) => b.classList.toggle('active', b.dataset.smGranularity === s.granularity));
    $('smUndoBtn').disabled = !s.undo.length;
    $('smRedoBtn').disabled = !s.redo.length;
    if (s.timelineOpen) s.timeline.wake();
    $('smCount').textContent = `${s.points.length} point${s.points.length === 1 ? '' : 's'} · ${formatTime(s.source.getTimeMs())}`;
    let hint;
    if (s.source.isBuffering?.()) hint = 'Waiting for the recording...';
    else if (!s.target) hint = 'Every bar has a point. Press Done, or Undo to change one.';
    else {
        const where = `bar ${s.target.barIndex + 1}${s.target.occurrence ? ` (pass ${s.target.occurrence + 1})` : ''}${s.granularity === 'beat' ? `, beat at ${Math.round(s.target.pos * 100)}%` : ''}`;
        hint = playing ? `Tap ${where} when you hear it. You can tap any later beat too.` : `Press play, then tap ${where} when you hear it.`;
    }
    $('smHint').textContent = hint;
}
