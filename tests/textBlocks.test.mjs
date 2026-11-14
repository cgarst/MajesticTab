// Run with: node --test tests/textBlocks.test.mjs
// Set CLASSTAB_DIR to a folder of downloaded classtab .txt files to also check a whole archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupBlocks, paginate, isStaffLine, isRulerLine, createChordLyricSegments, sliceAnnotationCols } from '../src/textProcessor/textBlocks.js';

// Synthetic, in the shape of a classtab file: heading, ruler, six strings, marks below, blank line, marks above the next ruler.
const sample = [
    'Some Piece - Some Composer',
    '',
    'tuning: E A D G B E',
    '',
    '    Andantino',
    '0   .    |   .   |   .',
    'e|--0--|-0-----1-0---|',
    'B|-----|-1-----------|',
    'G|*----|-------------|',
    'D|*----|-------------|',
    'A|-----|-0===========|',
    'E|-----|-------------|',
    '    mf        2',
    '              3',
    '',
    '       cII_          cII_',
    '5  |   .   |   .   |',
    'e|-0-----1-0---|-0---|',
    'B|-1-----------|-1---|',
    'G|-------------|-----|',
    'D|-------------|-----|',
    'A|-0===========|-0===|',
    'E|-------------|-----||',
    '',
    'Notes and Legend'
];

test('line classes follow the classtab shapes', () => {
    for (const l of ['e|-0-|', 'A|-0===|', 'G|*----|', 'D||---|', 'Eb |-2-|', 'b|---|']) assert.ok(isStaffLine(l), l);
    for (const l of ['0   .    |   .   |', '5  |   .   |   .', '25 |  .  |  .']) assert.ok(isRulerLine(l), l);
    for (const l of ['o|| - end of repeat', 'edition: Schott', 'tuning: E A D G B E', '']) assert.ok(!isStaffLine(l), l);
});

test('a staff system is one block with its ruler, heading, marks above and fingering below', () => {
    const blocks = groupBlocks(sample);
    const systems = blocks.filter(b => b.kind === 'system');
    assert.equal(systems.length, 2);
    assert.deepEqual([systems[0].start, systems[0].end], [4, 13]);   // Andantino .. fingering lines
    assert.deepEqual([systems[1].start, systems[1].end], [15, 22]);  // cII_ line .. last string
    assert.equal(blocks[blocks.length - 1].kind, 'line');            // the legend stays a plain line
});

test('blank runs are one gap block and every line is in exactly one block', () => {
    const blocks = groupBlocks(['a', '', '', '', 'b']);
    assert.deepEqual(blocks.map(b => b.kind), ['line', 'blank', 'line']);
    const covered = groupBlocks(sample).flatMap(b => Array.from({ length: b.end - b.start + 1 }, (_, i) => b.start + i));
    assert.deepEqual(covered, sample.map((_, i) => i));
});

test('a chord line over a lyric is one block; a lone string line is not a system', () => {
    assert.deepEqual(groupBlocks(['Am  G', 'hello there']).map(b => b.kind), ['chord']);
    assert.deepEqual(groupBlocks(['e|---0---|']).map(b => b.kind), ['line']);
});

test('pages break between blocks, drop gaps at the edges and give an oversize block its own page', () => {
    const blocks = [{ kind: 'line' }, { kind: 'blank' }, { kind: 'system' }, { kind: 'blank' }, { kind: 'system' }, { kind: 'system' }];
    const heights = [1, 1, 5, 1, 5, 20];
    assert.deepEqual(paginate(blocks, heights, 10), [[0, 1, 2], [4], [5]]);
});

test('no page boundary falls inside a system (every block lands whole on one page)', () => {
    const blocks = groupBlocks(sample);
    const heights = blocks.map(b => b.end - b.start + 1);
    for (const max of [5, 8, 10, 12, 20]) {
        const pages = paginate(blocks, heights, max);
        const seen = pages.flat();
        assert.equal(new Set(seen).size, seen.length);
        for (const page of pages) assert.notEqual(blocks[page[0]].kind, 'blank');
    }
});

const dir = process.env.CLASSTAB_DIR;
test('whole archive: no string line starts a block of its own inside a staff run', { skip: !dir }, () => {
    let checked = 0;
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.txt'))) {
        const lines = fs.readFileSync(path.join(dir, f), 'latin1').replace(/\r\n?/g, '\n').split('\n');
        const starts = new Set(groupBlocks(lines).map(b => b.start));
        for (let i = 1; i < lines.length; i++) {
            if (isStaffLine(lines[i]) && isStaffLine(lines[i - 1]) && starts.has(i)) assert.fail(`${f}:${i + 1} splits a system`);
        }
        checked++;
    }
    assert.ok(checked > 0);
});

test('chord names are cut whole, with extensions and slash chords', () => {
    const chords = (l) => createChordLyricSegments(l, ' '.repeat(l.length)).map(s => s.chord).filter(Boolean);
    assert.deepEqual(chords('Amaj7 Dsus4 F#m C/G Am7b5 Cdim Bb G7'), ['Amaj7', 'Dsus4', 'F#m', 'C/G', 'Am7b5', 'Cdim', 'Bb', 'G7']);
});

test('lyric before the first chord and past the last chord is kept', () => {
    assert.deepEqual(createChordLyricSegments('    Am', 'hello there'), [
        { chord: '', lyric: 'hell' },
        { chord: 'Am', lyric: 'o there' }
    ]);
    // chord line wider than its lyric: no throw, no reversed slice
    assert.deepEqual(createChordLyricSegments('C      G', 'hi'), [
        { chord: 'C', lyric: 'hi' },
        { chord: 'G', lyric: '' }
    ]);
});

test('expanded staff patterns: unnamed bar staves, dash-first pickup staves, letter-dash staves, barless 6-line staves', () => {
    for (const l of [
        '|-12-10-8-7-|',
        '||o-6-5-3---|',
        'E----2---0---|',
        'e-||---0---2---|',
        '---7---||--3---|',
        '   -----0-----0-|',
        'E+--7---------+',
        'E  --------]----0---]'
    ]) {
        assert.ok(isStaffLine(l), `Expected staff line: ${l}`);
    }
    // Barless 6-line staff system (e.g. lute / Andrew York tabs)
    const barless = [
        'Bagatelle',
        '',
        '-0-----0-2-0---------0-------0-',
        '-0-2-4-0-----3-2-0-------------',
        '-2-3---------------3-2-3-2-0-2-',
        '-2-4---2-----------------------',
        '-------------------------------',
        '-------0-------------0-------0-'
    ];
    const blocks = groupBlocks(barless);
    const systems = blocks.filter(b => b.kind === 'system');
    assert.equal(systems.length, 1);
    assert.equal(systems[0].strings.length, 6);
    assert.ok(systems[0].bars.length >= 1);
});

test('decomposeSystem extracts above, strings, below, trimCols, and bars with repeat flags and noteOnsets', () => {
    const blocks = groupBlocks(sample);
    const sys0 = blocks.find(b => b.kind === 'system');
    assert.deepEqual(sys0.above, ['    Andantino', '0   .    |   .   |   .']);
    assert.equal(sys0.strings.length, 6);
    assert.deepEqual(sys0.below, ['    mf        2', '              3']);
    assert.equal(sys0.trimCols, 1);
    assert.equal(sys0.bars.length, 2);
    assert.equal(sys0.bars[0].barNumber, 0);
    assert.equal(sys0.bars[1].barNumber, 1);
    assert.equal(sys0.bars[0].repeatStart, true);
    assert.equal(sys0.bars[1].repeatStart, false);
    assert.ok(sys0.bars[1].noteOnsets.length >= 3);
    assert.equal(sliceAnnotationCols('5  |   .   |', 2), '5|   .   |');
});

test('duet systems merge two 6-string staves separated by a part label, and legend examples stay out of playable systems', () => {
    const duetAndLegend = [
        'Gtr I',
        'e|-0---2---|-3---|',
        'B|-1---3---|-0---|',
        'G|-2---2---|-0---|',
        'D|---------|-----|',
        'A|-0-------|-----|',
        'E|---------|-3---|',
        'Gtr II',
        'e|---------|-----|',
        'B|---------|-----|',
        'G|-2---0---|-0---|',
        'D|-2---0---|-0---|',
        'A|-0---2---|-2---|',
        'E|---------|-3---|',
        '',
        'Tablature Explanation:',
        'e|--5h7--|  hammer-on',
        'B|-------|'
    ];
    const blocks = groupBlocks(duetAndLegend);
    const systems = blocks.filter(b => b.kind === 'system');
    assert.equal(systems.length, 1);
    assert.equal(systems[0].staves.length, 2);
    assert.equal(systems[0].strings.length, 12);
    const legendBlocks = blocks.filter(b => b.inLegend);
    assert.ok(legendBlocks.length >= 2);
});

