// tuningVisual.test.mjs
import assert from 'node:assert';
import { getTuningVisualData, renderTuningBarsSvg } from '../src/utils/tuningVisual.js';

console.log('Testing tuningVisual...');

// 1. Standard Guitar (6-string)
const std = getTuningVisualData('Standard');
assert.strictEqual(std.stringCount, 6, 'Standard guitar should have 6 strings');
assert.deepStrictEqual(std.deltas, [0, 0, 0, 0, 0, 0], 'Standard guitar deltas should all be 0');

// 2. Drop D (6-string)
const dropD = getTuningVisualData('Drop D');
assert.strictEqual(dropD.stringCount, 6);
assert.deepStrictEqual(dropD.deltas, [-2, 0, 0, 0, 0, 0], 'Drop D should have low string at -2 semitones');
assert.strictEqual(dropD.isDrop, true);

// 3. Eb Standard (6-string)
const eb = getTuningVisualData('Eb Standard');
assert.strictEqual(eb.stringCount, 6);
assert.deepStrictEqual(eb.deltas, [-1, -1, -1, -1, -1, -1], 'Eb Standard should have all strings at -1');

// 4. D Standard (6-string)
const dStd = getTuningVisualData('D Standard');
assert.strictEqual(dStd.stringCount, 6);
assert.deepStrictEqual(dStd.deltas, [-2, -2, -2, -2, -2, -2], 'D Standard should have all strings at -2');

// 5. Drop C (6-string)
const dropC = getTuningVisualData('Drop C');
assert.strictEqual(dropC.stringCount, 6);
assert.deepStrictEqual(dropC.deltas, [-4, -2, -2, -2, -2, -2], 'Drop C should have low string at -4 and rest at -2');

// 6. Bass Standard (4-string)
const bassStd = getTuningVisualData('Bass Standard');
assert.strictEqual(bassStd.stringCount, 4, 'Bass standard should have 4 strings');
assert.deepStrictEqual(bassStd.deltas, [0, 0, 0, 0], 'Bass standard deltas should all be 0');

// 7. Bass Drop D (4-string)
const bassDropD = getTuningVisualData('Bass Drop D');
assert.strictEqual(bassDropD.stringCount, 4);
assert.deepStrictEqual(bassDropD.deltas, [-2, 0, 0, 0], 'Bass Drop D should have low string at -2');

// 8. 5-String Bass
const bass5 = getTuningVisualData('5-String Bass');
assert.strictEqual(bass5.stringCount, 5, '5-String bass should have 5 strings');
assert.deepStrictEqual(bass5.deltas, [0, 0, 0, 0, 0]);

// 9. 6-String Bass
const bass6 = getTuningVisualData('6-String Bass');
assert.strictEqual(bass6.stringCount, 6);
assert.deepStrictEqual(bass6.deltas, [0, 0, 0, 0, 0, 0]);

// 10. 7-String Standard and Drop A
const std7 = getTuningVisualData('7-String Standard');
assert.strictEqual(std7.stringCount, 7);
assert.deepStrictEqual(std7.deltas, [0, 0, 0, 0, 0, 0, 0]);

const dropA7 = getTuningVisualData('7-String Drop A');
assert.strictEqual(dropA7.stringCount, 7);
assert.deepStrictEqual(dropA7.deltas, [-2, 0, 0, 0, 0, 0, 0]);

// 11. 8-String Standard
const std8 = getTuningVisualData('8-String Standard');
assert.strictEqual(std8.stringCount, 8);
assert.deepStrictEqual(std8.deltas, [0, 0, 0, 0, 0, 0, 0, 0]);

// 12. Object Input (as provided in libraryModal group)
const groupObj = {
    name: 'Drop D',
    key: 'DADGBE',
    notes: 'D A D G B E',
    songs: [{ title: 'Test Song' }]
};
const objData = getTuningVisualData(groupObj);
assert.strictEqual(objData.stringCount, 6);
assert.deepStrictEqual(objData.deltas, [-2, 0, 0, 0, 0, 0]);

// 13. SVG Markup Generation
const svg = renderTuningBarsSvg(groupObj, 36);
assert(typeof svg === 'string', 'SVG should be a string');
assert(svg.includes('<svg'), 'Should contain <svg tag');
assert(svg.includes('role="img"'), 'Should have role="img"');
assert(svg.includes('aria-label='), 'Should have accessible aria-label');
assert(svg.includes('<line'), 'Should have horizon line');
assert(svg.includes('<rect'), 'Should have pitch bars');
assert(svg.includes('<circle'), 'Should have string count micro-dots');

console.log('All tuningVisual tests passed successfully! ✅');
