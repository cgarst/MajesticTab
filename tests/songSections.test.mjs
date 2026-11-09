// Run with: node --test tests/songSections.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMark, deriveSections, shortLabel, partAtBar, buildSegments, segmentIndexAtBar } from '../src/gpProcessor/songSections.js';

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


test('buildSegments gives fractions that tile the song, and no label for the lead-in', () => {
    const { parts } = deriveSections(bars(40, { 5: 'Verse', 21: 'Chorus' }), { minBars: 4 });
    const segs = buildSegments(parts, 40);
    assert.equal(segs[0].label, '');
    assert.equal(segs[0].start, 0);
    assert.equal(segs.at(-1).start + segs.at(-1).width, 1);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].start + segs[i - 1].width);
    assert.deepEqual(segs.map((s) => s.label), ['', 'Verse', 'Chorus']);
    assert.equal(segmentIndexAtBar(segs, 22), 2);
    assert.equal(segmentIndexAtBar(segs, 1), 0);
});

test('buildSegments is empty when the file has no parts', () => {
    assert.deepEqual(buildSegments([], 40), []);
    assert.deepEqual(buildSegments(deriveSections(bars(40)).parts, 40), []);
});

const suite = () => deriveSections(bars(300, {
    1: 'I: First (Instrumental)', 21: 'Riff', 37: 'Riff 2', 61: 'Solo',
    81: 'II: Second', 101: 'Verse', 117: 'Chorus', 133: 'Verse 2', 149: 'Chorus 2',
    161: 'III: Third', 181: 'Verse', 201: 'Bridge', 229: 'Riff', 261: 'Outro'
}), { minBars: 4 }).parts;

test('numbered movements are the blocks, and the parts inside them belong to them', () => {
    const segs = buildSegments(suite(), 300, 1200);
    assert.deepEqual(segs.map((s) => [s.title, s.startBar, s.endBar]), [
        ['I: First (Instrumental)', 1, 80], ['II: Second', 81, 160], ['III: Third', 161, 300]
    ]);
    assert.equal(segmentIndexAtBar(segs, 118), 1);
});

test('a file without movements shows its parts; on a narrow ruler same-kind slivers become one run and different kinds stay apart', () => {
    const flat = deriveSections(bars(200, { 1: 'Intro', 17: 'Verse', 25: 'Verse 2', 33: 'Verse 3', 41: 'Chorus', 61: 'Verse 4', 81: 'Chorus 2', 121: 'Outro' }), { minBars: 4 }).parts;
    const wide = buildSegments(flat, 200, 1000);
    assert.deepEqual(wide.map((s) => s.title), ['Intro', 'Verse', 'Verse 2', 'Verse 3', 'Chorus', 'Verse 4', 'Chorus 2', 'Outro']);
    const narrow = buildSegments(flat, 200, 120, 24); // 8 bars is 5px
    assert.deepEqual(narrow.map((s) => s.family), ['bookend', 'verse', 'chorus', 'verse', 'chorus', 'bookend']);
    assert.equal(narrow[1].title, 'Verse'); // the run is called by its first part
    assert.equal(narrow[1].startBar, 17); assert.equal(narrow[1].endBar, 40);
    assert.equal(narrow[0].start, 0);
    assert.equal(narrow.at(-1).start + narrow.at(-1).width, 1);
    for (let i = 1; i < narrow.length; i++) assert.ok(Math.abs(narrow[i].start - (narrow[i - 1].start + narrow[i - 1].width)) < 1e-9);
});

test('a sliver whose name says no kind is absorbed by its neighbour, which keeps its name and kind', () => {
    const parts = deriveSections(bars(100, { 1: 'Verse', 41: 'Hypocrites', 45: 'Chorus' }), { minBars: 1 }).parts;
    const segs = buildSegments(parts, 100, 100, 24); // 4 bars is 4px
    assert.deepEqual(segs.map((s) => [s.title, s.family, s.startBar, s.endBar]), [['Verse', 'verse', 1, 44], ['Chorus', 'chorus', 45, 100]]);
});

test('a movement too narrow to draw joins its neighbour and keeps that neighbour\'s name', () => {
    const segs = buildSegments(suite(), 300, 150, 24); // 80 bars = 40px: all fit; shrink further
    assert.equal(segs.length, 3);
    const tiny = buildSegments(suite(), 300, 60, 24);
    assert.ok(tiny.length < 3);
    assert.equal(tiny[0].title, 'I: First (Instrumental)');
});

// ---- sectionKind: one meaning for the many ways files write a section ----
import { sectionKind } from '../src/gpProcessor/sectionKinds.js';

test('sectionKind reads the same kind through numbering, spelling, case, accents and other languages', () => {
    const fam = (n) => sectionKind(n)?.family || null;
    for (const n of ['Chorus', 'chorus 2', 'CHORUS II', 'Chorus (0:41)', 'Estribillo', 'Refrain', 'Pre-Chorus', 'Prechorus', 'Post Chorus 3']) assert.equal(fam(n), 'chorus', n);
    for (const n of ['Verse', 'Verse 1', 'verse2', 'Verso 2', 'Strophe', 'Pre-Verse']) assert.equal(fam(n), 'verse', n);
    for (const n of ['Bridge', 'Bridge 2', 'Puente', 'Pont', 'Middle 8']) assert.equal(fam(n), 'bridge', n);
    for (const n of ['Solo', 'Solo 2', 'Guitar Solo', 'Keyboard Solo', 'Bass solo', 'solos', 'Guitar Solo (Transition)']) assert.equal(fam(n), 'solo', n);
    for (const n of ['Intro', 'Introduction', 'Outro', 'Outtro', 'Ending', 'Coda', 'End']) assert.equal(fam(n), 'bookend', n);
    for (const n of ['Interlude', 'Instrumental', 'Main Riff', 'Riff 2', 'Break', 'Breakdown', 'Transition']) assert.equal(fam(n), 'instrumental', n);
});

test('sectionKind: a Pre-Chorus is not a Chorus, and the earliest naming word wins', () => {
    assert.equal(sectionKind('Pre-Chorus').kind, 'pre-chorus');
    assert.equal(sectionKind('Post-Chorus II').kind, 'post-chorus');
    assert.equal(sectionKind('Intro Solo').kind, 'intro');
    assert.equal(sectionKind('Riff Intro').kind, 'riff');
    assert.equal(sectionKind('Bridge into guitar solo').kind, 'bridge');
});

test('sectionKind never guesses: lyric lines, cues, movements and placeholders have no kind', () => {
    for (const n of ['', 'Start', 'Part 3', 'A', 'choir enters', 'help me', 'II: Innocence', 'Hypocrites', 'oboe fill', 'half time feel']) assert.equal(sectionKind(n), null, n);
});

test('buildSegments carries the family, and merging keeps it only when both blocks agree', () => {
    const parts = deriveSections(bars(120, { 1: 'Intro', 9: 'Verse', 25: 'Verse 2', 41: 'Chorus', 57: 'Guitar Solo', 81: 'Hypocrites', 101: 'Outro' }), { minBars: 4 }).parts;
    const segs = buildSegments(parts, 120, 1200);
    assert.deepEqual(segs.map((s) => s.family), ['bookend', 'verse', 'verse', 'chorus', 'solo', '', 'bookend']);
    const narrow = buildSegments(parts, 120, 150, 24); // the two verses are one run and stay a verse
    assert.equal(narrow.filter((s) => s.family === 'verse').length, 1);
});

test('a narrow ruler never piles the whole song into one block', () => {
    const marks = {};
    for (let i = 0; i < 20; i++) marks[1 + i * 14] = i % 2 ? 'Chorus' : 'Verse';
    const parts = deriveSections(bars(280, marks), { minBars: 4 }).parts;
    const segs = buildSegments(parts, 280, 266, 24); // alternating kinds: nothing can merge, so each part stays a coloured block
    assert.equal(segs.length, 20);
    assert.ok(segs.every((s) => s.family));
    const unnamed = {};
    for (let i = 0; i < 20; i++) unnamed[1 + i * 14] = 'Alpha ' + i;
    const lumps = buildSegments(deriveSections(bars(280, unnamed), { minBars: 4 }).parts, 280, 266, 24);
    assert.ok(lumps.length >= 6 && lumps.length <= 11, `blocks: ${lumps.length}`);
    assert.equal(segs.reduce((n, s) => n + s.width, 0).toFixed(6), '1.000000');
});
