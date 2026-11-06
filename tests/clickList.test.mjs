// Run with: node --test tests/clickList.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreTimeline, buildClickList } from '../src/audioSync/scorePositions.js';

const bar = (barIndex, start, num, den, tempoChanges = []) => ({ barIndex, start, end: start + num * (3840 / den), num, den, tempoChanges });
const clicksOf = (bars, tempo = 120) => buildClickList(bars, buildScoreTimeline(bars, tempo));

test('4/4 at 120 bpm: a click every 500 ms, the first of each bar accented', () => {
    const c = clicksOf([bar(0, 0, 4, 4), bar(1, 3840, 4, 4)]);
    assert.equal(c.length, 8);
    assert.deepEqual(c.map(x => x.ms), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    assert.deepEqual(c.map(x => x.accent), [true, false, false, false, true, false, false, false]);
});

test('3/4 has three clicks per bar', () => {
    const c = clicksOf([bar(0, 0, 3, 4), bar(1, 2880, 3, 4)]);
    assert.deepEqual(c.map(x => x.accent), [true, false, false, true, false, false]);
});

test('6/8 clicks on the eighth', () => {
    const c = clicksOf([bar(0, 0, 6, 8)]);
    assert.equal(c.length, 6);
    assert.equal(c[1].ms, 250);
    assert.equal(c[0].accent, true);
    assert.equal(c.filter(x => x.accent).length, 1);
});

test('a tempo change mid-song changes the spacing', () => {
    const c = clicksOf([bar(0, 0, 4, 4), bar(1, 3840, 4, 4, [{ tick: 3840, tempo: 60 }])]);
    assert.equal(c[4].ms, 2000);
    assert.equal(c[5].ms - c[4].ms, 1000);
});

test('a repeated bar clicks again on its second pass', () => {
    const c = clicksOf([bar(0, 0, 4, 4), bar(0, 3840, 4, 4)]);
    assert.equal(c.length, 8);
    assert.equal(c[4].ms, 2000);
    assert.equal(c[4].accent, true);
});
