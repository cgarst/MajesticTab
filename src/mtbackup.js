// mtbackup.js
// The .mtbackup file for the app: builds one from the library on this device and restores one into it.
// The format itself (the ZIP, the packs inside, old-format detection) is storage/mtbackup.js; this file is the part that
// knows the app's stores. Older .mtbackup files (one JSON document) are still restored by backupRestore.js; restoreAnyBackup
// picks the right one by looking at the first bytes.
import { getAllLibraryData, getSongById, putLibraryRecord, deleteLibraryRecord, getCollections } from './libraryStore.js';
import { getStoredFile } from './fileStore.js';
import { listSoundFonts, getSoundFontData, restoreSoundFontEntry } from './soundFontStore.js';
import { listClasstab, getClasstabData, restoreClasstabEntry } from './classtab/backup.js';
import { buildMpak, saveMpakToLibrary } from './mpak.js';
import { collectAllSettings, applyRestoredSettings, applyRestoredPreferences, wipeLibraryData, restoreBackup } from './backupRestore.js';
import { toLibraryDoc, toProfileDoc, fromLibraryDoc, fromProfileDoc, applyIndexToSong } from './storage/libraryDocs.js';
import { sha256 } from './mpak/core/index.js';
import { writeBackup, openBackup, backupKind, blobSource } from './storage/mtbackup.js';
import { openSpool } from './storage/spool.js';
import { songKeyFor } from './songKey.js';

const songKeyOf = songKeyFor;

/** The tab of a song that goes in its pack: the default tab when its file is stored here, else the first stored one. */
async function primaryTabFile(song) {
    const tabs = song.tabOptions || [];
    const ordered = [...tabs.filter((t) => t.id === song.defaultTabId), ...tabs.filter((t) => t.id !== song.defaultTabId)];
    for (const tab of ordered) {
        if (!tab.fileStoreId) continue;
        const stored = await getStoredFile(tab.fileStoreId);
        if (!stored?.file) continue;
        stored.file.librarySongId = song.id;
        stored.file.tabId = tab.id;
        return stored.file;
    }
    return null;
}

/**
 * A pack of one library song: `{ packId, blob }`, or null when the song has no tab stored on this device (it is then
 * in library.json only). Used by the backup, and by sync when it writes songs to a store.
 */
export async function buildSongPack(song) {
    const file = await primaryTabFile(song);
    if (!file) return null;
    const built = await buildMpak(file, { song, songKey: songKeyOf(song) });
    return { packId: built.packId, blob: built.blob };
}

/**
 * A tab record does not always carry the hash of its file, and the hash is how a restore finds which tab of the pack a tab
 * of the library is. The backup fills it in (in the copy it writes, not in the library) for every tab whose file is here.
 */
async function fillTabHashes(songs) {
    for (const song of songs) {
        for (const tab of song.tabOptions || []) {
            if (tab.sha256 || !tab.fileStoreId) continue;
            try {
                const stored = await getStoredFile(tab.fileStoreId);
                if (stored?.file) tab.sha256 = await sha256(new Uint8Array(await stored.file.arrayBuffer()));
            } catch { /* the tab then matches by id or name */ }
        }
    }
}

/**
 * Songs whose files are not on this device are in the backup too when the sync location holds their pack: the pack is
 * downloaded whole (audio included) and added as it is. A song neither has is listed in `skipped`, so the result says
 * what the file lacks instead of leaving it out silently.
 */
async function packFromSyncStore(songs, packs, skipped, onProgress, spool) {
    if (!songs.length) return;
    const noFile = 'its files are not on this device and no copy was found in the sync location';
    let store = null, why = noFile;
    try {
        const { getTarget, openSyncStore } = await import('./syncBackend.js');
        const target = getTarget();
        if (target) {
            const opened = await openSyncStore(target, { interactive: false });
            if (opened?.status === 'ready') store = opened.store;
            else why = `its files are only in the sync location, which is not reachable (${opened?.status || 'unavailable'})`;
        }
    } catch (err) { why = `its files are only in the sync location, which could not be opened (${err.message})`; }
    const { isPackId } = await import('./mpak.js');
    const { createPackStore } = await import('./storage/packStore.js');
    const have = new Set(packs.map((p) => p.packId));
    let n = 0;
    for (const song of songs) {
        onProgress({ phase: 'cloud', current: ++n, total: songs.length, name: song.title });
        const packId = isPackId(song.id) ? song.id : (isPackId(song.packId) ? song.packId : null);
        if (!packId) { skipped.push({ id: song.id, title: song.title, reason: noFile }); continue; }
        if (have.has(packId)) continue;
        if (!store) { skipped.push({ id: song.id, title: song.title, reason: why }); continue; }
        try {
            const pack = await createPackStore(store).open(packId);
            // Each pack goes to disk as it arrives, so the library is never all in memory at once
            packs.push({ packId, songId: song.id, data: await spool.put(packId, await pack.toMpak({ includeAudio: true })) });
            have.add(packId);
        } catch (err) {
            console.warn('[mtbackup] could not fetch', song.title, err);
            skipped.push({ id: song.id, title: song.title, reason: err.name === 'NotFoundError' ? noFile : err.message });
        }
    }
}

/**
 * Builds a .mtbackup of everything on this device. Resolves to { blob, filename, summary, skipped } where `skipped` lists
 * songs whose pack could not be built (the rest of the backup is still written).
 */
export async function createMtBackup({ onProgress = () => {} } = {}) {
    const records = await getAllLibraryData();
    const packs = [], skipped = [];
    const unpacked = []; // songs with a tab and no file of it on this device (hybrid sync gives the files up to the cloud copy)
    let n = 0;
    for (const song of records.songs) {
        onProgress({ phase: 'songs', current: ++n, total: records.songs.length, name: song.title });
        try {
            const pack = await buildSongPack(song);
            if (pack) packs.push({ packId: pack.packId, songId: song.id, data: pack.blob });
            else if ((song.tabOptions || []).length) unpacked.push(song);
        } catch (err) {
            console.warn('[mtbackup] could not pack', song.title, err);
            skipped.push({ id: song.id, title: song.title, reason: err.message });
        }
    }
    const spool = await openSpool();
    try { await packFromSyncStore(unpacked, packs, skipped, onProgress, spool); } catch (err) { await spool.release(); throw err; }
    // Read again: building a pack may have given a song a pack id of its own
    const library = await getAllLibraryData();
    await fillTabHashes(library.songs);

    onProgress({ phase: 'soundfonts', current: 0, total: 0 });
    const fonts = await listSoundFonts();
    const soundFonts = [];
    for (const f of fonts) {
        const data = await getSoundFontData(f.id);
        if (data) soundFonts.push({ ...f, data: new Uint8Array(data) });
    }
    const classtab = [];
    for (const c of await listClasstab()) {
        const data = await getClasstabData();
        if (data) classtab.push({ id: c.id, name: c.name || 'classtab.zip', data: new Uint8Array(data) });
    }

    onProgress({ phase: 'writing', current: 0, total: 0 });
    const now = Date.now();
    const blob = await writeBackup({
        libraryDoc: toLibraryDoc(library, { now }),
        profileDoc: toProfileDoc({ settings: collectAllSettings(), soundFonts: fonts }, { now }),
        packs, soundFonts, classtab, now,
    }).catch(async (err) => { await spool.release(); throw err; });
    const day = new Date(now).toISOString().slice(0, 10);
    return { blob, filename: `MajesticTab-backup-${day}.mtbackup`, summary: { songs: library.songs.length, packs: packs.length, soundFonts: soundFonts.length }, skipped,
        /** Frees the temporary files behind `blob`. Call it once the blob is saved. */
        release: () => spool.release() };
}

/** 'zip' (this format), 'json' (the older one) or null, from the first bytes of a file. */
export async function backupKindOfFile(file) {
    return backupKind(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
}

/** What a backup holds, for the screen that asks before restoring. Does not change anything. */
export async function inspectMtBackup(file) {
    const b = await openBackup(blobSource(file));
    const h = b.header;
    return { exportedAt: h.exportedAt, appVersion: h.appVersion || '', ...h.summary, missing: b.missing };
}

const asBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/**
 * Restores a .mtbackup into this device. mode 'merge' adds what is missing and leaves what is here alone;
 * 'wipe' empties the device's library first.
 * Resolves to { mode, songs, skippedSongs, collections, recents, setlists, soundFonts, missing, failed: [{ id, reason }] }.
 * A song that fails to restore is listed in `failed` and the rest carry on.
 */
export async function restoreMtBackup(file, { mode = 'merge', onProgress = () => {} } = {}) {
    const wipe = mode === 'wipe';
    const b = await openBackup(blobSource(file));
    const library = fromLibraryDoc(b.header.library);
    const profile = b.header.profile ? fromProfileDoc(b.header.profile) : { settings: {}, soundFonts: [] };
    if (wipe) await wipeLibraryData();

    const result = { mode, songs: 0, skippedSongs: 0, collections: 0, recents: 0, setlists: 0, soundFonts: 0, missing: b.missing, failed: [] };

    const haveCollections = new Set((await getCollections()).map((c) => c.id));
    for (const c of library.collections) {
        if (haveCollections.has(c.id)) continue;
        await putLibraryRecord('collection', c);
        result.collections++;
    }

    const indexedByPack = new Map(library.songs.map((s) => [s.packId || s.id, s]));
    for (const [i, entry] of b.packs.entries()) {
        const indexed = indexedByPack.get(entry.packId) || (entry.songId && library.songs.find((s) => s.id === entry.songId)) || null;
        onProgress({ phase: 'songs', current: i + 1, total: b.packs.length, name: indexed?.title || entry.packId });
        try {
            const saved = await saveMpakToLibrary(await b.packSource(entry), { queryMusicBrainz: false, collectionId: indexed?.collectionId });
            if (saved.merged && !saved.created) { result.skippedSongs++; continue; }
            if (indexed) {
                const imported = await getSongById(saved.song.id);
                const final = applyIndexToSong(imported, indexed);
                // The song keeps the id the library knew it by, so setlists and recents still point at it; the pack id is kept beside it
                if (final.id !== indexed.id) { final.id = indexed.id; final.packId = entry.packId; await deleteLibraryRecord('song', imported.id); }
                await putLibraryRecord('song', final);
            }
            result.songs++;
        } catch (err) {
            console.warn('[mtbackup] could not restore', entry.packId, err);
            result.failed.push({ id: entry.packId, reason: err.message });
        }
    }

    // Songs with no pack: no tab was stored on the device that made the backup, so only the library record exists
    const restoredPackIds = new Set(b.packs.map((p) => p.packId));
    for (const s of library.songs) {
        if (restoredPackIds.has(s.packId || s.id)) continue;
        if (!wipe && await getSongById(s.id)) continue;
        await putLibraryRecord('song', { ...s, tabOptions: (s.tabOptions || []).map((t) => ({ ...t, fileStoreId: null, driveFileId: null })) });
        result.songs++;
    }

    const have = { recent: new Set(), setlist: new Set() };
    if (!wipe) {
        const now = await getAllLibraryData();
        for (const r of now.recents) have.recent.add(r.id);
        for (const s of now.setlists) have.setlist.add(s.id);
    }
    for (const r of library.recents) if (!have.recent.has(r.id)) { await putLibraryRecord('recent', r); result.recents++; }
    for (const s of library.setlists) if (!have.setlist.has(s.id)) { await putLibraryRecord('setlist', s); result.setlists++; }

    applyRestoredSettings(profile.settings, { wipe });
    for (const entry of b.soundFonts) {
        const item = { id: entry.id, name: entry.name, size: entry.size, addedAt: entry.addedAt, fetchData: async () => asBuffer(await b.read(entry)) };
        if (await restoreSoundFontEntry(item, { wipe })) result.soundFonts++;
    }
    for (const entry of b.classtab) {
        await restoreClasstabEntry({ id: entry.id, name: entry.name, fetchData: async () => asBuffer(await b.read(entry)) }, { wipe });
    }
    applyRestoredPreferences();
    return result;
}

/** Restores either kind of .mtbackup: this ZIP format or the older single JSON document. */
export async function restoreAnyBackup(file, options = {}) {
    if ((await backupKindOfFile(file)) === 'zip') return restoreMtBackup(file, options);
    return restoreBackup(file, options);
}
