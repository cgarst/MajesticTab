// audioImport.js
// Bulk import, audio mode: choose a folder of audio files and each one is matched to a song that is already in the library and has a
// tab. Nothing is looked up on MusicBrainz and no song is created: a file with no song in the library is left out.
//   1. Pairing: the same three readings as tabs ("Artist - Song.ext", Artist/Album/Song.ext, Auto), see pairing.js.
//   2. Matching: the library's songs that have a tab (matcher.js, lookupLibraryAudio). A match by title alone is a guess the person
//      checks; any row can be changed by searching the library, or left out.
//   3. Import: each file is stored (audioFileStore.js) and becomes the song's Original recording or Backing track
//      (libraryAudio.js), whichever the person chose. Automatic (the default) takes a file as the recording unless its name says
//      "backing track" or "no guitar"; Recordings and Backing tracks send every file to that slot.
//      A switch leaves out songs that already have audio in that slot.
// The page's state lives in this module, so leaving Tools does not lose a review.

import { getAllSongs, getSongById } from '../libraryStore.js';
import { showToast } from '../utils/toast.js';
import { saveAudioFile, listAudioFiles, MAX_AUDIO_BYTES } from '../audioSync/audioFileStore.js';
import { AUDIO_FILES_CHANGED_EVENT } from '../audioSync/audioBackup.js';
import { SYNC_CHANGED_EVENT } from '../audioSync/syncStore.js';
import { decodePeaks } from '../audioSync/peaks.js';
import { libraryAudioKey, attachLibraryAudio, songHasAudioInSlot } from '../audioSync/libraryAudio.js';
import { pairFile, cleanAudioTitle, baseNameOf, sameTitle, VIA_LABEL } from './pairing.js';
import { lookupLibraryAudio, searchLibrarySongs } from './matcher.js';
import { canPickFolder, pickAndScanFolder } from './scanFolder.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const STRATEGIES = ['auto', 'artist-song', 'folders'];
const STRATEGY_LABEL = { auto: 'Automatic', 'artist-song': 'Artist - Song', folders: 'Artist/Album/Song' };
const STRATEGY_HELP = {
    auto: 'Each file is paired by the best thing it gives: two folders (Artist/Album), then “Artist - Song” in the name, then the song’s name alone.',
    'artist-song': 'Files are named like “Artist - Song.mp3”. A track number or “(Official Audio)” in front or behind is ignored.',
    folders: 'Files sit in an artist folder and an album folder, like Artist/Album/03 Song.flac. The two folders above each file are used, and a track number in front of the song is ignored.'
};
const SLOT_LABEL = { original: 'Original recording', backing: 'Backing track' };
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

const state = {
    phase: 'setup', // 'setup' | 'scanning' | 'review' | 'importing'
    strategy: 'auto',
    slot: 'auto', // where the files go: 'auto' (by file name), 'original' or 'backing'
    rootName: '',
    foundCount: 0,
    rows: [],
    filter: 'all', // 'all' | 'attention'
    skipExisting: true, // a song that already has audio in the slot is left out
    openId: null,
    working: false,
    summary: '',
    importDone: 0,
    importTotal: 0,
    songs: [],
    dupes: new Map(), // row id -> the row used in its place
    existingIds: new Set(),
    controller: null,
    scanController: null
};
const listeners = new Set();
const notify = (id) => { refreshDupes(); listeners.forEach((cb) => { try { cb(id); } catch (e) { console.error('[Bulk import audio]', e); } }); };

/** Readout for the Tools row. */
export function audioImportReadout() {
    return state.phase === 'importing' ? `${Math.min(state.importDone + 1, state.importTotal)} of ${state.importTotal}` : '';
}
export const onAudioImportChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

// --- Rows ------------------------------------------------------------------------------------------------------------

// Auto: a recording unless the file name says "backing track" or "no guitar". Recordings: always the recording.
const BACKING_NAME = /backing[\s_.-]*tracks?|no[\s_.-]*guitars?/i;
const slotOf = (row) => (state.slot === 'backing' || (state.slot === 'auto' && row.backing) ? 'backing' : 'original');
// Several files for one song and slot: one is used, the rest are left out until the person checks them. A lossless file beats a
// lossy one, then the larger file, then the one that comes first in the folder.
const QUALITY = { flac: 3, wav: 3, m4a: 2, ogg: 2, opus: 2, mp3: 1, aac: 1 };
const betterFile = (a, b) => (QUALITY[b.entry.ext] || 0) - (QUALITY[a.entry.ext] || 0) || (b.entry.size || 0) - (a.entry.size || 0);
/** rowId -> the row that is used instead, for every file that has a better file for the same song and slot. */
function refreshDupes() {
    const best = new Map();
    for (const row of state.rows) {
        if (!row.pick?.songId || row.imported) continue;
        const key = `${row.pick.songId}|${slotOf(row)}`;
        const cur = best.get(key);
        if (!cur || betterFile(row, cur) < 0) best.set(key, row);
    }
    state.dupes = new Map();
    for (const row of state.rows) {
        if (!row.pick?.songId || row.imported) continue;
        const winner = best.get(`${row.pick.songId}|${slotOf(row)}`);
        if (winner !== row) state.dupes.set(row.id, winner);
    }
}

const songOf = (row) => (row.pick ? state.songs.find((s) => s.id === row.pick.songId) : null);

function verdict(row) {
    if (row.imported) return 'done';
    if (row.stage !== 'done' && !row.manual) return 'wait';
    if (!row.pick) return 'attention';
    if (state.skipExisting && row.hadAudio && !row.forced) return 'have';
    if (row.excluded) return 'out';
    if (state.dupes.has(row.id) && !row.forced) return 'out';
    return row.status === 'maybe' && !row.manual && !row.confirmed ? 'attention' : 'ready';
}

function statusText(row) {
    if (row.imported === 'done') return 'Imported';
    if (row.imported === 'error') return row.note || 'Could not import';
    if (row.stage === 'working') return 'Matching…';
    if (state.dupes.has(row.id) && !row.forced && !row.excluded && verdict(row) === 'out') return `Not used: ${state.dupes.get(row.id).entry.name} is for this song`;
    if (verdict(row) === 'have') return `Already has a ${SLOT_LABEL[slotOf(row)].toLowerCase()}`;
    if (!row.pick) return row.parsed ? 'No song with a tab' : 'No pairing';
    if (row.manual) return 'Chosen by you';
    return row.status === 'maybe' ? 'Check this' : 'In your library';
}

function markHad(row) {
    const song = songOf(row);
    row.hadAudio = Boolean(song && songHasAudioInSlot(song, slotOf(row), state.existingIds));
}

function makeRow(entry, i) {
    return { id: `a${i}`, entry, parsed: null, backing: false, stage: 'queued', status: 'none', pick: null, candidates: [], excluded: false, confirmed: false, forced: false, manual: false, hadAudio: false, imported: '', note: '' };
}

function resolveRow(row) {
    const parsed = pairFile(row.entry, state.strategy, null);
    row.parsed = null;
    row.backing = BACKING_NAME.test(row.entry.path || row.entry.name || '');
    if (parsed) {
        const clean = (t) => (t ? cleanAudioTitle(t) : null);
        const main = clean(parsed.title);
        const raw = clean(parsed.rawTitle);
        const alt = clean(parsed.altTitle);
        row.backing = row.backing || Boolean(main?.backing || raw?.backing || alt?.backing);
        row.parsed = { ...parsed, title: main.title, ...(raw ? { rawTitle: raw.title } : {}), ...(alt ? { altTitle: alt.title } : {}) };
    }
    const found = row.parsed ? lookupLibraryAudio(row.parsed, state.songs) : { status: 'none', pick: null, candidates: [] };
    row.status = found.status;
    row.pick = found.pick;
    row.candidates = found.candidates;
    markHad(row);
    row.stage = 'done';
}

async function runMatching() {
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.working = true;
    state.songs = await getAllSongs().catch(() => []);
    state.existingIds = new Set((await listAudioFiles().catch(() => [])).map((f) => f.id));
    notify();
    let n = 0;
    for (const row of state.rows) {
        if (controller.signal.aborted) break;
        if (row.manual || row.imported) continue;
        resolveRow(row);
        // Let the page draw now and then on a big folder
        if (++n % 50 === 0) { notify(); await new Promise((r) => setTimeout(r, 0)); }
    }
    if (state.controller === controller) { state.working = false; state.controller = null; }
    notify();
}

function restartMatching() {
    state.controller?.abort();
    for (const row of state.rows) {
        if (row.manual || row.imported) continue;
        Object.assign(row, { stage: 'queued', status: 'none', pick: null, candidates: [], parsed: null, excluded: false, confirmed: false, forced: false, hadAudio: false });
    }
    runMatching();
}

/** The slot changed: which songs already have audio there changes with it. */
function refreshHad() {
    state.rows.forEach((r) => { if (!r.imported) markHad(r); });
}

export function loadAudioScan(result) {
    state.controller?.abort();
    state.rootName = result.rootName;
    state.rows = result.entries.map(makeRow);
    state.phase = 'review';
    state.summary = '';
    state.openId = null;
    state.filter = 'all';
    notify();
    if (state.rows.length) runMatching();
}

// --- Import ----------------------------------------------------------------------------------------------------------

async function runImport() {
    state.songs = await getAllSongs().catch(() => state.songs);
    state.existingIds = new Set((await listAudioFiles().catch(() => [])).map((f) => f.id));
    refreshHad();
    const todo = state.rows.filter((r) => verdict(r) === 'ready' && !r.imported);
    if (!todo.length) { notify(); return; }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.working = false;
    state.phase = 'importing';
    state.importDone = 0;
    state.importTotal = todo.length;
    notify();
    let added = 0;
    let failed = 0;
    const filled = new Set(); // song|slot already given a file in this run
    for (const row of todo) {
        if (controller.signal.aborted) break;
        const slotKey = `${row.pick.songId}|${slotOf(row)}`;
        // A file the person did not check does not replace one imported a moment ago for the same song and slot
        if (filled.has(slotKey) && !row.forced) {
            row.imported = 'error';
            row.note = 'Skipped: another file went to this song';
            state.importDone++;
            notify(row.id);
            continue;
        }
        try {
            const song = await getSongById(row.pick.songId);
            if (!song) throw new Error('The song is no longer in the library');
            const file = await row.entry.getFile();
            if (file.size > MAX_AUDIO_BYTES) { row.note = `Too large (limit ${Math.round(MAX_AUDIO_BYTES / 1048576)} MB)`; throw new Error(row.note); }
            const data = await file.arrayBuffer();
            const analysed = await decodePeaks(data);
            if (!analysed) { row.note = 'This device cannot play that format'; throw new Error(row.note); }
            const meta = await saveAudioFile({
                name: file.name, type: file.type || MIME[row.entry.ext] || 'audio/mpeg', data, songKey: libraryAudioKey(song),
                durationMs: analysed.durationMs ?? null, peaks: analysed.peaks ?? null
            });
            attachLibraryAudio(song, meta.id, slotOf(row));
            state.existingIds.add(meta.id);
            row.imported = 'done';
            filled.add(slotKey);
            added++;
        } catch (err) {
            console.error('[Bulk import audio] Could not import', row.entry.path, err);
            row.imported = 'error';
            row.note = row.note || 'Could not import';
            failed++;
        }
        state.importDone++;
        notify(row.id);
    }
    state.phase = 'review';
    state.controller = null;
    const parts = [plural(added, 'audio file', 'audio files') + ' imported'];
    if (failed) parts.push(`${failed} failed`);
    if (controller.signal.aborted) parts.unshift('Cancelled');
    state.summary = parts.join(' · ');
    if (added) {
        window.dispatchEvent(new CustomEvent(AUDIO_FILES_CHANGED_EVENT));
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        showToast(`Imported ${plural(added, 'audio file', 'audio files')}`, 'success');
    }
    notify();
}

// --- The page --------------------------------------------------------------------------------------------------------

export function renderAudioImport(container) {
    let alive = true;
    const root = document.createElement('div');
    root.className = 'be-root imp-root';
    container.appendChild(root);
    const searches = new Map(); // row id -> { text, results }

    const counts = () => {
        const c = { ready: 0, attention: 0, out: 0, wait: 0, done: 0, have: 0 };
        for (const r of state.rows) c[verdict(r)]++;
        return c;
    };

    function suggestionHtml(row) {
        const p = row.pick;
        if (!p) return `<span class="imp-sugg is-none">${esc(row.parsed ? [row.parsed.artist, row.parsed.title].filter(Boolean).join(' – ') : 'Nothing found in the name')}</span>`;
        const sub = [p.album, p.year, SLOT_LABEL[slotOf(row)]].filter(Boolean).join(' · ');
        return `<span class="imp-sugg">${esc(p.artist)} – ${esc(p.title)}${sub ? `<span class="imp-sub"> · ${esc(sub)}</span>` : ''}</span>`;
    }

    function searchHtml(row) {
        const s = searches.get(row.id) || {};
        const list = s.results || row.candidates || [];
        const text = s.text ?? [row.parsed?.artist, row.parsed?.title || baseNameOf(row.entry.name)].filter(Boolean).join(' ');
        return `
        <div class="imp-search" data-for="${row.id}">
          <div class="imp-search-bar">
            <input type="search" class="form-control form-control-sm" data-act="search-text" value="${esc(text)}" aria-label="Search your library for this song" placeholder="Artist or song">
            <button type="button" class="ct-text" data-act="search-go">Search</button>
          </div>
          <div class="imp-results" role="listbox" aria-label="Songs with a tab">
            ${!list.length ? '<p class="ct-sub">No song with a tab found. Try the song name alone, or fewer words.</p>' : ''}
            ${list.map((c, i) => `
              <button type="button" class="imp-result${row.pick && row.pick.songId === c.songId ? ' is-picked' : ''}" role="option" data-act="pick" data-i="${i}">
                <span class="imp-result-main">${esc(c.artist)} – ${esc(c.title)}</span>
                <span class="imp-sub">${esc(c.album || '')}</span>
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
            <span class="imp-state">${esc(statusText(row))}${via && row.pick && !row.manual && !row.imported ? ` · from ${esc(via)}` : ''}</span>
            ${row.imported || busy ? '' : `<button type="button" class="ct-text imp-change" data-act="change" aria-expanded="${open}">${row.pick ? 'Change' : 'Find song'}</button>`}
          </div>
          ${open ? searchHtml(row) : ''}
        </div>`;
    }

    function headHtml() {
        const c = counts();
        const parts = [`${plural(state.rows.length, 'file', 'files')} in ${esc(state.rootName)}`];
        if (c.ready) parts.push(`${c.ready} ready`);
        if (c.attention) parts.push(`${c.attention} need a look`);
        if (state.dupes.size) parts.push(`${plural(state.dupes.size, 'extra file', 'extra files')} for a song that has one`);
        if (c.have) parts.push(`${c.have} already ${c.have === 1 ? 'has' : 'have'} audio`);
        if (state.working) parts.push(`Matching ${state.rows.filter((r) => r.stage === 'done').length} of ${state.rows.length}`);
        return parts.join(' · ');
    }

    function slotHtml() {
        return `
        <fieldset class="imp-strategies">
          <legend class="be-option-title">The files are</legend>
          ${['auto', 'original', 'backing'].map((s) => `
            <label class="be-option imp-strategy">
              <input type="radio" class="form-check-input" name="impAudioSlot" value="${s}" ${state.slot === s ? 'checked' : ''}>
              <span class="be-option-text"><span class="be-option-title">${{ auto: 'Automatic', original: 'Recordings of the songs', backing: 'Backing tracks' }[s]}${s === 'auto' ? ' (recommended)' : ''}</span></span>
            </label>`).join('')}
          <p class="ct-sub imp-help">${{ auto: 'Each file becomes the song’s Original recording, unless its name says “backing track” or “no guitar”: then it becomes the Backing track.', original: 'Each file becomes the song’s Original recording.', backing: 'Each file becomes the song’s Backing track.' }[state.slot]} A new file has no sync points yet; those of a video or file it replaces stay saved with that one.</p>
        </fieldset>`;
    }

    function setupHtml() {
        const can = canPickFolder();
        return `
        <p class="ct-sub">Choose a folder of audio files (MP3, M4A, AAC, OGG, Opus, WAV and FLAC, subfolders included). Each file is matched to a song in your library that has a tab, and shown here for you to look over before anything is imported. Files with no song in the library are left out.</p>
        <fieldset class="imp-strategies">
          <legend class="be-option-title">How the files are named</legend>
          ${STRATEGIES.map((s) => `
            <label class="be-option imp-strategy">
              <input type="radio" class="form-check-input" name="impAudioStrategy" value="${s}" ${state.strategy === s ? 'checked' : ''}>
              <span class="be-option-text"><span class="be-option-title">${esc(STRATEGY_LABEL[s])}${s === 'auto' ? ' (recommended)' : ''}</span></span>
            </label>`).join('')}
          <p class="ct-sub imp-help">${esc(STRATEGY_HELP[state.strategy])}</p>
        </fieldset>
        ${slotHtml()}
        ${can ? '' : '<p class="ct-note">Importing a folder needs the MajesticTab app on a computer, or Chrome or Edge. On a phone, add audio to a song from its Sound panel.</p>'}
        <div class="be-actions">
          <button type="button" class="btn btn-sm btn-theme-primary" data-act="choose" ${can ? '' : 'disabled'}>Choose folder</button>
          <span class="be-status" role="status">${esc(state.summary)}</span>
        </div>`;
    }

    function reviewHtml() {
        const c = counts();
        const importing = state.phase === 'importing';
        const shown = state.filter === 'attention' ? state.rows.filter((r) => ['attention', 'wait'].includes(verdict(r)) && !r.imported) : state.rows;
        const pct = Math.round((state.importDone / Math.max(1, state.importTotal)) * 100);
        return `
        <div class="imp-top">
          <div class="be-stats-row" role="status" data-part="head">${headHtml()}</div>
          ${importing ? `<div class="be-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="be-progress-fill" style="width:${pct}%"></div></div>` : ''}
          <div class="be-actions imp-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="import" ${importing || !c.ready ? 'disabled' : ''}>${importing ? `Importing ${state.importDone} of ${state.importTotal}…` : (c.ready ? `Import ${plural(c.ready, 'audio file', 'audio files')}` : 'Import')}</button>
            ${importing ? '<button type="button" class="ct-text" data-act="cancel-import">Cancel</button>' : ''}
            ${importing ? '' : `
            <label class="imp-strategy-pick">
              <span class="imp-sub">Pair by</span>
              <select class="form-select form-select-sm" data-act="strategy" aria-label="How the files are named">
                ${STRATEGIES.map((s) => `<option value="${s}" ${state.strategy === s ? 'selected' : ''}>${esc(STRATEGY_LABEL[s])}</option>`).join('')}
              </select>
            </label>
            <label class="imp-strategy-pick">
              <span class="imp-sub">Files are</span>
              <select class="form-select form-select-sm" data-act="slot" aria-label="Where the files go">
                <option value="auto" ${state.slot === 'auto' ? 'selected' : ''}>Automatic</option>
                <option value="original" ${state.slot === 'original' ? 'selected' : ''}>Recordings</option>
                <option value="backing" ${state.slot === 'backing' ? 'selected' : ''}>Backing tracks</option>
              </select>
            </label>
            ${c.attention || state.filter !== 'all' ? `<button type="button" class="ct-text" data-act="${state.filter === 'all' ? 'only-attention' : 'show-all'}">${state.filter === 'all' ? (c.attention === 1 ? 'Show the one that needs a look' : `Show the ${c.attention} that need a look`) : 'Show all'}</button>` : ''}
            <button type="button" class="ct-text" data-act="select-all">Select all</button>
            <button type="button" class="ct-text" data-act="select-none">Select none</button>
            <button type="button" class="ct-text" data-act="choose">Choose another folder</button>`}
          </div>
          ${importing ? '' : `<label class="be-option imp-fallback"><input type="checkbox" class="form-check-input" data-act="skip-existing" ${state.skipExisting ? 'checked' : ''}><span class="be-option-text"><span class="be-option-title">Skip songs that already have audio there</span><span class="be-option-sub">A file is left out when its song already has a file in that slot. Check its row to import it anyway.</span></span></label>`}
          ${state.summary ? `<div class="be-status" role="status">${esc(state.summary)}</div>` : ''}
        </div>
        ${state.rows.length === 0 ? '<p class="ct-empty">No audio files were found in that folder.</p>' : ''}
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

    /** One row (and the header counts) changed: redraw only those, so a long list stays steady while matching runs. */
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
            importBtn.textContent = n ? `Import ${plural(n, 'audio file', 'audio files')}` : 'Import';
            importBtn.disabled = !n;
        } else if (state.phase === 'importing') {
            const bar = root.querySelector('.be-progress-fill');
            if (bar) bar.style.width = `${Math.round((state.importDone / Math.max(1, state.importTotal)) * 100)}%`;
            if (importBtn) importBtn.textContent = `Importing ${state.importDone} of ${state.importTotal}…`;
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
            }, controller.signal, 'audio');
            if (!alive && !result) return;
            if (!result || controller.signal.aborted) { state.phase = previous === 'scanning' ? 'setup' : previous; state.scanController = null; notify(); return; }
            state.scanController = null;
            loadAudioScan(result);
        } catch (err) {
            console.error('[Bulk import audio] Could not read the folder:', err);
            state.phase = previous === 'scanning' ? 'setup' : previous;
            state.scanController = null;
            showToast('Could not read that folder', 'error');
            notify();
        }
    }

    function runSearch(rowId) {
        const input = root.querySelector(`[data-for="${rowId}"] [data-act="search-text"]`);
        if (!input) return;
        const text = input.value.trim();
        searches.set(rowId, { text, results: searchLibrarySongs(text, state.songs) });
        patch(rowId);
    }

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn || !root.contains(btn)) return;
        const act = btn.dataset.act;
        const rowId = btn.closest('[data-row]')?.dataset.row || btn.closest('[data-for]')?.dataset.for;
        const row = state.rows.find((r) => r.id === rowId);
        if (act === 'choose') choose();
        else if (act === 'cancel-scan') state.scanController?.abort();
        else if (act === 'import') runImport();
        else if (act === 'cancel-import') state.controller?.abort();
        else if (act === 'select-all' || act === 'select-none') {
            const on = act === 'select-all';
            const inView = state.filter === 'attention' ? state.rows.filter((r) => ['attention', 'wait'].includes(verdict(r)) && !r.imported) : state.rows;
            for (const r of inView) {
                if (!r.pick || r.imported) continue;
                r.excluded = !on;
                if (on) r.confirmed = true;
            }
            render();
        }
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
            const chosen = (searches.get(row.id)?.results || row.candidates)?.[Number(btn.dataset.i)];
            if (!chosen) return;
            Object.assign(row, { pick: chosen, manual: true, status: 'library', excluded: false, forced: false, stage: 'done' });
            markHad(row);
            state.openId = null;
            patch(row.id);
            root.querySelector(`[data-row="${row.id}"] [data-act="change"]`)?.focus();
        }
    });
    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.name === 'impAudioStrategy') { state.strategy = t.value; render(); return; }
        if (t.name === 'impAudioSlot') { state.slot = t.value; render(); return; }
        if (t.dataset.act === 'strategy') { state.strategy = t.value; if (state.rows.length) { restartMatching(); render(); } return; }
        if (t.dataset.act === 'slot') { state.slot = t.value; refreshHad(); render(); return; }
        if (t.dataset.act === 'skip-existing') { state.skipExisting = t.checked; render(); return; }
        if (t.dataset.act === 'include') {
            const row = state.rows.find((r) => r.id === t.closest('[data-row]')?.dataset.row);
            if (row) {
                row.excluded = !t.checked;
                if (t.checked) { row.confirmed = true; row.forced = true; }
                patch(row.id);
            }
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
    return () => {
        alive = false;
        listeners.delete(onChange);
    };
}
