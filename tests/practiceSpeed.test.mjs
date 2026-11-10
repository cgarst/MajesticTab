// Run with: node --test tests/practiceSpeed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPercentRate, MIN_PERCENT, MAX_PERCENT } from '../src/utils/practiceSpeed.js';

test('one percent a press, up and down', () => {
    assert.equal(nextPercentRate(1, 1), 1.01);
    assert.equal(nextPercentRate(1, -1), 0.99);
    assert.equal(nextPercentRate(0.75, 1), 0.76);
});

test('a rate off the percent grid snaps to it before stepping', () => {
    assert.equal(nextPercentRate(0.7549, 1), 0.76);
    assert.equal(nextPercentRate(0.7551, -1), 0.75);
});

test('it stops at the ends', () => {
    assert.equal(nextPercentRate(MIN_PERCENT / 100, -1), MIN_PERCENT / 100);
    assert.equal(nextPercentRate(MAX_PERCENT / 100, 1), MAX_PERCENT / 100);
});
