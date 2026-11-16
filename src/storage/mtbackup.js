// storage/mtbackup.js
// The .mtbackup file: one ZIP that holds a whole library, built from the same parts as a sync store.
//
//   backup.json                  format, version 3, exported time, summary, the library and profile documents, and the
//                                list of what is in the archive (packs, soundfonts, classtab)
//   packs/<packId>.mpak          each song as a real .mpak, stored as it is (it is compressed inside)
//   soundfonts/<name>            SoundFont files
//   classtab/<name>              Classtab archives, untouched
//
// So any song in a backup can be opened by any mpak tool, and a restore reads one pack at a time. A pack inside the backup is
// read in place (a range of the file), not extracted.
//
// Older .mtbackup files are one JSON document (versions 1 and 2). backupKind() tells the two apart by the first bytes.
import { zipParts, readDirectory, readEntry, bytesSource, MpakError, LIMITS } from '../mpak/core/index.js';
import { LIBRARY_FORMAT, PROFILE_FORMAT } from './libraryDocs.js';

export const BACKUP_FORMAT = 'majestictab_backup';
export const BACKUP_VERSION = 3;
export const BACKUP_HEADER = 'backup.json';
export const BACKUP_MEDIA_TYPE = 'application/zip';
// A library can hold thousands of songs, far past what one pack may; the ratio limit guards bombs inside packs, not the header
const BACKUP_LIMITS = { ...LIMITS, maxEntries: 500000, maxRatio: 100000, maxDirectory: 256 << 20 };
const CHUNK = 1 << 20;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const safeName = (s, fallback) => (String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120) || fallback);

/** 'zip' for the new format, 'json' for the older single-document one, null when it is neither. Takes the first bytes. */
export function backupKind(head) {
    if (head[0] === 0x50 && head[1] === 0x4b) return 'zip';
    let i = 0;
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
    while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
    return head[i] === 0x7b ? 'json' : null;
}

/** A ByteSource over a Blob (or File). */
export const blobSource = (blob) => ({ size: blob.size, read: async (start, end) => new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer()) });

const asData = (data) => {
    if (data instanceof Uint8Array) return data;
    if (data && typeof data.size === 'number' && typeof data.slice === 'function') return { source: blobSource(data), start: 0, end: data.size };
    throw new TypeError('A backup entry is bytes or a Blob');
};

/**
 * Builds the archive.
 * @param {object} input
 * @param {object} input.library      library records ({collections, songs, recents, setlists}) as the app holds them
 * @param {object} input.libraryDoc   the library.json document for those records
 * @param {object} input.profileDoc   the profile.json document
 * @param {Array<{packId: string, songId?: string, data: Uint8Array|Blob}>} input.packs
 * @param {Array<{id: string, name: string, size?: number, addedAt?: number, data: Uint8Array|Blob}>} input.soundFonts
 * @param {Array<{id: string, name: string, data: Uint8Array|Blob}>} input.classtab
 * @returns {Promise<Blob>}
 */
export async function writeBackup({ libraryDoc, profileDoc, packs = [], soundFonts = [], classtab = [], appVersion = '', now = Date.now() }) {
    const used = new Set();
    const unique = (path) => { let p = path, n = 2; while (used.has(p.toLowerCase())) p = path.replace(/(\.[^./]*)?$/, `-${n++}$1`); used.add(p.toLowerCase()); return p; };
    const body = [];
    const listing = { packs: [], soundFonts: [], classtab: [] };
    for (const p of packs) {
        const path = unique(`packs/${safeName(p.packId, 'pack')}.mpak`);
        body.push({ name: path, data: asData(p.data), store: true });
        listing.packs.push({ packId: p.packId, ...(p.songId ? { songId: p.songId } : {}), path, size: p.data.size ?? p.data.length });
    }
    for (const f of soundFonts) {
        const path = unique(`soundfonts/${safeName(f.name, 'soundfont.sf2')}`);
        body.push({ name: path, data: asData(f.data), store: true });
        listing.soundFonts.push({ id: f.id, name: f.name, path, size: f.data.size ?? f.data.length, addedAt: f.addedAt ?? null });
    }
    for (const c of classtab) {
        const path = unique(`classtab/${safeName(c.name, `${c.id}.zip`)}`);
        body.push({ name: path, data: asData(c.data), store: true });
        listing.classtab.push({ id: c.id, name: c.name, path, size: c.data.size ?? c.data.length });
    }
    const header = {
        app: 'MajesticTab', format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), appVersion,
        summary: {
            songs: libraryDoc.songs.length, collections: libraryDoc.collections.length, setlists: libraryDoc.setlists.length, recents: libraryDoc.recents.length,
            packs: listing.packs.length, soundFonts: listing.soundFonts.length, classtab: listing.classtab.length,
            bytes: [...listing.packs, ...listing.soundFonts, ...listing.classtab].reduce((n, e) => n + (e.size || 0), 0),
        },
        library: libraryDoc, profile: profileDoc, ...listing,
    };
    const { parts } = await zipParts([{ name: BACKUP_HEADER, data: enc.encode(JSON.stringify(header)) }, ...body]);
    const chunks = [];
    for (const part of parts) {
        if (part instanceof Uint8Array) chunks.push(part);
        else for (let at = part.start; at < part.end; at += CHUNK) chunks.push(await part.source.read(at, Math.min(part.end, at + CHUNK)));
    }
    return new Blob(chunks, { type: BACKUP_MEDIA_TYPE });
}

/** The listing of a backup without reading any pack: errors a reader must refuse, as MpakError. */
export function checkBackupHeader(header) {
    if (!header || header.format !== BACKUP_FORMAT) throw new MpakError('This is not a MajesticTab backup');
    if (typeof header.version !== 'number' || header.version < 3) throw new MpakError('This backup is in the older format');
    if (header.version > BACKUP_VERSION) throw new MpakError(`This backup is from a newer version of MajesticTab (format ${header.version}). Update the app to restore it.`);
    if (header.library?.format !== LIBRARY_FORMAT) throw new MpakError('The backup has no library');
    if (header.profile && header.profile.format !== PROFILE_FORMAT) throw new MpakError('The backup profile is not readable');
    return header;
}

/**
 * Opens a backup from a ByteSource.
 * Returns { header, packs, soundFonts, classtab, packSource(entry), read(entry), has(path) }, where each list holds the
 * header's entries. `packSource` gives a ByteSource over one pack, read in place when the pack is Stored (it always is when
 * this app wrote it). `read` reads one soundfont or classtab entry whole. Entries the header names but the archive lacks are
 * listed in `missing`, so a damaged file restores what it can and says what it could not.
 */
export async function openBackup(source) {
    const entries = await readDirectory(source, BACKUP_LIMITS);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const head = byName.get(BACKUP_HEADER);
    if (!head) throw new MpakError('This is not a MajesticTab backup (no backup.json)');
    let header;
    try { header = JSON.parse(dec.decode(await readEntry(source, head, { limits: BACKUP_LIMITS }))); } catch (e) { throw new MpakError(`backup.json is not readable: ${e.message}`); }
    checkBackupHeader(header);

    const listed = [...(header.packs || []), ...(header.soundFonts || []), ...(header.classtab || [])];
    const missing = listed.filter((e) => !byName.has(e.path)).map((e) => e.path);
    const need = (path) => { const e = byName.get(path); if (!e) throw new MpakError(`The backup is missing ${path}`); return e; };
    const readWhole = (e) => readEntry(source, e, { limits: BACKUP_LIMITS });
    return {
        header, missing,
        packs: (header.packs || []).filter((p) => byName.has(p.path)),
        soundFonts: (header.soundFonts || []).filter((p) => byName.has(p.path)),
        classtab: (header.classtab || []).filter((p) => byName.has(p.path)),
        has: (path) => byName.has(path),
        read: (entry) => readWhole(need(entry.path)),
        packSource: async (entry) => {
            const e = need(entry.path);
            if (e.method !== 0) return bytesSource(await readWhole(e));
            return { size: e.usize, read: (start, end) => source.read(e.dataStart + start, e.dataStart + Math.min(end, e.usize)) };
        },
    };
}
