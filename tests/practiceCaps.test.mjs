// Run: node tests/practiceCaps.test.mjs
import assert from 'node:assert/strict';
import { practiceCaps } from '../src/utils/practiceCaps.js';

const base = { hasScore: false, auto: false, freeClick: false, onRecording: false, originalKind: null, originalAttached: false, hasPresets: false };
const caps = (o) => practiceCaps({ ...base, ...o });

// Guitar Pro, synth (or Off): the whole panel, click from the score
assert.deepEqual(caps({ hasScore: true }), { speed: 'synth', loopBars: true, parts: true, tempo: false, beatSource: 'score' });
// Guitar Pro with a recording
assert.equal(caps({ hasScore: true, onRecording: true, originalKind: 'local', originalAttached: true }).speed, 'percent');
assert.equal(caps({ hasScore: true, onRecording: true, originalKind: 'embedded', originalAttached: true }).speed, 'percent');
assert.equal(caps({ hasScore: true, onRecording: true, originalKind: 'youtube', originalAttached: true, hasPresets: true }).speed, 'presets');
assert.equal(caps({ hasScore: true, onRecording: true, originalKind: 'youtube', originalAttached: true, hasPresets: false }).speed, null, 'a video with no speeds offered');
assert.equal(caps({ hasScore: true, onRecording: true, originalKind: 'local', originalAttached: false }).speed, null, 'Original with nothing attached');
// Text tab with a MIDI file is a score
assert.equal(caps({ hasScore: true }).loopBars, true);
// Text or PDF on auto-scroll: pace, no bars, free click
assert.deepEqual(caps({ auto: true, freeClick: true }), { speed: 'pace', loopBars: false, parts: false, tempo: true, beatSource: 'free' });
// Text or PDF with a recording: speed of the recording, no bars, free click
const doc = caps({ freeClick: true, onRecording: true, originalKind: 'local', originalAttached: true });
assert.deepEqual([doc.speed, doc.loopBars, doc.parts, doc.tempo], ['percent', false, false, true]);
assert.equal(caps({ freeClick: true, onRecording: true, originalKind: 'youtube', originalAttached: true, hasPresets: true }).speed, 'presets');
// Nothing open
assert.deepEqual(caps({}), { speed: null, loopBars: false, parts: false, tempo: false, beatSource: 'score' });
console.log('practiceCaps ok');
