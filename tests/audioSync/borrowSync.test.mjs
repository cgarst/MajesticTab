// Run with: node --test tests/audioSync/borrowSync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOffsetMs, isConfident, borrowableRecords, borrowRecord } from '../../src/audioSync/borrowSync.js';
import { saveRecord, loadRecord } from '../../src/audioSync/syncStore.js';

function fakeStorage() {
    const m = new Map();
    return {
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
}
const a = { kind: 'local', audioId: 'a', name: 'a.mp3', durationMs: 60000, fingerprint: '1' };
const b = { kind: 'local', audioId: 'b', name: 'b.mp3', durationMs: 62000, fingerprint: '2' };
const bars = (...ms) => ms.map((t, i) => ({ id: `p${i}`, barIndex: i, occurrence: 0, pos: 0, timeMs: t, source: 'tap' }));

// A pseudo-random "song" envelope at 50 peaks per second
function envelope(seconds, seed = 7) {
    let x = seed;
    const out = new Uint8Array(seconds * 50);
    for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = 40 + (x % 200); }
    return out;
}

test('the offset is found when one recording has a longer lead-in', () => {
    const song = envelope(40);
    const lead = 3 * 50; // 3 s of near silence first
    const withLead = new Uint8Array(song.length + lead);
    withLead.fill(2, 0, lead);
    withLead.set(song, lead);
    const est = estimateOffsetMs(song, withLead);
    assert.equal(est.offsetMs, 3000);
    assert.ok(isConfident(est));
    assert.equal(estimateOffsetMs(withLead, song).offsetMs, -3000);
});

test('unrelated recordings are not confident', () => {
    const est = estimateOffsetMs(envelope(40, 1), envelope(40, 99));
    assert.ok(!isConfident(est));
});

test('too short or silent peaks give no estimate', () => {
    assert.equal(estimateOffsetMs(new Uint8Array(10), new Uint8Array(10)), null);
    assert.equal(estimateOffsetMs(new Uint8Array(500), envelope(10)), null);
});

test('borrowing shifts every point and keeps the first recording\'s points', () => {
    const s = fakeStorage();
    saveRecord('Song', a, bars(1000, 5000, 9000), s, 1);
    const [from] = borrowableRecords('Song', b, 'bar', s);
    assert.equal(from.media.audioId, 'a');
    const rec = borrowRecord('Song', from, b, 2500, { storage: s });
    assert.deepEqual(rec.points.map((p) => p.timeMs), [3500, 7500, 11500]);
    assert.deepEqual(loadRecord('Song', a, s).points.map((p) => p.timeMs), [1000, 5000, 9000]);
});

test('a negative shift drops points before the start', () => {
    const s = fakeStorage();
    saveRecord('Song', a, bars(1000, 5000), s, 1);
    const rec = borrowRecord('Song', borrowableRecords('Song', b, null, s)[0], b, -2000, { storage: s });
    assert.deepEqual(rec.points.map((p) => p.timeMs), [3000]);
});

test('points already made for the recording are kept unless replace is set', () => {
    const s = fakeStorage();
    saveRecord('Song', a, bars(1000), s, 1);
    saveRecord('Song', b, bars(7000), s, 1);
    const from = borrowableRecords('Song', b, null, s)[0];
    assert.equal(borrowRecord('Song', from, b, 0, { storage: s }), null);
    assert.equal(borrowRecord('Song', from, b, 0, { storage: s, replace: true }).points[0].timeMs, 1000);
});

test('records of another score key are not listed', () => {
    const s = fakeStorage();
    saveRecord('score:abc:Song', a, [{ page: 1, timeMs: 100, source: 'tap' }], s, 1, 'pdf');
    assert.equal(borrowableRecords('score:def:Song', b, null, s).length, 0);
    assert.equal(borrowableRecords('score:abc:Song', b, 'bar', s).length, 0);
    assert.equal(borrowableRecords('score:abc:Song', b, 'pdf', s).length, 1);
});
