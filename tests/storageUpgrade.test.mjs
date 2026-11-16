// Run with: node --test tests/storageUpgrade.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { createPackStore } from '../src/storage/packStore.js';
import { readStoreInfo, writeStoreInfo, StoreTooNewError, STORE_FORMAT } from '../src/storage/storeInfo.js';
import { probeLocation, needsUpgrade, upgradeLocation, UpgradeError, LOCATION } from '../src/storage/upgrade.js';
import { readLibrary } from '../src/storage/libraryDocs.js';
import { writeJson } from '../src/storage/contract.js';
import { buildMpak, concatParts, bytesSource, sha256 } from '../src/mpak/core/index.js';

const enc = new TextEncoder();
const legacyBackend = (manifests = [], blobs = [], exists = true) => ({
    label: 'fake', async open() { return exists; }, async listManifests() { return manifests; }, async listBlobs() { return blobs; },
});
const fresh = async () => { const s = createMemoryStore(); await s.open({ create: true }); return s; };
const unopened = () => createMemoryStore();

async function packFiles(id) {
    const score = enc.encode(`tab ${id}`);
    const manifest = { format: 'mpak', version: 1, id, song: { title: id, artist: 'A' }, scores: [{ id: 'main', path: 'score/a.gp5', format: 'gp5', sha256: await sha256(score), size: score.length }] };
    return concatParts((await buildMpak(manifest, { 'score/a.gp5': score })).parts);
}

test('probe tells the four states apart, and a half-made new layout is legacy with partial set', async () => {
    const old = legacyBackend([{ name: 'manifest-x.json' }]);
    assert.equal((await probeLocation({ legacy: legacyBackend([], [], false), current: unopened() })).state, LOCATION.NONE);
    assert.equal((await probeLocation({ legacy: old, current: unopened() })).state, LOCATION.LEGACY);
    const cur = await fresh(); await writeStoreInfo(cur);
    assert.equal((await probeLocation({ legacy: legacyBackend([], [], false), current: cur })).state, LOCATION.CURRENT);
    assert.equal((await probeLocation({ legacy: old, current: cur })).state, LOCATION.BOTH);
    const partial = await fresh(); await partial.write('packs/p/manifest.json', new Uint8Array([1]));
    const probe = await probeLocation({ legacy: old, current: partial });
    assert.deepEqual([probe.state, probe.partial], [LOCATION.LEGACY, true]);
    assert.equal(needsUpgrade(probe), true);
    assert.equal(needsUpgrade({ state: LOCATION.NONE }), false);
    assert.equal(needsUpgrade({ state: LOCATION.BOTH }), false);
});

test('a store from a newer layout is refused', async () => {
    const s = await fresh();
    await writeJson(s, 'store.json', { format: STORE_FORMAT + 1, minApp: '9.0' });
    await assert.rejects(() => readStoreInfo(s), StoreTooNewError);
    await assert.rejects(() => probeLocation({ legacy: null, current: s }), /newer MajesticTab/);
});

test('store.json is written once: the second writer is told it lost', async () => {
    const s = await fresh();
    assert.equal(await writeStoreInfo(s, { appVersion: '1.0' }), true);
    assert.equal(await writeStoreInfo(s, { appVersion: '1.1' }), false);
    assert.equal((await readStoreInfo(s)).createdBy.version, '1.0');
});

const songs = [{ id: 'one', title: 'One', tabOptions: [{ id: 't' }] }, { id: 'two', title: 'Two', tabOptions: [{ id: 't' }] }];
const exporter = (ids = ['one', 'two']) => async (store) => {
    const packs = createPackStore(store);
    for (const id of ids) await packs.importMpak(id, bytesSource(await packFiles(id)));
    return { packIds: ids, records: { songs, collections: [], recents: [], setlists: [] }, settings: { theme: 'dark' }, soundFonts: [] };
};

test('upgrade syncs first, writes packs and documents, checks, and writes store.json last', async () => {
    const cur = await fresh();
    const order = [];
    const writes = [];
    const w = cur.write.bind(cur); cur.write = async (p, ...r) => { writes.push(p); return w(p, ...r); };
    const r = await upgradeLocation({
        legacy: legacyBackend([{ name: 'm' }]), current: cur, appVersion: '1',
        syncWithLegacy: async () => order.push('sync'), exportToStore: async (s, p) => { order.push('export'); return exporter()(s, p); },
    });
    assert.deepEqual(order, ['sync', 'export']);
    assert.deepEqual(r, { state: 'upgraded', packs: 2, markerWritten: false });
    assert.equal(writes.at(-1), 'store.json');
    assert.deepEqual((await readLibrary(cur)).songs.map((s) => s.id), ['one', 'two']);
    assert.equal((await probeLocation({ legacy: legacyBackend([{ name: 'm' }]), current: cur })).state, LOCATION.BOTH);
});

test('the old layout is marked after store.json, and a failing mark does not undo the upgrade', async () => {
    const cur = await fresh();
    const order = [];
    const w = cur.write.bind(cur); cur.write = async (p, ...r) => { order.push(p); return w(p, ...r); };
    const r = await upgradeLocation({ legacy: legacyBackend([{ name: 'm' }]), current: cur, syncWithLegacy: async () => {}, exportToStore: exporter(), markLegacy: async () => order.push('marker') });
    assert.deepEqual([r.state, r.markerWritten], ['upgraded', true]);
    assert.deepEqual(order.slice(-2), ['store.json', 'marker']);
    const cur2 = await fresh();
    const r2 = await upgradeLocation({ legacy: legacyBackend([{ name: 'm' }]), current: cur2, syncWithLegacy: async () => {}, exportToStore: exporter(), markLegacy: async () => { throw new Error('read only'); } });
    assert.deepEqual([r2.state, r2.markerWritten], ['upgraded', false]);
    assert.ok(await cur2.stat('store.json'));
});

test('a problem found while checking leaves no store.json, so the location still reads as legacy and can be retried', async () => {
    const cur = await fresh();
    const legacy = legacyBackend([{ name: 'm' }]);
    await assert.rejects(() => upgradeLocation({ legacy, current: cur, syncWithLegacy: async () => {}, exportToStore: exporter(['one']) }),
        (e) => e instanceof UpgradeError && e.problems.some((p) => /Two/.test(p)));
    assert.equal(await cur.stat('store.json'), null);
    const probe = await probeLocation({ legacy, current: cur });
    assert.deepEqual([probe.state, probe.partial], [LOCATION.LEGACY, true]);
    // retry with everything this time: resumes and finishes
    assert.equal((await upgradeLocation({ legacy, current: cur, syncWithLegacy: async () => {}, exportToStore: exporter() })).state, 'upgraded');
});

test('a failed sync or export stops before anything is marked done', async () => {
    const cur = await fresh();
    await assert.rejects(() => upgradeLocation({ legacy: legacyBackend([{ name: 'm' }]), current: cur, syncWithLegacy: async () => { throw new Error('offline'); }, exportToStore: exporter() }), /offline/);
    assert.equal(await cur.stat('store.json'), null);
    assert.deepEqual(await cur.list(), []);
});

test('two devices upgrading at once: the one that loses reports already-upgraded and the store stays whole', async () => {
    const cur = await fresh();
    const legacy = legacyBackend([{ name: 'm' }]);
    const a = upgradeLocation({ legacy, current: cur, syncWithLegacy: async () => {}, exportToStore: exporter() });
    const b = upgradeLocation({ legacy, current: cur, syncWithLegacy: async () => {}, exportToStore: exporter() });
    const states = (await Promise.all([a, b])).map((r) => r.state).sort();
    assert.deepEqual(states, ['already-upgraded', 'upgraded']);
    assert.equal((await createPackStore(cur).listPacks()).length, 2);
});

test('nothing to upgrade, or already upgraded, is reported without touching anything', async () => {
    const empty = await fresh();
    await assert.rejects(() => upgradeLocation({ legacy: legacyBackend([], [], false), current: empty, syncWithLegacy: async () => {}, exportToStore: exporter() }), /no earlier backup/);
    const cur = await fresh(); await writeStoreInfo(cur);
    assert.deepEqual(await upgradeLocation({ legacy: legacyBackend([{ name: 'm' }]), current: cur, syncWithLegacy: async () => { throw new Error('no'); }, exportToStore: exporter() }), { state: 'already-upgraded' });
});
