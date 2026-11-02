// Run with: node --test tests/audioSync/jamBridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSyncPayload, readSyncPayload, JAM_SYNC_MAX_POINTS, setJamHosting, setJamGuest, setJamFollowing,
    setSessionSync, isJamHosting, isJamGuestFollowing, sessionPointsFor
} from '../../src/audioSync/jamBridge.js';

const VIDEO = 'eYCYGpu0OxM';
const point = (i, extra = {}) => ({ id: `p${i}`, barIndex: i, occurrence: 0, pos: 0, timeMs: 1000 * (i + 1), source: 'tap', ...extra });
const record = (n) => ({ points: Array.from({ length: n }, (_, i) => point(i)) });

test('the host sends the video and the points, and nothing when there are none', () => {
    const p = buildSyncPayload(VIDEO, record(3));
    assert.equal(p.videoId, VIDEO);
    assert.deepEqual(p.points.map(x => x.barIndex), [0, 1, 2]);
    assert.deepEqual(Object.keys(p.points[0]).sort(), ['barIndex', 'id', 'occurrence', 'pos', 'source', 'timeMs']);
    assert.equal(buildSyncPayload(VIDEO, { points: [] }), null);
    assert.equal(buildSyncPayload(VIDEO, null), null);
    assert.equal(buildSyncPayload(null, record(2)), null);
    assert.equal(buildSyncPayload('not a video id', record(2)), null);
    assert.equal(buildSyncPayload(VIDEO, record(JAM_SYNC_MAX_POINTS + 50)).points.length, JAM_SYNC_MAX_POINTS);
});

test('a guest accepts a good payload and cleans it', () => {
    const wire = JSON.parse(JSON.stringify(buildSyncPayload(VIDEO, record(4))));
    const got = readSyncPayload(wire);
    assert.equal(got.videoId, VIDEO);
    assert.equal(got.points.length, 4);
    // points come back sorted by time and normalised
    const shuffled = readSyncPayload({ videoId: VIDEO, points: [point(2), point(0), point(1)] });
    assert.deepEqual(shuffled.points.map(p => p.timeMs), [1000, 2000, 3000]);
});

test('a guest rejects anything malformed, oversized or hostile', () => {
    assert.equal(readSyncPayload(null), null);
    assert.equal(readSyncPayload('x'), null);
    assert.equal(readSyncPayload({ videoId: VIDEO }), null);
    assert.equal(readSyncPayload({ videoId: '../../etc', points: [point(0)] }), null);
    assert.equal(readSyncPayload({ videoId: VIDEO, points: [] }), null);
    assert.equal(readSyncPayload({ videoId: VIDEO, points: new Array(JAM_SYNC_MAX_POINTS + 1).fill(point(0)) }), null);
    // bad points are dropped, and a payload with none left is refused
    assert.equal(readSyncPayload({ videoId: VIDEO, points: [{ barIndex: -1, timeMs: 5 }, null, 7, { timeMs: NaN }] }), null);
    const mixed = readSyncPayload({ videoId: VIDEO, points: [point(0), { barIndex: 'x' }, point(1)] });
    assert.equal(mixed.points.length, 2);
});

test('the host\'s points apply only to a guest following that video', () => {
    const payload = readSyncPayload(buildSyncPayload(VIDEO, record(3)));
    const media = { kind: 'youtube', videoId: VIDEO };
    assert.equal(sessionPointsFor(media), null);                       // not in a session
    setSessionSync(payload);
    assert.equal(sessionPointsFor(media), null);                       // received, but not a guest
    setJamGuest(true);
    assert.equal(sessionPointsFor(media), null);                       // a guest that is not following yet
    setJamFollowing(true);
    assert.ok(isJamGuestFollowing());
    assert.equal(sessionPointsFor(media).length, 3);
    assert.equal(sessionPointsFor({ kind: 'youtube', videoId: 'aaaaaaaaaaa' }), null);   // another video
    assert.equal(sessionPointsFor({ kind: 'local', audioId: 'x' }), null);               // never for local audio
    setJamFollowing(false);                                            // detached: back to its own points
    assert.ok(!isJamGuestFollowing());
    assert.equal(sessionPointsFor(media), null);
    setJamFollowing(true);
    assert.equal(sessionPointsFor(media).length, 3);
    setJamGuest(false);                                                // leaving forgets them
    assert.equal(sessionPointsFor(media), null);
    setJamGuest(true); setJamFollowing(true);
    assert.equal(sessionPointsFor(media), null);
    setJamGuest(false);
});

test('hosting is tracked on its own', () => {
    assert.ok(!isJamHosting());
    setJamHosting(true);
    assert.ok(isJamHosting() && !isJamGuestFollowing());
    setJamHosting(false);
    assert.ok(!isJamHosting());
});
