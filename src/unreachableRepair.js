// unreachableRepair.js
// Settings > Library > Upkeep > Missing files: restores the tabs whose score the cloud pack no longer lists.
// A pack rebuilt by a device that did not hold every score drops those scores from manifest.json but leaves their files in
// the pack's score/ folder. This finds each such file there (the file name first, then every file of the folder), checks its
// SHA-256 against the tab's, and puts it back in this device's file store under the tab's existing entry. The next sync
// then writes a pack that lists it again. Nothing in the store is changed or removed.
import { sha256 } from './mpak/core/index.js';

const baseName = (path) => path.split('/').pop();
const mimeOf = (name) => (/\.pdf$/i.test(name) ? 'application/pdf' : /\.(txt|md)$/i.test(name) ? 'text/plain' : 'application/octet-stream');

/**
 * The files of a pack's score/ folder in the order worth reading for a tab: the file with the tab's name, then one a pack
 * renamed to avoid a clash ("<id>-<name>"), then the rest. `files` are `{ path }` entries.
 */
export function orderCandidates(tab, files) {
    const want = tab?.relativePath || tab?.name || '';
    const rank = (f) => (baseName(f.path) === want ? 0 : baseName(f.path).endsWith(`-${want}`) ? 1 : 2);
    return [...files].sort((a, b) => rank(a) - rank(b));
}

/**
 * Looks for the file of every tab in `groups` (findUnreachableTabs results) in the pack's score/ folder of `store`.
 * Resolves to { found: [{ song, tab, path, bytes }], notFound: [{ song, tab }] }. Only a file whose hash is the tab's counts.
 */
export async function findTabFiles(store, groups, { packIdOf, onProgress = () => {} } = {}) {
    const found = [], notFound = [];
    const total = groups.reduce((n, g) => n + g.tabs.length, 0);
    let done = 0;
    for (const g of groups) {
        const pid = packIdOf(g.song);
        let files = [];
        try { files = (await store.list(`packs/${pid}/score/`)).filter((e) => e.path.startsWith(`packs/${pid}/score/`)); } catch (err) { console.warn('[repair] could not list', pid, err); }
        const read = new Map();   // path -> { hash, bytes }, so a pack's files are read once for all its tabs
        for (const tab of g.tabs) {
            let hit = null;
            for (const f of orderCandidates(tab, files)) {
                if (!read.has(f.path)) {
                    try { const bytes = await store.read(f.path); read.set(f.path, { bytes, hash: await sha256(bytes) }); } catch (err) { read.set(f.path, null); console.warn('[repair] could not read', f.path, err); }
                }
                const r = read.get(f.path);
                if (r && r.hash === tab.sha256) { hit = { path: f.path, bytes: r.bytes }; break; }
            }
            if (hit) found.push({ song: g.song, tab, ...hit }); else notFound.push({ song: g.song, tab });
            onProgress({ current: ++done, total });
        }
    }
    return { found, notFound };
}

/**
 * Puts each found file in this device's file store under its tab's entry.
 * @param saveFile  (file, providerId, metadata) => Promise<{ id }>      (fileStore.saveStoredFile)
 * @param linkTab   (songId, tabId, { fileStoreId }) => Promise          (libraryStore.updateTabOptionOnSong)
 * Resolves to { restored, failed: [{ song, tab, reason }] }. A tab that fails is left as it was.
 */
export async function restoreTabFiles(found, { saveFile, linkTab, onProgress = () => {} }) {
    let restored = 0;
    const failed = [];
    for (const { song, tab, path, bytes } of found) {
        try {
            const name = tab.relativePath ? baseName(tab.relativePath) : baseName(path);
            const type = mimeOf(name);
            const file = new File([bytes], name, { type });
            const stored = await saveFile(file, tab.providerId || 'local', {
                name, type, relativePath: tab.relativePath || name, songId: song.id,
                sourceUrl: tab.sourceUrl || null, sourceWebsite: tab.sourceWebsite || null,
            });
            await linkTab(song.id, tab.id, { fileStoreId: stored.id });
            restored++;
        } catch (err) {
            failed.push({ song, tab, reason: err?.message || String(err) });
        }
        onProgress({ current: restored + failed.length, total: found.length });
    }
    return { restored, failed };
}
