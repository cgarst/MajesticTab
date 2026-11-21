// Run with: node tests/songKey.test.mjs
// The key a library song's audio, slots, videos and sync hang off: plain for most songs, its own for one that shares an artist and title.
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { baseSongKey, songKeyFor, ownSongKey, assignOwnSongKey, plainOwnKey, SONG_KEY_MARK } = await import('../src/songKey.js');
const { plainSongKey } = await import('../src/mpakSession.js');
const { isAudioChoiceKey, libraryAudioKey } = await import('../src/audioSync/libraryAudio.js');

const a = { id: 'song_1', artist: 'X', title: 'Twin', album: 'Studio' };
const b = { id: 'song_2', artist: 'X', title: 'Twin', album: 'Live' };
assert.equal(baseSongKey(a), 'X - Twin');
assert.equal(baseSongKey({ title: 'Only' }), 'Only');
assert.equal(songKeyFor(a), 'X - Twin', 'a song that never collided keeps the plain key');
assert.equal(ownSongKey('song_2'), null);

const own = assignOwnSongKey(b);
assert.ok(own.startsWith(SONG_KEY_MARK) && own.includes('song_2') && own.endsWith('X - Twin'));
assert.equal(songKeyFor(b), own);
assert.equal(songKeyFor(a), 'X - Twin', 'the first song is untouched');
assert.notEqual(songKeyFor(a), songKeyFor(b));
assert.equal(libraryAudioKey(b), own, 'bulk import files audio under the same key');
assert.equal(libraryAudioKey(a), 'X - Twin');
assert.equal(plainOwnKey(own), 'X - Twin', 'a person reads the plain key');
assert.equal(plainSongKey(own), 'X - Twin');
assert.equal(plainSongKey('mpak~abc-123 X - Twin'), 'X - Twin');
assert.ok(isAudioChoiceKey('audio_key_song_2'), 'the key travels with the other audio choices in a backup');
assert.equal(songKeyFor(null), '');
console.log('Song key tests passed!');
