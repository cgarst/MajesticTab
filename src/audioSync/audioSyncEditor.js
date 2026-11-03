// audioSyncEditor.js
// The "Sync points" dialog: a table of the points for the loaded song and recording, with in-place edits, add,
// delete, shift, jump, and import and export (AlphaTab sync points text and JSON). Every edit is saved at once
// (syncStore) and announced with an `audiosync:changed` window event, so the follower picks it up.

import { getSongKey } from '../youtubePlayer.js';
import { openModal, closeModal } from '../gpProcessor/mixerPanel.js';
import { loadRecord, saveRecord, SYNC_CHANGED_EVENT } from './syncStore.js';
import { getScoreContext } from './audioSyncController.js';
import { pointProblems } from './pointCheck.js';
import { buildBeatMap } from './beatMap.js';
import { loadFromUrl, setToPoints, setsFittingScore } from './importers/index.js';
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

const PROBLEM_TEXT = {
    missing: 'This bar pass is not played in the score',
    order: 'Out of order: must come after the previous point in both the recording and the score',
    tempo: 'Implies a tempo far from the written one'
};

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
        saveRecord(songKey(), media(), points);
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        render();
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
        const totalBars = ctx?.timeline?.bars?.length || 0;
        const syncedBars = new Set(points.map(p => p.barIndex)).size;
        const flagged = Object.keys(info.flags).length;
        let infoHtml = `<span class="tnum">${points.length} point${points.length === 1 ? '' : 's'}, ${syncedBars} of ${totalBars} bars synced.</span>`;
        if (flagged > 0) {
            infoHtml += ` <span class="chip warn">${flagged} to check</span>`;
        }
        if (totalBars > syncedBars && points.length > 0) {
            infoHtml += ` <span class="chip">${totalBars - syncedBars} bars not synced</span>`;
        }
        $('syncEditorInfo').innerHTML = infoHtml;
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
            const incoming = setToPoints(urlSets[index], playedBars());
            $('syncImportText').value = toAlphaTexSync(incoming);
            status.textContent = `${incoming.length} points ready. Choose Replace Points or Add to Points.`;
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

    $('syncUndoBtn').addEventListener('click', undo);
    $('syncRedoBtn').addEventListener('click', redo);
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
    $('syncImportFile').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) $('syncImportText').value = await file.text();
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
            undoStack = [];
            redoStack = [];
            points = loadRecord(songKey(), media())?.points || [];
            offSource?.();
            offSource = ctx.source.on(() => timeline.wake());
            $('syncImportPanel').hidden = true;
            openModal('syncEditorModal');
            render();
        }
    };
}
