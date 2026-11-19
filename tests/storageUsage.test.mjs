// Run: node tests/storageUsage.test.mjs
// The storage diagram's arithmetic: sorting a cloud listing into kinds, and bar segments drawn to one scale.
import assert from 'node:assert/strict';
import { cloudUsageFromEntries, sumSizes, totalOf, barSegments } from '../src/utils/storageUsageCore.js';

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
console.log('storageUsage: ok');
