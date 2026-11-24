// storageUsage.js
// The storage diagram at the top of Settings, Data management: two bars, one for this device and one for cloud storage,
// drawn to the same scale, with one legend. One hue per kind (see agents/ui-principles.md). The device figures are read from the local stores at once. Cloud storage is listed over
// the network, so its figures are kept from the last time and "Refresh" lists it again.
import { USAGE_KINDS, emptyUsage, cloudUsageFromEntries, sumSizes, totalOf, barSegments, stemGroupsFromMeta, largestRows } from './storageUsageCore.js';
import { formatBytes } from '../backupRestore.js';

const CACHE_KEY = 'majestictab_cloud_usage';

const readCache = (target) => {
    try {
        const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        return c && c.target === target && c.bytes ? c : null;
    } catch { return null; }
};
const writeCache = (target, bytes) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ target, bytes, at: Date.now() })); } catch { /* storage unavailable */ }
};

// The localStorage entries "Clear cached data" removes (YouTube lookups and tab search results), two bytes per character
const CACHE_PREFIXES = ['yt_track_', 'yt_videos_', 'tab_downloader_'];
function localCacheBytes() {
    let chars = 0;
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && CACHE_PREFIXES.some((p) => k.startsWith(p))) chars += k.length + (localStorage.getItem(k) || '').length;
        }
    } catch { /* storage unavailable */ }
    return chars * 2;
}

/** What this device holds, by kind. */
export async function readDeviceUsage() {
    const [{ getAllStoredFiles }, { listAudioFiles }, { listSoundFonts }, { listClasstab }, { artCacheBytes }] = await Promise.all([
        import('../fileStore.js'), import('../audioSync/audioFileStore.js'), import('../soundFontStore.js'), import('../classtab/backup.js'), import('../musicbrainz.js'),
    ]);
    const [files, audio, fonts, classtab, art] = await Promise.all([getAllStoredFiles(), listAudioFiles(), listSoundFonts(), listClasstab(), artCacheBytes()]);
    return { ...emptyUsage(), tabs: sumSizes(files), audio: sumSizes(audio), fonts: sumSizes(fonts), classtab: sumSizes(classtab), cache: art + localCacheBytes() };
}

/** Every file on this device as one row, biggest first (the audio files of a stem set are one row). */
export async function readLargestFiles() {
    const [{ getAllStoredFiles }, { listAudioFiles }, { listSoundFonts }, { listClasstab }] = await Promise.all([
        import('../fileStore.js'), import('../audioSync/audioFileStore.js'), import('../soundFontStore.js'), import('../classtab/backup.js'),
    ]);
    const [tabFiles, audio, fonts, classtab] = await Promise.all([getAllStoredFiles(), listAudioFiles(), listSoundFonts(), listClasstab()]);
    // A tab belongs to the song that lists it, or to the album when it is an album's own tab; a file no song lists has no owner
    const owners = new Map();
    try {
        for (const song of await (await import('../libraryStore.js')).getAllSongs()) {
            const label = song.isAlbumTabContainer ? `Album: ${song.album || song.title}${song.artist ? ` · ${song.artist}` : ''}` : `${song.artist ? `${song.artist} - ` : ''}${song.title}`;
            for (const t of song.tabOptions || []) {
                if (!t?.fileStoreId) continue;
                const prev = owners.get(t.fileStoreId);
                owners.set(t.fileStoreId, prev && prev !== label ? `${prev}, ${label}` : label);
            }
        }
    } catch { /* the library is unavailable: rows show without an owner */ }
    const tabs = tabFiles.map((f) => ({ ...f, owner: owners.get(f.id) || 'Not in any song' }));
    const metas = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('rec_meta_')) metas.push({ song: decodeURIComponent(k.slice('rec_meta_'.length)), map: JSON.parse(localStorage.getItem(k) || '{}') });
        }
    } catch { /* storage unavailable or an unreadable entry */ }
    return largestRows({ tabs, audio, fonts, classtab }, stemGroupsFromMeta(metas));
}

/**
 * Deletes what a row stands for and updates the songs that listed it. A tab leaves every song that lists it (a song left
 * without a tab is handled as when a tab is removed anywhere else), audio leaves its songs as the player's Remove does, and
 * a sound font leaves the selection. The Classical tab archive is removed from its own section, not here.
 */
export async function deleteLargestRow(row) {
    if (row.kind === 'tabs') {
        const { getAllSongs, removeTabOptionFromSong, deleteOrphanedStoredFiles } = await import('../libraryStore.js');
        const ids = new Set(row.ids);
        for (const song of await getAllSongs()) {
            for (const t of song.tabOptions || []) {
                if (ids.has(t.fileStoreId)) await removeTabOptionFromSong(song.id, t.id);
            }
        }
        await deleteOrphanedStoredFiles(row.ids); // a file no song listed
    } else if (row.kind === 'audio') {
        const { removeStemCopy } = await import('../backupRestore.js');
        for (const id of row.ids) for (const song of row.songs.length ? row.songs : ['']) await removeStemCopy(song, id);
        window.dispatchEvent(new CustomEvent('library:refresh'));
    } else if (row.kind === 'fonts') {
        const { deleteSoundFont } = await import('../soundFontStore.js');
        for (const id of row.ids) await deleteSoundFont(id);
    }
}

export const canDeleteRow = (row) => row.kind !== 'classtab';

const PAGE = 50;

/** What cloud storage holds, by kind. Null when there is no location or it cannot be reached without asking. */
async function readCloudUsage() {
    const { getTarget, openSyncStore } = await import('../syncBackend.js');
    const target = getTarget();
    if (!target) return { target: null, bytes: null };
    const opened = await openSyncStore(target, { interactive: false });
    if (opened.status !== 'ready') return { target, bytes: null };
    const lists = await Promise.all(['packs/', 'soundfonts/', 'classtab/'].map((p) => opened.store.list(p)));
    const bytes = cloudUsageFromEntries(lists.flat());
    writeCache(target, bytes);
    return { target, bytes };
}

const node = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
};

function barBlock(title, usage, scale, readout, loading = false) {
    const block = node('div', 'stor-block');
    const head = node('div', 'stor-head');
    head.append(node('b', '', title), node('span', '', readout ?? (usage ? formatBytes(totalOf(usage)) : '')));
    block.appendChild(head);
    const track = node('div', 'stor-track');
    track.setAttribute('role', 'img');
    const segs = usage && !loading ? barSegments(usage, scale) : [];
    if (loading) {
        track.classList.add('is-loading');
        track.appendChild(node('i', 'stor-load'));
    }
    track.setAttribute('aria-label', loading ? `${title}: reading` : segs.length
        ? `${title}: ${segs.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join(', ')}`
        : `${title}: nothing stored`);
    for (const s of segs) {
        const seg = node('i', `stor-seg stor-k${s.index}`);
        seg.style.width = `${s.percent}%`;
        track.appendChild(seg);
    }
    block.appendChild(track);
    return block;
}

/** Builds the diagram and keeps it current. Returns the element to put at the top of the pane. */
export function createStorageDiagram() {
    const root = node('div', 'stor');
    root.setAttribute('aria-label', 'Storage');
    let seq = 0;
    let cloud = null;       // { target, bytes, at } as last shown
    let cloudBusy = false;
    let cloudNote = '';

    const draw = (device) => {
        const { bytes: cloudBytes } = cloud || {};
        const hasCloud = Boolean(cloud?.target);
        const scale = Math.max(totalOf(device), totalOf(cloudBytes));
        root.replaceChildren();
        root.appendChild(barBlock('This device', device, scale, deviceReady ? undefined : 'Reading…', !deviceReady));
        if (hasCloud) {
            const place = cloud.placeLabel;
            const readout = cloudBusy ? 'Checking…' : cloudBytes ? formatBytes(totalOf(cloudBytes)) : 'Not checked';
            const b = barBlock(place, cloudBytes, scale, readout, cloudBusy);
            root.appendChild(b);
            if (cloudNote || cloud.at) {
                const when = cloud.at ? `Checked ${new Date(cloud.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : '';
                root.appendChild(node('p', 'stor-note', [cloudNote, when].filter(Boolean).join(' ')));
            }
        }
        const legend = node('ul', 'stor-legend');
        for (const k of USAGE_KINDS) {
            const li = node('li');
            li.append(node('i', `stor-key stor-k${USAGE_KINDS.indexOf(k)}`), node('span', '', k.label));
            const total = (device?.[k.id] || 0) + (cloudBytes?.[k.id] || 0);
            if (total > 0) legend.appendChild(li);
        }
        // Legend on the left, one Refresh at the bottom right for both bars
        const foot = node('div', 'stor-foot');
        foot.appendChild(legend);
        const refreshBtn = node('button', 'stor-refresh', 'Refresh');
        refreshBtn.type = 'button';
        refreshBtn.disabled = cloudBusy || !deviceReady;
        refreshBtn.setAttribute('aria-label', 'Refresh storage');
        refreshBtn.addEventListener('click', () => refresh(true));
        foot.appendChild(refreshBtn);
        root.appendChild(foot);
        root.appendChild(largestBlock());
    };

    // The "Largest files" disclosure: a scrollable list of this device's files by size, shown a page at a time
    let largestOpen = false;
    let largest = null;     // rows, or null while reading
    let largestShown = PAGE;
    const loadLargest = async () => {
        const mine = ++largestSeq;
        try { const rows = await readLargestFiles(); if (mine === largestSeq) largest = rows; }
        catch (err) { console.warn('[Storage] Largest files failed', err); if (mine === largestSeq) largest = []; }
        if (mine === largestSeq) draw(lastDevice);
    };
    let largestSeq = 0;
    // Delete asks twice: the first press turns the button to "Confirm", which lapses after a few seconds
    let armedRow = null;
    let armTimer = null;
    const deleteButton = (r) => {
        const armed = armedRow === r;
        const b = node('button', `stor-refresh stor-del${armed ? ' is-armed' : ''}`, armed ? 'Confirm' : 'Delete');
        b.type = 'button';
        b.setAttribute('aria-label', `${armed ? 'Confirm delete' : 'Delete'} ${r.name}`);
        b.addEventListener('click', async () => {
            clearTimeout(armTimer);
            if (!armed) {
                armedRow = r;
                armTimer = setTimeout(() => { armedRow = null; draw(lastDevice); }, 4000);
                draw(lastDevice);
                return;
            }
            armedRow = null;
            b.disabled = true;
            try {
                await deleteLargestRow(r);
                largest = largest.filter((x) => x !== r);
            } catch (err) { console.warn('[Storage] Delete failed', err); cloudNote = 'That could not be deleted.'; }
            await refresh();
        });
        return b;
    };
    const largestBlock = () => {
        const wrap = node('div', 'stor-largest');
        const toggle = node('button', 'stor-more', largestOpen ? 'Hide largest files' : 'Show largest files');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(largestOpen));
        toggle.addEventListener('click', () => {
            largestOpen = !largestOpen;
            if (largestOpen) { largest = null; largestShown = PAGE; draw(lastDevice); loadLargest(); } else draw(lastDevice);
        });
        wrap.appendChild(toggle);
        if (!largestOpen) return wrap;
        if (!largest) { wrap.appendChild(node('p', 'stor-note', 'Reading…')); return wrap; }
        if (!largest.length) { wrap.appendChild(node('p', 'stor-note', 'No files on this device.')); return wrap; }
        const list = node('ol', 'stor-files');
        list.tabIndex = 0;
        list.setAttribute('aria-label', 'Files on this device by size');
        for (const r of largest.slice(0, largestShown)) {
            const li = node('li');
            const text = node('span', 'stor-file-text');
            text.append(node('span', 'stor-file-name', r.name));
            if (r.owner && r.owner !== r.name) text.appendChild(node('span', 'stor-file-owner', r.owner));
            li.append(node('i', `stor-key stor-k${r.index}`), text, node('span', 'stor-file-size', formatBytes(r.bytes)));
            if (canDeleteRow(r)) li.appendChild(deleteButton(r));
            list.appendChild(li);
        }
        if (largest.length > largestShown) {
            const li = node('li', 'stor-files-more');
            const more = node('button', 'stor-refresh', `Show ${Math.min(PAGE, largest.length - largestShown)} more of ${largest.length - largestShown}`);
            more.type = 'button';
            more.addEventListener('click', () => {
                const top = list.scrollTop;
                largestShown += PAGE; draw(lastDevice);
                const again = root.querySelector('.stor-files'); if (again) again.scrollTop = top;
            });
            li.appendChild(more);
            list.appendChild(li);
        }
        wrap.appendChild(list);
        return wrap;
    };

    let lastDevice = emptyUsage();
    let deviceReady = false;
    const loadCloud = async (force) => {
        const { getTarget, targetLabel } = await import('../syncBackend.js');
        const target = getTarget();
        if (!target) { cloud = null; draw(lastDevice); return; }
        const short = { 'Google Drive': 'Google Drive', 'iCloud Drive': 'iCloud Drive' };
        const placeLabel = short[targetLabel(target)] || targetLabel(target).replace(/^your /, '').replace(/^./, (c) => c.toUpperCase());
        const cached = readCache(target);
        cloud = { target, placeLabel, bytes: cached?.bytes || null, at: cached?.at || 0 };
        if (cached && !force) { draw(lastDevice); return; }
        const mine = ++seq;
        cloudBusy = true; cloudNote = '';
        draw(lastDevice);
        try {
            const res = await readCloudUsage();
            if (mine !== seq) return;
            if (res.bytes) cloud = { ...cloud, bytes: res.bytes, at: Date.now() };
            else cloudNote = 'Cloud storage could not be reached.';
        } catch (err) {
            if (mine !== seq) return;
            console.warn('[Storage] Cloud usage failed', err);
            cloudNote = 'Cloud storage could not be reached.';
        } finally {
            if (mine === seq) { cloudBusy = false; draw(lastDevice); }
        }
    };

    const refresh = async (force = false) => {
        if (force) { deviceReady = false; draw(lastDevice); }
        try { lastDevice = await readDeviceUsage(); } catch (err) { console.warn('[Storage] Device usage failed', err); }
        deviceReady = true;
        draw(lastDevice);
        if (largestOpen) loadLargest();
        await loadCloud(force);
    };

    // Reflect changes: a sync or an eviction moves bytes between the two bars
    let refreshTimer = null;
    const soon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (root.isConnected) refresh(); }, 400); };
    for (const ev of ['library:refresh', 'sync:hybridChanged']) window.addEventListener(ev, soon);
    // Cloud storage is listed again only when a sync has just finished (not on every state change)
    let wasSyncing = false;
    window.addEventListener('autoSyncStateChanged', (e) => {
        const status = e.detail?.status;
        if (wasSyncing && status === 'idle' && root.isConnected && !root.closest('[hidden]')) loadCloud(true);
        wasSyncing = status === 'syncing';
    });
    root.refresh = refresh;
    draw(lastDevice);
    refresh();
    return root;
}
