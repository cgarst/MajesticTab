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
    assert.equal(classifyMark({ text: "[A'] (2:01)" }).name, 'A′');
    assert.equal(classifyMark({ text: "[A'']" }).name, 'A″');
    const solo = classifyMark({ text: "[E | Solo 1] (1:52)" });
    assert.equal(solo.name, 'Solo 1');
    assert.equal(solo.letter, 'E');
    assert.equal(classifyMark({ text: 'Section 14' }).kind, 'generic');
    assert.equal(classifyMark({ text: 'Section 14' }).name, 'Part 14');
    assert.equal(classifyMark({ text: 'Section 14 (Tempo : 145)' }).name, 'Part 14');
    assert.equal(classifyMark({ text: 'Section -125' }).name, 'Part 125');
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

test('letters format with unicode prime and become part names', () => {
    const { parts } = deriveSections(bars(40, { 1: '[A] (0:00)', 11: '[B] (0:30)', 21: "[A'] (1:00)", 31: "[B'] (1:30)" }));
    assert.deepEqual(parts.map((p) => [p.name, p.short]), [
        ['A', 'A'], ['B', 'B'], ['A′', 'A′'], ['B′', 'B′']
    ]);
});

test('repeat numbering runs before merging short parts', () => {
    // Bar 1-4 Intro, Bar 5-6 Bridge (short, 2 bars), Bar 7-14 Verse, Bar 15-20 Bridge (6 bars)
    // Bridge at bar 5 is Bridge #1, Bridge at bar 15 is Bridge #2
    // With minBars = 4, Bridge at bar 5 joins Intro. The surviving Bridge retains "Bridge 2".
    const { parts } = deriveSections(bars(20, { 1: 'Intro', 5: 'Bridge', 7: 'Verse', 15: 'Bridge' }), { minBars: 4 });
    assert.deepEqual(parts.map((p) => [p.name, p.startBar, p.endBar]), [
        ['Intro', 1, 6], ['Verse', 7, 14], ['Bridge 2', 15, 20]
    ]);
});

test('time code sequential renumbering after short part merge', () => {
    // 4 time parts, part 2 is only 2 bars (bar 5-6) and merges into part 1.
    // Resulting parts renumber sequentially: Part 1, Part 2, Part 3.
    const { parts } = deriveSections(bars(20, { 1: '(0:00)', 5: '(0:10)', 7: '(0:20)', 15: '(0:40)' }), { minBars: 4 });
    assert.deepEqual(parts.map((p) => [p.name, p.startBar, p.endBar]), [
        ['Part 1', 1, 6], ['Part 2', 7, 14], ['Part 3', 15, 20]
    ]);
});

