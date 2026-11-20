// Duplicate songs that hold tabs can be folded into the kept copy; the audio they had follows.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
    get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k)
};
const { findDuplicateSongs } = await import('../src/libraryDuplicates.js');
const { adoptSongAudio, readLibraryAudio, songAudioKeys } = await import('../src/audioSync/libraryAudio.js');

const mk = (id, extra = {}) => ({ id, artist: 'Dream Theater', album: 'Awake', title: 'Voices', tabOptions: [], addedAt: 1, ...extra });

test('copies that hold tabs are listed to merge, empty ones to remove, and a pack decides which stays', () => {
    const a = mk('a', { tabOptions: [{ id: 't1' }], addedAt: 1 });
    const b = mk('b', { tabOptions: [{ id: 't2' }], packId: 'p', addedAt: 2 });
    const c = mk('c');
    const [g] = findDuplicateSongs([a, b, c]);
    assert.equal(g.keep.id, 'b');
    assert.deepEqual(g.merge.map((s) => s.id), ['a']);
    assert.deepEqual(g.remove.map((s) => s.id), ['c']);
});

test('merging audio moves the attachments and remembered keys to the kept song', () => {
    const from = mk('from');
    const to = mk('to');
    localStorage.setItem('audio_lib_from', JSON.stringify([{ audioId: 'x', slot: 'original' }]));
    localStorage.setItem('yt_song_keys_from', JSON.stringify(['A Mind Beside Itself II. Voices']));
    adoptSongAudio(from, to);
    assert.deepEqual(readLibraryAudio('to'), [{ audioId: 'x', slot: 'original' }]);
    assert.ok(songAudioKeys(to).includes('A Mind Beside Itself II. Voices'));
    assert.equal(localStorage.getItem('audio_lib_from'), null);
});
