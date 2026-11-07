// Run with: node --test tests/textBlocks.test.mjs
// Set CLASSTAB_DIR to a folder of downloaded classtab .txt files to also check a whole archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { groupBlocks, paginate, isStaffLine, isRulerLine } from '../src/textProcessor/textBlocks.js';

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
