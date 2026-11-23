// missingTabsTool.js
// Fill in missing tabs, a page in Tools: lists every library song that has no tab, in artist, album and track order,
// and fills them in two lanes (the search providers in Settings decide which a song can use):
//   1. Automated: providers that fetch a file themselves (a service that describes itself) are asked for every song, one
//      after another, with no dialog (fillRun.js). Matches that are not plainly the song wait for a pick afterwards.
//   2. Walkthrough: for what is left, one song at a time, a search opens in the system browser and the page waits for the
//      tab: a file opened with the app, dropped, chosen or linked is added to that song (guideTarget.js).
// Native apps only. Unit tested in tests/fillRun.test.mjs.

import { getAllSongs } from '../libraryStore.js';
import { getSources, openWebSearch } from '../webSearch.js';
import { sourceFetches } from '../urlImport/sourceKind.js';
import { attachTabToSong, openTabFromUrl } from '../fileProviders.js';
import { holdSync } from '../autoSync.js';
import { showToast } from '../utils/toast.js';
import { createFillRun } from './fillRun.js';
import { fetchTabForSong } from './fetchForSong.js';
import { setGuideTarget } from './guideTarget.js';
import { loadFillState, saveFillState, snapshotOf } from './fillStore.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hasTab = (s) => Array.isArray(s.tabOptions) && s.tabOptions.length > 0;
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const byText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });

// What an earlier run found nothing for: a fact about a service's catalogue, kept in the run's cache file (fillStore.js), not a setting.
let notFound = new Set();
let restoreTried = false;
let saveTimer = null;
/** Writes the run to the cache file soon after it changes (one write for a burst of changes). */
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveFillState(snapshotOf({ songIds: fill?.songIds || [], items: fill?.run.items || new Map(), notFound }));
    }, 600);
}

const view = { artist: '' }; // '' is every artist
let missingCount = null;
const listeners = new Set();
const notify = () => { scheduleSave(); for (const fn of listeners) { try { fn(); } catch { /* a closed page */ } } };

// A run outlives the page: leaving Tools does not stop it, and coming back shows where it is.
let fill = null; // { run, songIds }
// The walkthrough: the songs it walks, where it is, and whether it is waiting for a tab.
const guide = { songs: null, index: 0, waiting: false, sourceId: '', linking: false, skipped: new Set(), added: 0 };

export function serializeMissingSongs(songs) {
    return (songs || []).map((s) => ({
        songId: s.id,
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        year: s.year || '',
        trackNumber: s.trackNumber || null,
        recordingMbid: s.recordingMbid || '',
        artistMbid: s.artistMbid || '',
        albumMbid: s.albumMbid || ''
    }));
}

/** Search providers split by what they do: those that fetch a file (asked for by the run) and those that open a web page. */
export async function splitSources(sources = getSources()) {
    const api = [];
    const page = [];
    for (const source of sources) {
        let fetches = false;
        try { fetches = await sourceFetches(source); } catch { /* unknown: treated as a page */ }
        (fetches ? api : page).push(source);
    }
    return { api, page };
}

/** Readout for the Tools row: how many songs have no tab (known once the page, or the list, has been read). */
export function missingTabsReadout() {
    return missingCount ? plural(missingCount, 'song', 'songs') : '';
}

/** Songs with no tab and a title and artist to search for, in the order the walk takes them. */
export async function listMissingTabSongs() {
    const songs = await getAllSongs().catch(() => []);
    const missing = songs.filter((s) => s && !hasTab(s) && s.title && s.artist);
    missing.sort((a, b) => byText(a.artist, b.artist) || byText(a.album, b.album)
        || ((a.trackNumber || 1e6) - (b.trackNumber || 1e6)) || byText(a.title, b.title));
    return missing;
}

/** Read the count for the Tools row without opening the page. */
export async function refreshMissingTabsCount() {
    publishCount((await listMissingTabSongs()).length);
}

function publishCount(n) {
    missingCount = n;
    const el = document.querySelector('[data-read="missingtabs"]');
    if (el && el.textContent !== missingTabsReadout()) el.textContent = missingTabsReadout();
}

const stateOf = (songId) => fill?.run.items.get(songId)?.state || '';

function rowStatusText(songId) {
    const item = fill?.run.items.get(songId);
    if (!item) return '';
    if (item.state === 'added') return 'Added';
    if (item.state === 'searching') return item.fraction !== null && item.fraction !== undefined ? `${item.label || 'Fetching'} ${Math.round(item.fraction * 100)}%` : (item.label || 'Searching…');
    if (item.state === 'pick') return 'Needs a pick';
    if (item.state === 'missing') return 'Not found';
    if (item.state === 'failed') return item.message || 'Failed';
    if (item.state === 'queued' && fill.run.running) return 'Waiting…';
    return '';
}

function summaryText(counts) {
    const parts = [];
    if (counts.added) parts.push(`${counts.added.toLocaleString()} added`);
    if (counts.pick) parts.push(`${counts.pick.toLocaleString()} ${counts.pick === 1 ? 'needs' : 'need'} a pick`);
    if (counts.missing) parts.push(`${counts.missing.toLocaleString()} not found`);
    if (counts.failed) parts.push(`${counts.failed.toLocaleString()} failed`);
    return parts.join(' · ');
}

export function renderMissingTabsTool(container) {
    let alive = true;
    let songs = null; // null while reading
    let lanes = null; // { api, page } once the providers have been read
    const root = document.createElement('div');
    root.className = 'be-root';
    container.appendChild(root);

    let menuOpen = ''; // '' (closed), 'all' (the Search button), or the id of the song whose Search menu is open

    const inScope = () => (view.artist ? songs.filter((s) => s.artist === view.artist) : songs);
    const guideSong = () => (guide.songs ? guide.songs[guide.index] || null : null);

    // The songs the walkthrough takes: everything not added yet (including what the providers could not fetch) and not skipped
    const leftovers = () => inScope().filter((s) => stateOf(s.id) !== 'added' && !guide.skipped.has(s.id));

    /**
     * A button with a menu of every search provider beside it. The button uses the default; picking a provider in the menu
     * uses that one this time. `defaults` are the ids of the providers the button itself uses, shown in the menu as such.
     */
    function splitButton({ menu, label, act, ariaLabel, style = 'outline', defaults = [], songId = '', disabled = false }) {
        const open = menuOpen === menu && !disabled;
        const klass = `btn btn-sm ${style === 'primary' ? 'btn-theme-primary' : 'btn-theme-outline'}`;
        const data = songId ? ` data-song-id="${esc(songId)}"` : '';
        const items = getSources().map((src) => `
            <button type="button" role="menuitem" class="fill-menu-item" data-act="menu-pick" data-menu="${esc(menu)}" data-source-id="${esc(src.id)}"${data}>
              <span>${esc(src.name)}</span>${defaults.includes(src.id) ? '<span class="fill-menu-note">default</span>' : ''}
            </button>`).join('');
        return `
          <span class="fill-split">
            <button type="button" class="${klass} fill-split-main" data-act="${act}"${data} ${ariaLabel ? `aria-label="${esc(ariaLabel)}"` : ''} ${disabled ? 'disabled' : ''}>${label}</button>
            <button type="button" class="${klass} fill-split-caret" data-act="menu" data-menu="${esc(menu)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="Search with another provider" ${disabled ? 'disabled' : ''}><i class="bi-chevron-down" aria-hidden="true"></i></button>
            ${open ? `<div class="fill-menu" role="menu" aria-label="Search with">${items}</div>` : ''}
          </span>`;
    }

    function renderGuide() {
        const song = guideSong();
        if (!song) {
            const done = guide.added;
            return `
              <div class="fill-guide">
                <div class="missingtabs-title fill-guide-title">That is the end of the list</div>
                <p class="ct-sub">${done ? `${plural(done, 'tab', 'tabs')} added in the browser.` : 'No tabs were added.'}</p>
                <div class="be-actions"><button type="button" class="btn btn-sm btn-theme-primary" data-act="guide-exit">Back to the list</button></div>
              </div>`;
        }
        const pages = lanes?.page || [];
        const source = pages.find((p) => p.id === guide.sourceId) || pages[0];
        const picker = pages.length > 1 ? `
          <label class="be-option be-field">
            <span class="be-option-title">Search with</span>
            <select class="form-select form-select-sm" data-act="guide-source" aria-label="Search with">
              ${pages.map((p) => `<option value="${esc(p.id)}" ${p.id === source?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </label>` : '';
        const waiting = guide.waiting ? `
            <p class="ct-sub fill-guide-wait" role="status">Waiting for the tab. Download it in your browser, then open the file with MajesticTab, drop it here, or choose it.</p>
            <div class="be-actions">
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-choose">Choose file</button>
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-link">Paste link</button>
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-reopen">Open search again</button>
            </div>
            ${guide.linking ? `
            <form class="fill-guide-link" data-act="guide-link-form">
              <input type="text" class="form-control form-control-sm" name="address" placeholder="Address of the tab file" aria-label="Address of the tab file" autocomplete="off">
              <button type="submit" class="btn btn-sm btn-theme-outline">Add</button>
            </form>` : ''}` : `
            <div class="be-actions"><button type="button" class="btn btn-sm btn-theme-primary" data-act="guide-open">Open search${source ? ` in ${esc(source.name)}` : ''}</button></div>`;
        return `
          <div class="fill-guide">
            <div class="missingtabs-sub">Song ${(guide.index + 1).toLocaleString()} of ${guide.songs.length.toLocaleString()}${guide.added ? ` · ${guide.added.toLocaleString()} added` : ''}</div>
            <div class="missingtabs-title fill-guide-title">${esc(song.title)}</div>
            <div class="missingtabs-sub">${esc(song.artist)}${song.album ? ` · ${esc(song.album)}` : ''}</div>
            ${picker}
            ${waiting}
            <div class="be-actions fill-guide-nav">
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-back" ${guide.index === 0 ? 'disabled' : ''}>Previous</button>
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-skip">Skip</button>
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-exit">Back to the list</button>
            </div>
          </div>`;
    }

    function renderList(scoped) {
        const counts = fill?.run.counts();
        const running = Boolean(fill?.run.running);
        const known = notFound;
        const apiQueued = lanes?.api.length ? scoped.filter((s) => (stateOf(s.id) === '' && !known.has(s.id)) || ['queued', 'failed'].includes(stateOf(s.id))).length : 0;
        const picks = scoped.filter((s) => stateOf(s.id) === 'pick').length;
        const retryable = scoped.filter((s) => stateOf(s.id) === 'missing' || (stateOf(s.id) === '' && known.has(s.id))).length;
        const left = leftovers().length;
        const canBrowse = Boolean(lanes?.page.length) && left > 0;
        // With providers that fetch, Search asks them all; with none, it walks the songs in the browser with the first provider
        const searchCount = !lanes ? 0 : (lanes.api.length ? apiQueued : left);
        const defaultIds = lanes?.api.length ? lanes.api.map((p) => p.id) : (lanes?.page[0] ? [lanes.page[0].id] : []);
        let primary = '';
        if (running) primary = '';
        else if (searchCount > 0) primary = splitButton({ menu: 'all', act: 'search-all', style: 'primary', defaults: defaultIds, label: `Search ${plural(searchCount, 'song', 'songs')}` });
        else if (picks > 0) primary = `<button type="button" class="btn btn-sm btn-theme-primary" data-act="pick-all">Choose ${picks === 1 ? 'a match' : `matches for ${picks.toLocaleString()} songs`}</button>`;
        else if (canBrowse) primary = `<button type="button" class="btn btn-sm btn-theme-primary" data-act="guide-start">${fill && counts.added + counts.missing + counts.failed > 0 ? `Continue in your browser (${left.toLocaleString()} left)` : 'Search in your browser'}</button>`;
        const secondary = running
            ? `<button type="button" class="btn btn-sm btn-theme-outline" data-act="stop" ${fill.run.stopping ? 'disabled' : ''}>${fill.run.stopping ? 'Stopping…' : 'Stop'}</button>`
            : [
                (picks > 0 && apiQueued > 0) ? '<button type="button" class="btn btn-sm btn-theme-outline" data-act="pick-all">Choose matches</button>' : '',
                (primary && !running && picks > 0 && apiQueued === 0 && canBrowse) ? '<button type="button" class="btn btn-sm btn-theme-outline" data-act="guide-start">Search in your browser</button>' : '',
                retryable > 0 && lanes?.api.length ? '<button type="button" class="btn btn-sm btn-theme-outline" data-act="retry-missing">Search not found again</button>' : '',
                '<button type="button" class="btn btn-sm btn-theme-outline" data-act="copy-manifest">Copy list</button>',
                '<button type="button" class="btn btn-sm btn-theme-outline" data-act="export-manifest">Export list</button>'
            ].join('');
        const done = counts ? counts.added + counts.pick + counts.missing + counts.failed : 0;
        const total = fill ? fill.songIds.length : 0;
        const current = running && fill.run.current ? scoped.find((s) => s.id === fill.run.current) || songs.find((s) => s.id === fill.run.current) : null;
        const item = current ? fill.run.items.get(current.id) : null;
        const progress = running ? `
          <div class="fill-progress" role="status">
            <div class="fill-progress-head">
              <span>${esc(`${plural(done, 'song', 'songs')} of ${total.toLocaleString()} done`)}</span>
              <span>${current ? esc(`${current.title}${item?.fraction != null ? ` · ${Math.round(item.fraction * 100)}%` : ''}`) : ''}</span>
            </div>
            <div class="job-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><div class="job-progress-fill" style="transform: scaleX(${total ? done / total : 0})"></div></div>
          </div>` : '';
        const runSummary = !running && counts && summaryText(counts) ? `<div class="be-stats-row" role="status">${esc(summaryText(counts))}</div>` : '';
        const error = fill?.run.error ? `<p class="ct-sub fill-error" role="alert">${esc(fill.run.error)}</p>` : '';
        return `
          ${progress}${runSummary}${error}
          <div class="be-actions">${primary}${secondary}</div>
          <div class="missingtabs-list" role="list" aria-label="Songs without tabs">
            ${scoped.map((song) => {
              const status = rowStatusText(song.id);
              const state = stateOf(song.id);
              return `
              <div class="missingtabs-row" role="listitem">
                <div class="missingtabs-info">
                  <span class="missingtabs-title">${esc(song.title)}</span>
                  <span class="missingtabs-sub">${esc(song.artist)}${song.album ? ` · ${esc(song.album)}` : ''}${status ? ` · ${esc(status)}` : ''}</span>
                </div>
                <div class="missingtabs-meta">
                  ${state === 'pick' && !running
                    ? `<button type="button" class="btn btn-sm btn-theme-outline" data-act="pick-song" data-song-id="${esc(song.id)}" aria-label="Choose a match for ${esc(song.artist)} – ${esc(song.title)}">Choose</button>`
                    : splitButton({ menu: song.id, songId: song.id, act: 'search-song', label: 'Search', ariaLabel: `Search for ${song.artist} – ${song.title}`, defaults: [getSources()[0]?.id], disabled: running })}
                </div>
              </div>`;
            }).join('')}
          </div>`;
    }

    function render() {
        if (!alive || !root.isConnected) return;
        if (!songs) { root.innerHTML = '<p class="ct-sub" role="status">Reading your library…</p>'; return; }
        // The walkthrough claims files only while it is waiting for one
        setGuideTarget(guide.songs && guide.waiting && guideSong() ? { accept: acceptFile } : null);
        const artists = [...new Set(songs.map((s) => s.artist))].sort(byText);
        if (view.artist && !artists.includes(view.artist)) view.artist = '';
        const scoped = inScope();
        const counts = new Map();
        songs.forEach((s) => counts.set(s.artist, (counts.get(s.artist) || 0) + 1));
        const stats = songs.length === 0
            ? 'Every song in your library has a tab.'
            : `${plural(songs.length, 'song', 'songs')} without a tab · ${plural(artists.length, 'artist', 'artists')}`;
        const apiNames = lanes?.api.map((s) => s.name).join(', ');
        const descText = lanes && lanes.api.length
            ? `Search all asks ${esc(apiNames)} for a tab of each song, one after another, and adds what it finds. For the rest, MajesticTab walks you through a search in your web browser.`
            : 'Search the web for a tab of each song that has none. MajesticTab opens a search in your web browser, one song at a time, and adds the tab file you open with it.';
        const inGuide = Boolean(guide.songs);
        root.innerHTML = `
          <p class="ct-sub">${descText}</p>
          <div class="be-stats-row" role="status">${esc(stats)}</div>
          ${!inGuide && songs.length && artists.length > 1 ? `
          <label class="be-option be-field">
            <span class="be-option-title">Artist</span>
            <select class="form-select form-select-sm" data-act="artist" aria-label="Artist" ${fill?.run.running ? 'disabled' : ''}>
              <option value="">All artists</option>
              ${artists.map((a) => `<option value="${esc(a)}" ${a === view.artist ? 'selected' : ''}>${esc(a)} (${counts.get(a)})</option>`).join('')}
            </select>
          </label>` : ''}
          ${inGuide ? renderGuide() : (scoped.length > 0 ? renderList(scoped) : (songs.length > 0 ? '<p class="ct-sub">No songs without tabs for this artist.</p>' : ''))}`;
    }

    async function load() {
        const list = await listMissingTabSongs();
        if (!alive) return;
        songs = list;
        publishCount(list.length);
        render();
        if (!lanes) {
            lanes = await splitSources();
            if (alive) render();
        }
        if (!restoreTried) {
            restoreTried = true;
            await restoreRun();
            if (alive) render();
        }
    }

    /** Picks up what an earlier session settled (a restart, or the OS closing the app), unless a run is already in memory. */
    async function restoreRun() {
        const saved = await loadFillState();
        if (!saved) return;
        notFound = new Set([...saved.notFound || [], ...notFound]);
        if (fill || !lanes?.api.length) return;
        const byId = new Map(songs.map((s) => [s.id, s]));
        // A song that has a tab now is added (or was deleted); a stub keeps the count honest. Anything else still missing stays itself.
        const runSongs = saved.songIds
            .map((id) => byId.get(id) || (saved.items[id]?.state === 'added' ? { id, title: '', artist: '' } : null))
            .filter(Boolean);
        if (!runSongs.length) return;
        const restored = { ...saved.items };
        for (const [id, item] of Object.entries(restored)) if (!byId.has(id) && item.state !== 'added') delete restored[id];
        const run = createFillRun({ songs: runSongs, sources: lanes.api, remembered: notFound, restored, fetchOne: fetchTabForSong, around: holdSync,
            attach: (file, song) => attachTabToSong(file, song, { quiet: true }), onChange: notify });
        fill = { run, songIds: runSongs.map((s) => s.id) };
    }

    // --- The automated lane ---

    async function searchAll({ retry = false, only = null } = {}) {
        if (!lanes?.api.length || fill?.run.running) return;
        // `only` is one provider chosen from the menu: every song not added is asked of it, whatever an earlier run found
        const scope = only ? inScope().filter((s) => stateOf(s.id) !== 'added') : inScope();
        const remembered = retry || only ? new Set() : new Set(notFound);
        // A run over this scope; tabs already added or parked from an earlier run in this session are kept
        const run = createFillRun({
            songs: scope,
            sources: only ? [only] : lanes.api,
            remembered,
            fetchOne: fetchTabForSong,
            attach: (file, song) => attachTabToSong(file, song, { quiet: true }),
            around: holdSync,
            onChange: notify
        });
        if (fill) for (const [id, item] of fill.run.items) if (run.items.has(id) && (only ? item.state === 'added' : ['added', 'pick'].includes(item.state))) Object.assign(run.items.get(id), item);
        fill = { run, songIds: scope.map((s) => s.id) };
        menuOpen = '';
        await run.start();
        // Remember what no provider had, so the next run skips it until it is asked again
        for (const [id, item] of run.items) {
            // Only a run of every provider says no provider has it
            if (item.state === 'missing' && !only) notFound.add(id);
            else if (item.state === 'added') notFound.delete(id);
        }
        if (run.counts().added) window.dispatchEvent(new CustomEvent('libraryDataChanged'));
        notify();
    }

    async function retryNotFound() {
        if (fill) for (const [id, item] of fill.run.items) if (item.state === 'missing') fill.run.requeue(id);
        for (const s of inScope()) notFound.delete(s.id);
        await searchAll({ retry: true });
    }

    async function pickMatches(only) {
        if (!fill) return;
        const { chooseMatch } = await import('../urlImport/chooseMatch.js');
        const parked = [...fill.run.items].filter(([id, item]) => item.state === 'pick' && (!only || id === only));
        for (const [id, item] of parked) {
            const song = songs.find((s) => s.id === id);
            const value = await chooseMatch({ ...item.choose, query: song ? `${song.artist} ${song.title}` : item.choose.query });
            if (value === null) { if (parked.length > 1) break; continue; }
            await holdSync(() => fill.run.resolvePick(id, value));
        }
        if (fill.run.counts().added) window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    }

    // --- The walkthrough ---

    function startGuide(sourceId = '') {
        const list = leftovers();
        if (!list.length || !lanes?.page.length) return;
        guide.songs = list;
        guide.index = 0;
        guide.waiting = false;
        guide.linking = false;
        guide.added = 0;
        guide.skipped = new Set();
        guide.sourceId = lanes.page.some((p) => p.id === sourceId) ? sourceId : lanes.page[0].id;
        render();
    }

    function leaveGuide() {
        guide.songs = null;
        guide.waiting = false;
        guide.linking = false;
        setGuideTarget(null);
        render();
        load();
    }

    function advance(step = 1) {
        guide.index = Math.min(Math.max(guide.index + step, 0), guide.songs.length);
        guide.waiting = false;
        guide.linking = false;
        render();
    }

    async function guideOpenSearch() {
        const song = guideSong();
        if (!song) return;
        guide.waiting = true;
        render();
        await openWebSearch({
            artist: song.artist,
            songName: song.title,
            query: `${song.artist} ${song.title}`.trim(),
            songId: song.id,
            targetSong: song,
            targetSourceId: guide.sourceId
        });
    }

    /** A tab file for the song the walkthrough is waiting for. Resolves true when it was added (the caller must not open it). */
    async function acceptFile(file) {
        const song = guideSong();
        if (!song || !guide.waiting) return false;
        const added = await attachTabToSong(file, song);
        if (!added) return false;
        guide.added++;
        if (fill?.run.items.has(song.id)) Object.assign(fill.run.items.get(song.id), { state: 'added', label: file.name, message: '', choose: null });
        advance();
        return true;
    }

    async function chooseFile() {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.gp,.gp3,.gp4,.gp5,.gpx,.pdf,.txt,.mpak';
        picker.addEventListener('change', () => { const f = picker.files?.[0]; if (f) acceptFile(f); }, { once: true });
        picker.click();
    }

    async function addFromLink(address) {
        const song = guideSong();
        const text = String(address || '').trim();
        if (!song || !text) return;
        await openTabFromUrl(text, { songId: song.id, targetSong: song, fetchOnly: true });
        // The address was added when the song now has a tab; the library tells us through the change event
        const fresh = (await getAllSongs().catch(() => [])).find((s) => s.id === song.id);
        if (fresh && hasTab(fresh)) {
            guide.added++;
            advance();
        }
    }

    root.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'menu') {
            const menu = e.target.closest('[data-act]').dataset.menu;
            menuOpen = menuOpen === menu ? '' : menu;
            render();
            root.querySelector('.fill-menu-item')?.focus();
            return;
        }
        if (act === 'menu-pick') {
            const { menu, sourceId, songId } = e.target.closest('[data-act]').dataset;
            menuOpen = '';
            const source = getSources().find((x) => x.id === sourceId);
            if (!source || !songs) { render(); return; }
            if (menu === 'all') {
                if (lanes?.api.some((x) => x.id === source.id)) searchAll({ only: source });
                else startGuide(source.id);
            } else {
                const song = songs.find((x) => x.id === songId);
                if (song) openWebSearch({ artist: song.artist, songName: song.title, query: `${song.artist} ${song.title}`.trim(), songId: song.id, targetSong: song, targetSourceId: source.id });
                render();
            }
            return;
        }
        if (menuOpen) { menuOpen = ''; render(); }
        if (act === 'search-all' && songs) { if (lanes?.api.length) searchAll(); else startGuide(); }
        else if (act === 'retry-missing' && songs) retryNotFound();
        else if (act === 'stop') fill?.run.stop();
        else if (act === 'pick-all' && songs) pickMatches();
        else if (act === 'pick-song') pickMatches(e.target.closest('[data-act]').dataset.songId);
        else if (act === 'guide-start' && songs) startGuide();
        else if (act === 'guide-open' || act === 'guide-reopen') guideOpenSearch();
        else if (act === 'guide-choose') chooseFile();
        else if (act === 'guide-link') { guide.linking = !guide.linking; render(); root.querySelector('[name="address"]')?.focus(); }
        else if (act === 'guide-skip') { const song = guideSong(); if (song) guide.skipped.add(song.id); advance(); }
        else if (act === 'guide-back') advance(-1);
        else if (act === 'guide-exit') leaveGuide();
        else if (act === 'copy-manifest' && songs) {
            const scoped = inScope();
            const json = JSON.stringify(serializeMissingSongs(scoped), null, 2);
            try {
                await navigator.clipboard.writeText(json);
                showToast(`Copied ${plural(scoped.length, 'song', 'songs')} to clipboard`, 'success');
            } catch {
                showToast('Could not copy to clipboard', 'error');
            }
        } else if (act === 'export-manifest' && songs) {
            const json = JSON.stringify(serializeMissingSongs(inScope()), null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'missing-tabs.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } else if (act === 'search-song' && songs) {
            const song = songs.find((s) => s.id === e.target.closest('[data-act]').dataset.songId);
            if (song) {
                openWebSearch({
                    artist: song.artist,
                    songName: song.title,
                    query: `${song.artist} ${song.title}`.trim(),
                    songId: song.id,
                    targetSong: song,
                });
            }
        }
    });
    root.addEventListener('submit', (e) => {
        if (e.target.dataset.act !== 'guide-link-form') return;
        e.preventDefault();
        addFromLink(new FormData(e.target).get('address'));
    });
    root.addEventListener('change', (e) => {
        if (e.target.dataset.act === 'artist') { view.artist = e.target.value; render(); }
        if (e.target.dataset.act === 'guide-source') { guide.sourceId = e.target.value; render(); }
    });
    // A tab saved in the browser (or added anywhere else) changes the list; while a run or the walkthrough is going the
    // list is held, so rows do not jump away under it
    const onData = () => { if (!fill?.run.running && !guide.songs) load(); };
    window.addEventListener('libraryDataChanged', onData);
    // Changes come in bursts (a progress tick, a song settling): one redraw per frame
    let frame = 0;
    const onRun = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
    listeners.add(onRun);
    // An open provider menu closes on a click elsewhere or Escape
    const onDocClick = (e) => { if (menuOpen && !e.target.closest?.('.fill-split')) { menuOpen = ''; render(); } };
    const onKey = (e) => { if (e.key === 'Escape' && menuOpen) { const caret = root.querySelector('.fill-split-caret[aria-expanded="true"]'); menuOpen = ''; render(); caret?.focus(); } };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);

    render();
    load();

    return () => {
        alive = false;
        listeners.delete(onRun);
        setGuideTarget(null);
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('libraryDataChanged', onData);
    };
}
