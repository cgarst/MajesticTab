// storage/orphans.js
// Finds and removes unused files in a pack-sync storage location (contract.js):
//   - unreferenced packs under packs/<id>/ (not listed in library.json)
//   - incomplete pack directories under packs/<id>/ (missing manifest.json)
//   - unreferenced SoundFonts under soundfonts/<id> (not listed in profile.json)
//   - leftover pre-upgrade snapshot files (blobs/ and manifests/) when the location has already been upgraded
import { readJsonIfExists, deletePackDir, pool } from './contract.js';
import { expectedFiles } from './packStore.js';
import { fromLibraryDoc, fromProfileDoc, LIBRARY_PATH, PROFILE_PATH } from './libraryDocs.js';
import { probeLocation, LOCATION } from './upgrade.js';

const UPGRADE_MARKER_NAME = 'manifest-UPGRADED.json';

const PACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DELETE_CONCURRENCY = 8;

function labelFromManifest(packId, manifest) {
    const title = manifest?.song?.title;
    const artist = manifest?.song?.artist;
    if (title && artist) return `${title} — ${artist}`;
    return title || packId;
}

/**
 * Scan a sync location for unused packs, SoundFonts, and pre-upgrade snapshot files.
 * Returns `{ state, items, totalBytes }` where `state` is from `LOCATION`.
 * When `state` is `NONE` or `LEGACY`, `items` is empty so an un-upgraded backup is never touched.
 */
export async function findRemoteOrphans({ store, legacy = null } = {}) {
    const probe = await probeLocation({ legacy, current: store });
    if (probe.state === LOCATION.NONE || probe.state === LOCATION.LEGACY) {
        return { state: probe.state, items: [], totalBytes: 0 };
    }

    const [libraryDoc, profileDoc, packEntries, sfEntries] = await Promise.all([
        readJsonIfExists(store, LIBRARY_PATH),
        readJsonIfExists(store, PROFILE_PATH),
        store.list('packs/'),
        store.list('soundfonts/'),
    ]);

    const items = [];

    // 1. Packs: group all files under packs/<packId>/
    const packGroups = new Map();
    for (const entry of packEntries) {
        const rest = entry.path.slice('packs/'.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const packId = rest.slice(0, slash);
        if (!PACK_ID_RE.test(packId)) continue;
        const rel = rest.slice(slash + 1);
        let group = packGroups.get(packId);
        if (!group) {
            group = { size: 0, fileCount: 0, hasManifest: false, files: [] };
            packGroups.set(packId, group);
        }
        group.size += entry.size || 0;
        group.fileCount += 1;
        group.files.push({ path: entry.path, rel, size: entry.size || 0 });
        if (rel === 'manifest.json') group.hasManifest = true;
    }

    let referencedPacks = null;
    if (libraryDoc) {
        const lib = fromLibraryDoc(libraryDoc);
        referencedPacks = new Set();
        for (const s of lib.songs || []) {
            if (!(s.tabOptions || []).length) continue;
            const id = s.packId || s.id;
            if (id) referencedPacks.add(id);
        }
    }

    const unreferencedWithManifest = [];
    const activeWithManifest = [];
    for (const [packId, info] of packGroups) {
        const countLabel = `${info.fileCount} ${info.fileCount === 1 ? 'file' : 'files'}`;
        if (!info.hasManifest) {
            items.push({
                kind: 'pack',
                id: packId,
                key: `pack:${packId}`,
                label: packId,
                detail: `Incomplete pack · ${countLabel}`,
                size: info.size,
            });
        } else if (referencedPacks && !referencedPacks.has(packId)) {
            unreferencedWithManifest.push({ packId, info, countLabel });
        } else {
            activeWithManifest.push({ packId, info });
        }
    }

    if (unreferencedWithManifest.length > 0) {
        await pool(unreferencedWithManifest, DELETE_CONCURRENCY, async ({ packId, info, countLabel }) => {
            const manifest = await readJsonIfExists(store, `packs/${packId}/manifest.json`).catch(() => null);
            items.push({
                kind: 'pack',
                id: packId,
                key: `pack:${packId}`,
                label: labelFromManifest(packId, manifest),
                detail: `Unused pack · ${countLabel}`,
                size: info.size,
            });
        });
    }

    if (activeWithManifest.length > 0) {
        await pool(activeWithManifest, DELETE_CONCURRENCY, async ({ packId, info }) => {
            const manifest = await readJsonIfExists(store, `packs/${packId}/manifest.json`).catch(() => null);
            if (!manifest) return;
            const expected = expectedFiles(manifest);
            const packLabel = labelFromManifest(packId, manifest);
            for (const f of info.files) {
                if (f.rel === 'manifest.json' || expected.has(f.rel)) continue;
                items.push({
                    kind: 'pack-file',
                    id: `${packId}/${f.rel}`,
                    key: `pack-file:${packId}/${f.rel}`,
                    label: f.rel,
                    detail: `Unused file in ${packLabel}`,
                    size: f.size,
                    path: f.path,
                });
            }
        });
    }

    // 2. SoundFonts: anything in soundfonts/ not listed in profile.json
    if (profileDoc) {
        const profile = fromProfileDoc(profileDoc);
        const referencedSoundFonts = new Set((profile.soundFonts || []).map((sf) => sf.id).filter(Boolean));
        for (const entry of sfEntries) {
            const id = entry.path.slice('soundfonts/'.length);
            if (!id || id.includes('/') || referencedSoundFonts.has(id)) continue;
            items.push({
                kind: 'soundfont',
                id,
                key: `soundfont:${id}`,
                label: id,
                detail: 'Unused SoundFont',
                size: entry.size || 0,
                path: entry.path,
            });
        }
    }

    // 3. Pre-upgrade legacy snapshots left behind after upgrading
    if (probe.state === LOCATION.BOTH && legacy) {
        const [blobs, manifests] = await Promise.all([legacy.listBlobs(), legacy.listManifests()]);
        if (blobs.length > 0 || manifests.length > 0) {
            const legacyBytes = blobs.reduce((sum, b) => sum + (b.size || 0), 0);
            items.push({
                kind: 'legacy',
                id: 'legacy-snapshots',
                key: 'legacy:snapshots',
                label: 'Unused application data',
                detail: `${blobs.length} ${blobs.length === 1 ? 'file' : 'files'}`,
                size: legacyBytes,
                blobs,
                manifests,
            });
        }
    }

    items.sort((a, b) => (b.size || 0) - (a.size || 0));
    const totalBytes = items.reduce((sum, it) => sum + (it.size || 0), 0);
    return { state: probe.state, items, totalBytes };
}

/**
 * Delete selected orphan items returned by `findRemoteOrphans`.
 */
export async function deleteRemoteOrphans({ store, legacy = null }, items = []) {
    for (const item of items) {
        if (item.kind === 'pack') {
            await deletePackDir(store, `packs/${item.id}`);
        } else if (item.kind === 'pack-file' || item.kind === 'soundfont') {
            await store.delete(item.path);
        } else if (item.kind === 'legacy' && legacy) {
            await pool(item.blobs || [], DELETE_CONCURRENCY, (b) => legacy.deleteBlob(b));
            await pool(item.manifests || [], DELETE_CONCURRENCY, (m) => legacy.deleteManifest(m));
        }
    }
}
