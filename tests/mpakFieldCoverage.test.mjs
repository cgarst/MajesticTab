// tests/mpakFieldCoverage.test.mjs
// Which library song fields a .mpak carries. Builds a pack from a song with every field filled, reads it back, and
// compares. The fields a pack does not carry are listed in KNOWN_LOST on purpose: they live in the library index, not in
// the pack. When the format starts carrying one, this test fails until the list is updated, so the gap cannot widen or
// close unnoticed. (A full IndexedDB round trip needs a browser; this runs in Node.)
import test from 'node:test';
import assert from 'node:assert/strict';

// Node has no localStorage; buildMpak reads a few keys from it.
globalThis.localStorage ??= {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};

const { buildMpak, readMpak } = await import('../src/mpak.js');

const MB = {
    recording: '11111111-1111-4111-8111-111111111111',
    artist: '22222222-2222-4222-8222-222222222222',
    group: '33333333-3333-4333-8333-333333333333',
};

// Every field saveSongToLibrary writes (libraryStore.js), plus the tab-option fields.
const librarySong = {
    id: 'song_1700000000000_ab12c',
    collectionId: 'col-2',
    title: 'Roundtrip Song',
    artist: 'Test Artist',
    artistMbid: MB.artist,
    album: 'Test Album',
    albumMbid: MB.group,
    year: 1999,
    length: 215000,
    trackNumber: 4,
    mediumNumber: 2,
    mediumTitle: 'Disc two',
    mediumFormat: 'CD',
    recordingMbid: MB.recording,
    coverUrl: 'https://example.invalid/cover.jpg',
    tunings: ['E A D G B E'],
    hiddenTunings: ['D A D G B E'],
    stringCount: 6,
    defaultTabId: 'tab_1',
    pinned: true,
    isCustom: false,
    folderPath: null,
    isAlbumTabContainer: false,
    addedAt: 1700000000000,
    lastOpenedAt: 1710000000000,
    tabOptions: [{
        id: 'tab_1', name: 'My lead tab', sourceUrl: 'https://example.invalid/t', sourceWebsite: 'example.invalid',
        tuningSource: 'detected', isDefault: true, addedAt: 1700000000500, fileType: 'txt',
    }],
};

const score = new File([new TextEncoder().encode('e|---0---|\nB|---1---|\n')], 'lead.txt', { type: 'text/plain' });
score.librarySongId = librarySong.id;
score.tabId = 'tab_1';

const built = await buildMpak(score, { song: librarySong, songKey: 'Test Artist - Roundtrip Song', scores: [] });
const { header } = await readMpak(new Uint8Array(await built.blob.arrayBuffer()));
const song = header.song;

// What a pack carries of the song record, by library field name -> where it comes back in the pack.
const CARRIED = {
    id: header.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    length: song.length,
    trackNumber: song.trackNumber,
    mediumNumber: song.mediumNumber,
    recordingMbid: song.recordingMbid,
    artistMbid: song.artistMbid,
    albumMbid: song.albumMbid,
};

// Library fields with no place in the pack. They belong to the library index (or, for ids, need a spec decision).
const KNOWN_LOST = [
    'collectionId', 'pinned', 'addedAt', 'lastOpenedAt', 'defaultTabId', 'hiddenTunings',
    'mediumTitle', 'mediumFormat', 'coverUrl', 'tunings', 'stringCount', 'isCustom', 'folderPath', 'isAlbumTabContainer',
];

test('the song fields a pack carries come back equal', () => {
    for (const [field, got] of Object.entries(CARRIED)) {
        assert.equal(got, librarySong[field], `${field} did not survive the pack`);
    }
});

test('the fields a pack does not carry are exactly the known list', () => {
    const carriedByPack = new Set(Object.keys(CARRIED));
    const lost = Object.keys(librarySong).filter((k) => k !== 'tabOptions' && !carriedByPack.has(k)).sort();
    assert.deepEqual(lost, [...KNOWN_LOST].sort(),
        'a field was added to or dropped from what the pack carries: update CARRIED / KNOWN_LOST and the library-index plan');
});

test('the tab option fields the pack drops are exactly the known list', () => {
    const entry = header.scores[0];
    const packKeys = new Set(Object.keys(entry));
    const tab = librarySong.tabOptions[0];
    // sourceUrl, sourceWebsite, addedAt, isDefault, tuningSource, name and id have no manifest field
    const lost = ['sourceUrl', 'sourceWebsite', 'addedAt', 'isDefault', 'tuningSource'].filter((k) => !packKeys.has(k));
    assert.deepEqual(lost, ['sourceUrl', 'sourceWebsite', 'addedAt', 'isDefault', 'tuningSource']);
    assert.ok(tab.name);
});

test('every score entry has a hash and a size (SPEC section 4, Integrity)', async () => {
    const bytes = new Uint8Array(await score.arrayBuffer());
    for (const s of header.scores) {
        assert.match(s.sha256, /^[0-9a-f]{64}$/);
        assert.equal(s.size, bytes.length);
    }
});

test('the pack carries the library song id as its own id when a pack can use it (SPEC section 4)', () => {
    assert.equal(header.id, librarySong.id);
});

test('a song whose id is too long for a pack gets another id, which is not the metadata-derived one', async () => {
    const long = { ...librarySong, id: `song_${MB.artist}_${MB.group}_m2_${MB.recording}`, packId: null };
    assert.ok(long.id.length > 64);
    const again = await buildMpak(score, { song: long, songKey: 'Test Artist - Roundtrip Song', scores: [] });
    const { header: h } = await readMpak(new Uint8Array(await again.blob.arrayBuffer()));
    assert.match(h.id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.notEqual(h.id, long.id);
    // a song that remembers its pack id keeps writing it
    const kept = await buildMpak(score, { song: { ...long, packId: 'kept-pack-id' }, songKey: 'Test Artist - Roundtrip Song', scores: [] });
    assert.equal((await readMpak(new Uint8Array(await kept.blob.arrayBuffer()))).header.id, 'kept-pack-id');
});
