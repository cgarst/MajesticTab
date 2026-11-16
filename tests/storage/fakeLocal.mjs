// tests/storage/fakeLocal.mjs
// A fake of this device for the pack sync tests: songs with scores (and optionally audio), soundfonts, records, settings.
import { buildMpak, concatParts, sha256 } from '../../src/mpak/core/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function fakeLocal() {
    const state = {
        songs: new Map(),       // id -> { id, title, scores: Map<name, text>, audio: Uint8Array|null, sync: string|null, added }
        fonts: new Map(),       // id -> { name, bytes, addedAt }
        records: { collections: [], songs: [], recents: [], setlists: [] },
        settings: {},
        removed: [],
    };
    const fpOf = (s) => `${[...s.scores.entries()].map(([k, v]) => `${k}=${v}`).sort().join('|')}#${s.audio ? s.audio.length : 0}#${s.sync || ''}`;

    const api = {
        state,
        addSong(id, title, scores = { 'a.gp5': 'one' }, extra = {}) {
            state.songs.set(id, { id, title, scores: new Map(Object.entries(scores)), audio: null, sync: null, added: Date.now(), ...extra });
            state.records.songs.push({ id, title, collectionId: 'default', pinned: false, addedAt: Date.now(), tabOptions: [], packId: null });
        },
        editSong(id, fn) { fn(state.songs.get(id)); },
        removeSong(id) { state.songs.delete(id); state.records.songs = state.records.songs.filter((s) => s.id !== id); },

        async items() {
            const out = new Map();
            for (const s of state.songs.values()) out.set(`p:${s.id}`, { kind: 'pack', id: s.id, name: s.title, fp: fpOf(s), time: s.added });
            for (const [id, f] of state.fonts) out.set(`s:${id}`, { kind: 'soundfont', id, name: f.name, fp: `${f.bytes.length}:${f.addedAt}`, time: f.addedAt, size: f.bytes.length });
            return out;
        },
        async readItem(key) {
            if (key.startsWith('s:')) { const f = state.fonts.get(key.slice(2)); return { bytes: f.bytes, name: f.name, addedAt: f.addedAt }; }
            const s = state.songs.get(key.slice(2));
            const files = { };
            const scores = [];
            let i = 0;
            for (const [name, text] of s.scores) {
                const bytes = enc.encode(text);
                files[`score/${name}`] = bytes;
                scores.push({ id: `s${i++}`, path: `score/${name}`, format: 'gp5', sha256: await sha256(bytes), size: bytes.length });
            }
            const manifest = { format: 'mpak', version: 1, id: s.id, song: { title: s.title, artist: 'A' }, scores };
            if (s.audio) {
                files['audio/a.bin'] = s.audio;
                manifest.recordings = [{ id: 'r1', role: 'original', sources: [{ type: 'file', path: 'audio/a.bin', size: s.audio.length, sha256: await sha256(s.audio) }] }];
            }
            const zipped = await concatParts((await buildMpak(manifest, files)).parts);
            // directory form: the manifest as written plus the files
            const { readDirectory, readEntry, bytesSource } = await import('../../src/mpak/core/index.js');
            const src = bytesSource(zipped);
            const map = new Map();
            for (const e of await readDirectory(src)) map.set(e.name, await readEntry(src, e, {}));
            return { files: map };
        },
        async applyPack(packId, pack) {
            let s = state.songs.get(packId);
            if (!s) { s = { id: packId, title: pack.manifest.song?.title || packId, scores: new Map(), audio: null, sync: null, added: Date.now() }; state.songs.set(packId, s); state.records.songs.push({ id: packId, title: s.title, collectionId: 'default', pinned: false, addedAt: s.added, tabOptions: [], packId: null }); }
            for (const sc of pack.manifest.scores) { const name = sc.path.split('/').pop(); if (![...s.scores.values()].includes(dec.decode(pack.scoreBytes(sc.id)))) s.scores.set(name, dec.decode(pack.scoreBytes(sc.id))); }
            const src = (pack.manifest.recordings || []).flatMap((r) => r.sources).find((x) => x.type === 'file');
            if (src && !s.audio) s.audio = await pack.audio(src.path);
        },
        async applyBlob(key, bytes, meta) { state.fonts.set(key.slice(2), { name: meta.name, bytes, addedAt: meta.addedAt || 1 }); },
        async deleteItem(key) {
            state.removed.push(key);
            if (key.startsWith('s:')) state.fonts.delete(key.slice(2)); else api.removeSong(key.slice(2));
        },
        async records() { return { library: structuredClone(state.records), settings: { ...state.settings } }; },
        async putRecord(kind, rec) {
            const list = state.records[{ collection: 'collections', song: 'songs', recent: 'recents', setlist: 'setlists' }[kind]];
            const i = list.findIndex((r) => r.id === rec.id);
            if (i >= 0) list[i] = rec; else list.push(rec);
        },
        async deleteRecord(kind, id) {
            const f = { collection: 'collections', song: 'songs', recent: 'recents', setlist: 'setlists' }[kind];
            state.records[f] = state.records[f].filter((r) => r.id !== id);
        },
        async setSetting(k, v) { state.settings[k] = v; },
        async removeSetting(k) { delete state.settings[k]; },
    };
    return api;
}

export const memoryBaselines = () => { const m = new Map(); return { get: (l) => m.get(l) || null, set: (l, v) => m.set(l, structuredClone(v)), clear: (l) => m.delete(l), _m: m }; };
