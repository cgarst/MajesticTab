// Run with: node --test tests/audioSync/tapCalibration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    nextClickInterval, delayForTap, summarizeDelays, offsetFromDelay, MAX_DELAY_MS, SKIP_TAPS
} from '../../src/audioSync/tapCalibration.js';

test('clicks come 0.9 to 1.7 seconds apart', () => {
    assert.equal(nextClickInterval(0), 900);
    assert.equal(nextClickInterval(0.5), 1300);
    assert.equal(nextClickInterval(0.9999), 1699);
    for (let i = 0; i < 100; i++) {
        const v = nextClickInterval(i / 100);
        assert.ok(v >= 900 && v < 1700);
    }
});

test('a tap pairs with the latest click before it', () => {
    const clicks = [1000, 2300, 3500];
    assert.deepEqual(delayForTap(clicks, 2450), { delay: 150, click: 2300 });
    assert.deepEqual(delayForTap(clicks, 3500), { delay: 0, click: 3500 });
    assert.deepEqual(delayForTap(clicks, 1099.5), { delay: 99.5, click: 1000 });
});

test('a tap before any click, or long after the last one, is not paired', () => {
    assert.equal(delayForTap([1000], 900), null);
    assert.equal(delayForTap([], 500), null);
    assert.equal(delayForTap([1000], 1000 + MAX_DELAY_MS + 1), null);
    assert.ok(delayForTap([1000], 1000 + MAX_DELAY_MS));
});

test('the result ignores the first taps, uses the median, and says how much taps vary', () => {
    const delays = [400, 380, 200, 210, 190, 205, 195, 500, 200];
    const r = summarizeDelays(delays);
    assert.equal(r.count, delays.length - SKIP_TAPS);
    assert.equal(r.medianMs, 200);                 // the 500 ms slip does not move it
    assert.ok(r.spreadMs <= 10);
    assert.equal(summarizeDelays([400, 380, 200, 210]), null);   // too few after the first two
    assert.equal(summarizeDelays([]), null);
});

test('only the latest taps count', () => {
    const early = new Array(30).fill(300);
    const late = new Array(12).fill(150);
    assert.equal(summarizeDelays([...early, ...late]).medianMs, 150);
});

test('the speakers\' delay is not counted twice', () => {
    assert.equal(offsetFromDelay(220, 0), 220);
    assert.equal(offsetFromDelay(220, 120), 100);
    assert.equal(offsetFromDelay(100, 250), 0);
    assert.equal(offsetFromDelay(220.4, 0), 220);
});
