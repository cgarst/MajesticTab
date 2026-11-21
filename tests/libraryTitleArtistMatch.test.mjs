// Run with: node tests/libraryTitleArtistMatch.test.mjs
// Which song a pack or result with a known artist and title is, when the library has more than one of that title.
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { pickByTitleAndArtist: pick } = await import('../src/libraryStore.js');

const studio = { id: 'a', title: 'Twin', artist: 'X', album: 'Studio' };
const live = { id: 'b', title: 'Twin', artist: 'X', album: 'Live' };
const loose = { id: 'c', title: 'Twin', artist: 'X', album: 'Unknown Album' };

assert.equal(pick([studio, live], { album: 'Live' }).id, 'b', 'the album that matches');
assert.equal(pick([studio], { album: 'Live' }), null, 'a song on another real album is another song');
assert.equal(pick([studio, live], { album: 'Greatest Hits' }), null, 'neither album is it');
assert.equal(pick([loose], { album: 'Live' }).id, 'c', 'a song with no real album yet can take the album');
assert.equal(pick([studio, loose], { album: 'Live' }).id, 'c', 'and is chosen over one on another album');
assert.equal(pick([studio], { album: 'Unknown Album' }).id, 'a', 'a result with no real album still finds the song');
assert.equal(pick([studio], {}).id, 'a');
assert.equal(pick([], { album: 'Live' }), null);
assert.equal(pick([{ ...studio, albumMbid: 'm1' }], { album: '', albumMbid: 'm2' }), null, 'a different album id is another song');
assert.equal(pick([{ ...studio, albumMbid: 'm1' }, { ...live, albumMbid: 'm2' }], { albumMbid: 'm2' }).id, 'b');
assert.equal(pick([{ ...studio, albumMbid: 'm1' }], { album: 'Studio', albumMbid: 'm1' }).id, 'a');
console.log('Title and artist match tests passed!');
