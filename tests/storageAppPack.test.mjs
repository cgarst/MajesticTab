// Run with: node --test tests/storageAppPack.test.mjs
// A pack built by the app's own exporter goes through the pack store and comes back intact.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); }, key(i) { return [...this._m.keys()][i] ?? null; }, get length() { return this._m.size; },
};
const { buildMpak } = await import('../src/mpak.js');
const { createMemoryStore } = await import('../src/storage/memoryStore.js');
const { createPackStore } = await import('../src/storage/packStore.js');
const { bytesSource } = await import('../src/mpak/core/index.js');

test('an exported .mpak is stored in directory form, opens without warnings and exports again', async () => {
    const score = new File([new TextEncoder().encode('e|---0---|\n')], 'lead.txt', { type: 'text/plain' });
    score.librarySongId = 'song_1700000000000_ab12c';
    const song = { id: score.librarySongId, title: 'Roundtrip Song', artist: 'Test Artist' };
    const built = await buildMpak(score, { song, songKey: 'Test Artist - Roundtrip Song', scores: [] });
    const bytes = new Uint8Array(await built.blob.arrayBuffer());

    const s = createMemoryStore(); await s.open({ create: true });
    const packs = createPackStore(s);
    await packs.importMpak(song.id, bytesSource(bytes));
    const p = await packs.open(song.id);
    assert.deepEqual(p.warnings, []);
    assert.equal(p.manifest.id, song.id);
    assert.equal(p.manifest.song.title, 'Roundtrip Song');
    assert.ok(p.score.length > 0);
    assert.ok((await packs.exportMpak(song.id)).size > 0);
});
