// Run with: node --test tests/storagePackSync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { createPackStore } from '../src/storage/packStore.js';
import { writeStoreInfo } from '../src/storage/storeInfo.js';
import { decideItem, planPackSync, applyPackSync, exportLocalToStore, seedItemBaselines, replaceRemoteFromLocal, ITEM_ACTION as A } from '../src/storage/packSync.js';
import { readLibrary } from '../src/storage/libraryDocs.js';
import { fakeLocal, memoryBaselines } from './storage/fakeLocal.mjs';

const LOC = 'test|store';
const newStore = async () => { const s = createMemoryStore(); await s.open({ create: true }); await writeStoreInfo(s); return s; };
const sync = (store, local, baselines) => applyPackSync({ store, local, baselines, location: LOC });
const packIds = async (store) => (await createPackStore(store).listPacks()).map((p) => p.packId).sort();

test('decideItem follows the table', () => {
    const d = (o) => decideItem(o)?.action ?? null;
    assert.equal(d({ l: 'a', r: 1, base: { l: 'a', r: 1 } }), null);
    assert.equal(d({ l: 'b', r: 1, base: { l: 'a', r: 1 } }), A.UPLOAD);
    assert.equal(d({ l: 'a', r: 2, base: { l: 'a', r: 1 } }), A.DOWNLOAD);
    assert.equal(d({ l: 'b', r: 2, base: { l: 'a', r: 1 } }), A.MERGE);
    assert.equal(d({ l: 'a', r: 1 }), A.MERGE);
    assert.equal(d({ l: 'a', base: { l: 'a', r: 1 } }), A.DELETE_LOCAL);
    assert.deepEqual(decideItem({ l: 'b', base: { l: 'a', r: 1 } }), { action: A.UPLOAD, conflict: true });
    assert.equal(d({ r: 1, base: { l: 'a', r: 1 } }), A.DELETE_REMOTE);
    assert.deepEqual(decideItem({ r: 2, base: { l: 'a', r: 1 } }), { action: A.DOWNLOAD, conflict: true });
    assert.equal(d({ l: 'a' }), A.UPLOAD);
    assert.equal(d({ r: 1 }), A.DOWNLOAD);
    assert.equal(d({}), null);
});

test('a tombstone newer than the item removes it on a device with no baseline; an older one does not', () => {
    assert.equal(decideItem({ l: 'a', tombstoneAt: 100, time: 50 }).action, A.DELETE_LOCAL);
    assert.equal(decideItem({ l: 'a', tombstoneAt: 100, time: 150 }).action, A.UPLOAD);
});

test('a location that is not a store is reported, not written to', async () => {
    const s = createMemoryStore(); await s.open({ create: true });
    assert.equal((await planPackSync({ store: s, local: fakeLocal(), baselines: memoryBaselines(), location: LOC })).notAStore, true);
    await assert.rejects(() => sync(s, fakeLocal(), memoryBaselines()), /not a MajesticTab library/);
});

test('first sync from a device uploads its songs; a second device downloads them; a second sync changes nothing', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    const r1 = await sync(store, a, baseA);
    assert.equal(r1.uploaded, 2);
    assert.deepEqual(await packIds(store), ['one', 'two']);

    const b = fakeLocal(), baseB = memoryBaselines();
    const r2 = await sync(store, b, baseB);
    assert.equal(r2.downloaded, 2);
    assert.deepEqual([...b.state.songs.keys()].sort(), ['one', 'two']);

    const again = await sync(store, a, baseA);
    assert.deepEqual([again.uploaded, again.downloaded, again.merged, again.removedHere, again.removedThere], [0, 0, 0, 0, 0]);
    assert.equal((await planPackSync({ store, local: b, baselines: baseB, location: LOC })).items.length, 0);
});

test('an edit on one device reaches the other, and only that pack moves', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    await sync(store, a, baseA); await sync(store, b, baseB);
    a.editSong('one', (s) => s.scores.set('b.gp5', 'second tab'));
    const r = await sync(store, a, baseA);
    assert.deepEqual([r.uploaded, r.downloaded], [1, 0]);
    const rb = await sync(store, b, baseB);
    assert.deepEqual([rb.downloaded, rb.uploaded], [1, 0]);
    assert.equal(b.state.songs.get('one').scores.size, 2);
});

test('a removal on one device removes the song on the other, and a tombstone is left', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    await sync(store, a, baseA); await sync(store, b, baseB);
    a.removeSong('one');
    const r = await sync(store, a, baseA);
    assert.equal(r.removedThere, 1);
    assert.deepEqual(await packIds(store), ['two']);
    assert.ok((await store.stat('tombstones.json')));
    const rb = await sync(store, b, baseB);
    assert.equal(rb.removedHere, 1);
    assert.deepEqual([...b.state.songs.keys()], ['two']);
});

test('an edit here beats a removal there: the song is sent again', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One');
    await sync(store, a, baseA); await sync(store, b, baseB);
    a.removeSong('one'); await sync(store, a, baseA);
    b.editSong('one', (s) => s.scores.set('b.gp5', 'edited after the removal'));
    const rb = await sync(store, b, baseB);
    assert.equal(rb.uploaded, 1);
    assert.equal(rb.conflicts, 1);
    assert.deepEqual(await packIds(store), ['one']);
});

test('a device with no baseline does not bring back a song that was removed, but keeps one added after the removal', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    await sync(store, a, baseA);
    a.removeSong('one'); await sync(store, a, baseA);
    const old = fakeLocal();
    old.addSong('one', 'One', { 'a.gp5': 'one' }, { added: Date.now() - 100000 });   // restored from an old backup
    old.addSong('three', 'Three');
    const r = await sync(store, old, memoryBaselines());
    assert.equal(r.removedHere, 1);
    assert.ok(!old.state.songs.has('one'));
    assert.deepEqual(await packIds(store), ['three', 'two']);
});

test('both devices edit the same pack: the later one merges the other in and sends the result, nothing is lost', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One');
    await sync(store, a, baseA); await sync(store, b, baseB);
    a.editSong('one', (s) => s.scores.set('fromA.gp5', 'A tab'));
    b.editSong('one', (s) => s.scores.set('fromB.gp5', 'B tab'));
    await sync(store, a, baseA);
    const rb = await sync(store, b, baseB);
    assert.equal(rb.merged, 1);
    assert.equal(rb.conflicts, 1);
    assert.deepEqual([...b.state.songs.get('one').scores.values()].sort(), ['A tab', 'B tab', 'one']);
    await sync(store, a, baseA);
    assert.deepEqual([...a.state.songs.get('one').scores.values()].sort(), ['A tab', 'B tab', 'one']);
});

test('a device that already has the song but never synced merges instead of duplicating or overwriting', async () => {
    const store = await newStore();
    const a = fakeLocal(); a.addSong('one', 'One'); await sync(store, a, memoryBaselines());
    const b = fakeLocal(); b.addSong('one', 'One', { 'a.gp5': 'one', 'own.gp5': 'own tab' });
    const r = await sync(store, b, memoryBaselines());
    assert.equal(r.merged, 1);
    assert.equal(r.uploaded, 0);
    const opened = await createPackStore(store).open('one');
    assert.equal(opened.manifest.scores.length, 2);
});

test('a pack another device replaced during the sync is left for the next sync, and the store keeps the other device\'s copy', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('one', 'One');
    await sync(store, a, baseA);
    a.editSong('one', (s) => s.scores.set('mine.gp5', 'mine'));
    // another device writes the manifest between our plan and our upload
    const write = store.write.bind(store);
    let raced = false;
    store.write = async (p, bytes, o) => {
        if (!raced && p === 'packs/one/manifest.json') { raced = true; await write(p, bytes); }   // the other writer
        return write(p, bytes, o);
    };
    const r = await sync(store, a, baseA);
    assert.deepEqual(r.failed.map((f) => f.reason), ['changed elsewhere during the sync']);
    store.write = write;
    assert.ok(baseA.get(LOC).items['p:one'].l !== undefined);
});

test('a failed upload leaves the old pack whole and is retried next time', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('one', 'One');
    await sync(store, a, baseA);
    a.editSong('one', (s) => s.scores.set('b.gp5', 'new'));
    store.failNext('write', new Error('network down'), 'packs/one/score/');
    const r = await sync(store, a, baseA);
    assert.equal(r.failed.length, 1);
    assert.equal((await createPackStore(store).open('one')).manifest.scores.length, 1);
    const r2 = await sync(store, a, baseA);
    assert.deepEqual([r2.uploaded, r2.failed.length], [1, 0]);
    assert.equal((await createPackStore(store).open('one')).manifest.scores.length, 2);
});

test('soundfonts move like packs', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.state.fonts.set('f1', { name: 'Piano.sf2', bytes: new Uint8Array([1, 2, 3]), addedAt: 5 });
    assert.equal((await sync(store, a, baseA)).uploaded, 1);
    assert.equal((await sync(store, b, baseB)).downloaded, 1);
    assert.deepEqual([...b.state.fonts.get('f1').bytes], [1, 2, 3]);
    assert.equal(b.state.fonts.get('f1').name, 'Piano.sf2');
    a.state.fonts.delete('f1');
    await sync(store, a, baseA);
    await sync(store, b, baseB);
    assert.equal(b.state.fonts.size, 0);
});

test('library records: a new song, a changed collection and a setlist travel; settings fill in; removals are carried', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One');
    a.state.records.collections.push({ id: 'default', name: 'Library' });
    a.state.records.setlists.push({ id: 'sl1', name: 'Gig', items: [] });
    a.state.settings.theme = 'dark';
    await sync(store, a, baseA);
    await sync(store, b, baseB);
    assert.equal(b.state.records.setlists[0].name, 'Gig');
    assert.equal(b.state.settings.theme, 'dark');
    assert.equal(b.state.records.collections[0].name, 'Library');
    assert.deepEqual((await readLibrary(store)).songs.map((s) => s.id), ['one']);
    // a rename on b, a removal on a
    b.state.records.setlists[0].name = 'Gig 2';
    a.state.records.collections = [];
    await sync(store, b, baseB);
    await sync(store, a, baseA);
    assert.equal(a.state.records.setlists[0].name, 'Gig 2');
    await sync(store, b, baseB);
    assert.equal(b.state.records.collections.length, 0);
});

test('a song changed on both devices keeps every tab of both', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One');
    await sync(store, a, baseA); await sync(store, b, baseB);
    const tab = (id) => ({ id, name: id, sha256: id.padEnd(64, '0') });
    a.state.records.songs[0].tabOptions = [tab('ta')]; a.state.records.songs[0].pinned = true;
    b.state.records.songs[0].tabOptions = [tab('tb')];
    await sync(store, a, baseA);
    const r = await sync(store, b, baseB);
    assert.equal(r.records.conflicts >= 1, true);
    assert.deepEqual((await readLibrary(store)).songs[0].tabOptions.map((t) => t.id).sort(), ['ta', 'tb']);
});

test('a store from a newer layout stops the sync', async () => {
    const s = createMemoryStore(); await s.open({ create: true });
    await s.write('store.json', new TextEncoder().encode(JSON.stringify({ format: 99 })));
    await assert.rejects(() => sync(s, fakeLocal(), memoryBaselines()), /newer MajesticTab/);
});

test('a song whose id is not a pack id comes back under its own id, not twice', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('P', 'Long id song');
    a.state.records.songs[0].id = 'X'; a.state.records.songs[0].packId = 'P';
    await sync(store, a, baseA);
    assert.deepEqual((await readLibrary(store)).songs.map((s) => [s.id, s.packId]), [['X', 'P']]);
    await sync(store, b, baseB);
    assert.deepEqual(b.state.records.songs.map((s) => [s.id, s.packId]), [['X', 'P']]);
    await sync(store, b, baseB);
    assert.deepEqual((await readLibrary(store)).songs.map((s) => s.id), ['X']);
});

test('the local fingerprint is read from one scan, not once per item', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    for (let i = 0; i < 20; i++) a.addSong(`s${i}`, `S${i}`);
    let scans = 0;
    const items = a.items.bind(a); a.items = async () => { scans++; return items(); };
    await sync(store, a, baseA);
    assert.ok(scans <= 4, `items() scanned ${scans} times for 20 songs`);
});

test('a song a device has just taken in from a pack gets the store\'s record, and the store\'s record is not overwritten by the bare one', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One');
    Object.assign(a.state.records.songs[0], { pinned: true, collectionId: 'col-9', mediumTitle: 'Disc two', tabOptions: [{ id: 'tab_mine', name: 'My lead', sha256: 'a'.repeat(64) }] });
    await sync(store, a, baseA);
    const rb = await sync(store, b, baseB);
    assert.equal(rb.records.pushed, 0);
    const got = b.state.records.songs[0];
    assert.deepEqual([got.pinned, got.collectionId, got.mediumTitle], [true, 'col-9', 'Disc two']);
    assert.deepEqual(got.tabOptions.map((t) => t.id), ['tab_mine']);
    const inStore = (await readLibrary(store)).songs[0];
    assert.deepEqual([inStore.pinned, inStore.collectionId], [true, 'col-9']);
});

test('an upgrade export writes every pack and font, and the seeded baseline makes the first sync move nothing', async () => {
    const a = fakeLocal(), base = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    a.state.fonts.set('f1', { name: 'Font', bytes: new Uint8Array([1, 2, 3]), addedAt: 5 });
    const store = createMemoryStore(); await store.open({ create: true });
    const out = await exportLocalToStore(store, a);
    assert.deepEqual(out.packIds.sort(), ['one', 'two']);
    assert.deepEqual(out.soundFonts.map((f) => f.id), ['f1']);
    assert.equal(out.records.songs.length, 2);
    // the export again sends nothing twice: same sizes are skipped, so an interrupted upgrade resumes
    const writes = []; const w = store.write.bind(store); store.write = async (p, ...r) => { writes.push(p); return w(p, ...r); };
    await exportLocalToStore(store, a);
    assert.deepEqual(writes.filter((p) => p.startsWith('soundfonts/') || p.includes('/score/')), []);
    await writeStoreInfo(store);
    await seedItemBaselines({ store, local: a, baselines: base, location: LOC });
    const plan = await planPackSync({ store, local: a, baselines: base, location: LOC });
    assert.deepEqual(plan.items, []);
    assert.equal(plan.unchanged, 3);
});

test('hybrid mode keeps audio and SoundFonts remote, settles on repeat sync, and preserves remote audio on edit', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    const audioBytes = new Uint8Array([9, 8, 7, 6]);
    a.addSong('one', 'One', undefined, { audio: audioBytes });
    a.state.fonts.set('f1', { name: 'Font', bytes: new Uint8Array([1, 2, 3]), addedAt: 5 });
    await sync(store, a, baseA);

    // Hybrid device B receives the song's tab/metadata without audio or SoundFont
    const planB = await planPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual(planB.items.map((i) => i.key), ['p:one']);
    const rb = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(rb.downloaded, 1);
    assert.equal(b.state.songs.get('one').audio, null);
    assert.equal(b.state.fonts.size, 0);

    // Second sync on hybrid device changes nothing
    const again = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual([again.uploaded, again.downloaded, again.merged, again.removedHere, again.removedThere], [0, 0, 0, 0, 0]);

    // Editing a tab on hybrid device B uploads the edit without wiping remote audio
    b.editSong('one', (s) => s.scores.set('b.gp5', 'edited on hybrid'));
    const up = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(up.uploaded, 1);

    // Full device A receives the tab edit and still has the audio
    const ra = await sync(store, a, baseA);
    assert.equal(ra.downloaded, 1);
    assert.equal(a.state.songs.get('one').scores.get('b.gp5'), 'edited on hybrid');
    assert.ok(await store.stat('packs/one/audio/a.bin'));
});

test('replaceRemoteFromLocal overwrites remote with local state, removes obsolete remote items, and seeds baseline', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    a.addSong('one', 'One'); a.addSong('two', 'Two');
    a.state.fonts.set('f1', { name: 'Font', bytes: new Uint8Array([1, 2, 3]), addedAt: 5 });
    await sync(store, a, baseA);

    b.addSong('three', 'Three');
    const res = await replaceRemoteFromLocal({ store, local: b, baselines: baseB, location: LOC });
    assert.equal(res.uploaded, 1);
    assert.equal(res.removedThere, 3);
    assert.deepEqual(await packIds(store), ['three']);
    assert.equal(await store.stat('soundfonts/f1.sf2'), null);
    assert.deepEqual((await readLibrary(store)).songs.map((s) => s.id), ['three']);

    // Next sync on B finds nothing to do
    const planB = await planPackSync({ store, local: b, baselines: baseB, location: LOC });
    assert.deepEqual(planB.items, []);

    // Device A syncing afterwards converges to B's state
    await sync(store, a, baseA);
    assert.deepEqual([...a.state.songs.keys()], ['three']);
});
