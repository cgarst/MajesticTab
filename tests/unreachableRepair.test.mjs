// Run with: node --test tests/unreachableRepair.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { sha256 } from '../src/mpak/core/index.js';
import { orderCandidates, findTabFiles, restoreTabFiles } from '../src/unreachableRepair.js';

const enc = (t) => new TextEncoder().encode(t);

test('candidates: the file with the tab\'s name first, then a renamed one, then the rest', () => {
    const files = ['score/zzz.gp', 'score/pdf-a.gp', 'score/a.gp'].map((path) => ({ path }));
    assert.deepEqual(orderCandidates({ relativePath: 'a.gp' }, files).map((f) => f.path), ['score/a.gp', 'score/pdf-a.gp', 'score/zzz.gp']);
});

test('finds each tab\'s file in the pack\'s score folder by hash, and restores it under the tab', async () => {
    const store = createMemoryStore(); await store.open({ create: true });
    const a = enc('guitar pro one'), b = enc('guitar pro two'), other = enc('not a tab of this song');
    await store.write('packs/p1/score/a.gp', a);
    await store.write('packs/p1/score/renamed-name.gp', b);   // a name that does not match its tab: found by hash
    await store.write('packs/p1/score/other.pdf', other);
    const song = { id: 's1', packId: 'p1', tabOptions: [] };
    const tabs = [
        { id: 't1', name: 'a.gp', relativePath: 'a.gp', sha256: await sha256(a) },
        { id: 't2', name: 'b.gp', relativePath: 'b.gp', sha256: await sha256(b) },
        { id: 't3', name: 'gone.gp', relativePath: 'gone.gp', sha256: await sha256(enc('nowhere')) },
    ];
    const { found, notFound } = await findTabFiles(store, [{ song, tabs }], { packIdOf: (s) => s.packId });
    assert.deepEqual(found.map((f) => [f.tab.id, f.path]), [['t1', 'packs/p1/score/a.gp'], ['t2', 'packs/p1/score/renamed-name.gp']]);
    assert.deepEqual(notFound.map((n) => n.tab.id), ['t3']);

    const saved = [], linked = [];
    const res = await restoreTabFiles(found, {
        saveFile: async (file, provider, meta) => { saved.push([file.name, file.size, provider, meta.songId]); return { id: `${provider}_${file.name}` }; },
        linkTab: async (songId, tabId, upd) => { linked.push([songId, tabId, upd.fileStoreId]); },
    });
    assert.equal(res.restored, 2);
    assert.deepEqual(res.failed, []);
    assert.deepEqual(linked, [['s1', 't1', 'local_a.gp'], ['s1', 't2', 'local_b.gp']]);
    assert.deepEqual(saved[0], ['a.gp', a.length, 'local', 's1']);
});

test('a save that fails leaves that tab alone and the others still restore', async () => {
    const found = [
        { song: { id: 's' }, tab: { id: 'x', relativePath: 'x.gp' }, path: 'score/x.gp', bytes: enc('x') },
        { song: { id: 's' }, tab: { id: 'y', relativePath: 'y.gp' }, path: 'score/y.gp', bytes: enc('y') },
    ];
    const linked = [];
    const res = await restoreTabFiles(found, {
        saveFile: async (file) => { if (file.name === 'x.gp') throw new Error('disk full'); return { id: file.name }; },
        linkTab: async (s, t) => { linked.push(t); },
    });
    assert.equal(res.restored, 1);
    assert.deepEqual(res.failed.map((f) => [f.tab.id, f.reason]), [['x', 'disk full']]);
    assert.deepEqual(linked, ['y']);
});
