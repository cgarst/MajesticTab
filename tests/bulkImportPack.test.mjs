// tests/bulkImportPack.test.mjs: how Bulk import pairs a .mpak: by the song in its manifest, not by its file name.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { pairFromPack, pairFile, coversTitle, closeTitle, sameAlbum, hasVersionTag } = await import('../src/bulkImport/pairing.js');
const { matchTrack } = await import('../src/bulkImport/matcher.js');

console.log('Testing Bulk import with packs...');

// The manifest is the pairing: trailing spaces, accents and the album come through, the file name's "(stems)" never does
const p = pairFromPack({ title: "Space Truckin' ", artist: 'Deep Purple', album: 'Machine Head', length: 275715 });
assert.deepEqual([p.artist, p.title, p.album, p.length, p.via], ['Deep Purple', "Space Truckin'", 'Machine Head', 275715, 'pack']);
assert.equal(pairFromPack({ title: 'Song' }), null, 'no artist: left to the file name');
assert.equal(pairFromPack({}), null);

// A file name that has to be used loses the "(stems)" tag
const named = pairFile({ dirs: ['jammit'], name: 'Dream Theater - Finally Free (stems).mpak' }, 'auto', null);
assert.equal(named.title, 'Finally Free');

// Titles that MusicBrainz gives with the act and scene in front, and with a version tag
assert.ok(closeTitle('Home', 'Act II: Scene Six: Home'));
assert.ok(closeTitle('Overture 1928', 'Act I: Scene Two: I. Overture 1928'));
assert.ok(closeTitle('The Dance of Eternity', 'Act II: Scene Seven: I. The Dance of Eternity'));
assert.ok(closeTitle('Hangar 18', 'Hangar 18 (original stereo mix)'));
assert.ok(!closeTitle('Home', 'Homeward'));
assert.ok(hasVersionTag('Through Her Eyes (alternate album mix)'));
assert.ok(!hasVersionTag('Trial of Tears'));

// Albums: Pt. and Part, commas, a missing "the"
assert.ok(sameAlbum('Metropolis Pt. 2: Scenes from a Memory', 'Metropolis, Pt. 2: Scenes From a Memory'));
assert.ok(sameAlbum('The Colour and Shape', 'The Colour and the Shape'));
assert.ok(!sameAlbum('Awake', 'Images and Words'));
assert.ok(!sameAlbum('Scenes from a Memory', 'The Making of Scenes From a Memory'));

assert.ok(!coversTitle('Act I: Scene Three: II. Fatal Tragedy', 'Through My Words Fatal Tragedy'));
assert.ok(coversTitle('Act I: Scene Two: I. Overture 1928', 'Regression-Overture 1928'));
assert.ok(coversTitle('Home', 'Home'));

// A tracklist: each pack finds its track, a pack that is a part of a long track does not read as another song
const track = (title, n, id) => ({ title, trackNumber: n, recordingMbid: id, length: 200000 });
const resolved = {
    album: { albumMbid: 'a1' },
    data: { artist: 'Dream Theater', title: 'Metropolis, Pt. 2: Scenes From a Memory', releaseGroupId: 'g1', year: 1999, tracks: [
        track('Act I: Scene Two: I. Overture 1928', 2, 'r2'), track('Act I: Scene Five: Home', 9, 'r9'),
        track('Act I: Scene Four: Through Her Eyes', 8, 'r8'), track('Act II: Scene Eight: The Spirit Carries On', 14, 'r14')
    ] }
};
const pick = (title) => matchTrack(pairFromPack({ title, artist: 'Dream Theater', album: 'Metropolis Pt. 2: Scenes from a Memory' }), resolved);
assert.equal(pick('Regression-Overture 1928').recordingMbid, 'r2', 'the pack names two songs, one of them this track');
assert.equal(pick('Overture 1928').recordingMbid, 'r2');
assert.equal(pick('Home').recordingMbid, 'r9');
assert.equal(pick('Through Her Eyes').recordingMbid, 'r8');
assert.equal(pick('The Spirit Carries On').recordingMbid, 'r14');
console.log('Bulk import with packs: ok');
