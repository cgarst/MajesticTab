// Run with: node --test tests/audioSync/cursorGlide.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCursorGlide } from '../../src/audioSync/cursorGlide.js';

// Two rows. Row 1 holds bars 0 and 1, row 2 holds bar 2. Each bar is 1920 ticks. The drawn beats are not the
// ones the tick lookup knows (a hidden track has beats the staff does not draw), so the map only needs the bars.
const row1 = { id: 'row1' };
const row2 = { id: 'row2' };
const bounds = (system, barX, barW, beats) => {
    const masterBarBounds = { staffSystemBounds: system, visualBounds: { x: barX, w: barW } };
    return beats.map(([rel, x]) => ({ beat: { playbackStart: rel }, onNotesX: x, barBounds: { masterBarBounds } }));
};
const staffSystems = [
    { bars: [
        { index: 0, bars: [{ beats: bounds(row1, 0, 200, [[0, 20], [960, 120]]) }] },
        { index: 1, bars: [{ beats: bounds(row1, 200, 200, [[0, 220]]) }] }
    ] },
    { bars: [{ index: 2, bars: [{ beats: bounds(row2, 0, 200, [[0, 20]]) }] }] }
];
const map = { bars: [0, 1, 2].map((barIndex, i) => ({ barIndex, occurrence: 0, startTick: i * 1920, endTick: (i + 1) * 1920 })) };

function make() {
    const calls = [];
    const handler = {
        placeBeatCursorNow: (c, b, x) => calls.push(['place', b.onNotesX, x]),
        transitionBeatCursor: (c, b, from, to, ms) => calls.push(['glide', from, to, ms]),
        freezeBeatCursor: () => calls.push(['freeze'])
    };
    const api = { renderer: { boundsLookup: { staffSystems } }, customCursorHandler: handler, renderFinished: { on() {}, off() {} } };
    return { glide: createCursorGlide(api, map), calls };
}

test('locate finds the drawn beat at a tick and the one after it', () => {
    const { glide } = make();
    const a = glide.locate(500);                       // before the second drawn beat of bar 0
    assert.equal(a.fromTick, 0);
    assert.equal(a.next.tick, 960);
    const b = glide.locate(1200);                      // after it: the next beat is the first of bar 1
    assert.equal(b.fromTick, 960);
    assert.equal(b.next.tick, 1920);
    const c = glide.locate(1920 + 500);                // bar 1 has one drawn beat: the next is the first of bar 2
    assert.equal(c.fromTick, 1920);
    assert.equal(c.next.tick, 3840);
    assert.equal(glide.locate(3840 + 100).next, null); // the last bar played has no next
});

test('a tick on or before a bar start picks its first beat; an unknown bar gives nothing', () => {
    const { glide } = make();
    assert.equal(glide.locate(0).fromTick, 0);
    assert.equal(createCursorGlide({ renderer: { boundsLookup: { staffSystems: [] } } }, map).locate(100), null);
});

test('running places the cursor part way and glides to the next beat in the time that is left', () => {
    const { glide, calls } = make();
    glide.run(glide.locate(500), 0.25, 400);
    assert.deepEqual(calls, [['place', 20, 45], ['glide', 45, 120, 400]]);   // 20 + 0.25 * (120 - 20)
});

test('the last beat of a row runs to the end of its bar, and a next beat on the same row is the target', () => {
    const { glide, calls } = make();
    glide.run(glide.locate(1200), 0, 300);                                    // bar 0, next beat is bar 1's first on the same row
    assert.deepEqual(calls.at(-1), ['glide', 120, 220, 300]);
    calls.length = 0;
    glide.run(glide.locate(1920 + 200), 0.5, 800);                            // bar 1 -> bar 2 is on another row: end of bar 1 (400)
    assert.deepEqual(calls, [['place', 220, 310], ['glide', 310, 400, 800]]); // 220 + 0.5 * (400 - 220)
});

test('paused, or nearly out of time, the cursor is placed and not animated; nothing happens without a handler', () => {
    const { glide, calls } = make();
    glide.run(glide.locate(500), 0.5, 0);
    assert.deepEqual(calls, [['place', 20, 70]]);
    calls.length = 0;
    glide.run(glide.locate(500), 2, 400);                                     // a fraction past 1 is held at the next beat
    assert.deepEqual(calls[0], ['place', 20, 120]);
    assert.equal(calls.length, 1);                                            // already there: no glide
    assert.doesNotThrow(() => createCursorGlide({ renderer: { boundsLookup: { staffSystems } } }, map).run({ from: {}, next: null }, 0, 10));
    glide.freeze();
    assert.deepEqual(calls.at(-1), ['freeze']);
});
