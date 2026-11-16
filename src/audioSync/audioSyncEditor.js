// audioSyncEditor.js
// The "Sync points" dialog: a table of the points for the loaded song and recording, with in-place edits, add,
// delete, shift, jump, and import and export (AlphaTab sync points text and JSON). Every edit is saved at once
// (syncStore) and announced with an `audiosync:changed` window event, so the follower picks it up.

import { getSongKey, getVideoInfo } from '../soundPlayer.js';
import { openModal, closeModal } from '../gpProcessor/mixerPanel.js';
import { loadRecord, listRecords, mediaKey, saveRecord, loadRestorePoint, samePoints, SYNC_CHANGED_EVENT } from './syncStore.js';
import { loadRecordingPeaks, loadRecordingFlux, stemSetName } from './stemSet.js';
import { getRecordingMeta } from './recordingMeta.js';
import { refineOffset } from './refineOffset.js';
import { measureAlignment, compareSyncs, conflictText } from './alignCheck.js';
import { getScoreContext } from './audioSyncController.js';
import { pointProblems, syncFit } from './pointCheck.js';
import { buildBeatMap } from './beatMap.js';
import { loadFromUrl, setToPoints, setsFittingScore, detectSets } from './importers/index.js';
import { getMidiTickLookup } from '../gpProcessor/gpPlayer.js';
import { hasNativeHttp } from '../s3Client.js';
import { createSyncTimeline } from './syncTimeline.js';
import { isTvMode } from '../tvMode.js';
import { scoreMsToTick, positionToScoreMs } from './scorePositions.js';
import {
    updatePoint, removePoints, shiftAfter, formatTime, parseTime,
    toAlphaTexSync, importPoints
} from './syncEdit.js';

export { SYNC_CHANGED_EVENT };

export const PROBLEM_TEXT = {
    missing: 'This bar pass is not played in the score',
    order: 'Out of order: must come after the previous point in both the recording and the score',
    tempo: 'Implies a tempo far from the written one'
};

const escapeHtml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * One editor serves every recording: `open({ source, media, peaks })` edits the points of that MediaSource and its
 * media descriptor (`{ kind: 'youtube', videoId }` or a local file's); `peaks` is the waveform, for a local file.
 */
export function initAudioSyncEditor() {
    const $ = (id) => document.getElementById(id);
    const modal = $('syncEditorModal');
    if (!modal) return { open() {} };

    const rowsEl = $('syncRows');
    let points = [];
    let current = null; // { source, media, peaks } of the open editor
    let currentRecord = null;
    let scoreCtx = null; // the score's timeline, read once per render
    let selectedId = null;
    let offSource = null;

    const media = () => current.media;
    const source = { getTimeMs: () => current.source.getTimeMs(), seek: (ms) => current.source.seek(ms) };
    const songKey = () => getSongKey();

    // Every edit in this dialog can be undone: the points before each one are kept (in memory only)
    let undoStack = [];
    let redoStack = [];
    const HISTORY_LIMIT = 100;

    function updateUndoButtons() {
        $('syncUndoBtn').disabled = !undoStack.length;
        $('syncRedoBtn').disabled = !redoStack.length;
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(points);
        persist(undoStack.pop(), { record: false });
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(points);
        persist(redoStack.pop(), { record: false });
    }

    function persist(next, { record = true } = {}) {
        if (record) {
            undoStack.push(points);
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
            redoStack = [];
        }
        points = next;
        // An edit keeps the points from before it as the restore point, when the recording has none yet
        saveRecord(songKey(), media(), points, undefined, undefined, undefined, { holdPrevious: true });
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        render();
    }

    const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

    // Restore original: the restore point is the points a pack or importer brought, or ones kept with "Keep as restore point"
    function updateRestoreButtons() {
        const restore = loadRestorePoint(songKey(), media());
        const differs = Boolean(restore) && !samePoints(restore.points, points);
        const btn = $('syncRestoreBtn');
        btn.disabled = !differs;
        btn.title = restore
            ? `Put back the restore point: ${restore.points.length} points, saved ${when(restore.savedAt)}${differs ? '' : ' (same as now)'}`
            : 'No restore point yet. One is kept when you first edit, or when you choose Keep as restore point';
        const keep = $('syncKeepBtn');
        keep.disabled = !points.length || (Boolean(restore) && samePoints(restore.points, points));
    }

    function numberInput(value, { min, max, step, label, onCommit }) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'form-control form-control-sm';
        Object.assign(input, { value: String(value), min, max, step });
        input.setAttribute('aria-label', label);
        input.addEventListener('change', () => {
            const n = Number(input.value);
            if (Number.isFinite(n)) onCommit(n);
            else render();
        });
        return input;
    }

    function buildRow(p, info) {
        const row = document.createElement('div');
        row.className = 'sync-row';
        row.dataset.id = p.id;
        const flag = info.flags[p.id];
        if (flag) row.classList.add('has-problem');

        // The score shows bar and pass numbers from 1; points store them from 0
        row.append(
            numberInput(p.barIndex + 1, { min: 1, step: 1, label: 'Bar', onCommit: (n) => persist(updatePoint(points, p.id, { barIndex: Math.max(0, Math.round(n) - 1) })) }),
            numberInput(p.occurrence + 1, { min: 1, step: 1, label: 'Pass', onCommit: (n) => persist(updatePoint(points, p.id, { occurrence: Math.max(0, Math.round(n) - 1) })) }),
            numberInput(Number(p.pos.toFixed(3)), { min: 0, max: 1, step: 0.05, label: 'Position in the bar, 0 to 1', onCommit: (n) => persist(updatePoint(points, p.id, { pos: Math.min(1, Math.max(0, n)) })) })
        );

        const time = document.createElement('input');
        time.type = 'text';
        time.className = 'form-control form-control-sm';
        time.value = formatTime(p.timeMs);
        time.spellcheck = false;
        time.setAttribute('aria-label', 'Time in the recording');
        time.addEventListener('change', () => {
            const ms = parseTime(time.value);
            if (ms === null) render();
            else persist(updatePoint(points, p.id, { timeMs: ms }));
        });
        row.append(time);

        const tempo = document.createElement('span');
        tempo.className = 'sync-col-extra small text-white-50';
        const t = info.tempos[p.id];
        tempo.textContent = t ? `${Math.round(t.bpm)} bpm` : '-';
        if (t) tempo.title = `${t.ratio.toFixed(2)}x the written tempo`;
        const src = document.createElement('span');
        src.className = 'sync-col-extra small text-white-50';
        src.textContent = p.source;

        const actions = document.createElement('div');
        actions.className = 'sync-row-actions';
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'btn btn-sm btn-theme-icon';
        jump.title = 'Jump to this point';
        jump.setAttribute('aria-label', 'Jump to this point');
        jump.innerHTML = '<i class="bi-skip-end-fill"></i>';
        jump.addEventListener('click', () => jumpTo(p));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-sm btn-theme-icon';
        del.title = 'Delete this point';
        del.setAttribute('aria-label', 'Delete this point');
        del.innerHTML = '<i class="bi-trash"></i>';
        del.addEventListener('click', () => persist(removePoints(points, [p.id])));
        actions.append(jump, del);
        row.append(tempo, src, actions);

        if (flag) {
            const note = document.createElement('div');
            note.className = 'sync-problem';
            note.textContent = PROBLEM_TEXT[flag];
            row.append(note);
        }
        return row;
    }

    const timeline = createSyncTimeline({
        host: $('syncEditorTimeline'),
        getData: () => (scoreCtx && current ? {
            timeline: scoreCtx.timeline, points, source: current.source, peaks: current.peaks || null,
            durationMs: current.source.durationMs ?? null, selectedId
        } : null),
        onChangePoints: (next) => persist(next),
        onSeek: ({ mediaMs, scoreMs }) => seekTo(mediaMs, scoreMs),
        onSelect: (id) => selectRow(id)
    });

    function selectRow(id) {
        selectedId = id;
        for (const row of rowsEl.children) {
            const on = row.dataset.id === id;
            row.classList.toggle('is-selected', on);
            if (on) row.scrollIntoView({ block: 'nearest' });
        }
        const panel = $('syncSelectedPointPanel');
        if (!panel) return;
        const p = points.find(pt => pt.id === id);
        if (!p) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = 'block';
        const barLabel = $('syncSelectedBarLabel');
        if (barLabel) barLabel.textContent = `Bar ${p.barIndex + 1}`;
        const timeLabel = $('syncSelectedTimeLabel');
        if (timeLabel) timeLabel.textContent = `at ${formatTime(p.timeMs)}`;
        const ctx = scoreCtx || getScoreContext();
        const info = ctx ? pointProblems(ctx.timeline, points) : { flags: {} };
        const flag = info.flags[p.id];
        const chip = $('syncSelectedStatusChip');
        if (chip) {
            if (flag) {
                chip.className = 'chip warn';
                chip.textContent = 'Check';
            } else {
                chip.className = 'chip ok';
                chip.textContent = 'On the beat';
            }
        }
    }

    function render() {
        const ctx = scoreCtx = getScoreContext();
        const info = ctx ? pointProblems(ctx.timeline, points) : { flags: {}, tempos: {} };
        rowsEl.replaceChildren(...points.map(p => buildRow(p, info)));
        if (selectedId && !points.some(p => p.id === selectedId)) selectedId = null;
        selectRow(selectedId);
        timeline.refresh();
        updateUndoButtons();
        $('syncEmpty').hidden = points.length > 0;
        updateRestoreButtons();
        const totalBars = ctx?.timeline?.bars?.length || 0;
        // The score's bars are the ones it plays, so a repeated bar counts once per pass
        const syncedBars = new Set(points.map(p => `${p.barIndex}:${p.occurrence || 0}`)).size;
        const flagged = Object.keys(info.flags).length;
        // Plain text separated by middle dots, as everywhere else: statuses are not pills. What needs a look is in ink.
        const parts = [`<span class="tnum">${points.length} point${points.length === 1 ? '' : 's'}, ${syncedBars} of ${totalBars} bars synced</span>`];
        if (totalBars > syncedBars && points.length > 0) parts.push(`<span class="tnum">${totalBars - syncedBars} not synced</span>`);
        if (flagged > 0) parts.push(`<span class="sync-info-check tnum">${flagged} to check</span>`);
        const fit = ctx && points.length ? syncFit(ctx.timeline, points) : null;
        if (fit) parts.push(`<span class="${fit.level === 'good' ? '' : 'sync-info-check'}">${escapeHtml(fit.text)}</span>`);
        if (currentRecord?.media?.origin?.fromTabName || currentRecord?.media?.origin?.fromSongKey) {
            const originName = currentRecord.media.origin.fromTabName || currentRecord.media.origin.fromSongKey;
            parts.push(`<span>Copied from tab ${escapeHtml(originName)}</span>`);
        }
        let infoHtml = parts.join('');
        infoHtml += `<span class="sync-info-check sync-info-note" id="syncAlignNote"${alignText ? '' : ' hidden'}>${escapeHtml(alignText)}</span>`;
        $('syncEditorInfo').innerHTML = infoHtml;
        checkAlignment();
        refreshFromRow();
    }

    // Does another recording of this song have a sync that disagrees with how the two recordings line up? The audio
    // offsets and the other recordings' peaks are kept for as long as the page is open, so an edit costs one comparison.
    const alignments = new Map();
    const otherPeaks = new Map();
    const suggested = new Map(); // `${this}>${other}` -> how much later this recording is than the other, once measured
    const pairKey = (otherMedia) => `${mediaKey(media())}>${mediaKey(otherMedia)}`;
    let filledFor = ''; // the pair whose measured offset is already in the box, so a typed value is not overwritten
    let alignText = '';
    let conflict = null; // { other: record, alignment } while another recording's sync disagrees with this one
    async function checkAlignment() {
        const cur = current;
        const has = (r) => r.points.some((p) => Number.isInteger(p.barIndex));
        const others = cur?.media?.kind === 'local' && cur.peaks && points.some((p) => Number.isInteger(p.barIndex))
            ? listRecords(songKey()).filter((r) => r.media?.kind === 'local' && r.media.audioId !== cur.media.audioId && has(r)).slice(0, 6)
            : [];
        let text = '';
        conflict = null;
        for (const other of others) {
            const id = other.media.audioId;
            if (!otherPeaks.has(id)) otherPeaks.set(id, await loadRecordingPeaks(songKey(), other.media));
            const peaks = otherPeaks.get(id);
            if (!peaks) continue;
            const key = `${cur.media.audioId}|${id}|${peaks.length}`;
            if (!alignments.has(key)) alignments.set(key, measureAlignment(cur.peaks, peaks));
            const alignment = alignments.get(key);
            if (alignment.kind === 'offset') suggested.set(pairKey(other.media), -alignment.offsetMs);
            text = conflictText(compareSyncs(points, other.points, alignment), alignment, other.media.name || 'another recording');
            if (text) { conflict = { other, alignment }; break; }
        }
        if (current !== cur) return;
        alignText = text || '';
        $('syncRederiveBtn').hidden = !conflict;
        fillFromOffset();
        if (conflict) $('syncRederiveBtn').title = `Replace these points with the ones of ${conflict.other.media.name || 'the other recording'}, moved by how far the two recordings are apart`;
        const el = $('syncAlignNote');
        if (el) { el.textContent = alignText; el.hidden = !alignText; }
    }

    /** Seek the recording, and the cursor with it when the score can place the time. */
    function seekTo(mediaMs, scoreMs) {
        source.seek(mediaMs);
        const ctx = scoreCtx || getScoreContext();
        if (ctx && scoreMs !== null) ctx.api.tickPosition = scoreMsToTick(ctx.timeline, scoreMs);
    }

    function jumpTo(p) {
        selectRow(p.id);
        const ctx = scoreCtx || getScoreContext();
        seekTo(p.timeMs, ctx ? positionToScoreMs(ctx.timeline, p) : null);
    }

    /** A lone web address in the box, rather than sync text. */
    const isUrl = (text) => /^https?:\/\/\S+$/i.test(text.trim());

    async function importFrom(text, merge) {
        const status = $('syncImportStatus');
        if (isUrl(text)) {
            if (!await importFromUrl(text.trim())) return;
            text = $('syncImportText').value;
        }
        const incoming = importPoints(text);
        if (!incoming || !incoming.length) {
            status.textContent = 'No sync points found';
            return;
        }
        persist(merge ? [...points, ...incoming].sort((a, b) => a.timeMs - b.timeMs) : incoming);
        status.textContent = `Imported ${incoming.length} point${incoming.length === 1 ? '' : 's'}`;
        $('syncImportText').value = '';
    }

    /** Text from a web address. The native app is not bound by CORS; in a browser the site has to allow it. */
    async function fetchText(url) {
        let res;
        try {
            res = await (hasNativeHttp() ? window.__TAURI__.http.fetch : fetch)(url, { headers: { Accept: 'application/json, text/plain, */*' } });
        } catch {
            throw new Error('Could not reach that address. In the browser the site must allow cross-origin requests; the desktop and mobile apps can fetch it.');
        }
        if (!res.ok) throw new Error(`That address answered ${res.status}.`);
        return res.text();
    }

    let urlSets = [];

    /** The played bars of the open score, in play order. */
    function playedBars() {
        const ctx = getScoreContext();
        const bars = ctx ? buildBeatMap(getMidiTickLookup(ctx.api)).bars : [];
        if (!bars.length) throw new Error('Open the tab first, so the points can be matched to its bars.');
        return bars;
    }

    function showUrlSet(index) {
        const status = $('syncImportStatus');
        try {
            const info = {};
            const incoming = setToPoints(urlSets[index], playedBars(), info);
            $('syncImportText').value = toAlphaTexSync(incoming);
            const more = info.extra ? ` The list has ${info.extra} more bars than the score, so it was read from bar 1 and the last ${info.extra} were left out.` : '';
            status.textContent = `${incoming.length} points ready.${more} Choose Replace points or Add to points.`;
        } catch (e) {
            $('syncImportText').value = '';
            status.textContent = e.message;
        }
    }

    /** Fetches the address and puts the converted points text in the box. Resolves true when points are ready. */
    async function importFromUrl(url) {
        const status = $('syncImportStatus');
        status.textContent = 'Fetching...';
        const select = $('syncImportSet');
        select.hidden = true;
        try {
            const found = await loadFromUrl(url, fetchText);
            urlSets = setsFittingScore(found, playedBars());
            select.replaceChildren(...urlSets.map((s, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: s.label })));
            select.hidden = urlSets.length < 2;
            showUrlSet(0);
            return $('syncImportText').value !== '';
        } catch (e) {
            status.textContent = e.message;
            return false;
        }
    }

    $('syncRestoreBtn').addEventListener('click', () => {
        const restore = loadRestorePoint(songKey(), media());
        if (!restore || samePoints(restore.points, points)) return;
        if (!confirm(`Replace the ${points.length} current points with the restore point (${restore.points.length} points, saved ${when(restore.savedAt)})? Undo brings the current ones back while this window is open.`)) return;
        persist(restore.points);
    });
    $('syncKeepBtn').addEventListener('click', () => {
        if (!points.length) return;
        saveRecord(songKey(), media(), points, undefined, undefined, undefined, { restoreTo: points });
        $('syncEditorInfo').textContent = `Kept these ${points.length} points as the restore point`;
        updateRestoreButtons();
    });

    const describeMove = (ms) => (ms ? `moved ${Math.abs(ms)} ms ${ms > 0 ? 'later' : 'earlier'}` : 'not moved');
    const recordingName = (m) => (m.kind === 'local' && stemSetName(getRecordingMeta(songKey(), m))) || m.name || (m.kind === 'youtube' ? getVideoInfo(m.videoId)?.title || m.label || 'YouTube video' : 'another recording');

    /** Replaces this recording's points with `other`'s, `laterMs` later (negative: earlier). One undo step. */
    function takeSyncFrom(other, laterMs, note = '') {
        const next = other.points.map((p) => ({ ...p, timeMs: p.timeMs + laterMs })).filter((p) => p.timeMs >= 0);
        if (!next.length) return;
        const ask = `Replace the ${points.length} current points with the ${next.length} of ${recordingName(other.media)}, ${describeMove(laterMs)}${note}? Undo brings the current ones back while this window is open.`;
        if (!points.length || confirm(ask)) persist(next);
    }

    // "Use the sync of ...": for a recording the app cannot measure against another one (a YouTube video), the offset is typed
    const fromRecords = () => {
        const mine = mediaKey(media());
        return listRecords(songKey()).filter((r) => mediaKey(r.media) !== mine && r.points.some((p) => Number.isInteger(p.barIndex)));
    };
    function refreshFromRow() {
        const others = fromRecords();
        const select = $('syncFromSelect');
        $('syncFromRow').hidden = !others.length;
        if (!others.length) return;
        const keep = select.value;
        select.replaceChildren(...others.map((r) => {
            const o = document.createElement('option');
            o.value = mediaKey(r.media);
            o.textContent = recordingName(r.media);
            return o;
        }));
        if (others.some((r) => mediaKey(r.media) === keep)) select.value = keep;
        fillFromOffset();
    }
    /** Puts the measured offset in the box when the audio of both recordings could be compared; otherwise leaves what was typed. */
    function fillFromOffset() {
        const key = `${mediaKey(media())}>${$('syncFromSelect').value}`;
        const ms = suggested.get(key);
        if (ms === undefined || filledFor === key) return;
        filledFor = key;
        $('syncFromMs').value = String(ms);
        $('syncFromMs').title = 'Measured from the two audio files, to about 20 ms';
    }
    $('syncFromSelect').addEventListener('change', () => {
        filledFor = '';
        $('syncFromMs').title = '';
        $('syncFromMs').value = '0';
        fillFromOffset();
    });
    $('syncFromBtn').addEventListener('click', () => {
        const other = fromRecords().find((r) => mediaKey(r.media) === $('syncFromSelect').value);
        const ms = Math.round(Number($('syncFromMs').value));
        if (other && Number.isFinite(ms)) takeSyncFrom(other, ms);
    });

    // Use the other recording's sync for this one, moved by the exact offset between the two audio files
    $('syncRederiveBtn').addEventListener('click', async () => {
        const found = conflict;
        const btn = $('syncRederiveBtn');
        if (!found || btn.disabled) return;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Measuring…';
        try {
            let offsetMs = found.alignment.offsetMs;
            let exact = false;
            // One at a time: each decode holds the whole recording in memory
            const fluxA = await loadRecordingFlux(songKey(), current.media);
            const fluxB = fluxA && await loadRecordingFlux(songKey(), found.other.media);
            const r = fluxB && refineOffset(fluxA, fluxB, offsetMs);
            if (r && r.confidence >= 0.5) { offsetMs = r.offsetMs; exact = true; }
            // offsetMs maps a time here to the other recording's time, so this recording is `-offsetMs` later than the other
            takeSyncFrom(found.other, -offsetMs, exact ? '' : ' (roughly: the audio could not be compared more closely)');
        } finally {
            btn.textContent = label;
            btn.disabled = false;
        }
    });
    $('syncUndoBtn').addEventListener('click', undo);
    $('syncRedoBtn').addEventListener('click', redo);
    $('syncTapAgainBtn').addEventListener('click', () => {
        // Hand over to tap mode of the same recording (the panel's tap control checks TV and Jam guest rules itself)
        const tapBtn = document.getElementById(`${current?.media?.kind === 'youtube' ? 'yt' : 'af'}SyncTapBtn`);
        closeModal('syncEditorModal');
        tapBtn?.click();
    });
    $('syncImportToggleBtn').addEventListener('click', () => {
        const panel = $('syncImportPanel');
        panel.hidden = !panel.hidden;
        $('syncImportStatus').textContent = '';
    });
    $('syncImportReplaceBtn').addEventListener('click', () => importFrom($('syncImportText').value, false));
    $('syncImportMergeBtn').addEventListener('click', () => importFrom($('syncImportText').value, true));
    // A web address pasted or typed into the box is fetched and converted in place
    $('syncImportText').addEventListener('input', (e) => {
        const text = e.target.value;
        $('syncImportSet').hidden = true;
        if (isUrl(text)) importFromUrl(text.trim());
    });
    $('syncImportSet').addEventListener('change', (e) => showUrlSet(Number(e.target.value)));
    async function handleImportFileText(text) {
        $('syncImportText').value = text;
        const status = $('syncImportStatus');
        const incoming = importPoints(text);
        if (incoming && incoming.length) {
            $('syncImportSet').hidden = true;
            status.textContent = `${incoming.length} point${incoming.length === 1 ? '' : 's'} ready. Choose Replace points or Add to points.`;
            return;
        }
        try {
            const found = detectSets(text);
            urlSets = setsFittingScore(found, playedBars());
            const select = $('syncImportSet');
            select.replaceChildren(...urlSets.map((s, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: s.label })));
            select.hidden = urlSets.length < 2;
            if (urlSets.length) {
                showUrlSet(0);
                return;
            }
        } catch (_) {}
        status.textContent = 'No sync points found in that file';
    }

    $('syncImportChooseBtn')?.addEventListener('click', async () => {
        if (window.__TAURI__?.dialog?.open && window.__TAURI__?.fs?.readTextFile) {
            try {
                const picked = await window.__TAURI__.dialog.open({
                    multiple: false,
                    title: 'Choose a sync points file',
                    filters: [{ name: 'Sync points', extensions: ['json', 'txt', 'atex', 'tex'] }]
                });
                if (!picked) return;
                const path = Array.isArray(picked) ? picked[0] : picked;
                const text = await window.__TAURI__.fs.readTextFile(path);
                await handleImportFileText(text);
                return;
            } catch (err) {
                console.warn('[Audio Sync] Native file open failed, falling back to input:', err);
            }
        }
        $('syncImportFile')?.click();
    });
    $('syncImportFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) {
            const text = await file.text();
            await handleImportFileText(text);
        }
    });
    $('syncCopyBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(toAlphaTexSync(points)); $('syncEditorInfo').textContent = 'Copied the points as text'; } catch { /* clipboard unavailable */ }
    });
    $('syncClearBtn').addEventListener('click', () => {
        if (points.length && confirm('Remove all sync points for this recording?')) persist([]);
    });
    $('syncShiftBtn').addEventListener('click', () => {
        const from = parseTime($('syncShiftFrom').value);
        const delta = Number($('syncShiftMs').value);
        if (from === null || !Number.isFinite(delta) || !delta) return;
        persist(shiftAfter(points, from, Math.round(delta)));
    });

    // Shifts every point of the recording at once, for a copy that is a little early or late. The quick buttons apply at once;
    // a typed amount applies with Apply. Each is one undo step.
    const shiftAll = (delta) => {
        if (!Number.isFinite(delta) || !delta || !points.length) return;
        persist(shiftAfter(points, 0, Math.round(delta)));
    };
    document.querySelectorAll('#syncShiftAllRow [data-shift-all]').forEach((btn) => {
        btn.addEventListener('click', () => shiftAll(Number(btn.dataset.shiftAll)));
    });
    $('syncShiftAllBtn').addEventListener('click', () => {
        shiftAll(Number($('syncShiftAllMs').value));
        $('syncShiftAllMs').value = '0';
    });

    document.querySelectorAll('#syncSelectedPointPanel [data-nudge]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!selectedId) return;
            const delta = parseInt(btn.dataset.nudge, 10);
            const p = points.find(pt => pt.id === selectedId);
            if (p) {
                persist(updatePoint(points, p.id, { timeMs: Math.max(0, p.timeMs + delta) }));
            }
        });
    });

    $('syncSelectedAuditionBtn')?.addEventListener('click', () => {
        if (!selectedId || !current) return;
        const p = points.find(pt => pt.id === selectedId);
        if (!p) return;
        const startMs = Math.max(0, p.timeMs - 1000);
        seekTo(startMs, null);
        current.source.play?.();
        setTimeout(() => {
            current.source.pause?.();
            seekTo(p.timeMs, null);
        }, 2000);
    });

    $('syncSelectedDeleteBtn')?.addEventListener('click', () => {
        if (!selectedId) return;
        persist(removePoints(points, [selectedId]));
        selectRow(null);
    });

    $('syncEditorModalCloseBtn')?.addEventListener('click', () => closeModal('syncEditorModal'));
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal('syncEditorModal'); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('show')) closeModal('syncEditorModal');
    });

    return {
        open(ctx) {
            if (isTvMode()) return;
            current = ctx;
            selectedId = null;
            filledFor = '';
            $('syncFromMs').value = '0';
            $('syncFromMs').title = '';
            undoStack = [];
            redoStack = [];
            currentRecord = loadRecord(songKey(), media());
            points = currentRecord?.points || [];
            offSource?.();
            offSource = ctx.source.on(() => timeline.wake());
            $('syncImportPanel').hidden = true;
            openModal('syncEditorModal');
            render();
        }
    };
}
