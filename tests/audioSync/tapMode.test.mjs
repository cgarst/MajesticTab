// Run with: node --test tests/audioSync/tapMode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBeatMap, candidatesForBeat, entryAt, nextTarget, firstUnsyncedTarget } from '../../src/audioSync/beatMap.js';
import { chooseTap, patchPlan, rangePlan } from '../../src/audioSync/tapRules.js';

// A fake of AlphaTab's lookup: bars of 1920 ticks with beats every 480 ticks, play order 0 1 2 1 2 3.
function fakeLookup(order) {
    return {
        masterBars: order.map((barIndex, i) => {
            const slices = [0, 480, 960, 1440].map(start => ({ start, highlightedBeats: [{ beat: { id: `${barIndex}@${start}`, voice: { bar: { masterBar: { index: barIndex } } }, playbackStart: start } }] }));
            slices.forEach((s, k) => { s.nextBeat = slices[k + 1] || null; });
            // a second slice for the same beat, as AlphaTab emits for long beats: it must not add a second entry
            const dup = { start: 240, highlightedBeats: [slices[0].highlightedBeats[0]], nextBeat: slices[1] };
            slices[0].nextBeat = dup;
            return { masterBar: { index: barIndex }, start: i * 1920, end: (i + 1) * 1920, firstBeat: slices[0] };
        })
    };
}
const map = buildBeatMap(fakeLookup([0, 1, 2, 1, 2, 3]));
const beatOf = (barIndex, start) => ({ voice: { bar: { masterBar: { index: barIndex } } }, playbackStart: start });

test('beat map lists beats in play order with pass numbers and positions', () => {
    assert.equal(map.entries.length, 24);
    assert.deepEqual(map.bars.map(b => [b.barIndex, b.occurrence]), [[0, 0], [1, 0], [2, 0], [1, 1], [2, 1], [3, 0]]);
    const e = map.entries.find(x => x.barIndex === 1 && x.occurrence === 1 && x.pos === 0.5);
    assert.equal(e.tick, 3 * 1920 + 960);
    assert.ok(map.entries.every((x, i) => i === 0 || x.tick > map.entries[i - 1].tick));
});

test('a clicked beat maps to one position per pass', () => {
    const c = candidatesForBeat(map, beatOf(1, 960));
    assert.deepEqual(c.map(x => [x.occurrence, x.pos, x.tick]), [[0, 0.5, 1920 + 960], [1, 0.5, 3 * 1920 + 960]]);
    assert.deepEqual(candidatesForBeat(map, beatOf(3, 0)).length, 1);
    assert.deepEqual(candidatesForBeat(map, {}), []);
});

test('next target by bar or beat, and the first unsynced bar', () => {
    assert.equal(nextTarget(map, 1920 + 960, 'bar').tick, 2 * 1920);
    assert.equal(nextTarget(map, 1920 + 960, 'beat').tick, 1920 + 1440);
    assert.equal(nextTarget(map, 5 * 1920 + 1900, 'bar'), null);
    assert.equal(nextTarget(map, 5 * 1920 + 1440, 'beat'), null);
    assert.equal(firstUnsyncedTarget(map, []).tick, 0);
    const synced = [{ barIndex: 0, occurrence: 0 }, { barIndex: 1, occurrence: 0 }, { barIndex: 2, occurrence: 0 }];
    const t = firstUnsyncedTarget(map, synced);
    assert.deepEqual([t.barIndex, t.occurrence], [1, 1]);
    assert.equal(firstUnsyncedTarget(map, map.bars.map(b => ({ barIndex: b.barIndex, occurrence: b.occurrence }))), null);
});

test('entryAt finds the beat nearest a stored position', () => {
    assert.equal(entryAt(map, { barIndex: 1, occurrence: 1, pos: 0.52 }).tick, 3 * 1920 + 960);
    assert.equal(entryAt(map, { barIndex: 3, occurrence: 1 }), null);
});

test('chooseTap accepts a tap that keeps both orders and replaces a re-tapped position', () => {
    const pts = [{ id: 'a', scoreMs: 0, timeMs: 1000 }, { id: 'b', scoreMs: 2000, timeMs: 3000 }];
    const next = chooseTap(pts, [{ scoreMs: 4000 }], 5000);
    assert.deepEqual([next.candidate.scoreMs, next.replaceId], [4000, null]);
    // re-tap the second bar a little later: replaces b
    const re = chooseTap(pts, [{ scoreMs: 2000 }], 3200);
    assert.equal(re.replaceId, 'b');
    // an earlier bar tapped after a later one in the recording is refused
    assert.equal(chooseTap(pts, [{ scoreMs: 1000 }], 3500), null);
    // the same time as an existing point is refused
    assert.equal(chooseTap(pts, [{ scoreMs: 4000 }], 3000), null);
    // inserting between points works
    assert.ok(chooseTap(pts, [{ scoreMs: 1000 }], 2000));
});

test('in a repeat, the pass that keeps the order is chosen', () => {
    // bar 1 (pass 0 at 2000) and bar 2 (pass 0 at 4000) were tapped; the repeat plays bar 1 again at 6000 and 8000 score ms
    const pts = [{ id: 'a', scoreMs: 2000, timeMs: 3000 }, { id: 'b', scoreMs: 4000, timeMs: 5000 }];
    const cands = [{ occurrence: 0, scoreMs: 2000 }, { occurrence: 1, scoreMs: 6000 }];
    const chosen = chooseTap(pts, cands, 9000);
    assert.equal(chosen.candidate.occurrence, 1);
    assert.equal(chosen.replaceId, null);
    // tapping bar 1 early in the recording is the first pass: it replaces point a
    assert.equal(chooseTap(pts, cands, 3100).candidate.occurrence, 0);
});

test('patchPlan keeps the tap and drops the points it contradicts', () => {
    const pts = [{ id: 'a', scoreMs: 0, timeMs: 1000 }, { id: 'b', scoreMs: 2000, timeMs: 3000 }, { id: 'c', scoreMs: 4000, timeMs: 5000 }, { id: 'd', scoreMs: 6000, timeMs: 7000 }];
    // bar at 4000 heard at 8000: c is replaced, d (heard before) is dropped
    const plan = patchPlan(pts, [{ scoreMs: 4000 }], 8000);
    assert.deepEqual([plan.replaceIds, plan.dropIds], [['c'], ['d']]);
    // consistent tap drops nothing
    assert.deepEqual(patchPlan(pts, [{ scoreMs: 3000 }], 4000).dropIds, []);
    // a repeat picks the pass that contradicts the fewest points
    const rep = patchPlan(pts, [{ occurrence: 0, scoreMs: 2000 }, { occurrence: 1, scoreMs: 8000 }], 9000);
    assert.equal(rep.candidate.occurrence, 1);
    assert.equal(patchPlan(pts, [], 1), null);
});

test('rangePlan clears the points between two taps', () => {
    const pts = [{ id: 'a', scoreMs: 0, timeMs: 1000 }, { id: 'b', scoreMs: 2000, timeMs: 3000 }, { id: 'c', scoreMs: 4000, timeMs: 5000 }, { id: 'd', scoreMs: 6000, timeMs: 7000 }, { id: 'e', scoreMs: 8000, timeMs: 9000 }];
    const plan = rangePlan(pts, [{ scoreMs: 2000 }], 3500, [{ scoreMs: 6000 }], 6500);
    assert.deepEqual(plan.removeIds.sort(), ['b', 'c', 'd']);
    // a stretch tapped end before start in the recording, or reversed in the score, is refused
    assert.equal(rangePlan(pts, [{ scoreMs: 2000 }], 6500, [{ scoreMs: 6000 }], 3500), null);
    assert.equal(rangePlan(pts, [{ scoreMs: 6000 }], 3500, [{ scoreMs: 2000 }], 6500), null);
    // an end that runs past a later point also removes it
    assert.deepEqual(rangePlan(pts, [{ scoreMs: 2000 }], 3500, [{ scoreMs: 4000 }], 9500).removeIds.sort(), ['b', 'c', 'd', 'e']);
});
