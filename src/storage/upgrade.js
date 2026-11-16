// storage/upgrade.js
// Telling what a storage location holds, and moving one from the old layout (blobs/ + manifests/ snapshots, see
// incrementalBackup.js) to the new one (packs, library.json, profile.json, store.json).
//
// The upgrade does not read the old layout itself. It runs the existing sync with the old location one last time, so this
// device holds everything the snapshot holds, then writes the new layout from this device's own library. Nothing in the old
// layout is changed or removed.
import { readStoreInfo, writeStoreInfo } from './storeInfo.js';
import { createPackStore } from './packStore.js';
import { toLibraryDoc, toProfileDoc, LIBRARY_PATH, PROFILE_PATH } from './libraryDocs.js';
import { writeJson } from './contract.js';

export const LOCATION = Object.freeze({
    NONE: 'none',        // nothing of ours here
    LEGACY: 'legacy',    // only the old layout
    CURRENT: 'current',  // only the new layout
    BOTH: 'both',        // both: upgraded already, the old one still there
});

export class UpgradeError extends Error {
    constructor(message, problems = []) { super(message); this.problems = problems; }
}

/**
 * What a location holds. Both arguments are views of the same location: `legacy` is the old-layout backend
 * ({ open, listManifests, listBlobs }), `current` is a contract store rooted at the new layout (or null where
 * a backend cannot offer one). Reads only. Throws StoreTooNewError when the new layout is from a newer app.
 * `partial` is set on LEGACY when an earlier upgrade left packs behind without finishing (no store.json).
 */
export async function probeLocation({ legacy, current }) {
    let isCurrent = false, partial = false;
    if (current && await current.open({ create: false })) {
        isCurrent = Boolean(await readStoreInfo(current));
        partial = !isCurrent && (await current.list('packs/')).length > 0;
    }
    let isLegacy = false;
    if (legacy && await legacy.open({ create: false })) {
        isLegacy = (await legacy.listManifests()).length > 0 || (await legacy.listBlobs()).length > 0;
    }
    const state = isCurrent ? (isLegacy ? LOCATION.BOTH : LOCATION.CURRENT) : (isLegacy ? LOCATION.LEGACY : LOCATION.NONE);
    return { state, partial };
}

/** Whether to offer the upgrade: the location has the old layout and no finished new one. */
export const needsUpgrade = (probe) => probe.state === LOCATION.LEGACY;

/**
 * Moves a location to the new layout.
 * @param legacy, current  as for probeLocation
 * @param syncWithLegacy   async () => void   the last two-way sync with the old layout
 * @param exportToStore    async (store, onProgress) => { packIds: string[], records, settings, soundFonts }
 *                         writes this device's packs (and soundfont/classtab blobs) into `store` and returns the library records,
 *                         settings and soundfont list for the two documents
 * @returns {{ state: 'upgraded'|'already-upgraded', packs?: number }}
 * Order: sync, packs, library.json, profile.json, verify, store.json last. A failure before store.json leaves a location that
 * still probes as legacy (partial), and running the upgrade again resumes: files already in place are not written twice.
 */
export async function upgradeLocation({ legacy, current, syncWithLegacy, exportToStore, appVersion = '', onStatus = () => {} }) {
    const before = await probeLocation({ legacy, current });
    if (before.state === LOCATION.CURRENT || before.state === LOCATION.BOTH) return { state: 'already-upgraded' };
    if (before.state === LOCATION.NONE) throw new UpgradeError('There is no earlier backup at this location to upgrade.');

    onStatus('Syncing with the existing backup');
    await syncWithLegacy();

    await current.open({ create: true });
    onStatus('Writing songs');
    const out = await exportToStore(current, (info) => onStatus('Writing songs', info));
    const { packIds, records, settings, soundFonts } = out;

    onStatus('Writing the library');
    await writeJson(current, LIBRARY_PATH, toLibraryDoc(records));
    await writeJson(current, PROFILE_PATH, toProfileDoc({ settings, soundFonts }));

    onStatus('Checking');
    const problems = await verifyStore(current, { packIds, songs: records.songs || [] });
    if (problems.length) throw new UpgradeError(`The new copy did not check out (${problems.length} problem${problems.length === 1 ? '' : 's'}). The existing backup was not changed.`, problems);

    if (!(await writeStoreInfo(current, { appVersion }))) return { state: 'already-upgraded' };
    return { state: 'upgraded', packs: packIds.length };
}

/**
 * Compares what is in the store with what the upgrade meant to write. Returns a list of problems, empty when it is right.
 * Every pack must open without warnings; every song must have its pack (a song with no tab has none by design: `noPack`).
 */
export async function verifyStore(store, { packIds, songs = [] }) {
    const problems = [];
    const packs = createPackStore(store);
    const listed = new Set((await packs.listPacks()).map((p) => p.packId));
    for (const id of packIds) {
        if (!listed.has(id)) { problems.push(`${id}: pack is not in the store`); continue; }
        try { for (const w of (await packs.open(id)).warnings) problems.push(`${id}: ${w}`); } catch (e) { problems.push(`${id}: ${e.message}`); }
    }
    const have = new Set(packIds);
    for (const s of songs) {
        if (s.noPack || !(s.tabOptions || []).length) continue;
        if (!have.has(s.packId || s.id)) problems.push(`${s.title || s.id}: no pack was written for this song`);
    }
    return problems;
}
