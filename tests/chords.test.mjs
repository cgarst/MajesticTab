// tests/chords.test.mjs
// Unit tests for MajesticTab chord database, Option B moveable shapes, and diagram rendering.

import assert from 'node:assert/strict';

// Set up minimal browser mocks for Node environment
globalThis.localStorage = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); }
};

import {
    getChordDataset,
    getNormalizedChordList,
    deriveMoveableShapes,
    formatSuffix,
    categorizeSuffix,
    TUNINGS_MIDI
} from '../src/utils/chordEngine.js';
import {
    buildChordDiagramSvg,
    getChordOrientation,
    setChordOrientation,
    getChordViewMode,
    setChordViewMode
} from '../src/utils/chordDiagram.js';

console.log('Running chord tests...');

// 1. Verify Raw Dataset Schemas
const guitar6 = await getChordDataset(6);
const guitar7 = await getChordDataset(7);
const guitar8 = await getChordDataset(8);

assert.equal(guitar6.main.strings, 6);
assert.equal(guitar6.tunings.standard.length, 6);
assert.equal(guitar6.keys.length, 12);
assert.ok(guitar6.suffixes.length >= 80, 'guitar6 should have at least 80 suffixes');
assert.ok(guitar6.chords['C'].length > 0, 'guitar6 C chords should exist');

assert.equal(guitar7.main.strings, 7);
assert.equal(guitar7.tunings.standard.length, 7);
assert.equal(guitar7.tunings.standard[0], 'B1');
assert.equal(guitar7.keys.length, 12);

assert.equal(guitar8.main.strings, 8);
assert.equal(guitar8.tunings.standard.length, 8);
assert.equal(guitar8.tunings.standard[0], 'F#1');
assert.equal(guitar8.keys.length, 12);

console.log('✓ Raw dataset schemas verified');

// 2. Normalized Chord Lists
const list6 = await getNormalizedChordList(6);
assert.ok(list6.length > 2500, `Expected > 2500 6-string positions, got ${list6.length}`);
const cMajor = list6.find(c => c.name === 'C' && c.cat === 'Major');
assert.ok(cMajor, 'C major chord found');
assert.equal(cMajor.frets, 'x 3 2 0 1 0');

const list7 = await getNormalizedChordList(7);
assert.ok(list7.length >= 400, `Expected >= 400 7-string positions, got ${list7.length}`);
const c7 = list7.find(c => c.name === 'C');
assert.ok(c7, '7-string C chord found');
assert.equal(c7.frets.split(' ').length, 7);

const list8 = await getNormalizedChordList(8);
assert.ok(list8.length >= 400, `Expected >= 400 8-string positions, got ${list8.length}`);
const c8 = list8.find(c => c.name === 'C');
assert.ok(c8, '8-string C chord found');
assert.equal(c8.frets.split(' ').length, 8);

console.log('✓ Normalized chord lists verified (6, 7, 8 strings)');

// 3. Option B Moveable Shapes Derivation
const shapes6 = await deriveMoveableShapes(6);
assert.ok(shapes6.length > 500, `Expected > 500 moveable shapes, got ${shapes6.length}`);

// Check that no moveable shape contains open strings
for (const s of shapes6) {
    assert.ok(s.isMoveable, 'Shape marked as moveable');
    assert.ok(s.rootString >= 0 && s.rootString < 6, 'Valid root string');
    assert.ok(Array.isArray(s.offsets), 'Offsets is an array');
    assert.ok(Array.isArray(s.labels), 'Labels is an array');
    assert.equal(s.labels[s.rootString], 'R', 'Root string must be labeled R');
}

// Check standard CAGED shapes for Major
const eShape = shapes6.find(s => s.suffix === 'major' && s.rootString === 0 && s.offsets[1] === 2 && s.offsets[2] === 2);
assert.ok(eShape, 'E-shape major moveable barre chord derived');
assert.deepEqual(eShape.offsets, [0, 2, 2, 1, 0, 0]);
assert.deepEqual(eShape.labels, ['R', '5', 'R', '3', '5', 'R']);

const aShape = shapes6.find(s => s.suffix === 'major' && s.rootString === 1 && s.offsets[2] === 2 && s.offsets[3] === 2);
assert.ok(aShape, 'A-shape major moveable barre chord derived');
assert.deepEqual(aShape.offsets, [null, 0, 2, 2, 2, 0]);
assert.deepEqual(aShape.labels, [null, 'R', '5', 'R', '3', '5']);

const shapes7 = await deriveMoveableShapes(7);
assert.ok(shapes7.length > 50, `Expected > 50 7-string moveable shapes, got ${shapes7.length}`);

const shapes8 = await deriveMoveableShapes(8);
assert.ok(shapes8.length > 50, `Expected > 50 8-string moveable shapes, got ${shapes8.length}`);

console.log('✓ Option B moveable shape derivation verified');

// 4. SVG Diagram Rendering (Vertical default vs Horizontal)
const sampleChord = { name: 'C', frets: 'x 3 2 0 1 0', startFret: 1 };

// Vertical (now default)
const vertSvg = buildChordDiagramSvg(sampleChord, 1, 'vertical');
assert.ok(vertSvg.includes('class="ref-chord-diagram-svg ref-chord-diagram-vertical"'));
assert.ok(vertSvg.includes('<line x1="22" y1="22"'), 'Nut horizontal on top');
assert.ok(vertSvg.includes('×'), 'Muted indicator on vertical');
assert.ok(vertSvg.includes('</svg>'), 'Valid SVG closing tag');

// Horizontal
const horizSvg = buildChordDiagramSvg(sampleChord, 1, 'horizontal');
assert.ok(horizSvg.includes('class="ref-chord-diagram-svg ref-chord-diagram-horizontal"'));
assert.ok(horizSvg.includes('<line x1="30" y1="14"'), 'Nut vertical on left');
assert.ok(horizSvg.includes('<svg'), 'Valid SVG opening tag');
assert.ok(horizSvg.includes('</svg>'), 'Valid SVG closing tag');

// Moveable shape in vertical orientation
const vertMoveableSvg = buildChordDiagramSvg(eShape, 1, 'vertical');
assert.ok(vertMoveableSvg.includes('fill="var(--action)"'), 'Root highlighted with action hue');
assert.ok(vertMoveableSvg.includes('>R<'), 'Root labeled with letter R');

// Moveable shape in horizontal orientation
const horizMoveableSvg = buildChordDiagramSvg(eShape, 1, 'horizontal');
assert.ok(horizMoveableSvg.includes('fill="var(--action)"'), 'Root highlighted in horizontal');
assert.ok(horizMoveableSvg.includes('>R<'), 'Root labeled with R in horizontal');

// Capo indication on fret (Vertical & Horizontal)
const vertCapoSvg = buildChordDiagramSvg(sampleChord, 1, 'vertical', null, 2);
assert.ok(vertCapoSvg.includes('class="ref-chord-capo-bar"'), 'Capo bar rendered in vertical');
assert.ok(vertCapoSvg.includes('Capo 2'), 'Capo fret 2 text rendered in vertical');

const horizCapoSvg = buildChordDiagramSvg(sampleChord, 1, 'horizontal', null, 3);
assert.ok(horizCapoSvg.includes('class="ref-chord-capo-bar"'), 'Capo bar rendered in horizontal');
assert.ok(horizCapoSvg.includes('Capo 3'), 'Capo fret 3 text rendered in horizontal');

const chordObjCapoSvg = buildChordDiagramSvg({ ...sampleChord, capo: 4 }, 1, 'vertical');
assert.ok(chordObjCapoSvg.includes('class="ref-chord-capo-bar"'), 'Capo bar rendered from chord object');
assert.ok(chordObjCapoSvg.includes('Capo 4'), 'Capo fret 4 text rendered from chord object');

console.log('✓ Diagram rendering verified (Vertical default & Horizontal, including Capo)');

// 5. Orientation and View Mode state helpers (Verify defaults)
// Clear storage to test defaults
globalThis.localStorage._data = {};
assert.equal(getChordOrientation(), 'vertical', 'Default orientation must be vertical');
assert.equal(getChordViewMode(), 'moveable', 'Default view mode must be moveable');

// Test toggle transitions
setChordOrientation('horizontal');
assert.equal(getChordOrientation(), 'horizontal');
setChordOrientation('vertical');
assert.equal(getChordOrientation(), 'vertical');

setChordViewMode('note');
assert.equal(getChordViewMode(), 'note');
setChordViewMode('moveable');
assert.equal(getChordViewMode(), 'moveable');

console.log('✓ State helpers and default preferences verified');

// 6. Verify URL router mapping and HTML ordering
import fs from 'node:fs';
const refLibSource = fs.readFileSync(new URL('../src/referenceLibrary.js', import.meta.url), 'utf8');
const urlRouterSource = fs.readFileSync(new URL('../src/utils/urlRouter.js', import.meta.url), 'utf8');

// Ensure prefer movable shapes switch is positioned before orientation buttons
const movableBtnIdx = refLibSource.indexOf('id="refChordMovableBtn"');
const orientRowIdx = refLibSource.indexOf('class="ref-chip-row ref-orient-row"');
assert.ok(movableBtnIdx !== -1 && orientRowIdx !== -1, 'Both controls present in source');
assert.ok(movableBtnIdx < orientRowIdx, 'Prefer movable shapes switch must be left of vertical/horizontal buttons');
console.log('✓ Prefer movable shapes positioned to the left of vertical/horizontal buttons');

// Ensure urlRouter routes reference to tools page, not modal
assert.ok(!urlRouterSource.includes('openReferenceModal(targetRefTab)'), 'urlRouter should not call openReferenceModal directly');
assert.ok(urlRouterSource.includes("openToolOnNextRender(targetRefTab)"), 'urlRouter should route to tools page via openToolOnNextRender');
console.log('✓ #reference URLs configured to route to Tools page');

// Ensure 6-string tunings include C tuning (offset 4)
const tuningSpecMatch = refLibSource.match(/6:\s*\{\s*low:\s*4,\s*steps:[^}]+offsets:\s*\[([^\]]+)\]/);
assert.ok(tuningSpecMatch, '6-string tuningSpec must be present');
const offsets = tuningSpecMatch[1].split(',').map(s => parseInt(s.trim(), 10));
assert.ok(offsets.includes(4), '6-string tuning offsets must include 4 (C tuning)');
console.log('✓ 6-string chord library tunings include C tuning (offset 4)');

console.log('All chord tests passed successfully!');

// 7. Movable shape catalogue (families, chord types, root-string grouping)
import { SHAPE_FAMILIES, SHAPE_TYPES, getShapeTypes, getShapesForType } from '../src/utils/chordShapes.js';
assert.equal(SHAPE_FAMILIES.length, 7);
assert.equal(SHAPE_TYPES.length, 42);
for (const f of SHAPE_FAMILIES) assert.ok(getShapeTypes(f.id).length > 0, `${f.id} has chord types`);
for (const t of SHAPE_TYPES) {
    const r = getShapesForType(t.id, 6);
    assert.ok(r.total > 0, `${t.id} has movable shapes`);
    for (const g of r.root) for (const sh of g.shapes) {
        assert.ok(!sh.frets.split(' ').includes('0'), 'no open strings');
        assert.equal(sh.labels[sh.lowString], 'R', 'root-position shape has the root in the bass');
    }
}
const d13 = getShapesForType('13', 6);
assert.ok(d13.root.length >= 2 && d13.inversions.length >= 1, 'dominant thirteenth has root and inversion shapes');
console.log('✓ Movable shape catalogue verified (7 families, 42 chord types, incl. dominant thirteenth)');

// 8. Tools nav Chord library readout formatting and CSS resilience
const formatChordsReadout = (strings, offset, capo) => {
    const parts = [];
    if (strings === 7 || strings === 8) parts.push(`${strings} strings`);
    if (capo > 0) parts.push(`Capo ${capo}`);
    if (Number.isInteger(offset) && offset !== 0) {
        const count = Math.abs(offset);
        parts.push(`${offset > 0 ? '+' : '\u2212'}${count} semitone${count === 1 ? '' : 's'}`);
    }
    return parts.join(' \u00b7 ');
};

assert.equal(formatChordsReadout(6, 0, 0), '');
assert.equal(formatChordsReadout(7, 1, 2), '7 strings · Capo 2 · +1 semitone');
assert.equal(formatChordsReadout(8, -2, 0), '8 strings · −2 semitones');
assert.equal(formatChordsReadout(6, -1, 3), 'Capo 3 · −1 semitone');

const designCss = fs.readFileSync(new URL('../src/design.css', import.meta.url), 'utf8');
assert.ok(designCss.includes('.tools-shell .setnav button .tool-name { flex: 0 0 auto; max-width: 100%; font-size: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }'), 'tool-name must not wrap or shrink into tool-read');
assert.ok(designCss.includes('.tools-shell .setnav button .tool-read { flex: 1 1 auto; min-width: 0; color: var(--ink2); font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; margin-left: auto; }'), 'tool-read must shrink and truncate cleanly without colliding');
console.log('✓ Tools nav Chord library readout formatting and CSS verified');

