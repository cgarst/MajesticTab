// missingTabsTool.js
// Fill in missing tabs, a page in Tools: walks the web search (the tab downloader's batch mode) through every library
// song that has no tab, one search per song, in artist, album and track order. Saving a tab in the browser moves to the
// next song; Skip leaves one for later. Native apps only: the web build has no downloader browser.

import { getAllSongs } from '../libraryStore.js';
import { getSources, isNative, openTabDownloader } from '../tabDownloader.js';
import { saveMtabToLibrary } from '../mtab.js';
import { showToast } from '../utils/toast.js';
import { hasFeature } from '../channel.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hasTab = (s) => Array.isArray(s.tabOptions) && s.tabOptions.length > 0;
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const byText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });

const view = { artist: '' }; // '' is every artist
let missingCount = null;
const MAX_URL_BATCH_SONGS = 30;
const batchListeners = new Set();

const batchState = {
    running: false,
    origin: null,
    batchId: null,
    uiUrl: null,
    items: new Map(), // songId -> { stage, confidence, error, mtabUrl }
    importedIds: new Set(),
    importingIds: new Set(),
    timer: null,
    error: null
};

function notifyBatch() {
    for (const fn of batchListeners) {
        try { fn(); } catch {}
    }
}

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

export function encodeBatchPayload(songs) {
    const json = JSON.stringify(serializeMissingSongs(songs));
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function findCompanionOrigin(sources = getSources()) {
    for (const s of sources || []) {
        const tpl = (s?.urlTemplate || '').trim();
        if (!tpl || s.isSeed) continue;
        try {
            const u = new URL(tpl.replace('$s', 'test').replace('{search}', 'test'));
            if (/\/search$/i.test(u.pathname) && u.searchParams.has('q')) {
                return u.origin;
            }
        } catch {}
    }
    return null;
}

async function httpFetch(url, options) {
    if (typeof window !== 'undefined' && window.__TAURI__?.http?.fetch) {
        return window.__TAURI__.http.fetch(url, options);
    }
    return fetch(url, options);
}

function stopBatchPolling() {
    if (batchState.timer) {
        clearTimeout(batchState.timer);
        batchState.timer = null;
    }
    batchState.running = false;
}

async function pollBatchOnce() {
    if (!batchState.running || !batchState.origin || !batchState.batchId) return;
    try {
        const res = await httpFetch(`${batchState.origin}/api/batch/${encodeURIComponent(batchState.batchId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        let pendingCount = 0;
        for (const item of items) {
            if (!item?.songId) continue;
            batchState.items.set(item.songId, item);
            const stage = item.stage || item.status;
            if (stage !== 'done' && stage !== 'error' && stage !== 'missing') {
                pendingCount++;
            }
            if (stage === 'done' && item.mtabUrl && !batchState.importedIds.has(item.songId) && !batchState.importingIds.has(item.songId)) {
                batchState.importingIds.add(item.songId);
                const mtabUrl = /^https?:\/\//i.test(item.mtabUrl)
                    ? item.mtabUrl
                    : `${batchState.origin}${item.mtabUrl.startsWith('/') ? '' : '/'}${item.mtabUrl}`;
                httpFetch(mtabUrl)
                    .then(async (r) => {
                        if (!r.ok) throw new Error(`HTTP ${r.status}`);
                        const buf = await r.arrayBuffer();
                        const name = item.fileName || `${item.artist || 'Song'} - ${item.title || item.songId}.mtab`;
                        const file = new File([buf], name, { type: 'application/x-majestictab-song' });
                        await saveMtabToLibrary(file, { targetSongId: item.songId, queryMusicBrainz: false });
                        batchState.importedIds.add(item.songId);
                        batchState.importingIds.delete(item.songId);
                        if (typeof window !== 'undefined') {
                            window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                        }
                        notifyBatch();
                    })
                    .catch((e) => {
                        batchState.importingIds.delete(item.songId);
                        batchState.items.set(item.songId, { ...item, stage: 'error', error: e?.message || 'Import failed' });
                        notifyBatch();
                    });
            }
        }
        notifyBatch();
        if (pendingCount === 0 && batchState.importingIds.size === 0) {
            stopBatchPolling();
            notifyBatch();
            return;
        }
    } catch (err) {
        batchState.error = err?.message || 'Batch sync failed';
        notifyBatch();
    }
    if (batchState.running) {
        batchState.timer = setTimeout(pollBatchOnce, 2000);
    }
}

async function startCompanionBatch(origin, songs) {
    stopBatchPolling();
    batchState.origin = origin;
    batchState.batchId = null;
    batchState.uiUrl = null;
    batchState.items.clear();
    batchState.importedIds.clear();
    batchState.importingIds.clear();
    batchState.error = null;
    batchState.running = true;
    notifyBatch();

    try {
        const res = await httpFetch(`${origin}/api/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ songs: serializeMissingSongs(songs) })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        batchState.batchId = data.batchId;
        batchState.uiUrl = data.uiUrl
            ? (/^https?:\/\//i.test(data.uiUrl) ? data.uiUrl : `${origin}${data.uiUrl.startsWith('/') ? '' : '/'}${data.uiUrl}`)
            : `${origin}/batch/${encodeURIComponent(data.batchId)}`;
        notifyBatch();
        pollBatchOnce();
    } catch (err) {
        stopBatchPolling();
        batchState.error = err?.message || 'Could not start batch';
        showToast(batchState.error, 'error');
        notifyBatch();
    }
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
        const isSystemBrowser = !hasFeature('inAppBrowser')
            || (typeof localStorage !== 'undefined' && localStorage.getItem('majestictab_web_search_browser') === 'system');
        const inApp = !isSystemBrowser;
        const companionOrigin = findCompanionOrigin();
        const descText = inApp
            ? 'Search the web for a tab of each song that has none, one song at a time. When a tab is saved the next song’s search opens. Skip a song to come back to it later.'
            : 'Search the web for a tab of each song that has none. Open a search in your web browser, download the tab file, and open it in MajesticTab.';
        const bulkButtons = scoped.length > 0 ? `
            ${companionOrigin ? `
              <button type="button" class="btn btn-sm btn-theme-primary" data-act="companion-batch" ${batchState.running ? 'disabled' : ''}>
                ${batchState.running ? 'Syncing batch…' : `Sync ${plural(scoped.length, 'song', 'songs')}`}
              </button>` : ''}
            ${companionOrigin && isSystemBrowser && scoped.length <= MAX_URL_BATCH_SONGS ? `
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="open-batch-browser">Open batch in browser</button>` : ''}
            ${batchState.uiUrl ? `
              <button type="button" class="btn btn-sm btn-theme-outline" data-act="open-batch-ui">Open batch queue</button>` : ''}
            <button type="button" class="btn btn-sm btn-theme-outline" data-act="copy-manifest">Copy list</button>
            <button type="button" class="btn btn-sm btn-theme-outline" data-act="export-manifest">Export list</button>
        ` : '';
        const rowStatusText = (songId) => {
            if (batchState.importedIds.has(songId)) return 'Added';
            const item = batchState.items.get(songId);
            if (!item) return '';
            const stage = item.stage || item.status;
            if (stage === 'error') return item.error || 'Failed';
            if (stage === 'missing') return 'Not found';
            if (stage === 'review') return 'Needs review';
            if (stage === 'done') return 'Importing…';
            if (stage === 'downloading') return 'Downloading audio…';
            if (stage === 'resolving' || stage === 'queued') return 'Waiting…';
            return stage || '';
        };
        const actionContent = inApp ? `
          <div class="be-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="start" ${native && scoped.length ? '' : 'disabled'}>
              ${scoped.length ? `Start with ${plural(scoped.length, 'song', 'songs')}` : 'Start'}
            </button>
            ${bulkButtons}
          </div>` : (scoped.length > 0 ? `
          <div class="be-actions">${bulkButtons}</div>
          <div class="missingtabs-list" role="list" aria-label="Songs without tabs">
            ${scoped.map((song) => {
              const status = rowStatusText(song.id);
              return `
              <div class="missingtabs-row" role="listitem">
                <div class="missingtabs-info">
                  <span class="missingtabs-title">${esc(song.title)}</span>
                  <span class="missingtabs-sub">${esc(song.artist)}${song.album ? ` · ${esc(song.album)}` : ''}${status ? ` · ${esc(status)}` : ''}</span>
                </div>
                <div class="missingtabs-meta">
                  <button type="button" class="btn btn-sm btn-theme-outline"
                          data-act="search-song" data-song-id="${esc(song.id)}"
                          aria-label="Search web for ${esc(song.artist)} – ${esc(song.title)}">Search</button>
                </div>
              </div>`;
            }).join('')}
          </div>` : (songs.length > 0 ? '<p class="ct-sub">No songs without tabs for this artist.</p>' : ''));
        root.innerHTML = `
          <p class="ct-sub">${descText}</p>
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
          ${actionContent}`;
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

    async function openExternalUrl(url) {
        const opener = window.__TAURI__?.opener;
        if (opener?.openUrl) {
            await opener.openUrl(url);
        } else {
            window.open(url, '_blank', 'noopener');
        }
    }

    root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-act="start"]')) start();
        if (e.target.closest('[data-act="companion-batch"]') && songs) {
            const origin = findCompanionOrigin();
            const scoped = inScope();
            if (origin && scoped.length) startCompanionBatch(origin, scoped);
        }
        if (e.target.closest('[data-act="open-batch-browser"]') && songs) {
            const origin = findCompanionOrigin();
            const scoped = inScope();
            if (origin && scoped.length) {
                await openExternalUrl(`${origin}/batch?batch=${encodeBatchPayload(scoped)}`);
            }
        }
        if (e.target.closest('[data-act="open-batch-ui"]') && batchState.uiUrl) {
            await openExternalUrl(batchState.uiUrl);
        }
        if (e.target.closest('[data-act="copy-manifest"]') && songs) {
            const scoped = inScope();
            const json = JSON.stringify(serializeMissingSongs(scoped), null, 2);
            try {
                await navigator.clipboard.writeText(json);
                showToast(`Copied ${plural(scoped.length, 'song', 'songs')} to clipboard`, 'success');
            } catch {
                showToast('Could not copy to clipboard', 'error');
            }
        }
        if (e.target.closest('[data-act="export-manifest"]') && songs) {
            const scoped = inScope();
            const json = JSON.stringify(serializeMissingSongs(scoped), null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'missing-tabs.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        const searchBtn = e.target.closest('[data-act="search-song"]');
        if (searchBtn && songs) {
            const song = songs.find((s) => s.id === searchBtn.dataset.songId);
            if (song) {
                openTabDownloader({
                    artist: song.artist,
                    songName: song.title,
                    query: `${song.artist} ${song.title}`.trim(),
                    songId: song.id,
                    targetSong: song,
                });
            }
        }
    });
    root.addEventListener('change', (e) => {
        if (e.target.dataset.act === 'artist') { view.artist = e.target.value; render(); }
    });
    // A tab saved in the browser (or added anywhere else) changes the list
    const onData = () => { load(); };
    window.addEventListener('libraryDataChanged', onData);
    const onBrowserPrefChange = () => { render(); };
    window.addEventListener('storage', onBrowserPrefChange);
    window.addEventListener('majestictab-web-search-browser-changed', onBrowserPrefChange);
    const onBatchUpdate = () => { render(); };
    batchListeners.add(onBatchUpdate);

    render();
    load();

    return () => {
        alive = false;
        batchListeners.delete(onBatchUpdate);
        window.removeEventListener('libraryDataChanged', onData);
        window.removeEventListener('storage', onBrowserPrefChange);
        window.removeEventListener('majestictab-web-search-browser-changed', onBrowserPrefChange);
    };
}
