import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/storage/memoryStore.js';
import { writeJson } from '../src/storage/contract.js';
import { writeStoreInfo } from '../src/storage/storeInfo.js';
import { toLibraryDoc, toProfileDoc, LIBRARY_PATH, PROFILE_PATH } from '../src/storage/libraryDocs.js';
import { LOCATION } from '../src/storage/upgrade.js';
import { findRemoteOrphans, deleteRemoteOrphans } from '../src/storage/orphans.js';

const UPGRADE_MARKER_NAME = 'manifest-UPGRADED.json';

const bytes = (n) => new Uint8Array(n).fill(1);

function makeFakeLegacy({ blobs = [], manifests = [] } = {}) {
    const blobMap = new Map(blobs.map((b) => [b.id, { ...b }]));
    const manMap = new Map(manifests.map((m) => [m.name, { ...m }]));
    return {
        open: async () => true,
        listBlobs: async () => [...blobMap.values()],
        listManifests: async () => [...manMap.values()],
        deleteBlob: async (b) => { blobMap.delete(b.id); },
        deleteManifest: async (m) => { manMap.delete(m.name); },
    };
}

test('NONE and LEGACY locations return empty items without touching anything', async () => {
    const empty = createMemoryStore();
    assert.deepEqual(await findRemoteOrphans({ store: empty }), { state: LOCATION.NONE, items: [], totalBytes: 0 });

    const legacyOnly = makeFakeLegacy({
        blobs: [{ id: 'b1', name: 'abc.bin', size: 120 }],
        manifests: [{ name: 'manifest-1.json' }],
    });
    const res = await findRemoteOrphans({ store: createMemoryStore(), legacy: legacyOnly });
    assert.equal(res.state, LOCATION.LEGACY);
    assert.equal(res.items.length, 0);
});

test('finds and deletes unreferenced packs, incomplete packs, and unreferenced soundfonts', async () => {
    const store = createMemoryStore();
    await store.open({ create: true });
    await writeStoreInfo(store, { appVersion: '1.2.4' });

    await writeJson(store, LIBRARY_PATH, toLibraryDoc({
        songs: [{ id: 'song-keep', title: 'Keep Me', tabOptions: [{ id: 't1', name: 'tab.gp5' }] }],
    }));
    await writeJson(store, PROFILE_PATH, toProfileDoc({
        soundFonts: [{ id: 'sf-keep.sf2', name: 'Keep.sf2', size: 50, addedAt: 1 }],
    }));

    // Referenced pack (with one used score and one leftover unreferenced audio file)
    await writeJson(store, 'packs/song-keep/manifest.json', {
        song: { title: 'Keep Me' },
        scores: [{ id: 'gp', path: 'score/tab.gp5', format: 'gp' }],
    });
    await store.write('packs/song-keep/score/tab.gp5', bytes(100));
    await store.write('packs/song-keep/audio/leftover.mp3', bytes(150));

    // Unreferenced pack
    await writeJson(store, 'packs/song-orphan/manifest.json', { song: { title: 'Orphan Song', artist: 'Nobody' } });
    await store.write('packs/song-orphan/score/tab.gp5', bytes(250));

    // Incomplete pack (no manifest.json)
    await store.write('packs/pack-broken/score/part.gp5', bytes(75));

    // Referenced & unreferenced soundfonts
    await store.write('soundfonts/sf-keep.sf2', bytes(50));
    await store.write('soundfonts/sf-orphan.sf2', bytes(400));

    const found = await findRemoteOrphans({ store });
    assert.equal(found.state, LOCATION.CURRENT);
    assert.equal(found.items.length, 4);
    assert.deepEqual(found.items.map((i) => i.key), [
        'soundfont:sf-orphan.sf2',
        'pack:song-orphan',
        'pack-file:song-keep/audio/leftover.mp3',
        'pack:pack-broken',
    ]);
    assert.equal(found.items[1].label, 'Orphan Song — Nobody');
    assert.equal(found.items[2].detail, 'Unused file in Keep Me');

    await deleteRemoteOrphans({ store }, found.items);

    const after = await findRemoteOrphans({ store });
    assert.equal(after.items.length, 0);
    assert.ok(await store.stat('packs/song-keep/manifest.json'));
    assert.ok(await store.stat('packs/song-keep/score/tab.gp5'));
    assert.equal(await store.stat('packs/song-keep/audio/leftover.mp3'), null);
    assert.ok(await store.stat('soundfonts/sf-keep.sf2'));
    assert.equal(await store.stat('packs/song-orphan/manifest.json'), null);
    assert.equal(await store.stat('packs/pack-broken/score/part.gp5'), null);
    assert.equal(await store.stat('soundfonts/sf-orphan.sf2'), null);
});

test('BOTH state surfaces pre-upgrade snapshots and deletes blobs and manifests when selected', async () => {
    const store = createMemoryStore();
    await store.open({ create: true });
    await writeStoreInfo(store, { appVersion: '1.2.4' });
    await writeJson(store, LIBRARY_PATH, toLibraryDoc({ songs: [] }));
    await writeJson(store, PROFILE_PATH, toProfileDoc({ soundFonts: [] }));

    const legacy = makeFakeLegacy({
        blobs: [{ id: 'b1', name: '1.bin', size: 400 }, { id: 'b2', name: '2.bin', size: 600 }],
        manifests: [{ name: 'manifest-1.json' }, { name: UPGRADE_MARKER_NAME }],
    });

    const found = await findRemoteOrphans({ store, legacy });
    assert.equal(found.state, LOCATION.BOTH);
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].kind, 'legacy');
    assert.equal(found.items[0].label, 'Unused application data');
    assert.equal(found.items[0].size, 1000);
    assert.equal(found.items[0].detail, '2 files');

    await deleteRemoteOrphans({ store, legacy }, found.items);

    const after = await findRemoteOrphans({ store, legacy });
    assert.equal(after.state, LOCATION.CURRENT);
    assert.equal(after.items.length, 0);
});
