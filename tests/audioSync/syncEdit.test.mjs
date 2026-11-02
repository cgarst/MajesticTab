// Run with: node --test tests/audioSync/syncEdit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatTime, parseTime, addPoint, updatePoint, removePoints, shiftAfter, deleteRange,
    toAlphaTexSync, fromAlphaTexSync, toJson, fromJson, importPoints
} from '../../src/audioSync/syncEdit.js';
import { normalizeRecord } from '../../src/audioSync/syncStore.js';

const P = (id, barIndex, timeMs, extra = {}) => ({ id, barIndex, occurrence: 0, pos: 0, timeMs, source: 'tap', ...extra });
const base = [P('a', 0, 1000), P('b', 4, 5000), P('c', 8, 9000)];

test('time formatting and parsing', () => {
    assert.equal(formatTime(83456), '1:23.456');
    assert.equal(formatTime(5), '0:00.005');
    assert.equal(formatTime(NaN), '-');
    assert.equal(parseTime('1:23.456'), 83456);
    assert.equal(parseTime('83.456'), 83456);
    assert.equal(parseTime('2:05'), 125000);
    assert.equal(parseTime(' 10 '), 10000);
    assert.equal(parseTime('1:75'), null);
    assert.equal(parseTime('abc'), null);
    assert.equal(parseTime(''), null);
    for (const ms of [0, 999, 61000, 599999]) assert.equal(parseTime(formatTime(ms)), ms);
});

test('add keeps time order and fills defaults', () => {
    const next = addPoint(base, { barIndex: 2, timeMs: 3000 });
    assert.deepEqual(next.map(p => p.timeMs), [1000, 3000, 5000, 9000]);
    const added = next[1];
    assert.equal(added.occurrence, 0);
    assert.equal(added.source, 'manual');
    assert.ok(added.id);
});

test('update, remove, shift and range delete', () => {
    assert.equal(updatePoint(base, 'b', { timeMs: 9500 }).at(-1).id, 'b');
    assert.deepEqual(removePoints(base, ['a', 'c']).map(p => p.id), ['b']);
    assert.deepEqual(shiftAfter(base, 5000, -250).map(p => p.timeMs), [1000, 4750, 8750]);
    assert.equal(shiftAfter(base, 0, -5000)[0].timeMs, 0);
    assert.deepEqual(deleteRange(base, 1000, 5000).map(p => p.id), ['c']);
    assert.equal(base.length, 3);
});

test('AlphaTab sync text round trips and reads inside other text', () => {
    const pts = [P('a', 0, 1000), P('b', 4, 5000, { occurrence: 1, pos: 0.5 })];
    const text = toAlphaTexSync(pts);
    assert.equal(text, '\\sync 0 0 1000\n\\sync 4 1 5000 0.5');
    const back = fromAlphaTexSync(text);
    assert.deepEqual(back.map(p => [p.barIndex, p.occurrence, p.pos, p.timeMs]), [[0, 0, 0, 1000], [4, 1, 0.5, 5000]]);
    const inFile = '\\title "x"\n\\tempo 120\n\\sync 2 0 300\n. 3.3.4 |\n\\sync 3 0 900.4';
    assert.deepEqual(fromAlphaTexSync(inFile).map(p => p.timeMs), [300, 900]);
    assert.deepEqual(fromAlphaTexSync('\\sync 1 0 -5\n\\sync 1 0 5 2'), []);
    assert.deepEqual(fromAlphaTexSync('nothing here'), []);
});

test('JSON round trips and accepts a bare array', () => {
    const back = fromJson(toJson(base));
    assert.deepEqual(back.map(p => p.id), ['a', 'b', 'c']);
    assert.equal(fromJson('[{"barIndex":1,"timeMs":10}]')[0].barIndex, 1);
    assert.ok(fromJson('[{"barIndex":1,"timeMs":10}]')[0].id);
    assert.equal(fromJson('{"nope":1}'), null);
    assert.equal(fromJson('not json'), null);
});

test('importPoints picks the format and imported points pass store normalization', () => {
    assert.equal(importPoints(''), null);
    assert.equal(importPoints('hello'), null);
    assert.equal(importPoints(toJson(base)).length, 3);
    assert.equal(importPoints(toAlphaTexSync(base)).length, 3);
    const rec = normalizeRecord({ version: 1, media: { kind: 'youtube', videoId: 'x' }, points: importPoints(toAlphaTexSync(base)), updatedAt: 1 });
    assert.equal(rec.points.length, 3);
});
