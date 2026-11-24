// storage/orphans.js
// Finds and removes unused files in a pack-sync storage location (contract.js):
//   - unreferenced packs under packs/<id>/ (not listed in library.json)
//   - incomplete pack directories under packs/<id>/ (missing manifest.json)
//   - dangling file references in active pack manifests (missing from packs/<id>/)
//   - unreferenced SoundFonts under soundfonts/<id> (not listed in profile.json)
//   - leftover pre-upgrade snapshot files (blobs/ and manifests/) when the location has already been upgraded
import { readJsonIfExists, writeJson, deletePackDir, pool } from './contract.js';
import { expectedFiles } from './packStore.js';
import { stemsOf, recordingSources } from '../mpak/stemLayer.js';
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
            const present = new Set(info.files.map((f) => f.rel));
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
            for (const rel of expected.keys()) {
                if (present.has(rel)) continue;
                items.push({
                    kind: 'manifest-ref',
                    packId,
                    rel,
                    id: `${packId}/${rel}`,
                    key: `manifest-ref:${packId}/${rel}`,
                    label: rel,
                    detail: `Missing file referenced in ${packLabel}`,
                    size: 0,
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

export function pruneManifestRefs(manifest, missing) {
    if (manifest.entries) {
        for (const rel of missing) delete manifest.entries[rel];
    }
    if (Array.isArray(manifest.scores)) {
        manifest.scores = manifest.scores
            .filter((sc) => !(sc?.path && missing.has(sc.path)))
            .map((sc) => {
                if (!Array.isArray(sc.alternates)) return sc;
                const alts = sc.alternates.filter((a) => !(a?.path && missing.has(a.path)));
                return alts.length ? { ...sc, alternates: alts } : (({ alternates: _, ...rest }) => rest)(sc);
            });
    }
    const scoreIds = new Set((manifest.scores || []).map((s) => s.id));
    if (Array.isArray(manifest.recordings)) {
        manifest.recordings = manifest.recordings
            .map((rec) => {
                const sources = (rec.sources || []).filter((s) => !(s.type === 'file' && s.path && missing.has(s.path)));
                // the stems of a recording (SPEC section 8) whose audio is gone leave the stem layer
                const stems = stemsOf(rec)
                    .map((st) => ({ ...st, sources: (st.sources || []).filter((s) => !(s.type === 'file' && s.path && missing.has(s.path))) }))
                    .filter((st) => st.sources.length);
                if (!sources.length && !stems.length) return null;
                const next = { ...rec, sources };
                if (Array.isArray(rec.stems)) {
                    if (stems.length) next.stems = stems; else { delete next.stems; delete next.stemsComplete; }
                    if (stems.length !== rec.stems.length) delete next.stemsComplete; // the parts that are left no longer add up to the mix
                }
                if (next.beats && missing.has(next.beats)) delete next.beats;
                if (next.sync) {
                    const kept = Object.fromEntries(Object.entries(next.sync).filter(([sid, p]) => scoreIds.has(sid) && !missing.has(p)));
                    if (Object.keys(kept).length) next.sync = kept; else delete next.sync;
                }
                if (next.scoreTracks) {
                    const kept = Object.fromEntries(Object.entries(next.scoreTracks).filter(([sid]) => scoreIds.has(sid)));
                    if (Object.keys(kept).length) next.scoreTracks = kept; else delete next.scoreTracks;
                }
                return next;
            })
            .filter(Boolean);
        const recIds = new Set(manifest.recordings.flatMap((r) => [r.id, ...stemsOf(r).map((st) => st.id)]));
        for (const r of manifest.recordings) {
            if ('syncFrom' in r && !recIds.has(r.syncFrom)) delete r.syncFrom;
            if ('stemOf' in r && !recIds.has(r.stemOf)) delete r.stemOf;
            if (Array.isArray(r.without)) {
                r.without = r.without.filter((w) => recIds.has(w) && w !== r.id);
                if (!r.without.length) delete r.without;
            }
        }
    }
    return manifest;
}

/**
 * Delete selected orphan items returned by `findRemoteOrphans`.
 */
export async function deleteRemoteOrphans({ store, legacy = null }, items = []) {
    const missingByPack = new Map();
    for (const item of items) {
        if (item.kind === 'pack') {
            await deletePackDir(store, `packs/${item.id}`);
        } else if (item.kind === 'pack-file' || item.kind === 'soundfont') {
            await store.delete(item.path);
        } else if (item.kind === 'manifest-ref' && item.packId && item.rel) {
            let set = missingByPack.get(item.packId);
            if (!set) { set = new Set(); missingByPack.set(item.packId, set); }
            set.add(item.rel);
        } else if (item.kind === 'legacy' && legacy) {
            await pool(item.blobs || [], DELETE_CONCURRENCY, (b) => legacy.deleteBlob(b));
            await pool(item.manifests || [], DELETE_CONCURRENCY, (m) => legacy.deleteManifest(m));
        }
    }
    for (const [packId, missing] of missingByPack) {
        const manifestPath = `packs/${packId}/manifest.json`;
        const manifest = await readJsonIfExists(store, manifestPath).catch(() => null);
        if (!manifest) continue;
        await writeJson(store, manifestPath, pruneManifestRefs(manifest, missing));
    }
}

/**
 * Removes named things from one pack in the sync location, right away: the scores (by file hash or tab id), the audio files
 * (by name, and size when known), and the YouTube videos (by id), with their files, sync files and every manifest reference.
 * `what` is `{ scoreHashes, scoreIds, audio: [{ name, size }], videoIds }`. The manifest is rewritten first, so a failure
 * part way leaves unused files in the folder (the Orphaned files tool finds those), never a manifest that names a missing file.
 * Returns `{ found, removedFiles }`; `found` is false when the location holds no such pack.
 */
export async function removeFromSyncCopy({ store }, packId, what = {}) {
    if (!PACK_ID_RE.test(packId || '')) return { found: false, removedFiles: 0 };
    const dir = `packs/${packId}`;
    const manifestPath = `${dir}/manifest.json`;
    const manifest = await readJsonIfExists(store, manifestPath).catch(() => null);
    if (!manifest) return { found: false, removedFiles: 0 };
    const hashes = new Set(what.scoreHashes || []);
    const ids = new Set(what.scoreIds || []);
    const videos = new Set(what.videoIds || []);
    const audio = what.audio || [];
    const gone = new Set();
    const rel = (p) => (p && p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p);
    const nameHit = (path, size) => {
        const base = String(path).split('/').pop();
        return audio.some((a) => a.name === base || (a.size && a.size === size && base?.endsWith(a.name)));
    };
    const present = new Map((await store.list(`${dir}/`)).map((e) => [rel(e.path), e]));
    const goneScoreIds = new Set();
    for (const x of (manifest.scores || []).flatMap((t) => [t, ...(t.alternates || [])])) {
        if (x.path && ((x.sha256 && hashes.has(x.sha256)) || ids.has(x.id))) { gone.add(x.path); goneScoreIds.add(x.id); }
    }
    const extra = new Set();   // sync and beat files of a recording that goes away with its source or its score
    for (const rec of manifest.recordings || []) {
        const sources = recordingSources(rec);
        const isGone = (s) => (s.type === 'youtube' && videos.has(s.videoId)) || (s.type === 'file' && s.path && nameHit(s.path, s.size ?? present.get(s.path)?.size));
        sources.filter((s) => s.type === 'file' && isGone(s)).forEach((s) => gone.add(s.path));
        if (sources.length > 0 && sources.every(isGone)) {
            Object.values(rec.sync || {}).forEach((p) => extra.add(p));
            if (rec.beats) extra.add(rec.beats);
        }
        if (Array.isArray(rec.sources)) rec.sources = rec.sources.filter((s) => !(s.type === 'youtube' && videos.has(s.videoId)));
        for (const [sid, p] of Object.entries(rec.sync || {})) if (goneScoreIds.has(sid)) extra.add(p);
    }
    const everything = new Set([...gone, ...extra]);
    const pruned = pruneManifestRefs(manifest, everything);
    await writeJson(store, manifestPath, pruned);
    let removedFiles = 0;
    for (const path of everything) {
        if (!present.has(path)) continue;
        try { await store.delete(`${dir}/${path}`); removedFiles++; } catch { /* left for the Orphaned files tool */ }
    }
    return { found: true, removedFiles };
}

/**
 * Where a song's things sit in the sync location, read from the pack's manifest alone (one small read and one listing, no file
 * is downloaded). `what` is as for removeFromSyncCopy. Returns `{ found, scores: [path], audio: [path] }` with store paths
 * ("packs/<id>/score/..."); `found` is false when the location holds no such pack.
 */
export async function locateInSyncCopy({ store }, packId, what = {}) {
    if (!PACK_ID_RE.test(packId || '')) return { found: false, scores: [], audio: [] };
    const dir = `packs/${packId}`;
    const manifest = await readJsonIfExists(store, `${dir}/manifest.json`).catch(() => null);
    if (!manifest) return { found: false, scores: [], audio: [] };
    const hashes = new Set(what.scoreHashes || []);
    const ids = new Set(what.scoreIds || []);
    const audio = what.audio || [];
    const sizes = new Map((await store.list(`${dir}/`)).map((e) => [e.path.slice(dir.length + 1), e.size]));
    const scores = (manifest.scores || []).flatMap((t) => [t, ...(t.alternates || [])])
        .filter((x) => x.path && ((x.sha256 && hashes.has(x.sha256)) || ids.has(x.id))).map((x) => `${dir}/${x.path}`);
    const files = (manifest.recordings || []).flatMap((r) => recordingSources(r)).filter((s) => s.type === 'file' && s.path);
    const hit = files.filter((s) => {
        const base = s.path.split('/').pop();
        const size = s.size ?? sizes.get(s.path);
        return audio.some((a) => a.name === base || (a.size && a.size === size && base?.endsWith(a.name)));
    }).map((s) => `${dir}/${s.path}`);
    return { found: true, scores, audio: hit };
}
