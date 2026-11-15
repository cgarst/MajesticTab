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
    const ytWithOrigin = {
        kind: 'youtube', videoId: 'abc123',
        origin: { fromSongKey: 'Other', fromTabName: 'Other.gp5', copiedAt: 500 }
    };
    const rec = saveRecord('Song', ytWithOrigin, pts, s, 1000);
    assert.equal(rec.updatedAt, 1000);
    assert.deepEqual(rec.media.origin, { fromSongKey: 'Other', fromTabName: 'Other.gp5', copiedAt: 500 });
    const back = loadRecord('Song', ytWithOrigin, s);
    assert.deepEqual(back.points.map(p => p.id), ['a', 'b']);
    assert.deepEqual(back.media.origin, { fromSongKey: 'Other', fromTabName: 'Other.gp5', copiedAt: 500 });
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

// --- Music Pack points (record version 2) -----------------------------------------------------------------------

test('a bar record is stored as Music Pack sync points and read back with barIndex', () => {
    const s = fakeStorage();
    saveRecord('Song', yt, pts, s, 7);
    const stored = JSON.parse(s.getItem(storageKey('Song', yt)));
    assert.equal(stored.version, 2);
    assert.equal(stored.anchorType, 'bar');
    assert.deepEqual(stored.points[0], { id: 'a', occurrence: 0, pos: 0, timeMs: 1000, source: 'tap', bar: 0 });
    assert.ok(stored.points.every((p) => !('barIndex' in p)));
    const rec = loadRecord('Song', yt, s);
    assert.equal(rec.anchorType, 'bar');
    assert.deepEqual(rec.points.map((p) => p.barIndex), [0, 4]);
});

test('a version 1 bar record is still read, and a backup of it merges', () => {
    const s = fakeStorage();
    const v1 = { version: 1, media: yt, points: pts, updatedAt: 3 };
    s.setItem(storageKey('Song', yt), JSON.stringify(v1));
    assert.deepEqual(loadRecord('Song', yt, s).points.map((p) => p.barIndex), [0, 4]);
    const t = fakeStorage();
    assert.equal(mergeAudioSync({ [storageKey('Song', yt)]: v1 }, {}, t), 1);
    assert.equal(JSON.parse(t.getItem(storageKey('Song', yt))).version, 2);
});

test('pdf and text records keep their own anchors and survive a backup', () => {
    const s = fakeStorage();
    saveRecord('text:Song', yt, [{ id: 'a', page: 3, x: 0.1, y: 0.2, timeMs: 10, source: 'tap' }, { id: 'b', page: 4, timeMs: 20, source: 'manual' }], s, 5);
    const pdf = loadRecord('text:Song', yt, s);
    assert.equal(pdf.anchorType, 'pdf');
    assert.deepEqual(pdf.points[0], { id: 'a', page: 3, x: 0.1, y: 0.2, timeMs: 10, source: 'tap' });
    saveRecord('text:Song', local, [{ id: 'l', line: 12, col: 4, timeMs: 10, source: 'tap' }], s, 5);
    assert.equal(loadRecord('text:Song', local, s).anchorType, 'text');
    const t = fakeStorage();
    mergeAudioSync(collectAudioSync(s), {}, t);
    assert.deepEqual(loadRecord('text:Song', local, t).points[0], { id: 'l', line: 12, col: 4, timeMs: 10, source: 'tap' });
    assert.equal(loadRecord('text:Song', yt, t).points[1].page, 4);
});

test('malformed Music Pack points are dropped', () => {
    const s = fakeStorage();
    saveRecord('text:Song', yt, [
        { id: 'ok', page: 1, timeMs: 0 },
        { id: 'p0', page: 0, timeMs: 1 },
        { id: 'xy', page: 2, x: 0.5, timeMs: 2 },
        { id: 'big', page: 2, x: 2, y: 0.5, timeMs: 3 },
    ], s, 1);
    assert.deepEqual(loadRecord('text:Song', yt, s).points.map((p) => p.id), ['ok']);
});

test('a version 1 record under a text key is read as units and goes back out as version 1', () => {
    const s = fakeStorage();
    const key = storageKey('text:Song', yt);
    s.setItem(key, JSON.stringify({ version: 1, media: yt, points: [{ id: 'a', barIndex: 3, occurrence: 0, pos: 0, timeMs: 10, source: 'tap' }], updatedAt: 9 }));
    const rec = loadRecord('text:Song', yt, s);
    assert.equal(rec.anchorType, 'unit');
    assert.deepEqual(rec.points.map((p) => p.unit), [3]);
    const t = fakeStorage();
    mergeAudioSync(collectAudioSync(s), {}, t);
    const out = JSON.parse(t.getItem(key));
    assert.equal(out.version, 1, 'a device that has not been updated can still read it');
    assert.equal(out.points[0].barIndex, 3);
});

test('a text or PDF tab takes over the record an earlier version shared between the tabs of a song', async () => {
    const { claimLegacyRecord, scoreSyncKey, legacyScoreSyncKey } = await import('../../src/audioSync/anchors.js');
    const s = fakeStorage();
    const legacyKey = legacyScoreSyncKey('Song');
    const own = scoreSyncKey('Song', 'a'.repeat(64));
    const other = scoreSyncKey('Song', 'b'.repeat(64));

    // a record of pages belongs to a PDF, not to a text tab
    saveRecord(legacyKey, yt, [{ id: 'p', page: 3, timeMs: 10, source: 'tap' }], s, 4, 'pdf');
    assert.equal(claimLegacyRecord('Song', yt, own, 'text', { blocks: [] }, s), null);
    assert.ok(loadRecord(legacyKey, yt, s), 'left for the PDF');
    const pdf = claimLegacyRecord('Song', yt, own, 'pdf', {}, s);
    assert.deepEqual(pdf.points.map((p) => p.page), [3]);
    assert.equal(pdf.updatedAt, 4, 'keeps its time, so a backup of it still merges');
    assert.equal(loadRecord(legacyKey, yt, s), null, 'taken, not copied');
    assert.deepEqual(loadRecord(own, yt, s).points.map((p) => p.page), [3]);
    assert.equal(claimLegacyRecord('Song', yt, other, 'pdf', {}, s), null, 'a second tab finds nothing to take');

    // a version 1 record of units goes to the first tab that asks, as lines
    s.setItem(storageKey(legacyKey, local), JSON.stringify({ version: 1, media: local, updatedAt: 2, points: [{ id: 'u', barIndex: 1, occurrence: 0, pos: 0, timeMs: 5, source: 'tap' }] }));
    const blocks = [{ kind: 'line', start: 0, end: 0 }, { kind: 'system', start: 2, end: 8, staffStart: 3 }];
    const txt = claimLegacyRecord('Song', local, own, 'text', { blocks }, s);
    assert.deepEqual(txt.points.map((p) => p.line), [3]);
    assert.equal(txt.anchorType, 'text');
});
