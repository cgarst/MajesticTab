// Run with: node --test tests/audioSync/peaks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePeaks, combinePeaks } from '../../src/audioSync/peaks.js';
import { fingerprintOf } from '../../src/audioSync/audioFileStore.js';

test('peaks are the loudest absolute sample per bin, across channels', () => {
    const sr = 100; // 50 peaks per second -> 2 samples per bin
    const left = Float32Array.from([0, 0.5, 0, 0, -1, 0, 0.25, 0]);
    const right = Float32Array.from([0, 0, 0.75, 0, 0, 0, 0, -0.5]);
    assert.deepEqual([...computePeaks([left, right], sr)], [128, 191, 255, 128]);
});

test('peaks cover a partial last bin and handle empty input', () => {
    const data = new Float32Array(5).fill(0.5);
    assert.equal(computePeaks([data], 100).length, 3);
    assert.equal(computePeaks([new Float32Array(0)], 44100).length, 0);
    assert.equal(computePeaks([], 44100).length, 0);
});

test('fingerprint depends on content and size, not on anything else', async () => {
    const a = new Uint8Array([1, 2, 3, 4]).buffer;
    const b = new Uint8Array([1, 2, 3, 4]).buffer;
    const c = new Uint8Array([1, 2, 3, 5]).buffer;
    const d = new Uint8Array([1, 2, 3, 4, 0]).buffer;
    assert.equal(await fingerprintOf(a), await fingerprintOf(b));
    assert.notEqual(await fingerprintOf(a), await fingerprintOf(c));
    assert.notEqual(await fingerprintOf(a), await fingerprintOf(d));
    assert.match(await fingerprintOf(a), /^[0-9a-f]{64}$/);
});

test('combinePeaks sums stems without clipping and scales down only above 255', () => {
    assert.equal(combinePeaks([]), null);
    assert.equal(combinePeaks([null, new Uint8Array(0)]), null);
    const single = new Uint8Array([10, 20]);
    assert.equal(combinePeaks([single]), single);
    assert.deepEqual([...combinePeaks([new Uint8Array([100, 50]), new Uint8Array([100, 80, 30])])], [200, 130, 30]);
    // Sum of 255 + 255 = 510 scales by 255/510 = 0.5, preserving relative shape
    assert.deepEqual([...combinePeaks([new Uint8Array([255, 100]), new Uint8Array([255, 0])])], [255, 50]);
});
