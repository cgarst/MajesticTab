// audioSyncEditor.js
// The "Sync points" dialog: a table of the points for the loaded song and recording, with in-place edits, add,
// delete, shift, jump, and import and export (AlphaTab sync points text and JSON). Every edit is saved at once
// (syncStore) and announced with an `audiosync:changed` window event, so the follower picks it up.

import { getSongKey } from '../youtubePlayer.js';
import { openModal, closeModal } from '../gpProcessor/mixerPanel.js';
import { loadRecord, saveRecord } from './syncStore.js';
import { getScoreContext } from './audioSyncController.js';
import { pointProblems } from './pointCheck.js';
import { tickToPosition, scoreMsToTick, positionToScoreMs } from './scorePositions.js';
import {
    addPoint, updatePoint, removePoints, shiftAfter, formatTime, parseTime,
    toAlphaTexSync, toJson, importPoints
} from './syncEdit.js';

export const SYNC_CHANGED_EVENT = 'audiosync:changed';

const PROBLEM_TEXT = {
    missing: 'This bar pass is not played in the score',
    order: 'Out of order: must come after the previous point in both the recording and the score',
    tempo: 'Implies a tempo far from the written one'
};

/**
 * One editor serves every recording: `open({ source, media })` edits the points of that MediaSource and its media
 * descriptor (`{ kind: 'youtube', videoId }` or a local file's).
 */
export function initAudioSyncEditor() {
    const $ = (id) => document.getElementById(id);
    const modal = $('syncEditorModal');
    if (!modal) return { open() {} };

    const rowsEl = $('syncRows');
    let points = [];
    let current = null; // { source, media } of the open editor

    const media = () => current.media;
    const source = { getTimeMs: () => current.source.getTimeMs(), seek: (ms) => current.source.seek(ms) };
    const songKey = () => getSongKey();

    function persist(next) {
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

    function render() {
        const ctx = getScoreContext();
        const info = ctx ? pointProblems(ctx.timeline, points) : { flags: {}, tempos: {} };
        rowsEl.replaceChildren(...points.map(p => buildRow(p, info)));
        $('syncEmpty').hidden = points.length > 0;
        const issues = Object.values(info.flags).filter(f => f !== 'tempo').length;
        const warnings = Object.values(info.flags).filter(f => f === 'tempo').length;
        const parts = [`${points.length} point${points.length === 1 ? '' : 's'}`];
        if (issues) parts.push(`${issues} to fix`);
        if (warnings) parts.push(`${warnings} with an unusual tempo`);
        $('syncEditorInfo').textContent = parts.join(' · ');
    }

    function jumpTo(p) {
        source.seek(p.timeMs);
        const ctx = getScoreContext();
        const scoreMs = ctx && positionToScoreMs(ctx.timeline, p);
        if (ctx && scoreMs !== null) ctx.api.tickPosition = scoreMsToTick(ctx.timeline, scoreMs);
    }

    function addAtCursor() {
        const ctx = getScoreContext();
        if (!ctx) return;
        const pos = tickToPosition(ctx.timeline, ctx.api.tickPosition);
        if (!pos) return;
        persist(addPoint(points, { ...pos, timeMs: Math.round(source.getTimeMs()), source: 'manual' }));
    }

    function importFrom(text, merge) {
        const status = $('syncImportStatus');
        const incoming = importPoints(text);
        if (!incoming || !incoming.length) {
            status.textContent = 'No sync points found';
            return;
        }
        persist(merge ? [...points, ...incoming].sort((a, b) => a.timeMs - b.timeMs) : incoming);
        status.textContent = `Imported ${incoming.length} point${incoming.length === 1 ? '' : 's'}`;
        $('syncImportText').value = '';
    }

    function download(name, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    $('syncAddBtn').addEventListener('click', addAtCursor);
    $('syncImportToggleBtn').addEventListener('click', () => {
        const panel = $('syncImportPanel');
        panel.hidden = !panel.hidden;
        $('syncImportStatus').textContent = '';
    });
    $('syncImportReplaceBtn').addEventListener('click', () => importFrom($('syncImportText').value, false));
    $('syncImportMergeBtn').addEventListener('click', () => importFrom($('syncImportText').value, true));
    $('syncImportFile').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) $('syncImportText').value = await file.text();
    });
    $('syncCopyBtn').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(toAlphaTexSync(points)); $('syncEditorInfo').textContent = 'Copied the points as text'; } catch { /* clipboard unavailable */ }
    });
    $('syncDownloadBtn').addEventListener('click', () => download('sync-points.json', toJson(points), 'application/json'));
    $('syncClearBtn').addEventListener('click', () => {
        if (points.length && confirm('Remove all sync points for this recording?')) persist([]);
    });
    $('syncShiftBtn').addEventListener('click', () => {
        const from = parseTime($('syncShiftFrom').value);
        const delta = Number($('syncShiftMs').value);
        if (from === null || !Number.isFinite(delta) || !delta) return;
        persist(shiftAfter(points, from, Math.round(delta)));
    });

    $('syncEditorModalCloseBtn')?.addEventListener('click', () => closeModal('syncEditorModal'));
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal('syncEditorModal'); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('show')) closeModal('syncEditorModal');
    });

    return {
        open(ctx) {
            current = ctx;
            points = loadRecord(songKey(), media())?.points || [];
            $('syncImportPanel').hidden = true;
            openModal('syncEditorModal');
            render();
        }
    };
}
