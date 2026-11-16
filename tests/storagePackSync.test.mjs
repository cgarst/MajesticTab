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

test('hybrid mode keeps scores, audio, and SoundFonts remote, settles on repeat sync, and preserves remote audio on edit', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    const audioBytes = new Uint8Array([9, 8, 7, 6]);
    a.addSong('one', 'One', undefined, { audio: audioBytes });
    a.state.fonts.set('f1', { name: 'Font', bytes: new Uint8Array([1, 2, 3]), addedAt: 5 });
    await sync(store, a, baseA);

    // Hybrid device B receives the song's library record without downloading scores, audio, or SoundFont
    const planB = await planPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual(planB.items.map((i) => i.key), ['p:one']);
    const rb = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(rb.downloaded, 1);
    assert.equal(b.state.songs.has('one'), false);
    assert.deepEqual(b.state.records.songs.map((s) => s.id), ['one']);
    assert.equal(b.state.fonts.size, 0);

    // Second sync on hybrid device changes nothing
    const again = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual([again.uploaded, again.downloaded, again.merged, again.removedHere, again.removedThere], [0, 0, 0, 0, 0]);

    // Turning hybrid off downloads the full pack (scores + audio) and SoundFont
    const full = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: false });
    assert.equal(full.downloaded, 2);
    assert.deepEqual(b.state.songs.get('one').audio, audioBytes);

    // Editing a tab on hybrid device B (without local audio) uploads the edit without wiping remote audio
    b.state.songs.get('one').audio = null;
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

test('sync merges tab sources by id, updatedAt, and deletion tombstones instead of overwriting', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    const K = 'majestictab_tab_sources';
    const D = 'majestictab_tab_sources_deleted';

    a.state.settings[K] = [
        { id: 'duckduckgo', name: 'DuckDuckGo', isSeed: true },
        { id: 'src-shared', name: 'Shared Old', urlTemplate: 'https://example.com/old?q=$s', updatedAt: 100 },
        { id: 'src-a', name: 'Source A', urlTemplate: 'https://example.com/a?q=$s', updatedAt: 110 },
        { id: 'src-deleted', name: 'Deleted', urlTemplate: 'https://example.com/del?q=$s', updatedAt: 150 },
    ];
    await sync(store, a, baseA);

    b.state.settings[K] = [
        { id: 'duckduckgo', name: 'DuckDuckGo', isSeed: true },
        { id: 'src-shared', name: 'Shared New', urlTemplate: 'https://example.com/new?q=$s', updatedAt: 200 },
        { id: 'src-b', name: 'Source B', urlTemplate: 'https://example.com/b?q=$s', updatedAt: 210 },
    ];
    b.state.settings[D] = { 'src-deleted': 250 };
    await sync(store, b, baseB);

    const bById = new Map(b.state.settings[K].map((s) => [s.id, s]));
    assert.deepEqual([...bById.keys()].sort(), ['duckduckgo', 'src-a', 'src-b', 'src-shared']);
    assert.equal(bById.get('src-shared').name, 'Shared New');
    assert.equal(b.state.settings[D]['src-deleted'], 250);

    await sync(store, a, baseA);
    const aById = new Map(a.state.settings[K].map((s) => [s.id, s]));
    assert.deepEqual([...aById.keys()].sort(), ['duckduckgo', 'src-a', 'src-b', 'src-shared']);
    assert.equal(aById.get('src-shared').name, 'Shared New');
    assert.equal(a.state.settings[D]['src-deleted'], 250);
});

test('hybrid mode keeps audio local for pinned songs and songs in any setlist', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines(), b = fakeLocal(), baseB = memoryBaselines();
    const audioPinned = new Uint8Array([1, 2, 3, 4]);
    const audioSetlist = new Uint8Array([5, 6, 7, 8]);
    const audioPlain = new Uint8Array([9, 10, 11, 12]);
    const audioLaterSetlist = new Uint8Array([13, 14, 15, 16]);

    a.addSong('pinned-song', 'Pinned', undefined, { audio: audioPinned });
    a.state.records.songs.find((s) => s.id === 'pinned-song').pinned = true;

    a.addSong('setlist-song', 'Setlist', undefined, { audio: audioSetlist });
    a.state.records.setlists.push({ id: 'sl1', name: 'Gig', items: [{ id: 'i1', songId: 'setlist-song', tabId: null }] });

    a.addSong('plain-song', 'Plain', undefined, { audio: audioPlain });
    a.addSong('later-song', 'Later', undefined, { audio: audioLaterSetlist });
    await sync(store, a, baseA);

    // Hybrid device B downloads pinned and setlist songs (scores + audio), but leaves plain/later songs remote-only
    const rb = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(rb.downloaded, 4);
    assert.deepEqual(b.state.songs.get('pinned-song').audio, audioPinned);
    assert.deepEqual(b.state.songs.get('setlist-song').audio, audioSetlist);
    assert.equal(b.state.songs.has('plain-song'), false);
    assert.equal(b.state.songs.has('later-song'), false);

    // Next hybrid sync changes nothing
    const again = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual([again.uploaded, again.downloaded, again.merged], [0, 0, 0]);

    // When a song is later added to a setlist on device A, device B's next hybrid sync downloads it
    a.state.records.setlists[0].items.push({ id: 'i2', songId: 'later-song', tabId: null });
    await sync(store, a, baseA);

    const planB2 = await planPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.deepEqual(planB2.items.map((i) => [i.key, i.action]), [['p:later-song', A.DOWNLOAD]]);
    const rb2 = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(rb2.downloaded, 1);
    assert.deepEqual(b.state.songs.get('later-song').audio, audioLaterSetlist);
    assert.equal(b.state.songs.has('plain-song'), false);

    // When a song is pinned locally on hybrid device B, its next hybrid sync downloads it
    b.state.records.songs.find((s) => s.id === 'plain-song').pinned = true;
    const rb3 = await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(rb3.downloaded, 1);
    assert.deepEqual(b.state.songs.get('plain-song').audio, audioPlain);
});

test('a second device adopts remote packIds for matching legacy song ids instead of duplicating them', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('pack-a-uuid', 'Legacy Song');
    a.state.records.songs[0].id = 'legacy_1';
    a.state.records.songs[0].packId = 'pack-a-uuid';
    await sync(store, a, baseA);

    const b = fakeLocal(), baseB = memoryBaselines();
    b.addSong('pack-b-wrong', 'Legacy Song');
    b.state.records.songs[0].id = 'legacy_1';
    b.state.records.songs[0].packId = 'pack-b-wrong';
    b.adoptPackIds = async (map) => {
        for (const s of b.state.records.songs) {
            const target = map.get(s.id);
            if (!target || s.packId === target) continue;
            const prev = s.packId;
            s.packId = target;
            if (prev && b.state.songs.has(prev)) {
                const song = b.state.songs.get(prev);
                song.id = target;
                b.state.songs.set(target, song);
                b.state.songs.delete(prev);
            }
        }
    };

    const plan = await planPackSync({ store, local: b, baselines: baseB, location: LOC });
    assert.deepEqual(plan.items.map((i) => [i.key, i.action]), [['p:pack-a-uuid', A.MERGE]]);

    const rb = await sync(store, b, baseB);
    assert.deepEqual([rb.merged, rb.downloaded, rb.uploaded], [1, 0, 0]);
    assert.deepEqual(await packIds(store), ['pack-a-uuid']);
    assert.equal((await planPackSync({ store, local: b, baselines: baseB, location: LOC })).items.length, 0);
});

test('plan + apply in hybrid mode skips listing packs/ and skips redundant JSON reads and no-op writes', async () => {
    const store = await newStore();
    const a = fakeLocal(), baseA = memoryBaselines();
    a.addSong('s1', 'Song One');
    a.addSong('s2', 'Song Two');
    a.state.records.songs[1].pinned = true;
    await sync(store, a, baseA);

    const b = fakeLocal(), baseB = memoryBaselines();
    await applyPackSync({ store, local: b, baselines: baseB, location: LOC, hybrid: true });

    const counts = { listPacks: 0, stats: [], reads: new Map(), writes: new Map() };
    const counted = {
        ...store,
        list: (prefix) => { if (prefix === 'packs/') counts.listPacks++; return store.list(prefix); },
        stat: (path) => { if (path.startsWith('packs/')) counts.stats.push(path); return store.stat(path); },
        read: (path, opts) => { counts.reads.set(path, (counts.reads.get(path) || 0) + 1); return store.read(path, opts); },
        write: (path, bytes, opts) => { counts.writes.set(path, (counts.writes.get(path) || 0) + 1); return store.write(path, bytes, opts); },
    };

    const plan = await planPackSync({ store: counted, local: b, baselines: baseB, location: LOC, hybrid: true });
    assert.equal(plan.items.length, 0);
    await applyPackSync({ store: counted, local: b, baselines: baseB, location: LOC, hybrid: true, plan });

    assert.equal(counts.listPacks, 0);
    assert.deepEqual(counts.stats, ['packs/s2/manifest.json']);
    assert.equal(counts.reads.get('profile.json'), 2);
    assert.equal(counts.reads.get('library.json'), 2);
    assert.equal(counts.writes.get('library.json') || 0, 0);
    assert.equal(counts.writes.get('profile.json') || 0, 0);
});
