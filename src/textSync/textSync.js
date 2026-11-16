// textSync/textSync.js
// A recording (the Original video, an audio file or a MIDI synth source) beside a text or PDF tab. These tabs have no
// bars, so a sync point pins a recording time to a block of a text tab (a line, or a whole staff system) or to a
// page of a PDF. The recording has its own progress strip above the page strip and is NOT synced by default:
// the strip says so, the tab does not follow it, and "Add sync points" starts tap-to-sync (play the recording and tap
// the line or page you hear). Once there are points the tab follows the recording: it scrolls to the line, or turns the page.
//
// Points are stored with the existing sync store (so they back up and sync like any others), under the song key
// a song key of their own (the song and the score file's hash, see anchors.js) so the score follower and editor never see
// them, and so a song's text and PDF tabs keep separate points. The store keeps Music Pack sync points: the page
// in the PDF, or the line of the block's top string row (audioSync/anchors.js). In here a point is
// { barIndex: unit, occurrence: 0, pos: 0, timeMs } where unit is the block number (text) or the index of the page among
// the pages the tab shows, which is what the tab is drawn and followed by.
//
// Repeats: points are ordered by time, not by position, so a point that names an earlier unit than the one before it is a
// jump back (a repeat sign, a D.S., a second verse on the first page). Tapping an earlier page or line while the
// recording plays is how one is made; the strip marks those points and the Edit list names them.

import { jamYouTubeControl, onYouTubeEvent, playerState, getSongKey } from '../soundPlayer.js';
import { createYouTubeSource } from '../audioSync/mediaSource.js';
import { getLocalRecording } from '../audioSync/audioFilePlayer.js';
import { getRealAudioActiveSource } from '../audioSync/realAudioController.js';
import { synthPlayerState, isSynthPlaying, playPauseSynth, pauseSynthPlayer, seekSynthPercent, getAudioLatencyMs } from '../gpProcessor/gpPlayer.js';
import { midiSynthActive } from '../classtab/midiSynth.js';
import { loadRecord, saveRecord, isSyncSharedFromOriginal, setSyncSharedFromOriginal } from '../audioSync/syncStore.js';
import { pdfPlayheadAt, hasPositions, rowSpans, playheadBox } from '../audioSync/pdfPosition.js';
import { unitsToPoints, pointsToUnits, scoreSyncKey, legacyScoreSyncKey, textBlocksOf, claimLegacyRecord } from '../audioSync/anchors.js';
import { sha256 } from '../mpak/core/index.js';
import { getScrubState, applyScrubValue } from '../utils/pageScrubber.js';
import { attachPillCursor } from '../utils/readerCursorShape.js';
import { makeId, formatTime } from '../audioSync/syncEdit.js';
import { showToast } from '../utils/toast.js';
import { positionAt, barProgressAt, backJumps, followTarget, glide } from './readingLine.js';
import { textState } from '../textProcessor/textHandler.js';

const $ = (id) => document.getElementById(id);

// --- Recordings -------------------------------------------------------------------------------------------------------

let _ytSource = null;
const getYtSource = () => (_ytSource || (_ytSource = createYouTubeSource(jamYouTubeControl, onYouTubeEvent)));
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
    const ytSrc = getYtSource();
    const yt = ytSrc.id ? { source: ytSrc, label: 'Video', media: { kind: 'youtube', videoId: ytSrc.id } } : null;
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

    // The open tab as the store knows it: the hash of its file, which names its points, and for text the blocks of its own
    // bytes, which turn a line into a unit. Both come from the file itself, so they cannot belong to another tab.
    const tabInfo = new WeakMap();
    let tab = null;
    let tabLoadingFor = null;
    function tabOf(file) {
        if (!tabInfo.has(file)) {
            tabInfo.set(file, (async () => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                return { hash: await sha256(bytes), blocks: isText(file) ? textBlocksOf(bytes) : [] };
            })());
        }
        return tabInfo.get(file);
    }
    const textKey = () => (tab ? scoreSyncKey(getSongKey(), tab.hash) : null);
    const unitWord = () => (isPdf(getCurrentFile()) ? 'page' : 'line');
    const latency = () => getAudioLatencyMs() || 0;

    const anchorKind = () => (isPdf(getCurrentFile()) ? 'pdf' : 'text');
    const anchorCtx = () => ({ firstPage: Number(getCurrentFile()?.startPage) || 1, blocks: tab?.blocks || [] });

    /** The stored points of the recording as units, or [] when there are none or they are for the other kind of tab. */
    function savedUnits() {
        const key = textKey();
        if (!key) return [];
        const stored = loadRecord(key, rec.media) || claimLegacyRecord(getSongKey(), rec.media, key, anchorKind(), anchorCtx());
        if (!stored) return [];
        return stored.anchorType === anchorKind() ? pointsToUnits(stored.points, stored.anchorType, anchorCtx()) : [];
    }

    function readPoints() {
        if (!rec) { points = []; return; }
        const saved = savedUnits();
        if (saved.length > 0 && !saved.every((p) => p.source === 'auto')) {
            points = saved;
        } else if (rec.source === midiSource && isText(getCurrentFile()) && textState.alignment?.points?.length) {
            points = [...textState.alignment.points];
        } else {
            points = saved;
        }
    }
    function writePoints(next) {
        points = [...next].sort((a, b) => a.timeMs - b.timeMs);
        const key = textKey();
        if (key) saveRecord(key, rec.media, unitsToPoints(points, anchorKind(), anchorCtx()), undefined, undefined, anchorKind());
    }
    function resetAutoPoints() {
        if (!rec) return;
        const key = textKey();
        if (key) saveRecord(key, rec.media, [], undefined, undefined, anchorKind());
        readPoints();
        history = [];
        lastTapText = 'Reset to automatic alignment';
        drawn(true);
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
                    const onePage = (cfg.getPageStep?.() ?? state.perView) === 1;
                    const forward = idx >= state.value + state.perView;
                    const target = (onePage === forward) ? idx - state.perView + 1 : idx;
                    applyScrubValue(cfg, state, Math.max(state.min, Math.min(state.max, target)));
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
        if (!tapping && rec && isText(getCurrentFile())) {
            const barEl = e.target.closest?.('.ts-bar');
            if (barEl) {
                const vIdx = Number(barEl.dataset.visualBar);
                const bIdx = Number(barEl.dataset.block);
                const bOff = Number(barEl.dataset.barOffset || 0);
                const matchPt = points.find((p) => p.barIndex === bIdx && (p.barOffset || 0) === bOff)
                    || points.find((p) => p.visualBarIndex === vIdx);
                const vb = textState.alignment?.visualBars?.[vIdx];
                const targetMs = matchPt ? matchPt.timeMs : vb?.startMs;
                if (typeof targetMs === 'number') {
                    holdUntil = 0;
                    rec.source.seek(Math.max(0, targetMs + 1 + latency()));
                    ensureFrame();
                }
            }
            return;
        }
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
        else if (act === 'reset-auto') resetAutoPoints();
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
        const isAuto = points.length > 0 && points.every((p) => p.source === 'auto');
        const canResetAuto = rec?.source === midiSource && isText(getCurrentFile()) && Boolean(textState.alignment?.points?.length) && !isAuto;
        const key = `${clearArmed}|${rec?.label}|${points.length}|${isAuto}|${canResetAuto}|${tapping}|${listOpen}|${lastTapText}|${durationOf(rec || { source: {} })}`;
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
                + (canResetAuto ? '<button type="button" class="ct-text" data-act="reset-auto">Reset to auto</button>' : '')
                + `<button type="button" class="ct-text" data-act="undo" ${history.length ? '' : 'disabled'}>Undo</button>`
                + `<button type="button" class="ct-text" data-act="clear" ${points.length ? '' : 'disabled'}>${clearArmed ? 'Press again to clear' : 'Clear'}</button>`
                + '<button type="button" class="ct-text rec-done" data-act="done">Done</button>';
        } else if (points.length) {
            const repeats = backs.size ? `${backs.size} ${backs.size === 1 ? 'repeat' : 'repeats'}` : '';
            const word1 = isAuto ? 'Auto-synced' : 'Synced';
            statusEl.textContent = '';
            statusEl.removeAttribute('title');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ct-text';
            btn.dataset.act = 'sync';
            if (repeats) {
                const detailEl = document.createElement('span');
                detailEl.className = 'rec-detail';
                detailEl.textContent = ` · ${repeats}`;
                btn.replaceChildren(word1, detailEl);
                btn.title = `${word1} · ${repeats}`;
            } else {
                btn.textContent = word1;
            }
            actionsEl.replaceChildren(btn);
        } else {
            statusEl.textContent = '';
            statusEl.removeAttribute('title');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ct-text';
            btn.dataset.act = 'sync';
            btn.textContent = 'Not synced';
            btn.title = `The ${rec?.label?.toLowerCase() || 'recording'} plays on its own. The tab won't follow it until you add sync points.`;
            actionsEl.replaceChildren(btn);
        }
        if (tapping) statusEl.removeAttribute('title');
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

    // A PDF whose sync points name positions on the page also gets a vertical playhead at the place the recording is at
    const pdfCursor = document.createElement('div');
    pdfCursor.className = 'pdf-cursor';
    pdfCursor.hidden = true;
    pdfCursor.setAttribute('aria-hidden', 'true');
    lineHost.appendChild(pdfCursor);
    let spanCache = { points: null, spans: null };
    const rowSpansOf = () => {
        if (spanCache.points !== points) spanCache = { points, spans: rowSpans(points) };
        return spanCache.spans;
    };

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
    output.addEventListener('pointerdown', (e) => {
        if (!e.target.closest?.('.ts-bar')) hold();
    }, true);
    pageStrip.addEventListener('pointerdown', hold, true);
    document.addEventListener('keydown', (e) => {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        const isHoriz = isText(getCurrentFile()) && textState.hasSystems && textState.layoutMode === 'horizontal';
        if (isHoriz && rec && points.length && !tapping && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            const dir = e.key === 'ArrowRight' ? 1 : -1;
            const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
            const curMs = Math.max(0, (rec.source.getTimeMs() || 0) - latency());
            let curIdx = 0;
            for (let i = 0; i < sorted.length; i++) {
                if (sorted[i].timeMs <= curMs + 40) curIdx = i;
                else break;
            }
            let targetIdx = curIdx;
            if (e.shiftKey) {
                const vBars = textState.alignment?.visualBars || [];
                let found = -1;
                for (let i = curIdx + dir; i >= 0 && i < sorted.length; i += dir) {
                    const vb = vBars[sorted[i].visualBarIndex];
                    if (vb && (vb.doubleBar || vb.repeatStart || vb.repeatEnd)) {
                        found = i;
                        break;
                    }
                }
                targetIdx = found >= 0 ? found : Math.max(0, Math.min(sorted.length - 1, curIdx + dir * 4));
            } else {
                targetIdx = Math.max(0, Math.min(sorted.length - 1, curIdx + dir));
            }
            const targetPt = sorted[targetIdx];
            if (targetPt) {
                holdUntil = 0;
                rec.source.seek(Math.max(0, targetPt.timeMs + 1 + latency()));
                ensureFrame();
            }
            return;
        }
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
            const seen = new Set();
            for (const r of roots) {
                r.querySelectorAll('[data-block]').forEach((b) => {
                    const num = Number(b.dataset.block);
                    if (!seen.has(num)) {
                        seen.add(num);
                        ids.push(num);
                    }
                });
            }
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
        output.querySelectorAll('.ts-bar-cursor:not([hidden])').forEach((c) => { c.hidden = true; });
        pdfCursor.hidden = true;
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
        const dur = durationOf(rec);
        const effTime = t - latency();

        // Horizontal Ribbon mode: pan `.txt-ribbon-scroll` so the active bar glides past the stationary 25% playhead
        if (isText(getCurrentFile()) && textState.hasSystems && textState.layoutMode === 'horizontal') {
            hideLine();
            const prog = barProgressAt(points, ids, effTime, dur);
            const scrollEl = output.querySelector('.txt-ribbon-scroll');
            if (!prog || !scrollEl) {
                if (playing) ensureFrame();
                return;
            }
            const barEl = scrollEl.querySelector(`.ts-bar[data-block="${prog.unitId}"][data-bar-offset="${prog.barOffset}"]`)
                || (prog.visualBarIndex != null ? scrollEl.querySelector(`.ts-bar[data-visual-bar="${prog.visualBarIndex}"]`) : null)
                || scrollEl.querySelector(`.ts-bar[data-block="${prog.unitId}"]`);
            if (!barEl) {
                if (playing) ensureFrame();
                return;
            }
            scrollEl.querySelectorAll('.ts-bar.is-active-bar').forEach((b) => {
                if (b !== barEl) b.classList.remove('is-active-bar');
            });
            barEl.classList.add('is-active-bar');

            let settling = false;
            if (now > holdUntil) {
                const scrollR = scrollEl.getBoundingClientRect();
                const barR = barEl.getBoundingClientRect();
                const barLeftInTrack = (barR.left - scrollR.left) + scrollEl.scrollLeft;
                const playheadX = scrollEl.clientWidth * 0.25;
                const targetLeft = Math.max(0, barLeftInTrack + barR.width * prog.barFrac - playheadX);
                const before = scrollEl.scrollLeft;
                const isJump = !playing || reduceMotion.matches || Math.abs(targetLeft - before) > scrollEl.clientWidth * 0.65;
                scrollEl.scrollLeft = isJump ? targetLeft : glide(before, targetLeft, dt, 0.12);
                settling = Math.abs(targetLeft - scrollEl.scrollLeft) > 0.5;
            }
            if (playing || settling) ensureFrame();
            return;
        }

        const pos = positionAt(points, ids, effTime, dur);
        if (pos == null) { hideLine(); return; }
        // A PDF with positions: the playhead says which page and where on it. Without them the page-level pace below is used.
        const place = isPdf(getCurrentFile()) && hasPositions(points) ? pdfPlayheadAt(points, effTime) : null;
        const placed = place && Number.isFinite(place.x) ? place : null;
        const k = placed ? Math.min(ids.length - 1, Math.max(0, ids.indexOf(placed.unit))) : Math.min(ids.length - 1, Math.floor(pos));
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

        // Intra-system bar cursor for vertical and page modes
        if (isText(getCurrentFile()) && textState.hasSystems) {
            const prog = barProgressAt(points, ids, effTime, dur);
            const activeCursor = el.querySelector?.('.ts-bar-cursor');
            output.querySelectorAll('.ts-bar-cursor:not([hidden])').forEach((c) => {
                if (c !== activeCursor) c.hidden = true;
            });
            if (activeCursor && prog) {
                const sysBlock = textState.blocks?.[prog.unitId];
                const trimCols = sysBlock?.trimCols ?? 2;
                attachPillCursor(activeCursor); // the page and scroll views hold clones, which lost their drawing
                activeCursor.hidden = false;
                activeCursor.style.left = `calc(${trimCols}ch + (100% - ${trimCols}ch) * ${prog.colFrac.toFixed(4)})`;
            }
        }

        const r = el.getBoundingClientRect();
        const nextEl = unitEl(ids[k + 1]);
        const nr = nextEl?.getBoundingClientRect();
        // Toward the next unit when it sits below in the same column; otherwise through this unit alone
        let y = nr && nr.top > r.top + 1 && Math.abs(nr.left - r.left) < 12
            ? r.top + (nr.top - r.top) * f
            : r.top + r.height * f;

        let box = null;
        if (placed && el.height) {
            box = playheadBox(el, r.height, placed.y, rowSpansOf().get(placed.unit));
            y = r.top + box.y;
        }

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
        line.hidden = !!box; // the cursor replaces the left-edge marker
        if (line._hiding) { clearTimeout(line._hiding); line._hiding = 0; }
        line.classList.toggle('is-off', !visible);
        line.style.transform = `translate3d(${r.left - hostR.left + lineHost.scrollLeft}px, ${y - hostR.top + lineHost.scrollTop}px, 0)`;
        if (box) {
            pdfCursor.hidden = false;
            attachPillCursor(pdfCursor);
            pdfCursor.classList.toggle('is-off', !visible);
            pdfCursor.style.height = `${box.h}px`;
            pdfCursor.style.transform = `translate3d(${r.left - hostR.left + lineHost.scrollLeft + placed.x * r.width}px, ${y - box.h / 2 - hostR.top + lineHost.scrollTop}px, 0)`;
        } else {
            pdfCursor.hidden = true;
        }

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
            tab = null;
            tabLoadingFor = null;
            if (tapping) stopTapping();
            lastUnit = null;
            drawnKey = '';
            markCurrent(null);
        }
        if (eligible && !tab && tabLoadingFor !== file) {
            tabLoadingFor = file;
            tabOf(file).then((info) => {
                if (getCurrentFile() !== file) return;
                tab = info;
                // the song's share option moves to the tab's own key with its points
                try {
                    const own = textKey();
                    if (own && isSyncSharedFromOriginal(legacyScoreSyncKey(getSongKey())) && !isSyncSharedFromOriginal(own)) setSyncSharedFromOriginal(own, true);
                } catch { /* optional */ }
                readPoints();
                drawn(true);
            }).catch((e) => console.warn('[textSync] could not read the tab:', e));
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
    window.addEventListener('majestictab:txt-aligned', () => {
        unitCache = { key: null, ids: [] };
        readPoints();
        drawn(true);
        if (points.length && !tapping) ensureFrame();
    });
    window.addEventListener('majestictab:txt-version-changed', () => {
        unitCache = { key: null, ids: [] };
        drawn(true);
        if (points.length && !tapping) ensureFrame();
    });
    tick();
}
