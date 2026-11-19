// storageUsage.js
// The storage diagram at the top of Settings, Data management: two bars, one for this device and one for cloud storage,
// drawn to the same scale, with one legend. One hue per kind (see agents/ui-principles.md). The device figures are read from the local stores at once. Cloud storage is listed over
// the network, so its figures are kept from the last time and "Refresh" lists it again.
import { USAGE_KINDS, emptyUsage, cloudUsageFromEntries, sumSizes, totalOf, barSegments } from './storageUsageCore.js';
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
