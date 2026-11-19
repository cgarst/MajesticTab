// tests/tabSets.test.mjs
// Tab sets: the link rule for one pack, reading sets back (with broken links), and the migration rule for tabs made before
// `origin` existed. All data here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSets, resolveSets, visibleTabs, setOf, deriveLegacySets, planTabSetMigration, LEGACY_SET_ORIGIN } from '../src/tabSets.js';

const tab = (id, name, path, extra = {}) => ({ id, name, relativePath: path, fileType: 'pdf', addedAt: 1, sha256: `h-${id}`, ...extra });
const quartet = (prefix, tag, extra = {}) => [
    tab(`${tag}1t`, `${prefix}Guitar 1 (Tablature)`, 'guitar-1-tablature.pdf', extra),
    tab(`${tag}1s`, `${prefix}Guitar 1 (Score)`, 'guitar-1-score.pdf', extra),
    tab(`${tag}2t`, `${prefix}Guitar 2 (Tablature)`, 'guitar-2-tablature.pdf', extra),
    tab(`${tag}2s`, `${prefix}Guitar 2 (Score)`, 'guitar-2-score.pdf', extra),
];

test('linkSets: scores with one origin are a set, the first is the head, no origin stands alone', () => {
    const m = linkSets([
        { id: 'gp' }, { id: 'a', origin: 'X' }, { id: 'b', origin: 'X' }, { id: 'c', origin: 'X' }, { id: 'mine' },
    ]);
    assert.deepEqual([...m], [['b', 'a'], ['c', 'a']]);
});

test('linkSets: the primary score heads its set, origins compare byte for byte, a set of one is nothing', () => {
    assert.deepEqual([...linkSets([{ id: 'p', origin: 'X' }, { id: 'q', origin: 'x' }, { id: 'r', origin: 'X' }])], [['r', 'p']]);
    assert.equal(linkSets([{ id: 'p', origin: 'X' }, { id: 'q', origin: 'Y' }]).size, 0);
    assert.equal(linkSets([{ id: 'p', origin: '' }, { id: 'q', origin: '' }]).size, 0);
    assert.equal(linkSets(undefined).size, 0);
});

test('resolveSets: heads are listed once, variants hang off them, a broken link stands alone', () => {
    const tabs = [
        { id: 'h' }, { id: 'v1', variantOf: 'h' }, { id: 'v2', variantOf: 'h' }, { id: 'solo' },
        { id: 'gone', variantOf: 'missing' }, { id: 'self', variantOf: 'self' }, { id: 'chain', variantOf: 'v1' },
    ];
    const { heads, variantsOf, headIdOf } = resolveSets(tabs);
    assert.deepEqual(heads.map((t) => t.id), ['h', 'solo', 'gone', 'self', 'chain']);
    assert.deepEqual(variantsOf.get('h').map((t) => t.id), ['v1', 'v2']);
    assert.equal(headIdOf.get('v2'), 'h');
    assert.equal(headIdOf.get('chain'), 'chain');
});

test('visibleTabs and setOf', () => {
    const song = { tabOptions: [{ id: 'gp' }, { id: 'h' }, { id: 'v', variantOf: 'h' }] };
    assert.deepEqual(visibleTabs(song).map((t) => t.id), ['gp', 'h']);
    assert.deepEqual(setOf(song, 'v').map((t) => t.id), ['h', 'v']);
    assert.deepEqual(setOf(song, 'gp').map((t) => t.id), ['gp']);
    assert.deepEqual(setOf(song, 'nope'), []);
    assert.deepEqual(visibleTabs({}), []);
});

test('deriveLegacySets: four views with a prefix are one set, the head is the first', () => {
    const song = { tabOptions: [tab('gp', 'song.gp', 'song.gp', { fileType: 'gp' }), ...quartet('Song - ', 'a')] };
    const { changes } = deriveLegacySets(song);
    assert.deepEqual(changes.map((c) => [c.tabId, c.variantOf]), [['a1t', null], ['a1s', 'a1t'], ['a2t', 'a1t'], ['a2s', 'a1t']]);
    assert.ok(changes.every((c) => c.origin === LEGACY_SET_ORIGIN));
});

test('deriveLegacySets: a tab named only by its file name is found by the file name', () => {
    const tabs = quartet('', 'b').map((t) => ({ ...t, name: t.relativePath }));
    assert.equal(deriveLegacySets({ tabOptions: tabs }).changes.length, 4);
});

test('deriveLegacySets: a lone match, a non-PDF and an unrelated PDF are left alone', () => {
    const song = { tabOptions: [tab('x', 'Song - Guitar 1 (Score)', 'guitar-1-score.pdf'), tab('gp', 'Song (Score).gp5', 'a.gp5', { fileType: 'gp5' }), tab('book', 'Chord book', 'book.pdf')] };
    const { changes, flags } = deriveLegacySets(song);
    assert.equal(changes.length, 0);
    assert.deepEqual(flags.leftAlone, ['x']);
});

test('deriveLegacySets: different prefixes are different sets (a song in parts)', () => {
    const song = { tabOptions: [...quartet('Song (Pt. I) - ', 'a'), ...quartet('Song (Pt. II) - ', 'b')] };
    const { changes } = deriveLegacySets(song);
    assert.equal(changes.length, 8);
    assert.deepEqual(changes.filter((c) => !c.variantOf).map((c) => c.tabId), ['a1t', 'b1t']);
});

test('deriveLegacySets: the same pack imported twice is two layers, flagged as duplicates, nothing merged', () => {
    const song = { tabOptions: [...quartet('Song - ', 'a', { addedAt: 1 }), ...quartet('Song - ', 'b', { addedAt: 2 })] };
    song.tabOptions.forEach((t) => { t.sha256 = t.relativePath; }); // identical files
    const { changes, flags } = deriveLegacySets(song);
    assert.deepEqual(changes.filter((c) => !c.variantOf).map((c) => c.tabId), ['a1t', 'b1t']);
    assert.equal(flags.duplicates.length, 4);
    assert.ok(changes.every((c) => (c.variantOf === null) || c.variantOf.startsWith(c.tabId[0])), 'a variant never points into the other layer');
});

test('deriveLegacySets: a second run finds nothing', () => {
    const song = { tabOptions: quartet('Song - ', 'a') };
    const first = deriveLegacySets(song);
    for (const c of first.changes) Object.assign(song.tabOptions.find((t) => t.id === c.tabId), { origin: c.origin, ...(c.variantOf ? { variantOf: c.variantOf } : {}) });
    assert.equal(deriveLegacySets(song).changes.length, 0);
});

test('planTabSetMigration: counts rows before and after and lists songs to look at', () => {
    const songs = [
        { id: 's1', title: 'One', tabOptions: [tab('gp', 'one.gp', 'one.gp', { fileType: 'gp' }), ...quartet('One - ', 'a')] },
        { id: 's2', title: 'Two', tabOptions: [...quartet('Two (Pt. I) - ', 'b'), ...quartet('Two (Pt. II) - ', 'c')] },
        { id: 's3', title: 'Three', tabOptions: [tab('only', 'Three.pdf', 'three.pdf')] },
    ];
    const { changes, report } = planTabSetMigration(songs);
    assert.equal(changes.length, 12);
    assert.deepEqual({ songs: report.songs, sets: report.sets, rowsBefore: report.rowsBefore, rowsAfter: report.rowsAfter }, { songs: 2, sets: 3, rowsBefore: 13, rowsAfter: 4 });
    assert.deepEqual(report.multiSet, [{ songId: 's2', title: 'Two', sets: 2 }]);
    assert.ok(changes.every((c) => c.songId === 's1' || c.songId === 's2'));
});
