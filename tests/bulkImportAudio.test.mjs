// tests/bulkImportAudio.test.mjs: Bulk import's audio mode, the parts that need no browser.
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { pairFile, cleanAudioTitle } = await import('../src/bulkImport/pairing.js');
const { lookupLibraryAudio, searchLibrarySongs } = await import('../src/bulkImport/matcher.js');
const lib = await import('../src/audioSync/libraryAudio.js');

console.log('Testing Bulk import audio mode...');

// Titles
assert.deepEqual(cleanAudioTitle('Pull Me Under (Official Audio)'), { title: 'Pull Me Under', backing: false });
assert.deepEqual(cleanAudioTitle('Pull Me Under [HQ]'), { title: 'Pull Me Under', backing: false });
assert.deepEqual(cleanAudioTitle('Pull Me Under (Backing Track)'), { title: 'Pull Me Under', backing: true });
assert.deepEqual(cleanAudioTitle('Pull Me Under - Karaoke'), { title: 'Pull Me Under', backing: true });
assert.deepEqual(cleanAudioTitle('7 Rings'), { title: '7 Rings', backing: false });

// Matching
const song = (id, artist, title, album = '', tabs = 1) => ({ id, artist, title, album, tabOptions: Array.from({ length: tabs }, (_, i) => ({ id: `t${i}`, name: 'x.gp5' })) });
const songs = [
    song('1', 'Dream Theater', 'Pull Me Under', 'Images and Words'),
    song('2', 'Dream Theater', 'Another Day', 'Images and Words', 0),
    song('3', 'Metallica', 'One', '...And Justice for All'),
    song('4', 'U2', 'One', 'Achtung Baby'),
    { ...song('5', 'Dream Theater', 'Systematic Chaos', 'Systematic Chaos'), isAlbumTabContainer: true }
];
const parse = (dirs, name) => pairFile({ dirs, name, ext: name.split('.').pop() }, 'auto', null);

let r = lookupLibraryAudio(parse(['Music'], 'Dream Theater - Pull Me Under.mp3'), songs);
assert.equal(r.status, 'library');
assert.equal(r.pick.songId, '1');

r = lookupLibraryAudio(parse(['Music', 'Dream Theater', 'Images and Words'], '01 Pull Me Under.flac'), songs);
assert.equal(r.status, 'library');
assert.equal(r.pick.songId, '1');

// A song with no tab is not a match
r = lookupLibraryAudio(parse(['Music'], 'Dream Theater - Another Day.mp3'), songs);
assert.equal(r.pick, null);
assert.equal(r.status, 'none');

// Title alone is a guess; two songs of that title give a choice
r = lookupLibraryAudio(parse(['Music'], 'Pull Me Under.mp3'), songs);
assert.equal(r.status, 'maybe');
r = lookupLibraryAudio(parse(['Music'], 'One.mp3'), songs);
assert.equal(r.status, 'maybe');
assert.equal(r.candidates.length, 2);
r = lookupLibraryAudio(parse(['Music'], 'U2 - One.mp3'), songs);
assert.equal(r.pick.songId, '4');
assert.equal(r.status, 'library');

// Right title, wrong artist: offered, never chosen
r = lookupLibraryAudio(parse(['Music'], 'Muse - Pull Me Under.mp3'), songs);
assert.equal(r.pick, null);
assert.equal(r.candidates[0].songId, '1');

// Album tab containers are never matched
r = lookupLibraryAudio(parse(['Music'], 'Dream Theater - Systematic Chaos.mp3'), songs);
assert.equal(r.pick, null);

assert.deepEqual(searchLibrarySongs('dream pull', songs).map((s) => s.songId), ['1']);

// Attachments
const s1 = songs[0];
const ids = new Set(['aud1']);
assert.equal(lib.songHasAudioInSlot(s1, 'original', ids), false);
lib.attachLibraryAudio(s1, 'aud1', 'original');
assert.equal(lib.songHasAudioInSlot(s1, 'original', ids), true);
assert.equal(lib.songHasAudioInSlot(s1, 'backing', ids), false);
assert.equal(lib.songHasAudioInSlot(s1, 'original', new Set()), false);
assert.deepEqual(lib.readLibraryAudio('1'), [{ audioId: 'aud1', slot: 'original' }]);
lib.attachLibraryAudio(s1, 'aud1', 'original');
assert.equal(lib.readLibraryAudio('1').length, 1);

console.log('Bulk import audio mode tests passed.');
