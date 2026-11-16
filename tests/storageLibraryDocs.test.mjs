// Run with: node --test tests/storageLibraryDocs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toLibraryDoc, fromLibraryDoc, libraryDocErrors, mergeSong, songFromManifest, reconcileLibrary, toProfileDoc, fromProfileDoc,
    settingsToFill, DocError,
} from '../src/storage/libraryDocs.js';

const song = (over = {}) => ({
    id: 'song_1', collectionId: 'default', title: 'T', artist: 'A', album: 'Al', pinned: true, addedAt: 100, lastOpenedAt: 200,
    tunings: ['E A D G B E'], hiddenTunings: [], defaultTabId: 'tab_1', packId: null,
    tabOptions: [{ id: 'tab_1', name: 'Lead', fileStoreId: 'local-42', driveFileId: 'drv', sha256: 'a'.repeat(64), sourceUrl: 'u', fileType: 'gp5' }],
    ...over,
});

test('library doc drops device-local tab ids and keeps everything else, including fields it does not know', () => {
    const doc = toLibraryDoc({ songs: [song({ futureField: { x: 1 } })], collections: [{ id: 'default', name: 'Library' }], recents: [], setlists: [] }, { now: 5 });
    const tab = doc.songs[0].tabOptions[0];
    assert.equal(tab.fileStoreId, undefined);
    assert.equal(tab.driveFileId, undefined);
    assert.equal(tab.sourceUrl, 'u');
    assert.equal('packId' in doc.songs[0], false);
    const back = fromLibraryDoc(JSON.parse(JSON.stringify(doc)));
    assert.deepEqual(back.songs[0].futureField, { x: 1 });
    assert.equal(back.songs[0].pinned, true);
});

test('a library doc from a newer version, or of the wrong kind, or with duplicate ids is refused', () => {
    const doc = toLibraryDoc({ songs: [song()] });
    assert.throws(() => fromLibraryDoc({ ...doc, version: 2 }), /newer version/);
    assert.throws(() => fromLibraryDoc({ ...doc, format: 'other' }), DocError);
    assert.match(libraryDocErrors({ ...doc, songs: [song(), song()] })[0], /duplicate id/);
    assert.match(libraryDocErrors({ ...doc, songs: [{ title: 'x' }] })[0], /no id/);
});

test('merging a song changed on both sides keeps every tab, unions tunings, and takes the later open time', () => {
    const mine = song({ tabOptions: [{ id: 'tab_1', name: 'Mine' }, { id: 'tab_m', name: 'M' }], tunings: ['A'], lastOpenedAt: 300, pinned: true });
    const theirs = song({ tabOptions: [{ id: 'tab_1', name: 'Theirs' }, { id: 'tab_t', name: 'T' }], tunings: ['B'], lastOpenedAt: 250, pinned: false, addedAt: 50 });
    const m = mergeSong(mine, theirs);
    assert.deepEqual(m.tabOptions.map((t) => t.id).sort(), ['tab_1', 'tab_m', 'tab_t']);
    assert.equal(m.tabOptions.find((t) => t.id === 'tab_1').name, 'Mine');
    assert.deepEqual(m.tunings.sort(), ['A', 'B']);
    assert.equal(m.lastOpenedAt, 300);
    assert.equal(m.addedAt, 50);
    assert.equal(m.pinned, true);
});

test('merging repairs a default tab that no longer exists', () => {
    const m = mergeSong(song({ tabOptions: [{ id: 'x' }], defaultTabId: 'gone' }), song({ tabOptions: [], defaultTabId: 'gone' }));
    assert.equal(m.defaultTabId, 'x');
});

const manifest = {
    format: 'mpak', version: 1, id: 'pack-1', createdAt: '2024-05-01T00:00:00Z',
    song: { title: 'Rebuilt', artist: 'Band', album: 'LP', year: 1999, trackNumber: 3, recordingMbid: 'r' },
    scores: [{ id: 'main', path: 'score/a.gp5', format: 'gp5', sha256: 'b'.repeat(64), alternates: [{ id: 'alt', path: 'score/b.pdf', format: 'pdf', sha256: 'c'.repeat(64), startPage: 2, endPage: 3 }] }],
};

test('a song can be rebuilt from a manifest alone, with its tabs and metadata', () => {
    const s = songFromManifest('pack-1', manifest, { now: 1 });
    assert.equal(s.id, 'pack-1');
    assert.equal(s.packId, null);
    assert.equal(s.title, 'Rebuilt');
    assert.equal(s.addedAt, Date.parse('2024-05-01T00:00:00Z'));
    assert.deepEqual(s.tabOptions.map((t) => [t.id, t.fileType, t.isDefault]), [['main', 'gp5', true], ['alt', 'pdf', false]]);
    assert.equal(s.tabOptions[1].startPage, 2);
    assert.equal(s.defaultTabId, 'main');
});

test('a manifest whose id differs from its folder remembers the folder as the pack id', () => {
    assert.equal(songFromManifest('folder', manifest).packId, 'folder');
});

test('reconcile adds songs for packs the index lacks, reports songs whose pack is absent, and removes nothing', () => {
    const doc = toLibraryDoc({ songs: [song({ id: 'song_1' }), song({ id: 'song_gone' })] });
    const r = reconcileLibrary(doc, [{ packId: 'song_1', manifest }, { packId: 'pack-1', manifest }]);
    assert.deepEqual(r.added, ['pack-1']);
    assert.deepEqual(r.orphaned, ['song_gone']);
    assert.deepEqual(fromLibraryDoc(r.doc).songs.map((s) => s.id).sort(), ['pack-1', 'song_1', 'song_gone']);
});

test('reconcile with no library doc builds the whole library from the packs', () => {
    const r = reconcileLibrary(null, [{ packId: 'pack-1', manifest }]);
    assert.equal(fromLibraryDoc(r.doc).songs[0].title, 'Rebuilt');
});

test('profile keeps settings but not the per-song data that packs carry; soundfont list has no bytes', () => {
    const doc = toProfileDoc({
        settings: { theme: 'dark', ytCache: { yt_track_x: 'id' }, audioSync: { k: 1 }, gpTabStrings: { gp_tab_strings_a: '6' } },
        soundFonts: [{ id: 's1', name: 'Piano.sf2', size: 10, addedAt: 1, data: new ArrayBuffer(10) }],
    });
    assert.deepEqual(Object.keys(doc.settings).sort(), ['gpTabStrings', 'theme']);
    assert.equal(doc.soundFonts[0].data, undefined);
    const back = fromProfileDoc(JSON.parse(JSON.stringify(doc)));
    assert.equal(back.settings.theme, 'dark');
    assert.throws(() => fromProfileDoc({ ...doc, version: 9 }), /newer version/);
});

test('settings only fill gaps', () => {
    assert.deepEqual(settingsToFill({ a: 1 }, { a: 2, b: 3 }), { b: 3 });
});

import { createMemoryStore } from '../src/storage/memoryStore.js';
import { updateLibrary, readLibrary } from '../src/storage/libraryDocs.js';

test('two devices adding songs at the same moment both end up in library.json', async () => {
    const s = createMemoryStore(); await s.open({ create: true });
    assert.deepEqual((await readLibrary(s)).songs, []);
    let raced = false;
    await updateLibrary(s, async (lib) => {
        if (!raced) { raced = true; await updateLibrary(s, (l) => ({ ...l, songs: [...l.songs, song({ id: 'from_b' })] })); }
        return { ...lib, songs: [...lib.songs, song({ id: 'from_a' })] };
    });
    assert.deepEqual((await readLibrary(s)).songs.map((x) => x.id).sort(), ['from_a', 'from_b']);
});

import { applyIndexToSong } from '../src/storage/libraryDocs.js';

test('the index laid over an imported song keeps the index fields and gives each tab the stored file of the same score', () => {
    const imported = { id: 'pack-1', title: 'T', pinned: false, collectionId: 'default', tabOptions: [
        { id: 'main', name: 'lead.gp5', sha256: 'a'.repeat(64), fileStoreId: 'file-A' },
        { id: 'alt', name: 'b.pdf', sha256: 'b'.repeat(64), fileStoreId: 'file-B' },
        { id: 'extra', name: 'c.txt', sha256: 'c'.repeat(64), fileStoreId: 'file-C' },
    ] };
    const indexed = { id: 'song_old', title: 'T', pinned: true, collectionId: 'col-2', defaultTabId: 'tab_x', lastOpenedAt: 9, tabOptions: [
        { id: 'tab_x', name: 'My lead', sha256: 'a'.repeat(64), sourceUrl: 'u', fileStoreId: 'foreign', driveFileId: 'drv' },
        { id: 'tab_y', name: 'b.pdf', sha256: null },
    ] };
    const out = applyIndexToSong(imported, indexed);
    assert.equal(out.id, 'pack-1');
    assert.equal(out.pinned, true);
    assert.equal(out.collectionId, 'col-2');
    assert.deepEqual(out.tabOptions.map((t) => [t.id, t.fileStoreId]), [['tab_x', 'file-A'], ['tab_y', 'file-B'], ['extra', 'file-C']]);
    assert.equal(out.tabOptions[0].driveFileId, null);
    assert.equal(out.tabOptions[0].sourceUrl, 'u');
    assert.equal(out.defaultTabId, 'tab_x');
});

test('an index default tab that matches nothing falls back to the first tab', () => {
    const out = applyIndexToSong({ id: 'p', tabOptions: [] }, { id: 'x', defaultTabId: 'gone', tabOptions: [{ id: 't1', sha256: null, name: 'n' }] });
    assert.equal(out.defaultTabId, 't1');
});
