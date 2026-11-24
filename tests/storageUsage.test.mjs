// Run: node tests/storageUsage.test.mjs
// The storage diagram's arithmetic: sorting a cloud listing into kinds, and bar segments drawn to one scale.
import assert from 'node:assert/strict';
import { cloudUsageFromEntries, sumSizes, totalOf, barSegments, stemGroupsFromMeta, largestRows } from '../src/utils/storageUsageCore.js';

const usage = cloudUsageFromEntries([
    { path: 'packs/abc/manifest.json', size: 1000 },
    { path: 'packs/abc/tabs/song.gp5', size: 4000 },
    { path: 'packs/abc/audio/take.mp3', size: 50000 },
    { path: 'packs/def/audio/x.m4a', size: 20000 },
    { path: 'soundfonts/font1', size: 7000 },
    { path: 'classtab/archive', size: 3000 },
    { path: 'tombstones.json', size: 99 },
    { path: 'packs/zero/manifest.json', size: 0 },
]);
assert.deepEqual(usage, { tabs: 5000, audio: 70000, fonts: 7000, classtab: 3000, cache: 0 });
assert.equal(totalOf(usage), 85000);
assert.equal(sumSizes([{ size: 3 }, { size: undefined }, null, { size: 4 }]), 7);
assert.deepEqual(cloudUsageFromEntries(null), { tabs: 0, audio: 0, fonts: 0, classtab: 0, cache: 0 });

const segs = barSegments({ tabs: 50, audio: 0, fonts: 25, classtab: 0 }, 100);
assert.deepEqual(segs.map((s) => [s.id, s.index, s.percent]), [['tabs', 0, 50], ['fonts', 2, 25]]);
assert.deepEqual(barSegments({ tabs: 1 }, 0), []);
assert.equal(barSegments({ tabs: 1 }, 1e9)[0].percent, 0.5);

// Largest files: a stem set is one row named for its song, summed; the rest are one row each; biggest first
const groups = stemGroupsFromMeta([{ song: 'a - b', map: { local_a: { role: 'stem', stems: [{ audioId: 'a' }, { audioId: 'b' }] }, local_c: { role: 'stem', stemOf: 'local_m' }, local_d: { role: 'stem', stemOf: 'local_m' } } }]);
const rows = largestRows({
    tabs: [{ id: 't', name: 'song.gp5', size: 500 }],
    audio: [{ id: 'a', name: 'drums.mp3', size: 40, songKeys: ['A - B'] }, { id: 'b', name: 'bass.mp3', size: 30, songKeys: ['A - B'] }, { id: 'c', name: 'x.mp3', size: 100 }, { id: 'd', name: 'y.mp3', size: 100 }, { id: 'e', name: 'mix.mp3', size: 150 }],
    fonts: [{ id: 'f', name: 'big.sf2', size: 0 }], classtab: [],
}, groups);
assert.deepEqual(rows.map((r) => [r.name, r.bytes]), [['song.gp5', 500], ['a - b (2 stems)', 200], ['mix.mp3', 150], ['A - B (2 stems)', 70]]);
assert.deepEqual(rows[3].ids, ['a', 'b']);
assert.deepEqual(rows[3].songs, ['a - b']);
console.log('storageUsage: ok');
