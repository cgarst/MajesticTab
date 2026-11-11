// tests/scalesSound.test.mjs
// Unit tests for Scales tool clickable notes and shorter audio playback.

import assert from 'node:assert/strict';

// Set up minimal browser mocks for Node environment
globalThis.localStorage = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); }
};
const mockEl = {
    checked: false,
    value: '',
    dataset: {},
    style: { setProperty: () => {}, removeProperty: () => {} },
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    focus: () => {}
};
globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => mockEl,
    createElement: () => mockEl,
    body: mockEl,
    documentElement: mockEl
};
globalThis.window = {
    location: { hash: '', pathname: '/src/index.html', search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} })
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

await import('../src/youtubePlayer.js');
const { buildFretboardSvg, renderScalesSection, renderCircleInfoPanel, getChordNotesForSymbol, scaleDefinitions } = await import('../src/referenceLibrary.js');
const { playNote, strumChord } = await import('../src/utils/chordStrum.js');
const { strumWithSoundFont } = await import('../src/utils/chordSynth.js');

console.log('Running scales and circle of fifths sound and clickable notes tests...');

// 1. Verify buildFretboardSvg generates interactive clickable note markers with data-midi
const svgRh = buildFretboardSvg('majorPentatonic', 0); // C Major Pentatonic
assert.ok(svgRh.includes('class="ref-fret-note ref-note-play"'), 'SVG contains ref-fret-note ref-note-play elements');
assert.ok(svgRh.includes('data-midi="'), 'SVG contains data-midi attributes on notes');
assert.ok(svgRh.includes('role="button"'), 'SVG notes have role="button"');
assert.ok(svgRh.includes('tabindex="0"'), 'SVG notes have tabindex="0"');
assert.ok(svgRh.includes('aria-label="Play C, fret 3, A string"'), 'A string fret 3 should be labeled Play C');

// Check that specific guitar notes have the exact MIDI pitch
// Standard tuning 6-string: A string open is 45, fret 3 is C3 = 48
assert.ok(svgRh.includes('data-midi="48"'), 'C3 (fret 3 on A string) should have MIDI 48');
// High e string open (fret 0) is E4 = 64
assert.ok(svgRh.includes('data-midi="64"'), 'E4 (fret 0 on high e string) should have MIDI 64');
// Low E string open (fret 0) is E2 = 40
assert.ok(svgRh.includes('data-midi="40"'), 'E2 (fret 0 on low E string) should have MIDI 40');

console.log('✓ Fretboard SVG right-handed notes and MIDI mapping verified');

// 2. Verify Left-Handed mode fretboard
globalThis.localStorage.setItem('majestictab_fretboard_left_handed', 'true');
const svgLh = buildFretboardSvg('majorPentatonic', 0);
assert.ok(svgLh.includes('class="ref-fret-note ref-note-play"'), 'LH SVG contains ref-note-play elements');
assert.ok(svgLh.includes('data-midi="48"'), 'LH SVG also maps C3 to MIDI 48');
globalThis.localStorage.setItem('majestictab_fretboard_left_handed', 'false');

console.log('✓ Fretboard SVG left-handed notes and MIDI mapping verified');

// 3. Verify renderScalesSection generates clickable scale note buttons
const scalesHtml = renderScalesSection();
assert.ok(scalesHtml.includes('ref-scales-section'), 'Scales container has ref-scales-section class');
assert.ok(scalesHtml.includes('class="ref-scale-note-btn ref-note-play"'), 'Scale notes rendered as clickable note buttons');
assert.ok(scalesHtml.includes('data-midi="'), 'Scale note buttons have data-midi');
assert.ok(scalesHtml.includes('aria-label="Play C"'), 'C scale note has accessible aria-label');

// Check that notes in C Major Pentatonic (C, D, E, G, A) ascend:
// C = 48, D = 50, E = 52, G = 55, A = 57
assert.ok(scalesHtml.includes('data-midi="48"'), 'Root C has MIDI 48');
assert.ok(scalesHtml.includes('data-midi="50"'), 'Second degree D has MIDI 50');
assert.ok(scalesHtml.includes('data-midi="52"'), 'Third degree E has MIDI 52');
assert.ok(scalesHtml.includes('data-midi="55"'), 'Fifth degree G has MIDI 55');
assert.ok(scalesHtml.includes('data-midi="57"'), 'Sixth degree A has MIDI 57');

console.log('✓ Scales section scale notes buttons and ascending MIDI notes verified');

// 4. Verify playNote and strumChord API contracts
assert.equal(typeof playNote, 'function', 'playNote should be exported as a function');
assert.equal(typeof strumChord, 'function', 'strumChord should be exported as a function');

// Test that calling with no window/audio context doesn't throw
assert.doesNotThrow(() => playNote(48), 'playNote should handle missing Web Audio context gracefully');
assert.doesNotThrow(() => playNote(-1), 'playNote should safely ignore negative MIDI numbers');
assert.doesNotThrow(() => playNote(128), 'playNote should safely ignore MIDI numbers > 127');
assert.doesNotThrow(() => playNote(NaN), 'playNote should safely ignore NaN');

// Verify strumWithSoundFont accepts custom holdTicks and releaseTicks
assert.equal(typeof strumWithSoundFont, 'function', 'strumWithSoundFont should be exported');
assert.doesNotThrow(() => strumWithSoundFont([48], { holdTicks: 720, releaseTicks: 576 }), 'strumWithSoundFont accepts holdTicks and releaseTicks');
assert.doesNotThrow(() => playNote(60, { duration: 1.3 }), 'playNote accepts custom duration');

// 5. Verify Circle of Fifths chord sound buttons and secondary chord-library link
const circleHtml = renderCircleInfoPanel();
assert.ok(circleHtml.includes('class="ref-deg-chord-btn ref-chord-play"'), 'Circle of fifths has primary chord play buttons');
assert.ok(circleHtml.includes('class="ref-deg-link-btn ref-chord-link"'), 'Circle of fifths has secondary chord library link buttons');
assert.ok(circleHtml.includes('title="Play C chord"'), 'Play button has title attribute for playing');
assert.ok(circleHtml.includes('title="Show C in chord library"'), 'Secondary link button has title attribute for chord library');

// Verify getChordNotesForSymbol returns sounding MIDI notes
const cNotes = getChordNotesForSymbol('C');
assert.ok(Array.isArray(cNotes), 'cNotes should be an array');
assert.ok(cNotes.filter(n => n >= 0).length >= 3, 'C chord should have at least 3 sounding notes');

const dmNotes = getChordNotesForSymbol('Dm');
assert.ok(Array.isArray(dmNotes), 'dmNotes should be an array');
assert.ok(dmNotes.filter(n => n >= 0).length >= 3, 'Dm chord should have at least 3 sounding notes');

const bdimNotes = getChordNotesForSymbol('B°');
assert.ok(Array.isArray(bdimNotes), 'bdimNotes should be an array');
assert.ok(bdimNotes.filter(n => n >= 0).length >= 3, 'B° chord should have at least 3 sounding notes');

const fsharpNotes = getChordNotesForSymbol('F♯m');
assert.ok(Array.isArray(fsharpNotes), 'fsharpNotes should be an array');
assert.ok(fsharpNotes.filter(n => n >= 0).length >= 3, 'F♯m chord should have at least 3 sounding notes');

console.log('✓ Circle of fifths primary play buttons, secondary links, and chord notes verified');
console.log('All scales and circle sound tests passed successfully!');
