// tests/packRepair.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPooledSongs, readRememberedKeys, markPacksForRebuild, rebuildStampOf } from '../src/packRepair.js';

const mem = (init = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
};

test('songs that share a remembered key with audio under it are found', () => {
    const storage = mem({
        yt_song_keys_a: JSON.stringify([{ key: 'X - A' }, { key: 'guitar-1-tablature' }]),
        yt_song_keys_b: JSON.stringify([{ key: 'X - B' }, { key: 'Guitar-1-Tablature' }]),
        yt_song_keys_c: JSON.stringify([{ key: 'X - C' }]),
    });
    const songs = [{ id: 'a', artist: 'X', title: 'A' }, { id: 'b', artist: 'X', title: 'B' }, { id: 'c', artist: 'X', title: 'C' }];
    const audioFiles = [{ id: '1', songKeys: ['X - A', 'guitar-1-tablature'] }, { id: '2', songKeys: ['X - B', 'guitar-1-tablature'] }];
    const found = findPooledSongs({ songs, audioFiles, keysBySong: readRememberedKeys(storage) });
    assert.deepEqual(found.map((f) => f.song.id), ['a', 'b']);
    assert.equal(found[0].files, 2);
});

test('a shared key with no audio under it, or a song\'s own key, is not reported', () => {
    const keysBySong = new Map([['a', ['X - A', 'tab']], ['b', ['X - B', 'tab']]]);
    const songs = [{ id: 'a', artist: 'X', title: 'A' }, { id: 'b', artist: 'X', title: 'B' }];
    assert.equal(findPooledSongs({ songs, audioFiles: [{ id: '1', songKeys: ['X - A'] }], keysBySong }).length, 0);
});

test('marking a song gives it a stamp, and only that song', () => {
    const storage = mem();
    assert.equal(markPacksForRebuild(['a'], { storage, now: 5 }), 1);
    assert.equal(rebuildStampOf('a', storage), 5);
    assert.equal(rebuildStampOf('b', storage), 0);
});

test('a song already marked for rebuild is not listed again', () => {
    const keysBySong = new Map([['a', ['X - A', 'tab']], ['b', ['X - B', 'tab']]]);
    const songs = [{ id: 'a', artist: 'X', title: 'A' }, { id: 'b', artist: 'X', title: 'B' }];
    const audioFiles = [{ id: '1', songKeys: ['X - A', 'tab'] }];
    assert.deepEqual(findPooledSongs({ songs, audioFiles, keysBySong }).map((f) => f.song.id), ['a', 'b']);
    assert.deepEqual(findPooledSongs({ songs, audioFiles, keysBySong, rebuildMarks: { a: 123 } }).map((f) => f.song.id), ['b']);
});
