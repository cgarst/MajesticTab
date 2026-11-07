// textSync/textSync.js
// A recording (the Original video, an audio file or a MIDI synth source) beside a text or PDF tab. These tabs have no
// bars, so a sync point pins a recording time to a block of a text tab (a line, or a whole staff system) or to a
// page of a PDF. The recording has its own progress strip above the page strip and is NOT synced by default:
// the strip says so, the tab does not follow it, and "Add sync points" starts tap-to-sync (play the recording and tap
// the line or page you hear). Once there are points the tab follows the recording: it scrolls to the line, or turns the page.
//
// Points are stored with the existing sync store (so they back up and sync like any others), under the song key
// "text:<song key>" so the score follower and editor never see them. A point is { barIndex: unit, occurrence: 0, pos: 0,
// timeMs } where unit is the block number (text) or the page's index in the PDF.
//
// Repeats: points are ordered by time, not by position, so a point that names an earlier unit than the one before it is a
// jump back (a repeat sign, a D.S., a second verse on the first page). Tapping an earlier page or line while the
// recording plays is how one is made; the strip marks those points and the Edit list names them.

import { jamYouTubeControl, onYouTubeEvent, playerState, getSongKey } from '../youtubePlayer.js';
import { createYouTubeSource } from '../audioSync/mediaSource.js';
import { getLocalRecording } from '../audioSync/audioFilePlayer.js';
import { getRealAudioActiveSource } from '../audioSync/realAudioController.js';
import { synthPlayerState, isSynthPlaying, playPauseSynth, pauseSynthPlayer, seekSynthPercent, getAudioLatencyMs } from '../gpProcessor/gpPlayer.js';
import { midiSynthActive } from '../classtab/midiSynth.js';
import { loadRecord, saveRecord } from '../audioSync/syncStore.js';
import { getScrubState, applyScrubValue } from '../utils/pageScrubber.js';
import { makeId, formatTime } from '../audioSync/syncEdit.js';
import { showToast } from '../utils/toast.js';
import { positionAt, backJumps, followTarget, glide } from './readingLine.js';

const $ = (id) => document.getElementById(id);

// --- Recordings -------------------------------------------------------------------------------------------------------

const ytSource = createYouTubeSource(jamYouTubeControl, onYouTubeEvent);
const midiSource = {
    kind: 'midi',
    id: 'midi',
    get durationMs() { return synthPlayerState.endTime || null; },
    getTimeMs: () => synthPlayerState.currentTime || 0,
    seek(ms) { if (synthPlayerState.endTime > 0) seekSynthPercent(ms / synthPlayerState.endTime); },
    play() { if (!isSynthPlaying()) playPauseSynth(); },
    pause: () => pauseSynthPlayer(),
    isPlaying: () => isSynthPlaying(),
    isBuffering: () => false
};

const durationOf = (rec) => rec.source.durationMs || (rec.source.kind === 'youtube' && playerState.duration ? playerState.duration * 1000 : null);

let stickyKind = null; // the recording last played, kept while nothing is playing

/** The recording in use, as { source, media, label }, or null: what is playing, else the last one used, else the dock's choice. */
// Synth counts as the selected sound only while its button is there to choose it. A text or PDF tab with no MIDI has the
// Original button alone, but the hidden Synth button keeps its class until the first Play, which kept the recording bar
// away after a recording was attached.
function synthSelected() {
    const btn = $('mobileSynthToggleBtn');
    return Boolean(btn?.classList.contains('active-audio-mode') && btn.getClientRects().length > 0);
}

function activeRecording(file) {
    const midi = midiSynthActive
        ? { source: midiSource, label: 'MIDI', media: { kind: 'local', audioId: `midi_${file.librarySongId || file.name}`, name: 'MIDI', durationMs: null, fingerprint: '' } }
        : null;
    const yt = ytSource.id ? { source: ytSource, label: 'Video', media: { kind: 'youtube', videoId: ytSource.id } } : null;
    const l = getLocalRecording();
    const local = l ? { source: l.source, label: 'Audio file', media: l.media } : null;
    // The dock's choice leads: with Synth selected the MIDI file is the recording, and with Original selected it is not,
    // however recently it played (a sticky MIDI pick would keep its progress bar up after the switch).
    const synthMode = synthSelected();
    if (synthMode && midi) return midi;
    const all = { midi: synthMode || !(yt || local) ? midi : null, yt, local };
    const playing = Object.keys(all).find((k) => all[k] && all[k].source.isPlaying());
    if (playing) stickyKind = playing;
    if (stickyKind && all[stickyKind]) return all[stickyKind];
    const preferLocal = getRealAudioActiveSource() === 'local';
    const originalMode = $('mobileYtToggleBtn')?.classList.contains('active-audio-mode');
    return (preferLocal ? local : yt) || (preferLocal ? yt : local) || (originalMode ? null : midi);
}

// --- Tab units: what a point names ------------------------------------------------------------------------------------

const isText = (f) => /\.txt$/i.test(f?.name || '');
const isPdf = (f) => /\.pdf$/i.test(f?.name || '');

export function initTextSync({ getConfig, getCurrentFile }) {
    const output = $('output');
    const pageStrip = $('pageStrip');
    if (!output || !pageStrip) return;

    const strip = document.createElement('aside');
    strip.id = 'recordingStrip';
    strip.className = 'rec-strip';
    strip.hidden = true;
    strip.setAttribute('aria-label', 'Recording');
    strip.innerHTML = `
      <span class="rec-time" aria-hidden="true">0:00</span>
      <div class="rec-track" role="slider" tabindex="0" aria-label="Recording position">
        <span class="rec-marks"></span><i class="rec-fill"></i><i class="rec-head"></i>
      </div>
      <span class="rec-status" role="status"></span>
      <span class="rec-actions"></span>
      <div class="rec-points" hidden></div>`;
    pageStrip.before(strip);
    const timeEl = strip.querySelector('.rec-time');
    const track = strip.querySelector('.rec-track');
    const fill = strip.querySelector('.rec-fill');
    const marksEl = strip.querySelector('.rec-marks');
    const head = strip.querySelector('.rec-head');
    const statusEl = strip.querySelector('.rec-status');
    const actionsEl = strip.querySelector('.rec-actions');
    const pointsEl = strip.querySelector('.rec-points');

    let rec = null;
    let points = [];
    let tapping = false;
    let lastTapText = '';
    let history = []; // ids of points added this session, for Undo
    let lastUnit = null;
    let drawnKey = '';
    let clearArmed = false;
    let listOpen = false;
    let clearTimer = 0;

    const textKey = () => `text:${getSongKey()}`;
    const unitWord = () => (isPdf(getCurrentFile()) ? 'page' : 'line');
    const latency = () => getAudioLatencyMs() || 0;

    function readPoints() {
        points = rec ? (loadRecord(textKey(), rec.media)?.points || []) : [];
    }
    function writePoints(next) {
        points = [...next].sort((a, b) => a.timeMs - b.timeMs);
        saveRecord(textKey(), rec.media, points);
    }

    // -- Going to a unit

    function blockEl(unit) {
        return output.querySelector(`[data-block="${unit}"]`);
    }
    function markCurrent(unit) {
        output.querySelectorAll('.ts-current').forEach((n) => n.classList.remove('ts-current'));
        if (unit != null && isText(getCurrentFile())) blockEl(unit)?.classList.add('ts-current');
    }
    function goToUnit(unit) {
        const cfg = getConfig();
        const file = getCurrentFile();
        const state = getScrubState(cfg);
        if (!state) return;
        if (isText(file)) {
            if (state.continuous) {
                const el = blockEl(unit);
                if (el) {
                    const out = output.getBoundingClientRect();
                    const r = el.getBoundingClientRect();
                    if (r.top < out.top + out.height * 0.1 || r.bottom > out.top + out.height * 0.85) {
                        output.scrollTo({ top: output.scrollTop + r.top - out.top - out.height * 0.2, behavior: 'smooth' });
                    }
                }
            } else {
                const idx = cfg.textState.pages.findIndex((p) => p.querySelector(`[data-block="${unit}"]`));
                if (idx >= 0 && !(idx >= state.value && idx < state.value + state.perView)) {
                    applyScrubValue(cfg, state, Math.max(state.min, Math.min(state.max, idx - (idx % state.perView))));
                }
            }
        } else if (isPdf(file)) {
            const canvas = cfg.condensedCanvases?.[unit];
            if (!canvas) return;
            if (state.continuous) {
                canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else {
                const idx = cfg.getPages().findIndex((p) => p.some((it) => it.canvas === canvas));
                if (idx >= 0 && !(idx >= state.value && idx < state.value + state.perView)) {
                    applyScrubValue(cfg, state, Math.max(state.min, Math.min(state.max, idx)));
                }
            }
        }
    }

    /** The unit under a tap. Text: the block. PDF: the page (the half of a two-page spread that was tapped). */
    function unitAtTap(e) {
        const file = getCurrentFile();
        if (isText(file)) {
            const b = e.target.closest?.('[data-block]');
            return b ? Number(b.dataset.block) : null;
        }
        const cfg = getConfig();
        const state = getScrubState(cfg);
        if (!state || !cfg.condensedCanvases?.length) return null;
        if (state.continuous) {
            const hit = document.elementsFromPoint(e.clientX, e.clientY).find((n) => cfg.condensedCanvases.includes(n));
            const i = hit ? cfg.condensedCanvases.indexOf(hit) : -1;
            return i >= 0 ? i : null;
        }
        const r = output.getBoundingClientRect();
        const second = state.perView > 1 && e.clientX > r.left + r.width / 2 ? 1 : 0;
        const item = cfg.getPages()[state.value + second]?.[0];
        const i = item ? cfg.condensedCanvases.indexOf(item.canvas) : -1;
        return i >= 0 ? i : null;
    }

    // -- Tap to sync

    function onTap(e) {
        if (!tapping || !rec) return;
        // Controls inside the output (links, buttons) keep working; everything else is a tap
        const unit = unitAtTap(e);
        e.preventDefault();
        e.stopPropagation();
        if (unit == null) return;
        // The first tap marks where the song starts: that unit at 0:00, wherever the recording is now. A song seldom
        // begins on the first line or page, so the reading line waits there from the moment the recording plays.
        const isStart = !points.length;
        const timeMs = isStart ? 0 : Math.max(0, Math.round(rec.source.getTimeMs() - latency()));
        const point = { id: makeId(), barIndex: unit, occurrence: 0, pos: 0, timeMs, source: 'tap' };
        // A tap within half a second of an older point replaces it
        writePoints([...points.filter((p) => Math.abs(p.timeMs - timeMs) > 500), point]);
        history.push(point.id);
        const ids = unitIds();
        const before = [...points].reverse().find((p) => p.timeMs < timeMs && ids.indexOf(p.barIndex) >= 0);
        const goesBack = !isStart && before && ids.indexOf(unit) < ids.indexOf(before.barIndex);
        if (isStart) lastTapText = `Start set. Now tap each ${unitWord()} as you hear it`;
        else if (goesBack) lastTapText = `Back to ${unitLabel(unit, ids)} at ${fmtTime(timeMs)}`;
        else lastTapText = isPdf(getCurrentFile()) ? `Page ${unit + 1} at ${fmtTime(timeMs)}` : `Pinned at ${fmtTime(timeMs)}`;
        markCurrent(unit);
        drawn(true);
    }
    output.addEventListener('click', onTap, true);

    function startTapping() {
        if (!rec) return;
        tapping = true;
        history = [];
        lastTapText = '';
        output.classList.add('ts-tapping');
        drawn(true);
        showToast(points.length ? `Play the recording, then tap each ${unitWord()} as you hear it.` : `First tap the ${unitWord()} where the song starts, then play and tap each one as you hear it.`, 'info', 5000);
    }
    function stopTapping() {
        tapping = false;
        output.classList.remove('ts-tapping');
        output.querySelectorAll('.ts-pinned').forEach((n) => n.classList.remove('ts-pinned'));
        markCurrent(null);
        lastUnit = null;
        listOpen = false;
        drawn(true);
    }
    function undo() {
        const id = history.pop();
        if (!id) return;
        writePoints(points.filter((p) => p.id !== id));
        lastTapText = 'Removed the last point';
        drawn(true);
    }
    function clearAll() {
        if (!points.length) return;
        // Two presses, no native dialog: the first arms the button, a second within 4 s removes the points
        if (!clearArmed) {
            clearArmed = true;
            clearTimeout(clearTimer);
            clearTimer = setTimeout(() => { clearArmed = false; drawn(true); }, 4000);
            drawn(true);
            return;
        }
        clearArmed = false;
        clearTimeout(clearTimer);
        history = [];
        writePoints([]);
        lastTapText = '';
        drawn(true);
    }

    actionsEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'sync') startTapping();
        else if (act === 'done') stopTapping();
        else if (act === 'undo') undo();
        else if (act === 'clear') clearAll();
        else if (act === 'points') { listOpen = !listOpen; drawn(true); }
    });
    pointsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-point]');
        if (!btn || !rec) return;
        const p = points.find((q) => q.id === btn.dataset.point);
        if (!p) return;
        if (btn.dataset.do === 'remove') {
            history = history.filter((id) => id !== p.id);
            writePoints(points.filter((q) => q.id !== p.id));
            lastTapText = 'Removed a point';
        } else {
            rec.source.seek(Math.max(0, p.timeMs + latency()));
        }
        drawn(true);
    });

    // -- Strip

    function fmtTime(ms) {
        const total = Math.max(0, Math.floor((ms || 0) / 1000));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    /** The words a text block starts with, found even when its page is not the one on screen. */
    function blockText(unit) {
        const roots = getConfig().textState?.pages?.length ? getConfig().textState.pages : [output];
        for (const r of roots) {
            const el = r.querySelector?.(`[data-block="${unit}"]`);
            if (el) return el.textContent.replace(/\s+/g, ' ').trim();
        }
        return '';
    }

    /** What a point names, in the player's terms: "Page 3" for a PDF, the first words of the line for a text tab. Block
     *  numbers count blocks the player never sees (a title, blank lines), so they are not shown. */
    function unitLabel(unit, ids = unitIds()) {
        const r = ids.indexOf(unit);
        if (isPdf(getCurrentFile())) return `Page ${r >= 0 ? r + 1 : '?'}`;
        const text = blockText(unit);
        if (!text) return r >= 0 ? `Line ${r + 1}` : 'Line';
        return `\u201c${text.length > 26 ? `${text.slice(0, 26).trimEnd()}\u2026` : text}\u201d`;
    }

    /** Rebuilds the status text, actions and tick marks. `force` redraws even when nothing seems to have changed. */
    function drawn(force = false) {
        const key = `${clearArmed}|${rec?.label}|${points.length}|${tapping}|${listOpen}|${lastTapText}|${durationOf(rec || { source: {} })}`;
        if (!force && key === drawnKey) return;
        drawnKey = key;
        strip.classList.toggle('is-synced', points.length > 0);
        strip.classList.toggle('is-tapping', tapping);
        const word = unitWord();
        const ids = points.length ? unitIds() : [];
        const backs = backJumps(points, ids);
        if (tapping) {
            statusEl.textContent = lastTapText || (points.length ? `Tap the ${word} you hear` : `Tap the ${word} where the song starts`);
            actionsEl.innerHTML = `<button type="button" class="ct-text" data-act="points" aria-expanded="${listOpen}" ${points.length ? '' : 'disabled'}>Points</button>`
                + `<button type="button" class="ct-text" data-act="undo" ${history.length ? '' : 'disabled'}>Undo</button>`
                + `<button type="button" class="ct-text" data-act="clear" ${points.length ? '' : 'disabled'}>${clearArmed ? 'Press again to clear' : 'Clear'}</button>`
                + '<button type="button" class="ct-text rec-done" data-act="done">Done</button>';
        } else if (points.length) {
            statusEl.textContent = `Synced · ${points.length} ${points.length === 1 ? 'point' : 'points'}`
                + (backs.size ? ` · ${backs.size} ${backs.size === 1 ? 'repeat' : 'repeats'}` : '');
            actionsEl.innerHTML = '<button type="button" class="ct-text" data-act="sync">Edit</button>';
        } else {
            statusEl.textContent = 'Not synced';
            statusEl.title = `The ${rec?.label?.toLowerCase() || 'recording'} plays on its own. The tab won't follow it until you add sync points.`;
            actionsEl.innerHTML = '<button type="button" class="ct-text" data-act="sync">Add points</button>';
        }
        if (points.length) statusEl.removeAttribute('title');
        // Tick marks where the tab is pinned to the recording
        const dur = rec && durationOf(rec);
        marksEl.replaceChildren();
        if (dur) {
            // At most one tick per 4px of track, so many points do not paint it solid; a repeat jump always shows
            const width = (strip.querySelector('.rec-track')?.clientWidth) || 160;
            let lastPx = -Infinity;
            for (const p of [...points].sort((a, b) => a.timeMs - b.timeMs)) {
                const px = Math.min(1, p.timeMs / dur) * width;
                if (px - lastPx < 4 && !backs.has(p.id)) continue;
                lastPx = px;
                const t = document.createElement('i');
                t.style.left = `${Math.min(100, (p.timeMs / dur) * 100)}%`;
                if (backs.has(p.id)) t.className = 'is-back';
                marksEl.appendChild(t);
            }
        }
        // The Edit list: when each point lands, where it puts the reader, and which ones are repeats
        const showList = tapping && listOpen && points.length > 0;
        pointsEl.hidden = !showList;
        pointsEl.replaceChildren();
        if (showList) {
            for (const p of points) {
                const row = document.createElement('div');
                row.className = 'rec-point';
                const where = ids.indexOf(p.barIndex) >= 0 ? unitLabel(p.barIndex, ids) : `A ${word} that is gone`;
                row.innerHTML = '<button type="button" class="ct-text rec-point-go" data-do="seek"></button><span class="rec-point-note"></span>'
                    + '<button type="button" class="ct-text" data-do="remove">Remove</button>';
                const go = row.querySelector('.rec-point-go');
                go.textContent = `${fmtTime(p.timeMs)} · ${where}`;
                go.setAttribute('aria-label', `Play from ${fmtTime(p.timeMs)}, ${where}`);
                row.querySelector('.rec-point-note').textContent = backs.has(p.id) ? 'Repeat' : '';
                for (const b of row.querySelectorAll('button')) b.dataset.point = p.id;
                row.querySelector('[data-do="remove"]').setAttribute('aria-label', `Remove the point at ${fmtTime(p.timeMs)}`);
                pointsEl.appendChild(row);
            }
        }
    }

    function seekFromPointer(e) {
        if (!rec) return;
        const dur = durationOf(rec);
        if (!dur) return;
        const r = track.getBoundingClientRect();
        rec.source.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur);
    }
    let dragging = false;
    track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); seekFromPointer(e); });
    track.addEventListener('pointermove', (e) => { if (dragging) seekFromPointer(e); });
    track.addEventListener('pointerup', () => { dragging = false; });
    track.addEventListener('pointercancel', () => { dragging = false; });
    track.addEventListener('keydown', (e) => {
        if (!rec) return;
        const step = { ArrowLeft: -5000, ArrowRight: 5000, ArrowDown: -5000, ArrowUp: 5000 }[e.key];
        if (step) { e.preventDefault(); rec.source.seek(Math.max(0, rec.source.getTimeMs() + step)); }
    });

    // -- The reading line
    // A marker at the left edge of the tab that glides down at the pace the sync points imply, so the reader sees where
    // the app thinks the recording is and how soon the page will scroll or turn. Page mode: it sweeps the page and the
    // page turns as it reaches the bottom. Scroll mode: it roams the upper part of the screen, and once it passes 60%
    // of the way down the page glides so it stays there.

    const line = document.createElement('div');
    line.className = 'reading-line';
    line.hidden = true;
    line.setAttribute('aria-hidden', 'true');
        const lineHost = output.parentElement || document.body;
    lineHost.appendChild(line);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let rawLast = -1;
    let clockT = 0;
    let clockAt = 0;
    let lastFrameAt = 0;
    let lastFlipAt = 0;
    let holdUntil = 0; // the reader took over (scrolled, turned the page, dragged the strip): the tab stops following for a moment
    let unitCache = { key: null, ids: [] };

    const hold = () => { holdUntil = performance.now() + 3500; };
    output.addEventListener('wheel', hold, { passive: true });
    output.addEventListener('touchmove', hold, { passive: true });
    output.addEventListener('pointerdown', hold, true);
    pageStrip.addEventListener('pointerdown', hold, true);
    document.addEventListener('keydown', (e) => {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) hold();
    }, true);

    /** Every unit of the open tab in reading order: text block numbers, or PDF canvas indexes. */
    function unitIds() {
        const cfg = getConfig();
        if (isPdf(getCurrentFile())) {
            const n = cfg.condensedCanvases?.length || 0;
            if (unitCache.key !== `pdf${n}`) unitCache = { key: `pdf${n}`, ids: Array.from({ length: n }, (_, i) => i) };
            return unitCache.ids;
        }
        const pages = cfg.textState?.pages;
        const key = pages?.length ? pages : output.firstElementChild;
        if (unitCache.key !== key) {
            const roots = pages?.length ? pages : [output];
            const ids = [];
            for (const r of roots) r.querySelectorAll('[data-block]').forEach((b) => ids.push(Number(b.dataset.block)));
            unitCache = { key, ids };
        }
        return unitCache.ids;
    }

    /** The element of a unit when it is on screen now, else null. */
    function unitEl(id) {
        if (id == null) return null;
        if (isPdf(getCurrentFile())) {
            const c = getConfig().condensedCanvases?.[id];
            return c && c.isConnected && output.contains(c) ? c : null;
        }
        return blockEl(id);
    }

    function hideLine() {
        line.classList.add('is-off');
        if (!line.hidden && !line._hiding) {
            line._hiding = setTimeout(() => { line.hidden = true; line._hiding = 0; }, 160);
        }
    }

    function ensureFrame() {
        if (!raf) raf = requestAnimationFrame(frame);
    }

    function frame(now) {
        raf = 0;
        if (!rec || tapping || !points.length) { hideLine(); return; }
        const dt = Math.min(0.1, (now - lastFrameAt) / 1000 || 0.016);
        lastFrameAt = now;

        // The recording's clock is polled; between polls it is carried forward so the line moves smoothly
        const raw = rec.source.getTimeMs() || 0;
        if (raw !== rawLast) { rawLast = raw; clockT = raw; clockAt = now; }
        const playing = rec.source.isPlaying() && !rec.source.isBuffering?.();
        const t = playing ? clockT + Math.min(1000, now - clockAt) : raw;

        const ids = unitIds();
        const pos = positionAt(points, ids, t - latency(), durationOf(rec));
        if (pos == null) { hideLine(); return; }
        const k = Math.min(ids.length - 1, Math.floor(pos));
        const f = Math.min(1, pos - k);
        const cfg = getConfig();
        const pageMode = !!(cfg.pageModeChecked || cfg.pageModeRadio?.checked);
        let el = unitEl(ids[k]);

        // Page mode: the unit is on another page, so turn to it. The reader's own page turns win for a moment.
        if (!el && pageMode && now > holdUntil && now - lastFlipAt > 250) {
            lastFlipAt = now;
            goToUnit(ids[k]);
            el = unitEl(ids[k]);
        }
        if (!el) { hideLine(); if (playing) ensureFrame(); return; }

        const r = el.getBoundingClientRect();
        const nextEl = unitEl(ids[k + 1]);
        const nr = nextEl?.getBoundingClientRect();
        // Toward the next unit when it sits below in the same column; otherwise through this unit alone
        let y = nr && nr.top > r.top + 1 && Math.abs(nr.left - r.left) < 12
            ? r.top + (nr.top - r.top) * f
            : r.top + r.height * f;

        const outR = output.getBoundingClientRect();
        let settling = false;
        if (!pageMode && now > holdUntil) {
            const viewH = output.clientHeight;
            const lineY = y - outR.top + output.scrollTop;
            let target = followTarget({ lineY, viewH, scrollTop: output.scrollTop });
            if (target != null) {
                // With reduced motion the page moves in one step, putting the line near the top, instead of gliding
                if (reduceMotion.matches) target = Math.max(0, lineY - viewH * 0.2);
                const before = output.scrollTop;
                output.scrollTop = reduceMotion.matches ? target : glide(before, target, dt);
                y -= output.scrollTop - before;
                settling = Math.abs(target - output.scrollTop) > 0.5;
            }
        }

        const hostR = lineHost.getBoundingClientRect();
        const visible = y >= outR.top && y <= outR.bottom;
        line.hidden = false;
        if (line._hiding) { clearTimeout(line._hiding); line._hiding = 0; }
        line.classList.toggle('is-off', !visible);
        line.style.transform = `translate3d(${r.left - hostR.left + lineHost.scrollLeft}px, ${y - hostR.top + lineHost.scrollTop}px, 0)`;

        if (playing || settling) ensureFrame();
    }

    // -- The loop: show the strip, move the progress, and keep the reading line going when there are some points

    let lastFileRef = null;
    function tick() {
        const file = getCurrentFile();
        const eligible = (isText(file) || isPdf(file)) && !document.body.classList.contains('library-view-active');
        if (file !== lastFileRef) {
            lastFileRef = file;
            stickyKind = null;
            if (tapping) stopTapping();
            lastUnit = null;
            drawnKey = '';
            markCurrent(null);
        }
        let next = eligible ? activeRecording(file) : null;
        // With Synth selected, a video or audio file is not what plays, so it gets no recording bar and the page strip stays
        if (next && next.source !== midiSource && synthSelected()) next = null;
        const sameMedia = next && rec && next.source === rec.source && JSON.stringify(next.media) === JSON.stringify(rec.media);
        if (!sameMedia) {
            if (tapping) stopTapping();
            rec = next;
            lastUnit = null;
            readPoints();
            drawn(true);
        }
        strip.hidden = !rec;
        document.body.classList.toggle('rec-strip-on', Boolean(rec));
        if (!rec) { hideLine(); return; }
        // Keep the strip directly above the page strip, wherever that strip is currently placed
        if (strip.nextElementSibling !== pageStrip) pageStrip.before(strip);
        const t = rec.source.getTimeMs() || 0;
        const dur = durationOf(rec);
        timeEl.textContent = dur ? `${fmtTime(t)} / ${fmtTime(dur)}` : fmtTime(t);
        const frac = dur ? Math.min(1, t / dur) : 0;
        fill.style.transform = `scaleX(${frac})`;
        if (head) head.style.left = `${frac * 100}%`;
        drawn();
        // The reading line shows where the recording puts the reader, and the tab follows it (see frame below)
        if (points.length && !tapping) ensureFrame(); else hideLine();
        if (tapping) {
            // The lines already pinned show while tapping, so the user sees what is left
            // and lines whose point was cleared or undone stop showing
            const pinned = new Set(points.map((p) => String(p.barIndex)));
            output.querySelectorAll('.ts-pinned').forEach((n) => { if (!pinned.has(n.dataset.block)) n.classList.remove('ts-pinned'); });
            for (const p of points) blockEl(p.barIndex)?.classList.add('ts-pinned');
        }
    }
    setInterval(tick, 150);
    window.addEventListener('audiosync:changed', () => { readPoints(); drawn(true); });
    tick();
}
