// Run with: node --test tests/audioSync/syncStore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    storageKey, normalizeRecord, loadRecord, saveRecord, deleteRecord, listRecords,
    collectAudioSync, mergeAudioSync, clearAudioSync
} from '../../src/audioSync/syncStore.js';

function fakeStorage() {
    const m = new Map();
    return {
        get length() { return m.size; },
        key: i => [...m.keys()][i] ?? null,
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k)
    };
}
const yt = { kind: 'youtube', videoId: 'abc123' };
const local = { kind: 'local', audioId: 'u1', name: 'take.mp3', durationMs: 90000, fingerprint: 'ff' };
const pts = [
    { id: 'b', barIndex: 4, occurrence: 0, pos: 0, timeMs: 5000, source: 'tap' },
    { id: 'a', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1000, source: 'tap' }
];

test('keys separate songs and recordings', () => {
    assert.equal(storageKey('Artist - Song', yt), 'audio_sync_artist%20-%20song_yt_abc123');
    assert.equal(storageKey('Artist - Song', local), 'audio_sync_artist%20-%20song_local_u1');
    assert.equal(storageKey('x', { kind: 'youtube' }), null);
});

test('save and load round trip, sorted by time', () => {
    const s = fakeStorage();
    const rec = saveRecord('Song', yt, pts, s, 1000);
    assert.equal(rec.updatedAt, 1000);
    const back = loadRecord('Song', yt, s);
    assert.deepEqual(back.points.map(p => p.id), ['a', 'b']);
    assert.deepEqual(loadRecord('Song', local, s), null);
});

test('saving no points removes the entry; delete removes it too', () => {
    const s = fakeStorage();
    saveRecord('Song', yt, pts, s);
    saveRecord('Song', yt, [], s);
    assert.equal(s.length, 0);
    saveRecord('Song', yt, pts, s);
    deleteRecord('Song', yt, s);
    assert.equal(s.length, 0);
});

test('normalize drops malformed points and rejects bad records', () => {
    const rec = normalizeRecord({ version: 1, media: yt, updatedAt: 5, points: [
        { barIndex: 1, timeMs: 10 }, { barIndex: -1, timeMs: 10 }, { barIndex: 1, timeMs: NaN }, { barIndex: 1, pos: 2, timeMs: 1 }, null
    ] });
    assert.equal(rec.points.length, 1);
    assert.equal(rec.points[0].source, 'manual');
    assert.equal(normalizeRecord({ version: 2, media: yt, points: [] }), null);
    assert.equal(normalizeRecord({ version: 1, media: { kind: 'x' }, points: [] }), null);
    const s = fakeStorage();
    s.setItem('audio_sync_song_yt_abc123', '{not json');
    assert.equal(loadRecord('Song', yt, s), null);
});

test('listRecords returns a song\'s recordings newest first', () => {
    const s = fakeStorage();
    saveRecord('Song', yt, pts, s, 100);
    saveRecord('Song', local, pts, s, 200);
    saveRecord('Other', yt, pts, s, 300);
    assert.deepEqual(listRecords('Song', s).map(r => r.media.kind), ['local', 'youtube']);
});

test('collect and merge: newer wins, wipe replaces, junk ignored', () => {
    const a = fakeStorage();
    saveRecord('Song', yt, pts, a, 1000);
    const map = collectAudioSync(a);
    assert.equal(Object.keys(map).length, 1);

    const b = fakeStorage();
    assert.equal(mergeAudioSync(map, {}, b), 1);
    assert.equal(mergeAudioSync(map, {}, b), 0);                         // same age: keep local
    saveRecord('Song', yt, [pts[0]], b, 2000);                           // local edited later
    assert.equal(mergeAudioSync(map, {}, b), 0);
    assert.equal(loadRecord('Song', yt, b).points.length, 1);
    assert.equal(mergeAudioSync(map, { wipe: true }, b), 1);             // wipe: incoming replaces
    assert.equal(loadRecord('Song', yt, b).points.length, 2);
    assert.equal(mergeAudioSync({ other_key: map[Object.keys(map)[0]], audio_sync_x: { version: 9 } }, {}, fakeStorage()), 0);
});

test('clear removes only audio sync entries', () => {
    const s = fakeStorage();
    saveRecord('Song', yt, pts, s);
    s.setItem('yt_track_song_guitar', 'abc');
    clearAudioSync(s);
    assert.equal(s.length, 1);
    assert.equal(s.getItem('yt_track_song_guitar'), 'abc');
});

test('a backing track uses the original recording points when the option is on', async () => {
    const { setSlotMediaResolver, setSyncSharedFromOriginal } = await import('../../src/audioSync/syncStore.js');
    const s = fakeStorage();
    const backing = { kind: 'youtube', videoId: 'bk1' };
    saveRecord('Song', yt, [{ barIndex: 0, timeMs: 0 }, { barIndex: 1, timeMs: 2000 }], s);
    setSlotMediaResolver(() => ({ original: yt, backing }));
    assert.equal(loadRecord('Song', backing, s), null);
    setSyncSharedFromOriginal('Song', true, s);
    const rec = loadRecord('Song', backing, s);
    assert.equal(rec.points.length, 2);
    assert.equal(rec.inherited, true);
    assert.equal(rec.media.videoId, 'bk1');
    // Its own points win once it has some
    saveRecord('Song', backing, [{ barIndex: 0, timeMs: 500 }], s);
    assert.equal(loadRecord('Song', backing, s).points.length, 1);
    setSlotMediaResolver(null);
});

test('the shared-points option travels in backups and merges on', async () => {
    const { setSyncSharedFromOriginal, isSyncSharedFromOriginal } = await import('../../src/audioSync/syncStore.js');
    const a = fakeStorage(), b = fakeStorage();
    setSyncSharedFromOriginal('Song', true, a);
    const map = collectAudioSync(a);
    assert.deepEqual(Object.values(map), [{ shared: true }]);
    mergeAudioSync(map, {}, b);
    assert.ok(isSyncSharedFromOriginal('Song', b));
    clearAudioSync(b);
    assert.ok(!isSyncSharedFromOriginal('Song', b));
});
