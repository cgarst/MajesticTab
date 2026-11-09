// Run with: node --test tests/audioSync/importers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFromUrl, placeBarTimes, setToPoints, setsFittingScore } from '../../src/audioSync/importers/index.js';
import { detectSets, timesToMs } from '../../src/audioSync/importers/detect.js';

const playedBars = (order) => {
    const seen = new Map();
    return order.map(barIndex => {
        const occurrence = seen.get(barIndex) || 0;
        seen.set(barIndex, occurrence + 1);
        return { barIndex, occurrence };
    });
};
const serving = (text) => async () => text;

test('AlphaTab sync text is recognised', () => {
    const sets = detectSets('\\sync 0 0 0\n\\sync 1 0 1500\n');
    assert.deepEqual(sets[0].points.map(p => [p.barIndex, p.timeMs]), [[0, 0], [1, 1500]]);
});

test('a MajesticTab JSON export is recognised', () => {
    const json = JSON.stringify({ version: 1, points: [{ barIndex: 2, occurrence: 0, pos: 0, timeMs: 10 }] });
    assert.equal(detectSets(json)[0].points.length, 1);
});

test('an array of objects that merely holds lists is not mistaken for sync points', () => {
    const sets = detectSets(JSON.stringify([{ id: 1, name: 'a', points: [0, 1, 2] }, { id: 2, name: 'b', points: [0, 1.1, 2.1] }]));
    assert.equal(sets.length, 2);
    assert.ok(sets.every(s => s.barTimesMs));
});

test('lists of bar times are found anywhere in JSON and described by their owner', () => {
    const json = JSON.stringify({
        meta: { total: 3 },
        items: [
            { id: 7, name: 'first', kind: 'main', points: [0, 1.5, 3.25] },
            { id: 8, name: 'second', points: [-0.01, 1.5, 3.3] },
            { name: 'flat', values: [5, 5, 5] },          // does not only go up: not bar times
            { name: 'short', points: [1] }                  // too short
        ]
    });
    const sets = detectSets(json);
    assert.equal(sets.length, 2);
    assert.deepEqual(sets[0].barTimesMs, [0, 1500, 3250]);
    assert.match(sets[0].label, /^1\. 3 bars · name first, kind main$/);
    assert.deepEqual(sets[1].barTimesMs, [-10, 1500, 3300]);
    // a bare array works too
    assert.deepEqual(detectSets('[0, 2.5, 5]')[0].barTimesMs, [0, 2500, 5000]);
});

test('seconds or milliseconds is decided by the typical gap between bars', () => {
    assert.deepEqual(timesToMs([0, 2.5, 5.1]), [0, 2500, 5100]);
    assert.deepEqual(timesToMs([0, 2500, 5100]), [0, 2500, 5100]);
    assert.deepEqual(timesToMs([0, 900.4, 1800.2]), [0, 900, 1800]);
    // integer seconds are still seconds
    assert.deepEqual(timesToMs([0, 3, 6, 9]), [0, 3000, 6000, 9000]);
});

test('anything else is refused, and a web page says so', () => {
    assert.throws(() => detectSets('hello'), /Nothing in that address/);
    assert.throws(() => detectSets('<!DOCTYPE html><html></html>'), /web page/);
    assert.throws(() => detectSets('{"a": [3, 2, 1]}'), /Nothing in that address/);
});

test('loadFromUrl accepts only http(s) addresses and reads what is served', async () => {
    await assert.rejects(loadFromUrl('not a url', serving('')), /web address/);
    await assert.rejects(loadFromUrl('file:///etc/passwd', serving('')), /http/);
    const sets = await loadFromUrl('https://example.com/a', serving('[0, 1, 2]'));
    assert.equal(sets[0].barTimesMs.length, 3);
});

test('bar times land on played bars including repeats, and a count mismatch is refused', () => {
    const pts = placeBarTimes([0, 1000, 2000, 3000], playedBars([0, 1, 1, 2]));
    assert.deepEqual(pts.map(p => [p.barIndex, p.occurrence]), [[0, 0], [1, 0], [1, 1], [2, 0]]);
    assert.throws(() => placeBarTimes([0, 1000], playedBars([0, 1, 2])), /2 bars.*plays 3/);
    // equal times are nudged apart so the list stays strictly increasing
    assert.deepEqual(placeBarTimes([5, 5, 5], playedBars([0, 1, 2])).map(p => p.timeMs), [5, 6, 7]);
    assert.deepEqual(setToPoints({ points: [1] }, []), [1]);
});

test('only the lists that fit the score are offered', () => {
    const sets = [{ label: 'a', barTimesMs: [0, 1] }, { label: 'b', barTimesMs: [0, 1, 2] }, { label: 'p', points: [] }];
    assert.deepEqual(setsFittingScore(sets, playedBars([0, 1, 2])).map(s => s.label), ['b', 'p']);
    assert.throws(() => setsFittingScore([sets[0]], playedBars([0, 1, 2])), /lists of 2 bars.*plays 3/);
});

test('a list longer than the score is read from the first bar and the extra times are left out', () => {
    const times = Array.from({ length: 8 }, (_, i) => i * 1000);
    const bars = playedBars([0, 1, 2, 3]).map(b => ({ ...b, seconds: 1 }));
    const info = {};
    const pts = placeBarTimes(times, bars, info);
    assert.deepEqual(pts.map(p => [p.barIndex, p.timeMs]), [[0, 0], [1, 1000], [2, 2000], [3, 3000]]);
    assert.equal(info.extra, 4);
    assert.deepEqual(setsFittingScore([{ label: 'a', barTimesMs: times }], bars).map(s => s.label), ['a']);
    // nothing to place the times on: still refused
    assert.throws(() => placeBarTimes(times, [], {}), /8 bars.*plays 0/);
});

test('a list with one repeated time is still bar times', () => {
    const times = Array.from({ length: 40 }, (_, i) => i * 2 + 1);
    times[21] = times[20];
    const sets = detectSets(JSON.stringify([{ id: 1, points: times }]));
    assert.equal(sets.length, 1);
    assert.equal(sets[0].barTimesMs.length, 40);
});

test('a shorter list is placed on the start of the score only when its gaps follow the bar lengths', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ barIndex: i, occurrence: 0, seconds: 2 }));
    const times = Array.from({ length: 15 }, (_, i) => 5000 + i * 2050); // a little off, like real data
    const info = {};
    const pts = placeBarTimes(times, bars, info);
    assert.equal(pts.length, 15);
    assert.equal(info.covered, 15);
    assert.equal(pts[14].barIndex, 14);
    assert.equal(setsFittingScore([{ label: 'a', barTimesMs: times }], bars).length, 1);
    // gaps that do not follow the bars (a different structure) are still refused
    const wrong = Array.from({ length: 15 }, (_, i) => i * 3500);
    assert.throws(() => placeBarTimes(wrong, bars), /15 bars.*plays 20/);
    // without bar lengths a short list is refused, as before
    assert.throws(() => placeBarTimes(times, bars.map(b => ({ barIndex: b.barIndex, occurrence: 0 }))), /plays 20/);
    // too little of the score is not a start
    assert.throws(() => placeBarTimes(times.slice(0, 5), bars), /plays 20/);
});

test('a list with one time per score bar is placed on the first pass of each bar', () => {
    const bars = playedBars([0, 1, 2, 1, 2, 3]); // bars 1-2 repeat: 6 played, 4 without repeats
    const info = {};
    const pts = placeBarTimes([0, 1000, 2000, 3000], bars, info);
    assert.deepEqual(pts.map(p => [p.barIndex, p.occurrence]), [[0, 0], [1, 0], [2, 0], [3, 0]]);
    assert.equal(info.firstPassOnly, true);
    assert.equal(setsFittingScore([{ label: 'a', barTimesMs: [0, 1, 2, 3] }], bars).length, 1);
    assert.throws(() => placeBarTimes([0, 1, 2, 3, 4], bars), /5 bars.*plays 6 \(4 without its repeats\)/);
});
