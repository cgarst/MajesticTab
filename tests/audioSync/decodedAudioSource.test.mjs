// Run with: node --test tests/audioSync/decodedAudioSource.test.mjs
// The player itself needs a real AudioContext (checked in the browsers); this covers the stretcher delay table
// and the feature check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stretchDelayMs, decodedPlaybackSupported, MAX_DECODED_SECONDS } from '../../src/audioSync/decodedAudioSource.js';

test('no stretcher at normal speed, so no delay', () => {
    assert.equal(stretchDelayMs(1), 0);
    assert.equal(stretchDelayMs(0.999), 0);
});

test('the delay is the measured value at the measured rates', () => {
    assert.equal(stretchDelayMs(0.5), 89);
    assert.equal(stretchDelayMs(0.75), 130);
    assert.equal(stretchDelayMs(0.95), 129);
});

test('between measured rates it is interpolated, below the lowest it holds', () => {
    assert.ok(Math.abs(stretchDelayMs(0.55) - 103) < 1e-9);
    assert.equal(stretchDelayMs(0.25), 89);
    assert.ok(stretchDelayMs(0.97) > 0 && stretchDelayMs(0.97) <= 130);
});

test('without Web Audio (Node) decoded playback is reported unsupported', () => {
    assert.equal(decodedPlaybackSupported(), false);
});

test('the memory limit is fifteen minutes', () => {
    assert.equal(MAX_DECODED_SECONDS, 900);
});
