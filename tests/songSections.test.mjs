// Run with: node --test tests/songSections.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMark, deriveSections, shortLabel, partAtBar } from '../src/gpProcessor/songSections.js';

const bars = (n, marks = {}) => Array.from({ length: n }, (_, i) => (marks[i + 1] ? { section: { text: marks[i + 1] } } : {}));

test('classifyMark reads each style', () => {
    assert.deepEqual(classifyMark({ text: 'Chorus' }).kind, 'named');
    assert.equal(classifyMark({ text: 'v2' }).name, 'Verse 2');
    assert.equal(classifyMark({ text: '1st Verse' }).name, 'Verse 1');
    assert.equal(classifyMark({ text: '(0:09)' }).kind, 'time');
    assert.equal(classifyMark({ text: '[A] (0:00)' }).kind, 'letter');
    assert.equal(classifyMark({ text: '[A] (0:00)' }).letter, 'A');
    const solo = classifyMark({ text: "[E | Solo 1] (1:52)" });
    assert.equal(solo.name, 'Solo 1');
    assert.equal(solo.letter, 'E');
    assert.equal(classifyMark({ text: 'Section 14' }).kind, 'generic');
    assert.equal(classifyMark({ text: 'Tempo : 130' }).kind, 'tempo');
    assert.equal(classifyMark({ text: '"hold me now"' }).kind, 'lyric');
    assert.equal(classifyMark({ text: '  ' }).kind, 'blank');
});

test('a file with no marks gives no parts', () => {
    assert.deepEqual(deriveSections(bars(32)).parts, []);
});

test('named marks become parts, with a lead-in and numbered repeats', () => {
    const { parts } = deriveSections(bars(40, { 5: 'Verse', 13: 'Chorus', 21: 'Verse', 29: 'Chorus', 37: 'Outro' }), { minBars: 2 });
    assert.deepEqual(parts.map((p) => [p.name, p.startBar, p.endBar]), [
        ['Start', 1, 4], ['Verse', 5, 12], ['Chorus', 13, 20], ['Verse 2', 21, 28], ['Chorus 2', 29, 36], ['Outro', 37, 40]
    ]);
});

test('names that already carry a number are left alone', () => {
    const { parts } = deriveSections(bars(24, { 1: 'Verse 1', 9: 'Verse 2', 17: 'Chorus' }));
    assert.deepEqual(parts.map((p) => p.name), ['Verse 1', 'Verse 2', 'Chorus']);
});

test('time-only, lyric and tempo marks fold into the part before', () => {
    const { parts } = deriveSections(bars(24, { 1: 'Intro', 5: '(0:09)', 9: '"lyric line"', 13: 'Verse' }));
    assert.deepEqual(parts.map((p) => [p.name, p.startBar, p.endBar]), [['Intro', 1, 12], ['Verse', 13, 24]]);
    assert.equal(parts[0].raw.length, 3);
});

test('time-only files use their time marks as Part 1, Part 2', () => {
    const { parts } = deriveSections(bars(24, { 1: '(0:00)', 9: '(0:20)', 17: '(0:41)' }));
    assert.deepEqual(parts.map((p) => p.name), ['Part 1', 'Part 2', 'Part 3']);
});

test('parts under the minimum join the one before; the first joins the one after', () => {
    const { parts } = deriveSections(bars(20, { 1: 'Intro', 3: 'Verse', 11: 'Hit', 12: 'Chorus' }), { minBars: 4 });
    assert.deepEqual(parts.map((p) => [p.name, p.startBar, p.endBar]), [['Verse', 1, 11], ['Chorus', 12, 20]]);
});

test('only unusable marks give no parts', () => {
    assert.deepEqual(deriveSections(bars(16, { 1: 'Tempo : 130', 5: '"words"' })).parts, []);
});

test('short labels', () => {
    assert.equal(shortLabel('Verse'), 'V');
    assert.equal(shortLabel('Chorus 3'), 'C3');
    assert.equal(shortLabel('Pre-chorus'), 'PC');
    assert.equal(shortLabel('Guitar solo'), 'GS');
    assert.equal(shortLabel('Intro'), 'In');
});

test('partAtBar finds the current part', () => {
    const { parts } = deriveSections(bars(24, { 1: 'Intro', 9: 'Verse', 17: 'Chorus' }));
    assert.equal(partAtBar(parts, 10).name, 'Verse');
    assert.equal(partAtBar(parts, 99), null);
});
