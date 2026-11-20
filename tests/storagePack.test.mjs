// Run with: node --test tests/storagePack.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { createPackStore } from '../src/storage/packStore.js';
import { ConflictError } from '../src/storage/contract.js';
import { buildMpak, concatParts, bytesSource, openMpak, sha256, derivedPackId } from '../src/mpak/core/index.js';

const enc = new TextEncoder();
const SCORE = enc.encode('e|---0---|\n');
const AUDIO = new Uint8Array(200000).map((_, i) => (i * 7) % 256);
const SYNC = enc.encode(JSON.stringify({ version: 1, recording: 'r1', score: 'main', anchorType: 'bar', points: [{ timeMs: 0, bar: 0, occurrence: 0, pos: 0, source: 'manual' }, { timeMs: 2150, bar: 1, occurrence: 0, pos: 0, source: 'tap' }] }));

async function makeMpak({ withAudio = true } = {}) {
    const scoreSha = await sha256(SCORE);
    const id = await derivedPackId(scoreSha);
    const syncSha = await sha256(SYNC);
    const manifest = {
        format: 'mpak', version: 1, id,
        song: { title: 'T', artist: 'A' },
        scores: [{ id: 'main', path: 'score/a.gp5', format: 'gp5', sha256: scoreSha, size: SCORE.length }],
        recordings: withAudio ? [{ id: 'r1', role: 'original', sources: [{ type: 'file', path: 'audio/a.bin', size: AUDIO.length, sha256: await sha256(AUDIO) }], sync: { main: 'sync/r1.json' } }] : undefined,
        entries: { 'sync/r1.json': { size: SYNC.length, sha256: syncSha } },
    };
    if (!withAudio) delete manifest.recordings, delete manifest.entries;
    const files = { 'score/a.gp5': SCORE };
    if (withAudio) { files['audio/a.bin'] = AUDIO; files['sync/r1.json'] = SYNC; }
    const bytes = await concatParts((await buildMpak(manifest, files)).parts);
    return { id, bytes, manifest };
}

const fresh = async () => { const s = createMemoryStore(); await s.open({ create: true }); return { s, packs: createPackStore(s) }; };

test('import a .mpak into directory form, list it, open it and read audio by range', async () => {
    const { s, packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    assert.deepEqual([...s.dump().keys()].filter((k) => k.startsWith(`packs/${id}/`)).sort(),
        [`packs/${id}/audio/a.bin`, `packs/${id}/manifest.json`, `packs/${id}/score/a.gp5`, `packs/${id}/sync/r1.json`]);
    assert.deepEqual((await packs.listPacks()).map((p) => p.packId), [id]);
    const p = await packs.open(id);
    assert.deepEqual(p.warnings, []);
    assert.deepEqual(p.score, SCORE);
    assert.equal(p.sync('r1').points.length, 2);
    assert.deepEqual(await p.audioRange('audio/a.bin', { start: 100, end: 110 }), AUDIO.slice(100, 110));
    assert.deepEqual(await p.audio('audio/a.bin'), AUDIO);
    assert.deepEqual(p.audioInfo(), [{ recording: 'r1', path: 'audio/a.bin', present: true, size: AUDIO.length, expectedSize: AUDIO.length }]);
});

test('opening a pack never reads its audio', async () => {
    const { s, packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    let audioReads = 0;
    const read = s.read.bind(s);
    s.read = async (path, o) => { if (path.includes('/audio/')) audioReads++; return read(path, o); };
    await packs.open(id);
    assert.equal(audioReads, 0);
});

test('a pack whose audio is not on the store (remote-only) opens with a warning naming it, and says what is missing', async () => {
    const { s, packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    await s.delete(`packs/${id}/audio/a.bin`);
    const p = await packs.open(id);
    assert.deepEqual(p.warnings, ['missing audio file audio/a.bin']);
    assert.equal(p.audioInfo()[0].present, false);
    await assert.rejects(() => p.audio('audio/a.bin'), /No such audio/);
});

test('a file that does not match the manifest is a warning, after one re-read', async () => {
    const { s, packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    await s.write(`packs/${id}/sync/r1.json`, enc.encode('{}'));
    const p = await packs.open(id);
    assert.ok(p.warnings.some((w) => /sync\/r1\.json/.test(w)), p.warnings.join('|'));
});

test('a half-written pack (no manifest yet) is not listed and not openable', async () => {
    const { s, packs } = await fresh();
    await s.write('packs/abc/score/a.gp5', SCORE);
    assert.deepEqual(await packs.listPacks(), []);
    await assert.rejects(() => packs.open('abc'), /No such pack/);
});

test('write refuses files that do not match the manifest or an id that is not the folder', async () => {
    const { packs } = await fresh();
    const { id, manifest } = await makeMpak();
    const m = enc.encode(JSON.stringify(manifest));
    await assert.rejects(() => packs.write(id, { 'manifest.json': m, 'score/a.gp5': enc.encode('other') }), /sha256|size/);
    await assert.rejects(() => packs.write('other-id', { 'manifest.json': m, 'score/a.gp5': SCORE }), /is not the pack id/);
    await assert.rejects(() => packs.write(id, { 'manifest.json': m }), /not in the pack/);
});

test('export gives a .mpak that opens with the same score, sync and audio, and is the import byte for byte in content', async () => {
    const { packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    const blob = await packs.exportMpak(id);
    const o = await openMpak(bytesSource(new Uint8Array(await blob.arrayBuffer())));
    assert.deepEqual(o.warnings, []);
    assert.deepEqual(o.score, SCORE);
    assert.deepEqual(await o.file('audio/a.bin'), AUDIO);
    assert.equal(o.manifest.id, id);
    const light = await packs.exportMpak(id, { includeAudio: false });
    assert.ok(light.size < blob.size / 2);
});

test('a second device writing a pack that exists is a conflict when it asks for a new pack', async () => {
    const { packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes), { manifestIfVersion: null });
    await assert.rejects(() => packs.importMpak(id, bytesSource(bytes), { manifestIfVersion: null }), ConflictError);
});

test('remove deletes the whole pack', async () => {
    const { s, packs } = await fresh();
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    await packs.remove(id);
    assert.deepEqual([...s.dump().keys()], []);
});

test('write accepts a Blob for audio entries and streams it into the store', async () => {
    const { packs } = await fresh();
    const { id, bytes } = await makeMpak();
    const { readDirectory, readEntry } = await import('../src/mpak/core/index.js');
    const src = bytesSource(bytes);
    const blobFiles = new Map();
    for (const e of await readDirectory(src)) {
        if (e.name === 'mimetype') continue;
        blobFiles.set(e.name, e.name === 'audio/a.bin' ? new Blob([AUDIO]) : await readEntry(src, e, {}));
    }
    await packs.write(id, blobFiles);
    const opened = await packs.open(id);
    assert.deepEqual(opened.warnings, []);
    assert.deepEqual(await opened.audio('audio/a.bin'), AUDIO);
    assert.deepEqual(await opened.audioRange('audio/a.bin', { start: 10, end: 50 }), AUDIO.slice(10, 50));
});

test('exportMpak reads each audio file whole, several at a time, and reports the bytes of the audio', async () => {
    const store = createMemoryStore();
    const packs = createPackStore(store);
    const { id, bytes } = await makeMpak();
    await packs.importMpak(id, bytesSource(bytes));
    const reads = [];
    const read = store.read.bind(store);
    store.read = async (path, options) => { reads.push({ path, range: Boolean(options?.range) }); return read(path, options); };
    const seen = [];
    const blob = await packs.exportMpak(id, { onProgress: (p) => seen.push(p) });
    assert.ok(!reads.some((r) => r.range), 'no range request is made for the audio');
    assert.equal(reads.filter((r) => r.path.endsWith('audio/a.bin')).length, 1);
    assert.equal(seen.at(-1).loaded, AUDIO.length);
    assert.equal(seen.at(-1).total, AUDIO.length);
    assert.ok(blob.size > AUDIO.length);
});
