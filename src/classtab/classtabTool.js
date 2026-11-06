// classtab/classtabTool.js
// The Classical tab page in Tools: a front end for the Classtab archive the user downloads (or supplies) once.
// No archive yet: a short explanation and the one primary action. With an archive: composers on the left, pieces on the
// right (one list at a time on phones), search and filters. Opening a piece reads it out of the stored ZIP.

import {
    getCatalogRecord, installArchive, readArchiveEntry, onArchiveChange, ClasstabError
} from './archive.js';
import { canDownloadArchive, downloadArchive, readLocalZip, CLASSTAB_HOME } from './download.js';
import { composerList, browse, pieceFacts, composerHeading, formatUpdated, passesFilters, nameParts, FILTERS, MORE_FILTERS } from './catalog.js';
import { resolvePins, isPiecePinned, isComposerPinned, togglePiecePin, toggleComposerPin } from './pins.js';
import { showToast } from '../utils/toast.js';

export const CLASSTAB_SOURCE = 'Classtab';
const MAX_ROWS = 400;

// A search typed elsewhere (the library's search) that the tool should open on
let pendingView = null;
export function requestClasstabView(view) { pendingView = view; }
// Where the player was when the reader took the screen, so coming back lands on the same list
let savedView = null;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A composer's name with the sorted-on last name in bold. */
const nameHtml = (name) => {
    const { before, key, after } = nameParts(name);
    return `${esc(before)}${key ? `<b>${esc(key)}</b>` : ''}${esc(after)}`;
};
const mb = (n) => (n / 1048576).toFixed(1);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

async function openExternal(url) {
    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) await opener.openUrl(url);
    else window.open(url, '_blank', 'noopener');
}

/** The credit line, always under the title. */
const creditHtml = () =>
    `<p class="ct-credit">Tabs and MIDI files from Classtab, a free archive of classical guitar tabs. <a href="${CLASSTAB_HOME}" data-ct-home>Visit classtab.org</a></p>`;

/** Save the piece's first video as the song's Original source (the same saved choice the video panel reads). */
export async function linkOriginalVideo(songKey, piece) {
    const url = piece.video_links?.[0]?.url;
    if (!songKey || !url) return;
    const { extractVideoId } = await import('../youtubePlayer.js');
    const id = extractVideoId(url);
    if (!id) return; // Vimeo links are not played in the app; the row menu still opens them
    const k = encodeURIComponent(String(songKey).toLowerCase());
    try {
        localStorage.setItem(`yt_track_${k}_original`, id);
        localStorage.setItem(`yt_pick_${k}_original`, '1');
    } catch { /* storage unavailable */ }
}

/** A File for a piece, read out of the stored archive. null when the archive no longer has it. */
export async function pieceFile(piece, composer) {
    const bytes = await readArchiveEntry(piece.tab_url);
    if (!bytes) return null;
    const file = new File([bytes], piece.tab_url, { type: 'text/plain' });
    file.sourceWebsite = CLASSTAB_SOURCE;
    file.classtabTab = piece.tab_url;
    // The reader shows the catalog's names, not the archive's file name
    if (piece.midi_urls?.length) file.synthMidiLoader = () => readArchiveEntry(piece.midi_urls[0]);
    file.songTitle = piece.title;
    file.tabName = piece.title;
    if (composer) file.artist = composer.name;
    return file;
}

export async function openPiece(piece, composer) {
    const file = await pieceFile(piece, composer);
    if (!file) {
        showToast('No longer in the archive.', 'warning');
        return;
    }
    const { openLocalFile } = await import('../fileProviders.js');
    await openLocalFile(file);
    const { getSongKey } = await import('../youtubePlayer.js');
    await linkOriginalVideo(getSongKey(), piece);
}

/** Copy a piece into the library as a normal song. Nothing refers back to the archive afterwards. */
export async function addPieceToLibrary(piece, composer) {
    const file = await pieceFile(piece, composer);
    if (!file) {
        showToast('No longer in the archive.', 'warning');
        return false;
    }
    const { saveSongToLibrary, mapOpenFileToSong } = await import('../libraryStore.js');
    const tuning = piece.tuning === 'drop D' ? ['Drop D'] : [];
    const song = await saveSongToLibrary({
        title: piece.title, artist: composer.name, album: 'Classical tab', isCustom: true, tunings: tuning, stringCount: 6
    });
    await mapOpenFileToSong(file, song.id, piece.title);
    await linkOriginalVideo(`${composer.name} - ${piece.title}`, piece);
    if (piece.midi_urls?.length) {
        const midi = await readArchiveEntry(piece.midi_urls[0]);
        if (midi) await (await import('./midiSynth.js')).saveSongMidi(song.id, piece.midi_urls[0], midi);
    }
    window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    showToast(`Added "${piece.title}" to your library.`, 'success');
    return true;
}

/** Archive file names of pieces already copied into the library. */
async function libraryTabNames() {
    try {
        const { getAllSongs } = await import('../libraryStore.js');
        const names = new Set();
        for (const s of await getAllSongs()) {
            for (const t of s.tabOptions || []) if (t.sourceWebsite === CLASSTAB_SOURCE && t.relativePath) names.add(t.relativePath);
        }
        return names;
    } catch {
        return new Set();
    }
}

export function renderClasstabTool(container, { onBack } = {}) {
    const state = {
        rec: null, query: '', filters: new Set(), composer: null, // composer: index into rec.composers
        job: null, // { text, cancel } while downloading or reading
        message: '', error: '', inLibrary: new Set(), menuFor: null,
        showPinned: null // null: the Pinned group when there are pins; true / false once the player picks
    };
    if (!pendingView && savedView) Object.assign(state, savedView);
    savedView = null;
    if (pendingView) {
        state.query = pendingView.query || '';
        state.pane = 'pieces';
        pendingView = null;
    }
    let alive = true;
    let list = [];

    container.innerHTML = '<div class="ct-root"></div>';
    const root = container.querySelector('.ct-root');
    const unsubscribe = onArchiveChange(() => { if (alive && root.isConnected) refresh(); });

    async function refresh() {
        state.rec = await getCatalogRecord();
        state.inLibrary = await libraryTabNames();
        if (state.rec && (state.composer == null || !state.rec.composers[state.composer])) {
            const first = composerList(state.rec.composers)[0];
            state.composer = first ? first.index : null;
        }
        render();
    }

    // Keep the chosen composer by name across an update
    function keepComposerByName(name) {
        if (!state.rec) return;
        const i = state.rec.composers.findIndex((c) => c.name === name);
        state.composer = i >= 0 ? i : composerList(state.rec.composers)[0]?.index ?? null;
    }

    async function install(getBytes, label) {
        const keep = state.rec?.composers[state.composer]?.name;
        const ctrl = new AbortController();
        state.error = '';
        state.message = '';
        state.job = { text: label, cancel: () => ctrl.abort() };
        render();
        try {
            const bytes = await getBytes(ctrl.signal, (loaded, total) => {
                state.job.text = total ? `Downloading · ${mb(loaded)} of ${mb(total)} MB` : `Downloading · ${mb(loaded)} MB`;
                const el = root.querySelector('.ct-job-text');
                if (el) el.textContent = state.job.text;
            });
            state.job = { text: 'Reading tabs…', cancel: null };
            render();
            await new Promise((r) => setTimeout(r, 30)); // let the line paint before parsing
            const res = await installArchive(bytes);
            state.rec = await getCatalogRecord();
            keepComposerByName(keep);
            state.inLibrary = await libraryTabNames();
            state.message = res.first
                ? `Classical tab ready · ${plural(res.counts.pieces, 'piece', 'pieces')}`
                : `Classical tab updated · ${res.added} new, ${res.changed} changed`;
        } catch (e) {
            if (e?.code !== 'cancelled') state.error = e instanceof ClasstabError ? e.message : "Couldn't read that archive.";
        }
        state.job = null;
        if (alive) render();
    }

    const startDownload = () => install((signal, onProgress) => downloadArchive({ signal, onProgress }), 'Downloading…');

    function chooseZip() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.addEventListener('change', () => {
            const f = input.files?.[0];
            if (f) install(() => readLocalZip(f), 'Reading tabs…');
        });
        input.click();
    }

    let updateArmed = false;
    let updateTimer = 0;
    /** First press arms the update (the button says what it does); a second press within 4 s goes ahead. No native dialog. */
    function updateConfirmed() {
        if (updateArmed) { updateArmed = false; clearTimeout(updateTimer); return true; }
        updateArmed = true;
        updateTimer = setTimeout(() => { updateArmed = false; render(); }, 4000);
        render();
        return false;
    }

    const statusHtml = () => {
        if (state.job) {
            return `<div class="ct-status"><span class="ct-job-text" role="status">${esc(state.job.text)}</span>${state.job.cancel ? '<button type="button" class="ct-text" data-act="cancel">Cancel</button>' : ''}</div>`;
        }
        return `${state.message ? `<p class="ct-note" role="status">${esc(state.message)}</p>` : ''}${state.error ? `<p class="ct-error" role="alert">${esc(state.error)}</p>` : ''}`;
    };

    function renderEmpty() {
        const native = canDownloadArchive();
        root.innerHTML = `
        <header class="ct-head">
          <h2 class="ct-title">Classical tab</h2>
          ${creditHtml()}
          <p class="ct-sub">About 3,800 pieces by 600 composers. Downloads once, then works offline.</p>
        </header>
        ${state.job ? statusHtml() : `
        <div class="ct-start">
          ${native
        ? '<button type="button" class="btn btn-sm btn-theme-primary" data-act="download">Download archive</button><button type="button" class="ct-text" data-act="choose">Use a ZIP from this device</button>'
        : '<button type="button" class="btn btn-sm btn-theme-primary" data-act="choose">Choose ZIP file</button>'}
        </div>
        ${state.message ? `<p class="ct-note" role="status">${esc(state.message)}</p>` : ''}${state.error ? `<p class="ct-error" role="alert">${esc(state.error)}</p>` : ''}
        <p class="ct-sub">${native ? 'About 14 MB. From classtab.org.' : 'Download the ZIP from classtab.org in your browser, then choose it here.'} Not part of your backup.</p>`}`;
    }

    function pieceRow(m, showComposer) {
        const c = state.rec.composers[m.composer];
        const p = m.piece;
        const facts = pieceFacts(p);
        const meta = [showComposer ? c.name : '', ...facts].filter(Boolean).join(' · ');
        const key = `${m.composer}:${p.tab_url}`;
        const mine = state.inLibrary.has(p.tab_url);
        const pinned = isPiecePinned(c.name, p.title);
        return `<div class="ct-row" role="listitem" data-key="${esc(key)}">
          <button type="button" class="ct-open" data-act="open" data-key="${esc(key)}">
            <span class="ct-row-title">${esc(p.title)}</span>
            <span class="ct-row-meta">${esc(meta)}</span>
          </button>
          ${mine ? '<span class="ct-inlib">In your library</span>' : `<button type="button" class="ct-text ct-add" data-act="add" data-key="${esc(key)}">Add to library</button>`}
          <button type="button" class="ct-pin" data-act="pin" data-key="${esc(key)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(p.title)}"><i class="bi-pin-angle${pinned ? '-fill' : ''}" aria-hidden="true"></i></button>
          <button type="button" class="ct-more" data-act="menu" data-key="${esc(key)}" aria-label="More for ${esc(p.title)}" aria-haspopup="menu" aria-expanded="${state.menuFor === key}">⋯</button>
          ${state.menuFor === key ? `<div class="ct-menu" role="menu">
            <button type="button" role="menuitem" data-act="open" data-key="${esc(key)}">Open</button>
            <button type="button" role="menuitem" data-act="add" data-key="${esc(key)}">${mine ? 'Add another copy' : 'Add to library'}</button>
            ${(p.video_links || []).map((v, i) => `<button type="button" role="menuitem" data-act="video" data-key="${esc(key)}" data-i="${i}">Open video${p.video_links.length > 1 ? ` · ${esc(v.performer)}` : ''}</button>`).join('')}
          </div>` : ''}
        </div>`;
    }

    function composerRow(ci) {
        const c = state.rec.composers[ci];
        const meta = [plural(c.pieces.length, 'piece', 'pieces'), c.dates ? c.dates.replace(/-/g, '–') : ''].filter(Boolean).join(' · ');
        return `<div class="ct-row" role="listitem">
          <button type="button" class="ct-open" data-comp="${ci}"><span class="ct-row-title"><span class="ct-comp-name">${nameHtml(c.name)}</span></span><span class="ct-row-meta">${esc(meta)}</span></button>
          <button type="button" class="ct-pin" data-pincomp="${ci}" aria-pressed="true" aria-label="Unpin ${esc(c.name)}"><i class="bi-pin-angle-fill" aria-hidden="true"></i></button>
        </div>`;
    }

    function renderBrowse() {
        const { composers } = state.rec;
        const q = { query: state.query, filters: [...state.filters], composer: state.composer };
        const res = browse(composers, q);
        const comps = composerList(composers).filter((c) => res.composerCounts.has(c.index));
        const searching = state.query.trim().length > 0;
        const chosen = composers[state.composer];
        const pins = resolvePins(composers);
        const activeIds = [...state.filters];
        const pinnedPieces = pins.pieces.filter((m) => passesFilters(m.piece, activeIds));
        const pinCount = pins.composers.length + pins.pieces.length;
        const pinnedActive = !searching && pinCount > 0 && state.showPinned !== false;
        const shown = res.pieces.slice(0, MAX_ROWS);
        list = res.pieces;
        const total = state.rec.counts.pieces;
        const filterBtn = (f) => `<button type="button" class="ct-filter" data-filter="${f.id}" aria-pressed="${state.filters.has(f.id)}">${f.label}</button>`;
        const moreOn = MORE_FILTERS.some((f) => state.filters.has(f.id));
        root.innerHTML = `
        <header class="ct-head">
          <div class="ct-head-row">
            <h2 class="ct-title">Classical tab</h2>
            ${state.job ? '' : `<button type="button" class="ct-text" data-act="update">${updateArmed ? 'Press again to replace the library (your songs stay)' : 'Update archive'}</button>`}
          </div>
          ${creditHtml()}
          <p class="ct-sub">${plural(total, 'piece', 'pieces')} · updated ${formatUpdated(state.rec.updatedAt)}</p>
        </header>
        ${statusHtml()}
        <input type="search" class="ct-search" placeholder="Search composers and pieces" aria-label="Search composers and pieces" value="${esc(state.query)}" autocomplete="off" spellcheck="false">
        <div class="ct-filters" role="group" aria-label="Filters">
          ${FILTERS.map(filterBtn).join('')}
          <span class="ct-morewrap"><button type="button" class="ct-filter" data-act="more" aria-expanded="${state.moreOpen ? 'true' : 'false'}" aria-pressed="${moreOn}">More</button>
          ${state.moreOpen ? `<span class="ct-moremenu" role="group">${MORE_FILTERS.map(filterBtn).join('')}</span>` : ''}</span>
        </div>
        <div class="ct-cols" data-pane="${state.pane || 'composers'}">
          <nav class="ct-composers" aria-label="Composers">
            ${pinCount ? `<button type="button" class="ct-comp" data-act="showpinned" aria-current="${pinnedActive}">
              <span class="ct-comp-text"><span class="ct-comp-name"><b>Pinned</b></span><small>${[pins.composers.length ? plural(pins.composers.length, 'composer', 'composers') : '', pins.pieces.length ? plural(pins.pieces.length, 'piece', 'pieces') : ''].filter(Boolean).join(' · ')}</small></span><i class="bi-chevron-right chev" aria-hidden="true"></i></button>` : ''}
            <div class="ct-colhead"><span>Composers</span><span>${comps.length.toLocaleString()}</span></div>
            ${comps.map((c) => {
              const pinned = isComposerPinned(c.name);
              return `<div class="ct-comprow"><button type="button" class="ct-comp" data-comp="${c.index}" aria-current="${!searching && !pinnedActive && c.index === state.composer}">
              <span class="ct-comp-text"><span class="ct-comp-name">${nameHtml(c.name)}</span><small>${plural(res.composerCounts.get(c.index), 'piece', 'pieces')}</small></span><i class="bi-chevron-right chev" aria-hidden="true"></i></button>
              <button type="button" class="ct-pin" data-pincomp="${c.index}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(c.name)}"><i class="bi-pin-angle${pinned ? '-fill' : ''}" aria-hidden="true"></i></button></div>`;
            }).join('') || '<p class="ct-empty">No composers match.</p>'}
          </nav>
          <section class="ct-pieces" aria-label="Pieces">
            <button type="button" class="ct-back" data-act="back"><i class="bi-chevron-left" aria-hidden="true"></i> Composers</button>
            <div class="ct-head-row">
              <h3 class="ct-pieces-title">${searching ? esc(plural(res.pieces.length, 'result', 'results')) : pinnedActive ? 'Pinned' : chosen ? esc(composerHeading(chosen)) : ''}</h3>
            </div>
            ${!searching && !pinnedActive && chosen?.aliases ? `<p class="ct-sub">Also ${esc(chosen.aliases)}</p>` : ''}
            <div class="ct-list" role="list">
              ${pinnedActive
        ? `${pins.composers.map(composerRow).join('')}${pinnedPieces.map((m) => pieceRow(m, true)).join('')}${!pins.composers.length && !pinnedPieces.length ? '<p class="ct-empty">No pinned pieces match the filters.</p>' : ''}`
        : `${shown.map((m) => pieceRow(m, searching)).join('') || '<p class="ct-empty">No pieces match. <button type="button" class="ct-text" data-act="clear">Clear filters</button></p>'}
              ${res.pieces.length > shown.length ? `<p class="ct-empty">Showing the first ${MAX_ROWS}. Narrow the search to see more.</p>` : ''}`}
            </div>
          </section>
        </div>`;
    }

    function render() {
        if (!alive || !root.isConnected) return;
        // Keep focus and caret in the search box while typing
        const hadSearch = document.activeElement?.classList?.contains('ct-search');
        const caret = hadSearch ? document.activeElement.selectionStart : 0;
        if (!state.rec) renderEmpty();
        else renderBrowse();
        if (hadSearch) {
            const s = root.querySelector('.ct-search');
            s?.focus();
            s?.setSelectionRange(caret, caret);
        }
    }

    const findPiece = (key) => {
        const at = key.indexOf(':');
        const ci = Number(key.slice(0, at));
        const c = state.rec.composers[ci];
        return { composer: c, piece: c?.pieces.find((p) => p.tab_url === key.slice(at + 1)) };
    };

    root.addEventListener('input', (e) => {
        if (!e.target.classList.contains('ct-search')) return;
        state.query = e.target.value;
        render();
    });

    root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-ct-home]')) { e.preventDefault(); openExternal(CLASSTAB_HOME); return; }
        const filter = e.target.closest('[data-filter]');
        if (filter) {
            const id = filter.dataset.filter;
            if (state.filters.has(id)) state.filters.delete(id); else state.filters.add(id);
            render();
            return;
        }
        const pinComp = e.target.closest('[data-pincomp]');
        if (pinComp) {
            const c = state.rec.composers[Number(pinComp.dataset.pincomp)];
            if (c) toggleComposerPin(c.name);
            render();
            return;
        }
        const comp = e.target.closest('[data-comp]');
        if (comp) {
            state.composer = Number(comp.dataset.comp);
            state.query = '';
            state.pane = 'pieces';
            state.showPinned = false;
            render();
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (!btn) { if (state.menuFor || state.moreOpen) { state.menuFor = null; state.moreOpen = false; render(); } return; }
        const act = btn.dataset.act;
        if (act === 'download') startDownload();
        else if (act === 'choose') chooseZip();
        else if (act === 'cancel') state.job?.cancel?.();
        else if (act === 'update') {
            if (!updateConfirmed()) return;
            if (canDownloadArchive()) startDownload(); else chooseZip();
        } else if (act === 'more') { state.moreOpen = !state.moreOpen; render(); }
        else if (act === 'clear') { state.filters.clear(); state.query = ''; render(); }
        else if (act === 'showpinned') { state.showPinned = true; state.query = ''; state.pane = 'pieces'; render(); }
        else if (act === 'pin') {
            const { composer, piece } = findPiece(btn.dataset.key);
            if (composer && piece) togglePiecePin(composer.name, piece.title);
            render();
        }
        else if (act === 'back') { state.pane = 'composers'; render(); }
        else if (act === 'menu') { state.menuFor = state.menuFor === btn.dataset.key ? null : btn.dataset.key; render(); }
        else if (['open', 'add', 'video'].includes(act)) {
            const { composer, piece } = findPiece(btn.dataset.key);
            state.menuFor = null;
            render();
            if (!piece) return;
            try {
                if (act === 'open') await openPiece(piece, composer);
                else if (act === 'add') { if (await addPieceToLibrary(piece, composer)) { state.inLibrary = await libraryTabNames(); render(); } }
                else openExternal(piece.video_links[Number(btn.dataset.i)].url);
            } catch (err) {
                showToast(err?.message || 'Could not open that piece.', 'error');
            }
        }
    });

    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (state.menuFor || state.moreOpen)) { state.menuFor = null; state.moreOpen = false; render(); }
    });

    refresh();
    return (keep = false) => {
        alive = false;
        unsubscribe();
        savedView = keep ? { query: state.query, filters: new Set(state.filters), composer: state.composer, pane: state.pane, showPinned: state.showPinned } : null;
    };
}
