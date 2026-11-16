// Run with: node --test tests/audioSync/refineOffset.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFlux, refineOffset } from '../../src/audioSync/refineOffset.js';

const SR = 8000;
// Bursts of noise at pseudo-random times, each decaying over ~120 ms
function song(seconds, seed = 3) {
    let x = seed;
    const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    const out = new Float32Array(seconds * SR);
    for (let t = 0.2; t < seconds - 0.3; t += 0.15 + rnd() * 0.4) {
        const start = Math.round(t * SR);
        const len = Math.round(0.12 * SR);
        const gain = 0.3 + rnd() * 0.7;
        for (let i = 0; i < len; i++) out[start + i] += (rnd() * 2 - 1) * gain * Math.exp(-i / (0.04 * SR));
    }
    return out;
}
const delayed = (a, ms) => { const o = new Float32Array(a.length + Math.round(ms * SR / 1000)); o.set(a, Math.round(ms * SR / 1000)); return o; };

test('the exact lead-in is found from a coarse estimate 9 ms off', () => {
    const a = song(60);
    const fa = computeFlux([a], SR);
    const fb = computeFlux([delayed(a, 2451)], SR);
    const r = refineOffset(fa, fb, 2460);
    assert.ok(Math.abs(r.offsetMs - 2451) <= 1, `got ${r.offsetMs}`);
    assert.ok(r.confidence > 0.8);
});

test('a different mix at the same timing gives the same offset', () => {
    const a = song(60);
    const other = delayed(a, 1203).map((v, i) => v * 0.6 + 0.05 * Math.sin(i * 0.3));
    const r = refineOffset(computeFlux([a], SR), computeFlux([other], SR), 1190);
    assert.ok(Math.abs(r.offsetMs - 1203) <= 2, `got ${r.offsetMs}`);
});

test('a negative offset works as well', () => {
    const a = song(60);
    const r = refineOffset(computeFlux([delayed(a, 800)], SR), computeFlux([a], SR), -770);
    assert.ok(Math.abs(r.offsetMs + 800) <= 1, `got ${r.offsetMs}`);
});

test('nothing to compare returns null', () => {
    assert.equal(refineOffset(new Float32Array(100), new Float32Array(100), 0), null);
});
