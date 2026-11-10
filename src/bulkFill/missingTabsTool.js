// missingTabsTool.js
// Fill in missing tabs, a page in Tools: walks the web search (the tab downloader's batch mode) through every library
// song that has no tab, one search per song, in artist, album and track order. Saving a tab in the browser moves to the
// next song; Skip leaves one for later. Native apps only: the web build has no downloader browser.

import { getAllSongs } from '../libraryStore.js';
import { isNative, openTabDownloader } from '../tabDownloader.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hasTab = (s) => Array.isArray(s.tabOptions) && s.tabOptions.length > 0;
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const byText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });

const view = { artist: '' }; // '' is every artist
let missingCount = null;

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

export function renderMissingTabsTool(container) {
    let alive = true;
    let songs = null; // null while reading
    const root = document.createElement('div');
    root.className = 'be-root';
    container.appendChild(root);

    const inScope = () => (view.artist ? songs.filter((s) => s.artist === view.artist) : songs);

    function render() {
        if (!alive || !root.isConnected) return;
        if (!songs) { root.innerHTML = '<p class="ct-sub" role="status">Reading your library…</p>'; return; }
        const native = isNative();
        const artists = [...new Set(songs.map((s) => s.artist))].sort(byText);
        if (view.artist && !artists.includes(view.artist)) view.artist = '';
        const scoped = inScope();
        const counts = new Map();
        songs.forEach((s) => counts.set(s.artist, (counts.get(s.artist) || 0) + 1));
        const stats = songs.length === 0
            ? 'Every song in your library has a tab.'
            : `${plural(songs.length, 'song', 'songs')} without a tab · ${plural(artists.length, 'artist', 'artists')}`;
        root.innerHTML = `
          <p class="ct-sub">Search the web for a tab of each song that has none, one song at a time. When a tab is saved the next song’s search opens. Skip a song to come back to it later.</p>
          <div class="be-stats-row" role="status">${esc(stats)}</div>
          ${songs.length && artists.length > 1 ? `
          <label class="be-option be-field">
            <span class="be-option-title">Artist</span>
            <select class="form-select form-select-sm" data-act="artist" aria-label="Artist">
              <option value="">All artists</option>
              ${artists.map((a) => `<option value="${esc(a)}" ${a === view.artist ? 'selected' : ''}>${esc(a)} (${counts.get(a)})</option>`).join('')}
            </select>
          </label>` : ''}
          ${native ? '' : '<p class="ct-note">Searching the web for tabs works in the MajesticTab apps for Windows, macOS, Linux, Android and iOS. On the web, add tabs to a song one at a time.</p>'}
          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="start" ${native && scoped.length ? '' : 'disabled'}>
              ${scoped.length ? `Start with ${plural(scoped.length, 'song', 'songs')}` : 'Start'}
            </button>
          </div>`;
    }

    async function load() {
        const list = await listMissingTabSongs();
        if (!alive) return;
        songs = list;
        publishCount(list.length);
        render();
    }

    async function start() {
        const scoped = inScope();
        if (!scoped.length) return;
        const queue = scoped.map((s, i) => ({
            trackNumber: s.trackNumber || (i + 1),
            title: s.title,
            artist: s.artist,
            songId: s.id,
            acquired: false,
            alreadyInLibrary: false,
            fileName: null
        }));
        await openTabDownloader({ batchMode: true, batchLabel: view.artist || 'Missing tabs', queue, currentIndex: 0 });
    }

    root.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="start"]')) start();
    });
    root.addEventListener('change', (e) => {
        if (e.target.dataset.act === 'artist') { view.artist = e.target.value; render(); }
    });
    // A tab saved in the browser (or added anywhere else) changes the list
    const onData = () => { load(); };
    window.addEventListener('libraryDataChanged', onData);

    render();
    load();

    return () => {
        alive = false;
        window.removeEventListener('libraryDataChanged', onData);
        };
}
