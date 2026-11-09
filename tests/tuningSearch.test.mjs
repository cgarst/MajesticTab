// Run: node tests/tuningSearch.test.mjs
import assert from 'node:assert/strict';
import { tuningMatchesQuery, getTuningInfo } from '../src/utils/tuningUtils.js';

const group = (t) => { const i = getTuningInfo(t); return { key: i.key, notes: i.notes, name: i.displayName, defaultName: i.defaultName }; };
const dadgad = group('DADGAD'), dropD = group('Drop D'), std = group('EADGBE'), openG = group('Open G'), dropDb = group('Drop Db');

assert.ok(tuningMatchesQuery(dropD, 'Drop D'));
assert.ok(tuningMatchesQuery(openG, 'open g'));
assert.ok(tuningMatchesQuery(dadgad, 'dadgad'));
assert.ok(tuningMatchesQuery(dadgad, 'DADGAD'));
assert.ok(tuningMatchesQuery(dadgad, 'D A D G A D'));
assert.ok(tuningMatchesQuery(std, 'EADGBE'));
assert.ok(tuningMatchesQuery(std, 'eadgbe'));
assert.ok(tuningMatchesQuery(std, 'E A D G B E'));
assert.ok(tuningMatchesQuery(dropDb, 'Db Ab Db Gb Bb Eb'));
assert.ok(tuningMatchesQuery(dropDb, 'C# G# C# F# A# D#'));
assert.ok(tuningMatchesQuery(dropDb, 'DbAbDbGbBbEb'));
assert.ok(!tuningMatchesQuery(std, 'DADGAD'));
assert.ok(!tuningMatchesQuery(std, 'Drop D'));
assert.ok(!tuningMatchesQuery(std, 'e'));
assert.ok(!tuningMatchesQuery(std, 'ea'));
assert.ok(!tuningMatchesQuery(std, ''));
console.log('tuningSearch ok');
