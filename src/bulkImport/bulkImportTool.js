// bulkImportTool.js
// Bulk import page in Tools: choose a folder, and every tab file in it (subfolders included) is paired with a song.
//   1. Pairing: "Artist - Song.ext", Artist/Album/Song.ext (a track number before the song is ignored), or the metadata
//      inside a Guitar Pro file; Auto tries them in that order of how much each file gives (see pairing.js).
//   2. Suggestions: each pairing is looked up in the library, then on MusicBrainz (one request at a time, as MusicBrainz asks;
//      the rows fill in while it runs).
//   3. Fixing: any row can be changed by searching MusicBrainz, or left out.
//   4. Import: each paired file is stored and attached to its song (an existing library song, or a new one from the match).
// The page's state lives in this module, so leaving Tools while the lookups run does not lose them.

import { getAllSongs, saveSongToLibrary, getSongById, mapOpenFileToSong, DEFAULT_COLLECTION_ID } from '../libraryStore.js';
import { detectFileMetadata } from '../utils/tuningUtils.js';
import { showToast } from '../utils/toast.js';
import { STRATEGIES, pairFile, baseNameOf, sameArtist, sameTitle, VIA_LABEL } from './pairing.js';
import { lookup, searchSongs } from './matcher.js';
import { canPickFolder, pickAndScanFolder } from './scanFolder.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const STRATEGY_LABEL = {
    auto: 'Automatic',
    'artist-song': 'Artist - Song',
    folders: 'Artist/Album/Song',
    metadata: 'Guitar Pro file data'
};
const STRATEGY_HELP = {
    auto: 'Each file is paired by the best thing it gives: the data inside a Guitar Pro file, then two folders (Artist/Album), then “Artist - Song” in the name.',
    'artist-song': 'Files are named like “Artist - Song.gp5”. A track number or “(tab)” in front or behind is ignored.',
    folders: 'Files sit in an artist folder and an album folder, like Artist/Album/03 Song.gp5. The two folders above each file are used, and a track number in front of the song is ignored.',
    metadata: 'The title, artist and album written inside each Guitar Pro file. PDF and text files carry none.'
};

const state = {
    phase: 'setup', // 'setup' | 'scanning' | 'review' | 'importing'
    strategy: 'auto',
    rootName: '',
    foundCount: 0,
    rows: [],
    filter: 'all', // 'all' | 'attention'
    openId: null, // the row whose search panel is open
    lookingUp: false,
    summary: '',
    importDone: 0,
    importTotal: 0,
    songs: [], // library songs, for matching and for finding a song again
    controller: null,
    scanController: null
};
const listeners = new Set();
const notify = (id) => listeners.forEach((cb) => { try { cb(id); } catch (e) { console.error('[Bulk import]', e); } });

/** Readout for the Tools row. */
export function bulkImportReadout() {
    if (state.phase === 'importing') return `${Math.min(state.importDone + 1, state.importTotal)} of ${state.importTotal}`;
    if (state.phase === 'review' && state.lookingUp) {
        const done = state.rows.filter((r) => r.stage === 'done').length;
        return `${done} of ${state.rows.length}`;
    }
    return '';
}
listeners.add(() => {
    const el = document.querySelector('[data-read="bulkimport"]');
    if (el && el.textContent !== bulkImportReadout()) el.textContent = bulkImportReadout();
});

// --- Rows ------------------------------------------------------------------------------------------------------------

/** What a row is, for the page: ready (will be imported), attention (needs a look), or left out. */
function verdict(row) {
    if (row.imported) return 'done';
    if (row.stage !== 'done' && !row.manual) return 'wait';
    if (!row.pick) return 'attention';
    if (row.excluded) return 'out';
    // A guess is not imported until the person has looked at it (checked it, or chosen a song)
    return row.status === 'maybe' && !row.manual && !row.confirmed ? 'attention' : 'ready';
}
const statusText = (row) => {
    if (row.imported === 'done') return 'Imported';
    if (row.imported === 'skipped') return row.note || 'Already added';
    if (row.imported === 'error') return row.note || 'Could not import';
    if (row.stage === 'queued') return 'Waiting';
    if (row.stage === 'working') return 'Looking up…';
    if (row.stage === 'error') return 'Lookup failed';
    if (row.manual && row.pick) return 'Chosen by you';
    if (!row.pick) return row.parsed ? 'No match' : 'No pairing';
    return { library: 'In your library', match: 'Matched', maybe: 'Check this' }[row.status] || '';
};

function makeRow(entry, i) {
    return { id: `r${i}`, entry, parsed: null, stage: 'queued', status: 'none', pick: null, candidates: [], excluded: false, confirmed: false, manual: false, imported: '', note: '', error: '' };
}

async function embeddedMeta(entry) {
    if (!/^gp[345x]?$/.test(entry.ext)) return null;
    try { return await detectFileMetadata(await entry.getFile(), entry.name); } catch { return null; }
}

/** Pair one file by the chosen strategy, then look the pairing up. A row the person set by hand is left alone. */
async function resolveRow(row, signal) {
    row.stage = 'working';
    notify(row.id);
    try {
        const meta = state.strategy === 'artist-song' || state.strategy === 'folders' ? null : await embeddedMeta(row.entry);
        row.parsed = pairFile(row.entry, state.strategy, meta);
        if (!row.parsed) { row.stage = 'done'; row.status = 'none'; row.pick = null; row.candidates = []; return; }
        const found = await lookup(row.parsed, { songs: state.songs, signal });
        if (row.manual) return;
        row.status = found.status;
        row.pick = found.pick;
        row.candidates = found.candidates;
        row.stage = 'done';
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') { row.stage = 'queued'; return; }
        console.warn('[Bulk import] Lookup failed for', row.entry.path, err);
        row.stage = 'error';
        row.error = err?.message || 'Lookup failed';
    } finally {
        notify(row.id);
    }
}

async function runLookups() {
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.lookingUp = true;
    state.songs = await getAllSongs().catch(() => []);
    notify();
    for (const row of state.rows) {
        if (controller.signal.aborted) break;
        if (row.manual || row.stage === 'done' || row.imported) continue;
        await resolveRow(row, controller.signal);
    }
    if (state.controller === controller) { state.lookingUp = false; state.controller = null; }
    notify();
}

function restartLookups() {
    state.controller?.abort();
    for (const row of state.rows) {
        if (row.manual || row.imported) continue;
        Object.assign(row, { stage: 'queued', status: 'none', pick: null, candidates: [], parsed: null, error: '', excluded: false, confirmed: false });
    }
    runLookups();
}

/** Start from a scan result (the folder picker, and the tests that hand one in). */
export function loadScanResult(result) {
    state.controller?.abort();
    state.rootName = result.rootName;
    state.rows = result.entries.map(makeRow);
    state.phase = 'review';
    state.summary = '';
    state.openId = null;
    state.filter = 'all';
    notify();
    if (state.rows.length) runLookups();
}

// --- Import ----------------------------------------------------------------------------------------------------------

async function songFor(pick) {
    if (pick.songId) {
        const s = await getSongById(pick.songId);
        if (s) return s;
    }
    const known = state.songs.find((s) => (pick.recordingMbid && s.recordingMbid === pick.recordingMbid)
        || (sameTitle(s.title, pick.title) && sameArtist(s.artist, pick.artist) && (!pick.album || sameTitle(s.album, pick.album))));
    if (known) return known;
    const song = await saveSongToLibrary({
        title: pick.title, artist: pick.artist, artistMbid: pick.artistMbid, album: pick.album, albumMbid: pick.albumMbid,
        recordingMbid: pick.recordingMbid, year: pick.year, length: pick.length, coverUrl: pick.coverUrl
    }, DEFAULT_COLLECTION_ID);
    state.songs.push(song);
    return song;
}

async function runImport() {
    const todo = state.rows.filter((r) => verdict(r) === 'ready' && !r.imported);
    if (!todo.length) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.lookingUp = false;
    state.phase = 'importing';
    state.importDone = 0;
    state.importTotal = todo.length;
    state.songs = await getAllSongs().catch(() => state.songs);
    notify();
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of todo) {
        if (controller.signal.aborted) break;
        try {
            const file = await row.entry.getFile();
            const song = await songFor(row.pick);
            // The same file name on the same song is the same tab
            if ((song.tabOptions || []).some((t) => t.name === file.name)) {
                row.imported = 'skipped';
                row.note = 'Already added';
                skipped++;
            } else {
                const { song: updated } = await mapOpenFileToSong(file, song.id, file.name, 'local', row.entry.path);
                const i = state.songs.findIndex((s) => s.id === song.id);
                if (i >= 0) state.songs[i] = (await getSongById(song.id)) || updated; else state.songs.push(updated);
                row.imported = 'done';
                added++;
            }
        } catch (err) {
            console.error('[Bulk import] Could not import', row.entry.path, err);
            row.imported = 'error';
            row.note = 'Could not import';
            failed++;
        }
        state.importDone++;
        notify(row.id);
    }
    state.phase = 'review';
    state.controller = null;
    const parts = [plural(added, 'tab', 'tabs') + ' imported'];
    if (skipped) parts.push(`${skipped} already in the library`);
    if (failed) parts.push(`${failed} failed`);
    if (controller.signal.aborted) parts.unshift('Cancelled');
    state.summary = parts.join(' · ');
    if (added) {
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        showToast(`Imported ${plural(added, 'tab', 'tabs')}`, 'success');
    }
    notify();
}

// --- The page --------------------------------------------------------------------------------------------------------

export function renderBulkImportTool(container) {
    let alive = true;
    const root = document.createElement('div');
    root.className = 'be-root imp-root';
    container.appendChild(root);
    const searches = new Map(); // row id -> { text, results, busy, error }
    let searchSeq = 0;

    const counts = () => {
        const c = { ready: 0, attention: 0, out: 0, wait: 0, done: 0 };
        for (const r of state.rows) c[verdict(r)]++;
        return c;
    };

    function suggestionHtml(row) {
        const p = row.pick;
        if (!p) return `<span class="imp-sugg is-none">${esc(row.parsed ? [row.parsed.artist, row.parsed.title].filter(Boolean).join(' – ') : 'Nothing found in the name or the file')}</span>`;
        const sub = [p.album, p.year].filter(Boolean).join(' · ');
        return `<span class="imp-sugg">${esc(p.artist)} – ${esc(p.title)}${sub ? `<span class="imp-sub"> · ${esc(sub)}</span>` : ''}</span>`;
    }

    function searchHtml(row) {
        const s = searches.get(row.id) || {};
        const list = s.results || row.candidates || [];
        const text = s.text ?? [row.parsed?.artist, row.parsed?.title || baseNameOf(row.entry.name)].filter(Boolean).join(' ');
        return `
        <div class="imp-search" data-for="${row.id}">
          <div class="imp-search-bar">
            <input type="search" class="form-control form-control-sm" data-act="search-text" value="${esc(text)}" aria-label="Search MusicBrainz for this song" placeholder="Artist and song">
            <button type="button" class="ct-text" data-act="search-go">Search</button>
          </div>
          <div class="imp-results" role="listbox" aria-label="Songs found">
            ${s.busy ? '<p class="ct-sub" role="status">Searching…</p>' : ''}
            ${s.error ? `<p class="ct-error">${esc(s.error)}</p>` : ''}
            ${!s.busy && !s.error && !list.length ? '<p class="ct-sub">Nothing found. Try the song name alone, or fewer words.</p>' : ''}
            ${list.map((c, i) => `
              <button type="button" class="imp-result${row.pick && row.pick.recordingMbid === c.recordingMbid && row.pick.songId === c.songId && sameTitle(row.pick.title, c.title) ? ' is-picked' : ''}" role="option" data-act="pick" data-i="${i}">
                <span class="imp-result-main">${esc(c.artist)} – ${esc(c.title)}</span>
                <span class="imp-sub">${esc([c.album, c.year, c.source === 'library' ? 'In your library' : ''].filter(Boolean).join(' · '))}</span>
              </button>`).join('')}
          </div>
          <div class="imp-search-foot"><button type="button" class="ct-text" data-act="close-search">Done</button></div>
        </div>`;
    }

    function rowHtml(row) {
        const v = verdict(row);
        const open = state.openId === row.id;
        const via = row.parsed?.via ? VIA_LABEL[row.parsed.via] : '';
        const busy = state.phase === 'importing';
        return `
        <div class="imp-row is-${v}${open ? ' is-open' : ''}" data-row="${row.id}">
          <div class="imp-line">
            <input type="checkbox" class="form-check-input imp-check" data-act="include" aria-label="Import ${esc(row.entry.name)}" ${v === 'ready' ? 'checked' : ''} ${!row.pick || row.imported || busy ? 'disabled' : ''}>
            <div class="imp-text">
              <span class="imp-file" title="${esc(row.entry.path)}">${esc(row.entry.path)}</span>
              ${suggestionHtml(row)}
            </div>
            <span class="imp-state">${esc(statusText(row))}${via && row.pick && !row.manual && row.status !== 'library' ? ` · from ${esc(via)}` : ''}</span>
            ${row.imported || busy ? '' : `<button type="button" class="ct-text imp-change" data-act="change" aria-expanded="${open}">${row.pick ? 'Change' : 'Find song'}</button>`}
          </div>
          ${open ? searchHtml(row) : ''}
        </div>`;
    }

    function headHtml() {
        const c = counts();
        const total = state.rows.length;
        const parts = [`${plural(total, 'file', 'files')} in ${esc(state.rootName)}`];
        if (c.ready) parts.push(`${c.ready} ready`);
        if (c.attention) parts.push(`${c.attention} need a look`);
        if (state.lookingUp) parts.push(`Looking up ${state.rows.filter((r) => r.stage === 'done').length} of ${total}`);
        return parts.join(' · ');
    }

    function setupHtml() {
        const can = canPickFolder();
        return `
        <p class="ct-sub">Choose a folder of tabs (Guitar Pro, PDF and text files, subfolders included). Each file is paired with a song, checked against your library and MusicBrainz, and shown here for you to look over before anything is imported.</p>
        <fieldset class="imp-strategies">
          <legend class="be-option-title">How the files are named</legend>
          ${STRATEGIES.map((s) => `
            <label class="be-option imp-strategy">
              <input type="radio" class="form-check-input" name="impStrategy" value="${s}" ${state.strategy === s ? 'checked' : ''}>
              <span class="be-option-text"><span class="be-option-title">${esc(STRATEGY_LABEL[s])}${s === 'auto' ? ' (recommended)' : ''}</span></span>
            </label>`).join('')}
          <p class="ct-sub imp-help">${esc(STRATEGY_HELP[state.strategy])}</p>
        </fieldset>
        ${can ? '' : '<p class="ct-note">Importing a folder needs the MajesticTab app on a computer, or Chrome or Edge. Phones can add tabs to a song one at a time.</p>'}
        <div class="be-actions">
          <button type="button" class="btn btn-sm btn-theme-primary" data-act="choose" ${can ? '' : 'disabled'}>Choose folder</button>
          <span class="be-status" role="status">${esc(state.summary)}</span>
        </div>`;
    }

    function reviewHtml() {
        const c = counts();
        const importing = state.phase === 'importing';
        const shown = state.filter === 'attention' ? state.rows.filter((r) => ['attention', 'wait'].includes(verdict(r)) && !r.imported) : state.rows;
        return `
        <div class="imp-top">
          <div class="be-stats-row" role="status" data-part="head">${headHtml()}</div>
          ${importing ? `<div class="be-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}"><div class="be-progress-fill" style="width:${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}%"></div></div>` : ''}
          <div class="be-actions imp-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="import" ${importing || !c.ready ? 'disabled' : ''}>${importing ? `Importing ${state.importDone} of ${state.importTotal}…` : (c.ready ? `Import ${plural(c.ready, 'tab', 'tabs')}` : 'Import')}</button>
            ${importing ? '<button type="button" class="ct-text" data-act="cancel-import">Cancel</button>' : ''}
            ${importing ? '' : `
            <label class="imp-strategy-pick">
              <span class="imp-sub">Pair by</span>
              <select class="form-select form-select-sm" data-act="strategy" aria-label="How the files are named">
                ${STRATEGIES.map((s) => `<option value="${s}" ${state.strategy === s ? 'selected' : ''}>${esc(STRATEGY_LABEL[s])}</option>`).join('')}
              </select>
            </label>
            <button type="button" class="ct-text" data-act="${state.filter === 'all' ? 'only-attention' : 'show-all'}" ${c.attention || state.filter !== 'all' ? '' : 'disabled'}>${state.filter === 'all' ? (c.attention === 1 ? 'Show the one that needs a look' : `Show the ${c.attention} that need a look`) : 'Show all'}</button>
            <button type="button" class="ct-text" data-act="choose">Choose another folder</button>`}
          </div>
          ${state.summary ? `<div class="be-status" role="status">${esc(state.summary)}</div>` : ''}
        </div>
        ${state.rows.length === 0 ? '<p class="ct-empty">No Guitar Pro, PDF or text files were found in that folder.</p>' : ''}
        <div class="imp-list">${shown.map(rowHtml).join('')}</div>`;
    }

    function render() {
        if (!alive || !root.isConnected) return;
        if (state.phase === 'scanning') {
            root.innerHTML = `<div class="be-stats-row" role="status">Looking through the folder… ${plural(state.foundCount, 'file', 'files')} so far</div>
              <div class="be-actions"><button type="button" class="ct-text" data-act="cancel-scan">Cancel</button></div>`;
        } else if (state.phase === 'setup') root.innerHTML = setupHtml();
        else root.innerHTML = reviewHtml();
    }

    /** One row (and the header counts) changed: redraw only those, so a long list stays steady while lookups arrive. */
    function patch(id) {
        if (!alive || !root.isConnected) return;
        if (!id || state.phase === 'setup' || state.phase === 'scanning') { render(); return; }
        const el = root.querySelector(`[data-row="${id}"]`);
        const row = state.rows.find((r) => r.id === id);
        if (el && row) {
            const hadFocus = el.contains(document.activeElement);
            el.outerHTML = rowHtml(row);
            if (hadFocus && state.openId === id) root.querySelector(`[data-row="${id}"] [data-act="search-text"]`)?.focus();
        }
        const head = root.querySelector('[data-part="head"]');
        if (head) head.innerHTML = headHtml();
        const importBtn = root.querySelector('[data-act="import"]');
        if (importBtn && state.phase === 'review') {
            const n = counts().ready;
            importBtn.textContent = n ? `Import ${plural(n, 'tab', 'tabs')}` : 'Import';
            importBtn.disabled = !n;
        } else if (state.phase === 'importing') {
            const bar = root.querySelector('.be-progress-fill');
            if (bar) bar.style.width = `${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}%`;
            const btn = root.querySelector('[data-act="import"]');
            if (btn) btn.textContent = `Importing ${state.importDone} of ${state.importTotal}…`;
        }
    }

    const onChange = (id) => patch(id);
    listeners.add(onChange);

    async function choose() {
        const controller = new AbortController();
        state.scanController = controller;
        state.foundCount = 0;
        const previous = state.phase;
        try {
            state.phase = 'scanning';
            render();
            const result = await pickAndScanFolder((n) => {
                state.foundCount = n;
                if (n % 25 === 0) render();
            }, controller.signal);
            if (!alive && !result) return;
            if (!result || controller.signal.aborted) { state.phase = previous === 'scanning' ? 'setup' : previous; state.scanController = null; notify(); return; }
            state.scanController = null;
            loadScanResult(result);
        } catch (err) {
            console.error('[Bulk import] Could not read the folder:', err);
            state.phase = previous === 'scanning' ? 'setup' : previous;
            state.scanController = null;
            showToast('Could not read that folder', 'error');
            notify();
        }
    }

    async function runSearch(rowId) {
        const row = state.rows.find((r) => r.id === rowId);
        const input = root.querySelector(`[data-for="${rowId}"] [data-act="search-text"]`);
        if (!row || !input) return;
        const text = input.value.trim();
        const seq = ++searchSeq;
        searches.set(rowId, { text, results: null, busy: Boolean(text), error: '' });
        patch(rowId);
        if (!text) return;
        try {
            const results = await searchSongs(text);
            if (seq !== searchSeq) return;
            searches.set(rowId, { text, results, busy: false, error: '' });
        } catch (err) {
            if (seq !== searchSeq) return;
            searches.set(rowId, { text, results: [], busy: false, error: `Search failed: ${err?.message || 'no answer from MusicBrainz'}` });
        }
        patch(rowId);
    }

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        const rowEl = btn.closest('[data-row]');
        const searchEl = btn.closest('[data-for]');
        const rowId = rowEl?.dataset.row || searchEl?.dataset.for;
        const row = state.rows.find((r) => r.id === rowId);
        if (act === 'choose') choose();
        else if (act === 'cancel-scan') { state.scanController?.abort(); }
        else if (act === 'import') runImport();
        else if (act === 'cancel-import') state.controller?.abort();
        else if (act === 'only-attention') { state.filter = 'attention'; render(); }
        else if (act === 'show-all') { state.filter = 'all'; render(); }
        else if (act === 'change' && row) {
            const prev = state.openId;
            state.openId = state.openId === row.id ? null : row.id;
            if (prev && prev !== row.id) patch(prev);
            patch(row.id);
            root.querySelector(`[data-row="${row.id}"] [data-act="search-text"]`)?.focus();
        } else if (act === 'close-search' && row) { state.openId = null; patch(row.id); root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus(); }
        else if (act === 'search-go' && row) runSearch(row.id);
        else if (act === 'pick' && row) {
            const s = searches.get(row.id);
            const list = s?.results || row.candidates;
            const chosen = list?.[Number(btn.dataset.i)];
            if (!chosen) return;
            row.pick = chosen;
            row.manual = true;
            row.status = chosen.source === 'library' ? 'library' : 'match';
            row.excluded = false;
            row.stage = 'done';
            state.openId = null;
            patch(row.id);
            root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus();
        }
    });
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.name === 'impStrategy') { state.strategy = t.value; render(); return; }
        if (t.dataset.act === 'strategy') { state.strategy = t.value; if (state.rows.length) { restartLookups(); render(); } return; }
        if (t.dataset.act === 'include') {
            const row = state.rows.find((r) => r.id === t.closest('[data-row]')?.dataset.row);
            if (row) { row.excluded = !t.checked; if (t.checked) row.confirmed = true; patch(row.id); }
        }
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.dataset?.act === 'search-text') {
            e.preventDefault();
            runSearch(e.target.closest('[data-for]')?.dataset.for);
        } else if (e.key === 'Escape' && state.openId && e.target.closest?.('[data-for]')) {
            e.stopPropagation();
            const id = state.openId;
            state.openId = null;
            patch(id);
            root.querySelector(`[data-row="${id}"] [data-act="change"]`)?.focus();
        }
    });

    render();
    // Lookups started before the page was left carry on; the page shows where they are
    return () => {
        alive = false;
        listeners.delete(onChange);
    };
}
