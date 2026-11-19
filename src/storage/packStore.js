// storage/packStore.js
// Packs on a store (contract.js), kept in directory form (SPEC section 3.2): "packs/<packId>/manifest.json, score/, audio/ ...".
//
//   listPacks()                       -> [{ packId, size, version, modifiedTime }]   one listing, no pack is opened
//   open(packId)                      -> { manifest, version, warnings, score, scoreBytes, sync, beats, file, audio(path), audioRange(path, range), audioInfo() }
//   write(packId, files, options)     writes a pack: everything but manifest.json first, manifest.json last
//   importMpak(packId, source)        unzips a .mpak ByteSource into the directory form (manifest bytes kept as they are)
//   exportMpak(packId, options)       -> Blob of a .mpak (audio included by default)
//   remove(packId)
//
// Opening reads the manifest, scores, sync and beat files and never audio. It does that by building a small archive
// from those files and giving it to the same openMpak the app uses for .mpak files, so a pack on a store and a .mpak
// file are read by the same code (timelines, syncFrom, hashes and all). Audio stays in the store; audio(path) reads it
// whole and audioRange(path, range) reads part of it (a range request where the store has one).
import {
    openMpak, buildMpak, zipParts, concatParts, bytesSource, readDirectory, readEntry, sha256, validateManifest, MpakError, checkEntryName,
} from '../mpak/core/index.js';
import { writePackDir, deletePackDir, readIfExists, NotFoundError, StorageError, byteLengthOf } from './contract.js';

const PACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MANIFEST_RE = /^([^/]+)\/manifest\.json$/;
const CHUNK = 1 << 20;
const isAudio = (name) => name.startsWith('audio/');
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function checkPackId(id) {
    if (typeof id !== 'string' || !PACK_ID_RE.test(id)) throw new StorageError(`Not a pack id: ${id}`);
    return id;
}

/** A ByteSource over one stored file: each read is a range request where the store has them. */
export function storeSource(store, path, size) {
    return { size, read: async (start, end) => store.read(path, { range: { start, end: Math.min(end, size) } }) };
}

/** What a manifest says each file must be: path -> { size?, sha256? } (scores, file sources, entries). */
export function expectedFiles(manifest) {
    const out = new Map();
    const add = (path, info) => { if (path) out.set(path, { ...out.get(path), ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) }); };
    for (const t of manifest.scores || []) for (const x of [t, ...(t.alternates || [])]) add(x.path, { size: x.size, sha256: x.sha256 });
    for (const r of manifest.recordings || []) for (const s of r.sources || []) if (s.type === 'file') add(s.path, { size: s.size, sha256: s.sha256 });
    for (const [path, info] of Object.entries(manifest.entries || {})) add(path, info);
    return out;
}

const PROGRESS_CHUNK = 2 * 1024 * 1024;

export function createPackStore(store, { root = 'packs' } = {}) {
    const dirOf = (packId) => `${root}/${checkPackId(packId)}`;

    async function listPacks() {
        const found = [];
        for (const e of await store.list(`${root}/`)) {
            const m = MANIFEST_RE.exec(e.path.slice(root.length + 1));
            if (m && PACK_ID_RE.test(m[1])) found.push({ packId: m[1], size: e.size, version: e.version, modifiedTime: e.modifiedTime });
        }
        return found;
    }

    /** Reads every non-audio file of the pack and opens them as an archive. */
    async function openOnce(packId, onProgress) {
        const dir = dirOf(packId);
        const manifestEntry = await store.stat(`${dir}/manifest.json`);
        if (!manifestEntry) throw new NotFoundError(`No such pack: ${packId}`);
        const manifestBytes = await store.read(`${dir}/manifest.json`);
        let manifest;
        try { manifest = JSON.parse(decode(manifestBytes)); } catch (e) { throw new MpakError(`manifest is not JSON: ${e.message}`); }
        const errs = validateManifest(manifest);
        if (errs.length) throw new MpakError(`invalid manifest:\n  ${errs.join('\n  ')}`);

        const listing = await store.list(`${dir}/`);
        const present = new Map(listing.map((e) => [e.path.slice(dir.length + 1), e]));
        const light = [{ name: 'manifest.json', data: manifestBytes }];
        const wanted = [...present].filter(([name]) => name !== 'manifest.json' && !isAudio(name));
        const total = wanted.reduce((sum, [, e]) => sum + (e.size || 0), 0);
        let loaded = 0;
        if (onProgress) onProgress({ loaded, total });
        for (const [name, e] of wanted) {
            let data;
            if (onProgress && e.size > PROGRESS_CHUNK) {
                // A large score: read it in ranges so the caller can show bytes arriving
                const parts = [];
                for (let start = 0; start < e.size; start += PROGRESS_CHUNK) {
                    const part = await store.read(`${dir}/${name}`, { range: { start, end: Math.min(start + PROGRESS_CHUNK, e.size) } });
                    parts.push(part);
                    loaded += byteLengthOf(part);
                    onProgress({ loaded, total: Math.max(total, loaded) });
                }
                data = await concatParts(parts);
            } else {
                data = await store.read(`${dir}/${name}`);
                loaded += byteLengthOf(data) || e.size || 0;
                if (onProgress) onProgress({ loaded, total: Math.max(total, loaded) });
            }
            light.push({ name, data });
        }
        const opened = await openMpak(bytesSource(await concatParts((await zipParts(light)).parts)));
        // Audio is not in the light archive on purpose; what is missing from the store is reported by audioInfo
        const audio = (manifest.recordings || []).flatMap((r) => (r.sources || []).filter((s) => s.type === 'file'));
        const warnings = opened.warnings.filter((w) => !audio.some((s) => w.includes(s.path)));
        for (const s of audio) {
            const e = present.get(s.path);
            if (!e) warnings.push(`missing audio file ${s.path}`);
            else if (s.size !== undefined && s.size !== e.size) warnings.push(`audio size differs from the manifest: ${s.path}`);
        }
        return { manifest, opened, warnings, present, version: manifestEntry.version, dir };
    }

    async function open(packId, { onProgress } = {}) {
        let r = await openOnce(packId, onProgress);
        // SPEC 3.2: a size or hash mismatch may be a writer still at work; read once more before reporting it
        if (r.warnings.some((w) => /sha256|size/.test(w))) r = await openOnce(packId, onProgress);
        const { manifest, opened, warnings, present, version, dir } = r;
        if (manifest.id !== undefined && manifest.id !== packId) warnings.push(`manifest id ${manifest.id} differs from the folder ${packId}`);
        const audioEntry = (path) => {
            const e = present.get(path);
            if (!e || !isAudio(path)) throw new NotFoundError(`No such audio file in ${packId}: ${path}`);
            return e;
        };
        return {
            packId, manifest, version, warnings,
            score: opened.score, scoreBytes: opened.scoreBytes, sync: opened.sync, beats: opened.beats, defaultRecording: opened.defaultRecording,
            file: (path) => opened.file(path),
            /** This pack as a .mpak Blob, with its audio or without (a song whose audio stays in the store). */
            toMpak: (options) => exportMpak(packId, options),
            /** Whole audio file. */
            audio: async (path) => { audioEntry(path); return store.read(`${dir}/${path}`); },
            /** Bytes [start, end) of an audio file. */
            audioRange: async (path, { start, end }) => { audioEntry(path); return store.read(`${dir}/${path}`, { range: { start, end } }); },
            audioSource: (path) => { const e = audioEntry(path); return storeSource(store, `${dir}/${path}`, e.size); },
            /** Per file source: { path, present, size, expectedSize }. */
            audioInfo: () => (manifest.recordings || []).flatMap((rec) => (rec.sources || []).filter((s) => s.type === 'file').map((s) => ({
                recording: rec.id, path: s.path, present: present.has(s.path), size: present.get(s.path)?.size ?? null, expectedSize: s.size ?? null,
            }))),
        };
    }

    /**
     * @param files  object or Map: relative path -> Uint8Array; must include manifest.json (as the bytes to store)
     * What is written is checked against the manifest first: a pack whose hashes do not match its files is a writer's bug.
     */
    async function write(packId, files, { manifestIfVersion, skipSameSize = true, onProgress } = {}) {
        const dir = dirOf(packId);
        const map = files instanceof Map ? files : new Map(Object.entries(files));
        const manifestBytes = map.get('manifest.json');
        if (!manifestBytes) throw new MpakError('A pack needs a manifest.json');
        const manifest = JSON.parse(decode(manifestBytes));
        const errs = validateManifest(manifest);
        if (errs.length) throw new MpakError(`invalid manifest:\n  ${errs.join('\n  ')}`);
        if (manifest.id !== undefined && manifest.id !== packId) throw new MpakError(`manifest id ${manifest.id} is not the pack id ${packId}`);
        for (const name of map.keys()) checkEntryName(name);
        for (const [path, want] of expectedFiles(manifest)) {
            const bytes = map.get(path);
            if (!bytes) { if (!isAudio(path) || !manifest.recordings) throw new MpakError(`manifest names ${path} but it is not in the pack`); continue; }
            if (want.size !== undefined && want.size !== byteLengthOf(bytes)) throw new MpakError(`${path}: size differs from the manifest`);
            if (want.sha256 !== undefined && !(typeof Blob !== 'undefined' && bytes instanceof Blob) && want.sha256 !== await sha256(bytes)) throw new MpakError(`${path}: sha256 differs from the manifest`);
        }
        await writePackDir(store, dir, Object.fromEntries(map), { skipSameSize, onProgress, manifestIfVersion });
    }

    /** `source` is a ByteSource over a .mpak. Audio entries are held one at a time. Returns { files, manifest }. */
    async function importMpak(packId, source, options = {}) {
        const entries = await readDirectory(source);
        const files = new Map();
        for (const e of entries) {
            if (e.name === 'mimetype') continue;
            files.set(e.name, await readEntry(source, e, {}));
        }
        const manifest = JSON.parse(decode(files.get('manifest.json')));
        if (manifest.id === undefined) throw new MpakError('This pack has no id; give it one (or derive it) before storing it');
        await write(packId, files, options);
        return { manifest, files: files.size };
    }

    async function exportMpak(packId, { includeAudio = true } = {}) {
        const dir = dirOf(packId);
        const manifestBytes = await store.read(`${dir}/manifest.json`);
        const manifest = JSON.parse(decode(manifestBytes));
        const files = new Map();
        for (const e of await store.list(`${dir}/`)) {
            const name = e.path.slice(dir.length + 1);
            if (name === 'manifest.json') continue;
            if (isAudio(name)) { if (includeAudio) files.set(name, { source: storeSource(store, e.path, e.size), start: 0, end: e.size }); }
            else files.set(name, await store.read(e.path));
        }
        const chunks = [];
        for (const part of (await buildMpak(manifest, files)).parts) {
            if (part instanceof Uint8Array) chunks.push(part);
            else for (let at = part.start; at < part.end; at += CHUNK) chunks.push(await part.source.read(at, Math.min(part.end, at + CHUNK)));
        }
        return new Blob(chunks, { type: 'application/vnd.mpak+zip' });
    }

    return { listPacks, open, write, importMpak, exportMpak, remove: (packId) => deletePackDir(store, dirOf(packId)), readIfExists: (path) => readIfExists(store, path) };
}
