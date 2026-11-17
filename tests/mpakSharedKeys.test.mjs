// tests/mpakSharedKeys.test.mjs
// A set of packs can share one score file name ("guitar-1-tablature.pdf" is the first score of every stem pack). That name must
// not become a song key shared by all the songs, or each song's pack takes in every other song's audio.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
    key(i) { return [...this._m.keys()][i] ?? null; },
    get length() { return this._m.size; },
};

const { isSongSpecificName } = await import('../src/mpak.js');
const { keysOfOtherSongs } = await import('../src/audioSync/libraryAudio.js');

test('a score name shared by every pack is not a song key', () => {
    assert.equal(isSongSpecificName('guitar-1-tablature', 'Hell’s Kitchen'), false);
    assert.equal(isSongSpecificName('guitar-1-tablature', 'New Millennium'), false);
    assert.equal(isSongSpecificName('guitar-1-tablature', ''), false);
});

test('a score name that carries the title is the song\'s own', () => {
    assert.equal(isSongSpecificName("6 Hell's Kitchen", 'Hell’s Kitchen'), true);
    assert.equal(isSongSpecificName('New Millennium', 'New Millennium'), true);
});

test('keys other songs remember are found, the song\'s own are not', () => {
    const store = new Map();
    const storage = {
        getItem: (k) => store.get(k) ?? null,
        key: (i) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
    };
    store.set('yt_song_keys_a', JSON.stringify([{ key: 'Artist - A' }, { key: 'guitar-1-tablature' }]));
    store.set('yt_song_keys_b', JSON.stringify([{ key: 'Artist - B' }, 'Guitar-1-Tablature']));
    store.set('other_thing', 'x');
    const forA = keysOfOtherSongs('a', storage);
    assert.ok(forA.has('guitar-1-tablature'));
    assert.ok(forA.has('artist - b'));
    assert.ok(!forA.has('artist - a'));
});
