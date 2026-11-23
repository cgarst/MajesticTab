// Run with: node --test tests/audioSync/alignCheck.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureAlignment, compareSyncs, conflictText, formatShift } from '../../src/audioSync/alignCheck.js';

function envelope(seconds, seed = 7) {
    let x = seed;
    const out = new Uint8Array(seconds * 50);
    for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = 40 + (x % 200); }
    return out;
}
// B is A with `lead` seconds of silence in front (so a time in A plus lead is the same sound in B)
const withLead = (a, lead) => { const o = new Uint8Array(a.length + lead * 50); o.set(a, lead * 50); return o; };
const bars = (...ms) => ms.map((t, i) => ({ barIndex: i, occurrence: 0, timeMs: t }));

test('a constant lead-in is one offset in every window', () => {
    const a = envelope(120);
    const r = measureAlignment(a, withLead(a, 2.46));
    assert.equal(r.kind, 'offset');
    assert.ok(Math.abs(r.offsetMs - 2460) <= 20, `offset ${r.offsetMs}`);
    assert.ok(r.windows >= 3);
});

test('a different mix with the same timing still reads as one offset', () => {
    const a = envelope(120);
    const b = withLead(a, 1.5);
    for (let i = 0; i < b.length; i++) b[i] = Math.min(255, Math.max(0, b[i] * 0.7 + ((i * 37) % 23)));
    assert.equal(measureAlignment(a, b).kind, 'offset');
});

test('a recording whose timing changes part way is not a constant offset', () => {
    const a = envelope(120);
    const b = new Uint8Array(a.length + 400);
    b.set(a.subarray(0, 3000), 100);      // 2 s of lead for the first minute
    b.set(a.subarray(3000), 3000 + 300);  // then 4 s
    assert.equal(measureAlignment(a, b).kind, 'varies');
});

test('unrelated or too short audio is unknown', () => {
    assert.equal(measureAlignment(envelope(1), envelope(1)).kind, 'unknown');
    assert.notEqual(measureAlignment(envelope(120, 1), envelope(120, 99)).kind, 'offset');
});

test('identical sync times on recordings 2.4 s apart are a conflict', () => {
    const al = { kind: 'offset', offsetMs: 2450 };
    const pts = bars(4000, 7400, 10800, 14200);
    const r = compareSyncs(pts, pts, al);
    assert.equal(r.verdict, 'conflict');
    assert.equal(r.deltaMs, 0);
    assert.match(conflictText(r, al, 'band.flac'), /The points match band\.flac, but the two recordings are 2\.5 s apart/);
});

test('times shifted by the audio offset are consistent', () => {
    const al = { kind: 'offset', offsetMs: 2450 };
    const r = compareSyncs(bars(4000, 7400, 10800, 14200), bars(6450, 9850, 13250, 16650), al);
    assert.equal(r.verdict, 'consistent');
    assert.equal(conflictText(r, al, 'x'), null);
});

test('no verdict without a constant offset or enough shared bars', () => {
    assert.equal(compareSyncs(bars(1, 2, 3, 4), bars(1, 2, 3, 4), { kind: 'varies', offsetMs: 0 }).verdict, 'unknown');
    assert.equal(compareSyncs(bars(1, 2), bars(1, 2), { kind: 'offset', offsetMs: 900 }).verdict, 'unknown');
});

test('formatShift', () => {
    assert.equal(formatShift(640), '640 ms');
    assert.equal(formatShift(-2451), '2.5 s');
});
