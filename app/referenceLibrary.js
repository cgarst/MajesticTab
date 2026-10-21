// referenceLibrary.js
// Interactive music theory reference library: Circle of Fifths, Chord Library,
// Scales & Modes, Tone Matrix, and Triad Inversions & Formulas.
// Optimized for desktop and mobile viewports with MajesticTab finish theme integration.

import { fretboardController } from './fretboard/fretboardController.js';

const STORAGE_KEY_LH = 'majestictab_fretboard_left_handed';
const STORAGE_KEY_FLIP = 'majestictab_fretboard_flip_strings';

export function getIsLeftHanded() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_LH);
        if (stored !== null) return stored === 'true';
    } catch (_) {}
    return fretboardController?.isLeftHanded ?? false;
}

export function getIsFlipped() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_FLIP);
        if (stored !== null) return stored === 'true';
    } catch (_) {}
    return fretboardController?.isFlipped ?? false;
}

export function setIsLeftHanded(val) {
    const boolVal = Boolean(val);
    try {
        localStorage.setItem(STORAGE_KEY_LH, String(boolVal));
    } catch (_) {}
    if (fretboardController?.setLeftHanded) {
        fretboardController.setLeftHanded(boolVal);
    }
}

export function setIsFlipped(val) {
    const boolVal = Boolean(val);
    try {
        localStorage.setItem(STORAGE_KEY_FLIP, String(boolVal));
    } catch (_) {}
    if (fretboardController?.setFlipped) {
        fretboardController.setFlipped(boolVal);
    }
}

let activeTab = 'chords'; // 'circle', 'chords', 'scales', 'tone'
let refTabChangeListener = null;

export function getActiveReferenceTab() {
    return activeTab;
}

export function setActiveReferenceTab(tab) {
    if (['circle', 'chords', 'scales', 'tone'].includes(tab)) {
        activeTab = tab;
    }
}

export function setReferenceTabChangeListener(fn) {
    refTabChangeListener = fn;
}
let selectedCircleIndex = 0; // default C Major / Am
let selectedScaleKey = 'majorPentatonic';
let selectedRootNote = 0; // C (0 to 11)
let selectedToneKey = 'all'; // 'all', 'C', 'D', 'E', 'F', 'G', 'A', 'B'
let selectedChordFilter = 'all'; // 'all', 'Major', 'Dominant', 'Minor', 'Suspended'
let preferBarChords = (() => { try { return localStorage.getItem('majestictab_prefer_bar_chords') === 'true'; } catch (_) { return false; } })();
let selectedRootFilter = 'all'; // 'all', 'A', 'B', 'C', 'D', 'E', 'F', 'G'

// -----------------------------------------------------------------------------
// Data Sets
// -----------------------------------------------------------------------------

export const circleData = [
    { major: 'C', minor: 'Am', accidentals: '0 Sharps / Flats', majorChords: ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B°'], minorChords: ['Am', 'B°', 'C', 'Dm', 'Em', 'F', 'G'] },
    { major: 'G', minor: 'Em', accidentals: '1 Sharp (F♯)', majorChords: ['G', 'Am', 'Bm', 'C', 'D', 'Em', 'F♯°'], minorChords: ['Em', 'F♯°', 'G', 'Am', 'Bm', 'C', 'D'] },
    { major: 'D', minor: 'Bm', accidentals: '2 Sharps (F♯, C♯)', majorChords: ['D', 'Em', 'F♯m', 'G', 'A', 'Bm', 'C♯°'], minorChords: ['Bm', 'C♯°', 'D', 'Em', 'F♯m', 'G', 'A'] },
    { major: 'A', minor: 'F♯m', accidentals: '3 Sharps (F♯, C♯, G♯)', majorChords: ['A', 'Bm', 'C♯m', 'D', 'E', 'F♯m', 'G♯°'], minorChords: ['F♯m', 'G♯°', 'A', 'Bm', 'C♯m', 'D', 'E'] },
    { major: 'E', minor: 'C♯m', accidentals: '4 Sharps (F♯, C♯, G♯, D♯)', majorChords: ['E', 'F♯m', 'G♯m', 'A', 'B', 'C♯m', 'D♯°'], minorChords: ['C♯m', 'D♯°', 'E', 'F♯m', 'G♯m', 'A', 'B'] },
    { major: 'B', minor: 'G♯m', accidentals: '5 Sharps (F♯, C♯, G♯, D♯, A♯)', majorChords: ['B', 'C♯m', 'D♯m', 'E', 'F♯', 'G♯m', 'A♯°'], minorChords: ['G♯m', 'A♯°', 'B', 'C♯m', 'D♯m', 'E', 'F♯'] },
    { major: 'F♯', minor: 'D♯m', accidentals: '6 Sharps (F♯, C♯, G♯, D♯, A♯, E♯)', majorChords: ['F♯', 'G♯m', 'A♯m', 'B', 'C♯', 'D♯m', 'E♯°'], minorChords: ['D♯m', 'E♯°', 'F♯', 'G♯m', 'A♯m', 'B', 'C♯'] },
    { major: 'D♭', minor: 'B♭m', accidentals: '5 Flats (B♭, E♭, A♭, D♭, G♭)', majorChords: ['D♭', 'E♭m', 'Fm', 'G♭', 'A♭', 'B♭m', 'C°'], minorChords: ['B♭m', 'C°', 'D♭', 'E♭m', 'Fm', 'G♭', 'A♭'] },
    { major: 'A♭', minor: 'Fm', accidentals: '4 Flats (B♭, E♭, A♭, D♭)', majorChords: ['A♭', 'B♭m', 'Cm', 'D♭', 'E♭', 'Fm', 'G°'], minorChords: ['Fm', 'G°', 'A♭', 'B♭m', 'Cm', 'D♭', 'E♭'] },
    { major: 'E♭', minor: 'Cm', accidentals: '3 Flats (B♭, E♭, A♭)', majorChords: ['E♭', 'Fm', 'Gm', 'A♭', 'B♭', 'Cm', 'D°'], minorChords: ['Cm', 'D°', 'E♭', 'Fm', 'Gm', 'A♭', 'B♭'] },
    { major: 'B♭', minor: 'Gm', accidentals: '2 Flats (B♭, E♭)', majorChords: ['B♭', 'Cm', 'Dm', 'E♭', 'F', 'Gm', 'A°'], minorChords: ['Gm', 'A°', 'B♭', 'Cm', 'Dm', 'E♭', 'F'] },
    { major: 'F', minor: 'Dm', accidentals: '1 Flat (B♭)', majorChords: ['F', 'Gm', 'Am', 'B♭', 'C', 'Dm', 'E°'], minorChords: ['Dm', 'E°', 'F', 'Gm', 'Am', 'B♭', 'C'] }
];

export const toneMatrixData = [
    { tune: 'C', chords: [ {deg:'I', name:'C', frets:'x 3 2 0 1 0'}, {deg:'ii', name:'Dm', frets:'x x 0 2 3 1'}, {deg:'iii', name:'Em', frets:'0 2 2 0 0 0'}, {deg:'IV', name:'F', frets:'1 3 3 2 1 1'}, {deg:'V', name:'G', frets:'3 2 0 0 0 3'}, {deg:'vi', name:'Am', frets:'x 0 2 2 1 0'}, {deg:'vii°', name:'Bdim', frets:'x 2 3 4 3 x'}, {deg:'VII', name:'G7', frets:'3 2 0 0 0 1'} ] },
    { tune: 'D', chords: [ {deg:'I', name:'D', frets:'x x 0 2 3 2'}, {deg:'ii', name:'Em', frets:'0 2 2 0 0 0'}, {deg:'iii', name:'F♯m', frets:'2 4 4 2 2 2'}, {deg:'IV', name:'G', frets:'3 2 0 0 0 3'}, {deg:'V', name:'A', frets:'x 0 2 2 2 0'}, {deg:'vi', name:'Bm', frets:'x 2 4 4 3 2'}, {deg:'vii°', name:'C♯dim', frets:'x 4 5 6 5 x'}, {deg:'VII', name:'A7', frets:'x 0 2 0 2 0'} ] },
    { tune: 'E', chords: [ {deg:'I', name:'E', frets:'0 2 2 1 0 0'}, {deg:'ii', name:'F♯m', frets:'2 4 4 2 2 2'}, {deg:'iii', name:'G♯m', frets:'4 6 6 4 4 4'}, {deg:'IV', name:'A', frets:'x 0 2 2 2 0'}, {deg:'V', name:'B', frets:'x 2 4 4 4 2'}, {deg:'vi', name:'C♯m', frets:'x 4 6 6 5 4'}, {deg:'vii°', name:'D♯dim', frets:'x x 1 2 1 2'}, {deg:'VII', name:'B7', frets:'x 2 1 2 0 2'} ] },
    { tune: 'F', chords: [ {deg:'I', name:'F', frets:'1 3 3 2 1 1'}, {deg:'ii', name:'Gm', frets:'3 5 5 3 3 3'}, {deg:'iii', name:'Am', frets:'x 0 2 2 1 0'}, {deg:'IV', name:'B♭', frets:'x 1 3 3 3 1'}, {deg:'V', name:'C', frets:'x 3 2 0 1 0'}, {deg:'vi', name:'Dm', frets:'x x 0 2 3 1'}, {deg:'vii°', name:'Edim', frets:'0 1 2 0 2 x'}, {deg:'VII', name:'C7', frets:'x 3 2 3 1 0'} ] },
    { tune: 'G', chords: [ {deg:'I', name:'G', frets:'3 2 0 0 0 3'}, {deg:'ii', name:'Am', frets:'x 0 2 2 1 0'}, {deg:'iii', name:'Bm', frets:'x 2 4 4 3 2'}, {deg:'IV', name:'C', frets:'x 3 2 0 1 0'}, {deg:'V', name:'D', frets:'x x 0 2 3 2'}, {deg:'vi', name:'Em', frets:'0 2 2 0 0 0'}, {deg:'vii°', name:'F♯dim', frets:'2 x 4 2 4 x'}, {deg:'VII', name:'D7', frets:'x x 0 2 1 2'} ] },
    { tune: 'A', chords: [ {deg:'I', name:'A', frets:'x 0 2 2 2 0'}, {deg:'ii', name:'Bm', frets:'x 2 4 4 3 2'}, {deg:'iii', name:'C♯m', frets:'x 4 6 6 5 4'}, {deg:'IV', name:'D', frets:'x x 0 2 3 2'}, {deg:'V', name:'E', frets:'0 2 2 1 0 0'}, {deg:'vi', name:'F♯m', frets:'2 4 4 2 2 2'}, {deg:'vii°', name:'G♯dim', frets:'4 x 6 4 6 x'}, {deg:'VII', name:'E7', frets:'0 2 0 1 0 0'} ] },
    { tune: 'B', chords: [ {deg:'I', name:'B', frets:'x 2 4 4 4 2'}, {deg:'ii', name:'C♯m', frets:'x 4 6 6 5 4'}, {deg:'iii', name:'D♯m', frets:'x 6 8 8 7 6'}, {deg:'IV', name:'E', frets:'0 2 2 1 0 0'}, {deg:'V', name:'F♯', frets:'2 4 4 3 2 2'}, {deg:'vi', name:'G♯m', frets:'4 6 6 4 4 4'}, {deg:'vii°', name:'A♯dim', frets:'x 1 2 3 2 x'}, {deg:'VII', name:'F♯7', frets:'2 4 2 3 2 2'} ] }
];

// Add the remaining circle-of-fifths keys (sharps/flats) with generated barre voicings
(function extendToneMatrix() {
    const pitchOf = (name) => {
        const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[name[0]];
        let p = base;
        for (const ch of name.slice(1)) { if (ch === '♯') p++; else if (ch === '♭') p--; }
        return ((p % 12) + 12) % 12;
    };
    const fretOn = (pitch, openPitch) => { const f = (((pitch - openPitch) % 12) + 12) % 12; return f === 0 ? 12 : f; };
    const shift = (shape, n) => shape.map(v => v === null ? 'x' : v + n).join(' ');
    const voicing = (root, quality) => {
        const pitch = pitchOf(root);
        if (quality === 'dim') return shift([null, 0, 1, 2, 1, null], (((pitch - 9) % 12) + 12) % 12);
        const eFret = fretOn(pitch, 4);
        const shapes = {
            E: { M: [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0] },
            A: { M: [null, 0, 2, 2, 2, 0], m: [null, 0, 2, 2, 1, 0], 7: [null, 0, 2, 0, 2, 0] }
        };
        return eFret <= 8 ? shift(shapes.E[quality], eFret) : shift(shapes.A[quality], fretOn(pitch, 9));
    };
    const degs = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
    const quals = ['M', 'm', 'm', 'M', 'M', 'm', 'dim'];
    ['F♯', 'D♭', 'A♭', 'E♭', 'B♭'].forEach(key => {
        const circle = circleData.find(c => c.major === key);
        const chords = circle.majorChords.map((raw, i) => {
            const root = raw.replace(/[m°]/g, '');
            const name = quals[i] === 'dim' ? root + 'dim' : raw;
            return { deg: degs[i], name, frets: voicing(root, quals[i]) };
        });
        const v = circle.majorChords[4];
        chords.push({ deg: 'VII', name: v + '7', frets: voicing(v, '7') });
        toneMatrixData.push({ tune: key, chords });
    });
    const order = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
    toneMatrixData.sort((a, b) => order.indexOf(a.tune) - order.indexOf(b.tune));
})();

export const scaleDefinitions = {
    majorPentatonic: { name: 'Major Pentatonic', formula: '1 - 2 - 3 - 5 - 6', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:4,lbl:'3'},{int:7,lbl:'5'},{int:9,lbl:'6'}] },
    minorPentatonic: { name: 'Minor Pentatonic', formula: '1 - ♭3 - 4 - 5 - ♭7', intervals: [{int:0,lbl:'R'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:10,lbl:'♭7'}] },
    majorBlues: { name: 'Major Blues', formula: '1 - 2 - ♭3 - 3 - 5 - 6', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:3,lbl:'♭3'},{int:4,lbl:'3'},{int:7,lbl:'5'},{int:9,lbl:'6'}] },
    minorBlues: { name: 'Minor Blues', formula: '1 - ♭3 - 4 - ♭5 - 5 - ♭7', intervals: [{int:0,lbl:'R'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:6,lbl:'♭5'},{int:7,lbl:'5'},{int:10,lbl:'♭7'}] },
    harmonicMinor: { name: 'Harmonic Minor', formula: '1 - 2 - ♭3 - 4 - 5 - ♭6 - 7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:8,lbl:'♭6'},{int:11,lbl:'7'}] },
    melodicMinor: { name: 'Melodic Minor', formula: '1 - 2 - ♭3 - 4 - 5 - 6 - 7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:9,lbl:'6'},{int:11,lbl:'7'}] },
    ionian: { name: 'Ionian (Major)', formula: '1 - 2 - 3 - 4 - 5 - 6 - 7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:4,lbl:'3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:9,lbl:'6'},{int:11,lbl:'7'}] },
    dorian: { name: 'Dorian', formula: '1 - 2 - ♭3 - 4 - 5 - 6 - ♭7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:9,lbl:'6'},{int:10,lbl:'♭7'}] },
    phrygian: { name: 'Phrygian', formula: '1 - ♭2 - ♭3 - 4 - 5 - ♭6 - ♭7', intervals: [{int:0,lbl:'R'},{int:1,lbl:'♭2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:8,lbl:'♭6'},{int:10,lbl:'♭7'}] },
    lydian: { name: 'Lydian', formula: '1 - 2 - 3 - ♯4 - 5 - 6 - 7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:4,lbl:'3'},{int:6,lbl:'♯4'},{int:7,lbl:'5'},{int:9,lbl:'6'},{int:11,lbl:'7'}] },
    mixolydian: { name: 'Mixolydian', formula: '1 - 2 - 3 - 4 - 5 - 6 - ♭7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:4,lbl:'3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:9,lbl:'6'},{int:10,lbl:'♭7'}] },
    aeolian: { name: 'Aeolian (Natural Minor)', formula: '1 - 2 - ♭3 - 4 - 5 - ♭6 - ♭7', intervals: [{int:0,lbl:'R'},{int:2,lbl:'2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:7,lbl:'5'},{int:8,lbl:'♭6'},{int:10,lbl:'♭7'}] },
    locrian: { name: 'Locrian', formula: '1 - ♭2 - ♭3 - 4 - ♭5 - ♭6 - ♭7', intervals: [{int:0,lbl:'R'},{int:1,lbl:'♭2'},{int:3,lbl:'♭3'},{int:5,lbl:'4'},{int:6,lbl:'♭5'},{int:8,lbl:'♭6'},{int:10,lbl:'♭7'}] }
};

const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const stringTunings = [4, 9, 2, 7, 11, 4]; // E2, A2, D3, G3, B3, E4
const stringNames = ['E', 'A', 'D', 'G', 'B', 'e'];

export const chordData = [
    // === MAJOR FAMILY (IMG_6420)[cite: 13] ===
    { name: 'A', cat: 'Major', frets: 'x 0 2 2 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A', cat: 'Major', frets: '5 7 7 6 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B', cat: 'Major', frets: 'x 2 4 4 4 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C', cat: 'Major', frets: 'x 3 2 0 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'C', cat: 'Major', frets: '8 10 10 9 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'D', cat: 'Major', frets: 'x x 0 2 3 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'D', cat: 'Major', frets: 'x 5 7 7 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'E', cat: 'Major', frets: '0 2 2 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E', cat: 'Major', frets: '0 7 9 9 9 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F', cat: 'Major', frets: '1 3 3 2 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'G', cat: 'Major', frets: '3 2 0 0 0 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'G', cat: 'Major', frets: '3 5 5 4 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'Amaj7', cat: 'Major', frets: 'x 0 2 1 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Amaj7', cat: 'Major', frets: '5 7 6 6 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bmaj7', cat: 'Major', frets: 'x 2 4 3 4 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cmaj7', cat: 'Major', frets: 'x 3 2 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cmaj7', cat: 'Major', frets: '8 10 9 9 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dmaj7', cat: 'Major', frets: 'x x 0 2 2 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dmaj7', cat: 'Major', frets: 'x 5 7 6 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Emaj7', cat: 'Major', frets: '0 2 1 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Emaj7', cat: 'Major', frets: 'x 7 9 8 9 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fmaj7', cat: 'Major', frets: 'x x 3 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Fmaj7', cat: 'Major', frets: '1 3 3 2 1 1', startFret: 1, barChord: 1, default: 0 },
    { name: 'Gmaj7', cat: 'Major', frets: '3 2 0 0 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gmaj7', cat: 'Major', frets: '3 5 4 4 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'Amaj9', cat: 'Major', frets: 'x 0 2 4 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Amaj9', cat: 'Major', frets: '5 7 6 9 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bmaj9', cat: 'Major', frets: 'x 2 1 2 2 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Bmaj9', cat: 'Major', frets: '7 9 8 9 9 9', startFret: 7, barChord: 1, default: 0 },
    { name: 'Cmaj9', cat: 'Major', frets: 'x 3 0 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cmaj9', cat: 'Major', frets: '8 10 9 10 10 10', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dmaj9', cat: 'Major', frets: 'x x 0 2 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dmaj9', cat: 'Major', frets: 'x 5 7 6 7 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'Emaj9', cat: 'Major', frets: '0 2 1 3 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Emaj9', cat: 'Major', frets: 'x 7 9 8 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fmaj9', cat: 'Major', frets: 'x 3 3 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Fmaj9', cat: 'Major', frets: '1 3 3 2 1 3', startFret: 1, barChord: 1, default: 0 },
    { name: 'Gmaj9', cat: 'Major', frets: '3 2 0 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gmaj9', cat: 'Major', frets: '3 5 4 4 3 5', startFret: 3, barChord: 1, default: 0 },

    { name: 'Amaj7-11', cat: 'Major', frets: 'x 0 1 1 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Amaj7-11', cat: 'Major', frets: '5 7 6 6 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bmaj7-11', cat: 'Major', frets: 'x 2 3 3 4 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cmaj7-11', cat: 'Major', frets: 'x 3 2 0 0 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cmaj7-11', cat: 'Major', frets: '8 10 9 9 10 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dmaj7-11', cat: 'Major', frets: 'x x 0 2 2 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dmaj7-11', cat: 'Major', frets: 'x 5 7 6 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Emaj7-11', cat: 'Major', frets: '0 2 1 2 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Emaj7-11', cat: 'Major', frets: 'x 7 9 8 9 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fmaj7-11', cat: 'Major', frets: 'x 0 3 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Fmaj7-11', cat: 'Major', frets: '1 3 3 2 3 1', startFret: 1, barChord: 1, default: 0 },
    { name: 'Gmaj7-11', cat: 'Major', frets: '3 2 0 0 1 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gmaj7-11', cat: 'Major', frets: '3 5 4 4 5 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'Amaj7-13', cat: 'Major', frets: 'x 0 2 1 2 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Amaj7-13', cat: 'Major', frets: '5 7 6 6 7 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bmaj7-13', cat: 'Major', frets: 'x 2 3 3 4 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cmaj7-13', cat: 'Major', frets: 'x 3 2 4 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cmaj7-13', cat: 'Major', frets: '8 10 9 10 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dmaj7-13', cat: 'Major', frets: 'x 5 4 6 7 5', startFret: 5, barChord: 1, default: 1 },
    { name: 'Emaj7-13', cat: 'Major', frets: '0 2 1 2 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Emaj7-13', cat: 'Major', frets: 'x 7 9 8 9 9', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fmaj7-13', cat: 'Major', frets: '0 0 3 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Fmaj7-13', cat: 'Major', frets: '1 3 2 2 1 1', startFret: 1, barChord: 1, default: 0 },
    { name: 'Gmaj7-13', cat: 'Major', frets: '3 2 0 4 3 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gmaj7-13', cat: 'Major', frets: '3 5 4 5 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'A6', cat: 'Major', frets: 'x 0 2 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'B6', cat: 'Major', frets: 'x 2 4 4 4 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'C6', cat: 'Major', frets: 'x 3 2 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'C6', cat: 'Major', frets: '8 10 10 9 10 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'D6', cat: 'Major', frets: 'x x 0 2 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'D6', cat: 'Major', frets: 'x 5 7 7 7 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'E6', cat: 'Major', frets: '0 2 2 1 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E6', cat: 'Major', frets: '0 7 9 9 9 9', startFret: 7, barChord: 1, default: 0 },
    { name: 'F6', cat: 'Major', frets: 'x x 3 2 3 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'F6', cat: 'Major', frets: '1 3 3 2 3 1', startFret: 1, barChord: 1, default: 0 },
    { name: 'G6', cat: 'Major', frets: '3 2 0 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'G6', cat: 'Major', frets: '3 5 5 4 3 5', startFret: 3, barChord: 1, default: 0 },

    // === DOMINANT FAMILY (IMG_6420)[cite: 13] ===
    { name: 'A7', cat: 'Dominant', frets: 'x 0 2 0 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A7', cat: 'Dominant', frets: '5 7 5 6 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B7', cat: 'Dominant', frets: 'x 2 1 2 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'B7', cat: 'Dominant', frets: '7 9 7 8 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'C7', cat: 'Dominant', frets: 'x 3 2 3 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'C7', cat: 'Dominant', frets: '8 10 8 9 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'D7', cat: 'Dominant', frets: 'x x 0 2 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'D7', cat: 'Dominant', frets: 'x 5 7 5 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'E7', cat: 'Dominant', frets: '0 2 0 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E7', cat: 'Dominant', frets: '0 7 6 7 5 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F7', cat: 'Dominant', frets: '1 3 1 2 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7', cat: 'Dominant', frets: '3 2 0 0 0 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'G7', cat: 'Dominant', frets: '3 5 3 4 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'A9', cat: 'Dominant', frets: 'x 0 2 1 2 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'A9', cat: 'Dominant', frets: '5 7 5 6 5 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'B9', cat: 'Dominant', frets: 'x 2 1 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C9', cat: 'Dominant', frets: 'x 3 2 3 3 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'D9', cat: 'Dominant', frets: 'x 5 4 5 5 5', startFret: 4, barChord: 1, default: 1 },
    { name: 'E9', cat: 'Dominant', frets: '0 2 0 1 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'E9', cat: 'Dominant', frets: 'x 7 6 7 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F9', cat: 'Dominant', frets: '1 3 1 2 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'G9', cat: 'Dominant', frets: '3 2 3 2 3 3', startFret: 1, barChord: 1, default: 1 },

    { name: 'A7-11', cat: 'Dominant', frets: 'x 0 0 0 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A7-11', cat: 'Dominant', frets: '5 7 5 6 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B7-11', cat: 'Dominant', frets: 'x 2 1 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C7-11', cat: 'Dominant', frets: 'x 3 2 3 3 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'D7-11', cat: 'Dominant', frets: 'x 5 4 5 5 5', startFret: 4, barChord: 1, default: 1 },
    { name: 'E7-11', cat: 'Dominant', frets: '0 0 0 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E7-11', cat: 'Dominant', frets: 'x 7 6 7 9 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F7-11', cat: 'Dominant', frets: '1 3 1 2 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7-11', cat: 'Dominant', frets: '3 2 3 2 3 3', startFret: 1, barChord: 1, default: 1 },

    { name: 'A7-13', cat: 'Dominant', frets: 'x 0 2 0 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'B7-13', cat: 'Dominant', frets: 'x 2 1 2 4 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'C7-13', cat: 'Dominant', frets: 'x 3 2 3 5 5', startFret: 1, barChord: 1, default: 1 },
    { name: 'D7-13', cat: 'Dominant', frets: 'x 5 4 5 7 7', startFret: 4, barChord: 1, default: 1 },
    { name: 'E7-13', cat: 'Dominant', frets: '0 2 0 1 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'F7-13', cat: 'Dominant', frets: '1 3 1 2 3 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7-13', cat: 'Dominant', frets: '3 2 3 2 5 5', startFret: 1, barChord: 1, default: 1 },

    // === MINOR FAMILY (IMG_6421)[cite: 14] ===
    { name: 'Am', cat: 'Minor', frets: 'x 0 2 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am', cat: 'Minor', frets: '5 7 7 5 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm', cat: 'Minor', frets: 'x 2 4 4 3 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm', cat: 'Minor', frets: 'x 3 5 5 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm', cat: 'Minor', frets: 'x x 0 2 3 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dm', cat: 'Minor', frets: 'x 5 7 7 6 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Em', cat: 'Minor', frets: '0 2 2 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em', cat: 'Minor', frets: '0 7 9 9 8 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm', cat: 'Minor', frets: '1 3 3 1 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm', cat: 'Minor', frets: '3 5 5 3 3 3', startFret: 3, barChord: 1, default: 1 },

    { name: 'Am6', cat: 'Minor', frets: 'x 0 2 2 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am6', cat: 'Minor', frets: '5 7 7 5 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm6', cat: 'Minor', frets: 'x 2 4 4 3 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm6', cat: 'Minor', frets: 'x 3 5 5 4 5', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm6', cat: 'Minor', frets: 'x x 0 2 0 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dm6', cat: 'Minor', frets: 'x 5 7 7 6 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'Em6', cat: 'Minor', frets: '0 2 2 0 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em6', cat: 'Minor', frets: '0 7 9 9 8 9', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm6', cat: 'Minor', frets: '1 3 3 1 3 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm6', cat: 'Minor', frets: '3 5 5 3 5 3', startFret: 3, barChord: 1, default: 1 },

    { name: 'Am7', cat: 'Minor', frets: 'x 0 2 0 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am7', cat: 'Minor', frets: '5 7 5 5 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm7', cat: 'Minor', frets: 'x 2 4 2 3 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm7', cat: 'Minor', frets: 'x 3 5 3 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm7', cat: 'Minor', frets: 'x x 0 2 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Em7', cat: 'Minor', frets: '0 2 2 0 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em7', cat: 'Minor', frets: '0 7 9 7 8 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm7', cat: 'Minor', frets: '1 3 1 1 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm7', cat: 'Minor', frets: '3 5 3 3 3 3', startFret: 3, barChord: 1, default: 1 },

    { name: 'Am9', cat: 'Minor', frets: 'x 0 2 4 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am9', cat: 'Minor', frets: '5 7 5 5 5 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm9', cat: 'Minor', frets: 'x 2 4 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm9', cat: 'Minor', frets: 'x 3 5 3 3 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm9', cat: 'Minor', frets: 'x 5 3 5 5 5', startFret: 3, barChord: 1, default: 1 },
    { name: 'Em9', cat: 'Minor', frets: '0 2 0 0 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em9', cat: 'Minor', frets: '0 7 6 7 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm9', cat: 'Minor', frets: '1 3 1 1 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm9', cat: 'Minor', frets: '3 5 3 3 3 5', startFret: 3, barChord: 1, default: 1 },

    { name: 'Am7-11', cat: 'Minor', frets: 'x 0 0 0 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am7-11', cat: 'Minor', frets: '5 7 5 5 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm7-11', cat: 'Minor', frets: 'x 2 2 2 3 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm7-11', cat: 'Minor', frets: 'x 3 3 3 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm7-11', cat: 'Minor', frets: 'x 5 5 5 6 5', startFret: 5, barChord: 1, default: 1 },
    { name: 'Em7-11', cat: 'Minor', frets: '0 0 0 0 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em7-11', cat: 'Minor', frets: '0 7 7 7 8 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm7-11', cat: 'Minor', frets: '1 1 1 1 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm7-11', cat: 'Minor', frets: '3 3 3 3 3 3', startFret: 3, barChord: 1, default: 1 },

    { name: 'Am7-13', cat: 'Minor', frets: 'x 0 2 0 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Am7-13', cat: 'Minor', frets: '5 7 5 5 7 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bm7-13', cat: 'Minor', frets: 'x 2 4 2 3 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cm7-13', cat: 'Minor', frets: 'x 3 5 3 4 5', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dm7-13', cat: 'Minor', frets: 'x 5 3 5 6 6', startFret: 3, barChord: 1, default: 1 },
    { name: 'Em7-13', cat: 'Minor', frets: '0 2 0 0 3 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Em7-13', cat: 'Minor', frets: '0 7 6 7 8 8', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fm7-13', cat: 'Minor', frets: '1 3 1 1 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gm7-13', cat: 'Minor', frets: '3 5 3 3 5 5', startFret: 3, barChord: 1, default: 1 },

    // === DIMINISHED & AUGMENTED (IMG_6421)[cite: 14] ===
    { name: 'Adim', cat: 'Dim/Aug', frets: 'x 0 1 2 1 x', startFret: 1, barChord: 0, default: 1 },
    { name: 'Adim', cat: 'Dim/Aug', frets: '5 6 7 5 7 x', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bdim', cat: 'Dim/Aug', frets: 'x 2 3 4 3 x', startFret: 1, barChord: 0, default: 1 },
    { name: 'Bdim', cat: 'Dim/Aug', frets: '7 8 9 7 9 x', startFret: 7, barChord: 1, default: 0 },
    { name: 'Cdim', cat: 'Dim/Aug', frets: 'x 3 4 5 4 x', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cdim', cat: 'Dim/Aug', frets: '8 9 10 8 10 x', startFret: 8, barChord: 1, default: 0 },
    { name: 'Ddim', cat: 'Dim/Aug', frets: 'x x 0 1 3 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Ddim', cat: 'Dim/Aug', frets: 'x 5 6 7 6 x', startFret: 5, barChord: 1, default: 0 },
    { name: 'Edim', cat: 'Dim/Aug', frets: '0 1 2 0 2 x', startFret: 1, barChord: 0, default: 1 },
    { name: 'Edim', cat: 'Dim/Aug', frets: '0 7 8 9 8 x', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fdim', cat: 'Dim/Aug', frets: '1 2 3 1 4 x', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gdim', cat: 'Dim/Aug', frets: '3 4 5 3 6 x', startFret: 3, barChord: 1, default: 1 },

    { name: 'Adim7', cat: 'Dim/Aug', frets: 'x 0 1 2 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Adim7', cat: 'Dim/Aug', frets: '5 6 5 6 5 6', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bdim7', cat: 'Dim/Aug', frets: 'x 2 3 2 3 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cdim7', cat: 'Dim/Aug', frets: 'x 3 4 3 4 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Ddim7', cat: 'Dim/Aug', frets: 'x x 0 1 0 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Ddim7', cat: 'Dim/Aug', frets: 'x 5 6 5 6 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Edim7', cat: 'Dim/Aug', frets: '0 1 2 0 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Edim7', cat: 'Dim/Aug', frets: '0 7 8 7 8 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fdim7', cat: 'Dim/Aug', frets: '1 2 1 2 1 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gdim7', cat: 'Dim/Aug', frets: '3 4 3 4 3 4', startFret: 3, barChord: 1, default: 1 },

    { name: 'Aaug', cat: 'Dim/Aug', frets: 'x 0 3 2 2 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'Aaug', cat: 'Dim/Aug', frets: '5 8 7 6 5 x', startFret: 5, barChord: 1, default: 0 },
    { name: 'Baug', cat: 'Dim/Aug', frets: 'x 2 1 0 0 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Baug', cat: 'Dim/Aug', frets: '7 10 9 8 7 x', startFret: 7, barChord: 1, default: 0 },
    { name: 'Caug', cat: 'Dim/Aug', frets: 'x 3 2 1 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Caug', cat: 'Dim/Aug', frets: '8 11 10 9 8 x', startFret: 8, barChord: 1, default: 0 },
    { name: 'Daug', cat: 'Dim/Aug', frets: 'x x 0 3 3 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Daug', cat: 'Dim/Aug', frets: 'x 5 8 7 7 6', startFret: 5, barChord: 1, default: 0 },
    { name: 'Eaug', cat: 'Dim/Aug', frets: '0 3 2 1 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Eaug', cat: 'Dim/Aug', frets: '0 7 10 9 8 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Faug', cat: 'Dim/Aug', frets: '1 3 3 2 2 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gaug', cat: 'Dim/Aug', frets: '3 2 1 0 0 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gaug', cat: 'Dim/Aug', frets: '3 6 5 4 3 x', startFret: 3, barChord: 1, default: 0 },

    { name: 'A7(-5)', cat: 'Dim/Aug', frets: 'x 0 1 0 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A7(-5)', cat: 'Dim/Aug', frets: '5 6 5 6 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B7(-5)', cat: 'Dim/Aug', frets: 'x 2 1 2 0 1', startFret: 1, barChord: 0, default: 1 },
    { name: 'B7(-5)', cat: 'Dim/Aug', frets: '7 8 7 8 10 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'C7(-5)', cat: 'Dim/Aug', frets: 'x 3 2 3 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'C7(-5)', cat: 'Dim/Aug', frets: '8 9 8 9 11 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'D7(-5)', cat: 'Dim/Aug', frets: 'x x 0 1 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'D7(-5)', cat: 'Dim/Aug', frets: 'x 5 6 5 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'E7(-5)', cat: 'Dim/Aug', frets: '0 1 0 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E7(-5)', cat: 'Dim/Aug', frets: '0 7 8 7 9 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F7(-5)', cat: 'Dim/Aug', frets: '1 2 1 2 1 0', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7(-5)', cat: 'Dim/Aug', frets: '3 2 3 2 2 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'G7(-5)', cat: 'Dim/Aug', frets: '3 4 3 4 6 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'A6/9', cat: 'Dim/Aug', frets: 'x 0 2 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'B6/9', cat: 'Dim/Aug', frets: 'x 2 1 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C6/9', cat: 'Dim/Aug', frets: 'x 3 2 2 3 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'D6/9', cat: 'Dim/Aug', frets: 'x x 0 2 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'D6/9', cat: 'Dim/Aug', frets: 'x 5 7 7 7 7', startFret: 5, barChord: 1, default: 0 },
    { name: 'E6/9', cat: 'Dim/Aug', frets: '0 2 2 1 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'F6/9', cat: 'Dim/Aug', frets: 'x 8 7 7 8 8', startFret: 7, barChord: 1, default: 1 },
    { name: 'G6/9', cat: 'Dim/Aug', frets: '3 2 2 2 3 3', startFret: 2, barChord: 1, default: 1 },

    // === SUSPENDED & ADD FAMILY (IMG_6421)[cite: 14] ===
    { name: 'Asus2', cat: 'Suspended', frets: 'x 0 2 2 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Asus2', cat: 'Suspended', frets: '5 7 7 7 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bsus2', cat: 'Suspended', frets: 'x 2 4 4 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Csus2', cat: 'Suspended', frets: 'x 3 0 0 1 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Csus2', cat: 'Suspended', frets: '8 10 10 10 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dsus2', cat: 'Suspended', frets: 'x x 0 2 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dsus2', cat: 'Suspended', frets: 'x 5 7 7 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Esus2', cat: 'Suspended', frets: '0 2 4 4 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Esus2', cat: 'Suspended', frets: '0 7 9 9 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fsus2', cat: 'Suspended', frets: 'x 3 3 0 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gsus2', cat: 'Suspended', frets: '3 0 0 0 3 3', startFret: 1, barChord: 1, default: 1 },

    { name: 'Asus4', cat: 'Suspended', frets: 'x 0 2 2 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Asus4', cat: 'Suspended', frets: '5 7 7 7 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bsus4', cat: 'Suspended', frets: 'x 2 4 4 5 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Csus4', cat: 'Suspended', frets: 'x 3 3 0 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Dsus4', cat: 'Suspended', frets: 'x x 0 2 3 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dsus4', cat: 'Suspended', frets: 'x 5 7 7 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Esus4', cat: 'Suspended', frets: '0 2 2 2 0 0', startFret: 1, barChord: 1, default: 1 },
    { name: 'Fsus4', cat: 'Suspended', frets: '1 3 3 3 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gsus4', cat: 'Suspended', frets: '3 3 0 0 1 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gsus4', cat: 'Suspended', frets: '3 5 5 5 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'A7sus2', cat: 'Suspended', frets: 'x 0 0 0 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A7sus2', cat: 'Suspended', frets: '5 7 5 7 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B7sus2', cat: 'Suspended', frets: 'x 2 2 2 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C7sus2', cat: 'Suspended', frets: 'x 3 3 3 3 3', startFret: 3, barChord: 1, default: 1 },
    { name: 'D7sus2', cat: 'Suspended', frets: 'x x 0 2 1 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'D7sus2', cat: 'Suspended', frets: 'x 5 7 5 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'E7sus2', cat: 'Suspended', frets: '0 2 2 2 3 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'F7sus2', cat: 'Suspended', frets: '1 3 1 3 1 1', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7sus2', cat: 'Suspended', frets: '3 5 3 5 3 3', startFret: 3, barChord: 1, default: 1 },

    { name: 'A7sus4', cat: 'Suspended', frets: 'x 0 2 0 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'A7sus4', cat: 'Suspended', frets: '5 7 5 7 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'B7sus4', cat: 'Suspended', frets: 'x 2 4 2 5 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'C7sus4', cat: 'Suspended', frets: 'x 3 3 3 6 3', startFret: 3, barChord: 1, default: 1 },
    { name: 'D7sus4', cat: 'Suspended', frets: 'x x 0 2 1 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'D7sus4', cat: 'Suspended', frets: 'x 5 7 5 8 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'E7sus4', cat: 'Suspended', frets: '0 2 0 2 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'E7sus4', cat: 'Suspended', frets: '0 7 7 7 10 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'F7sus4', cat: 'Suspended', frets: '1 3 1 3 1 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'G7sus4', cat: 'Suspended', frets: '3 5 3 5 3 5', startFret: 3, barChord: 1, default: 1 },

    { name: 'Aadd9', cat: 'Suspended', frets: 'x 0 2 4 2 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Aadd9', cat: 'Suspended', frets: '5 7 7 6 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Badd9', cat: 'Suspended', frets: 'x 2 4 4 2 4', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cadd9', cat: 'Suspended', frets: 'x 3 2 0 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Cadd9', cat: 'Suspended', frets: '8 10 10 9 8 8', startFret: 8, barChord: 1, default: 0 },
    { name: 'Dadd9', cat: 'Suspended', frets: 'x x 0 2 5 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dadd9', cat: 'Suspended', frets: 'x 5 7 7 7 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Eadd9', cat: 'Suspended', frets: '0 2 4 1 0 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Eadd9', cat: 'Suspended', frets: '0 7 9 9 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fadd9', cat: 'Suspended', frets: 'x 8 7 5 6 5', startFret: 5, barChord: 1, default: 1 },
    { name: 'Gadd9', cat: 'Suspended', frets: '3 2 0 2 0 3', startFret: 1, barChord: 0, default: 1 },
    { name: 'Gadd9', cat: 'Suspended', frets: '3 5 5 4 3 3', startFret: 3, barChord: 1, default: 0 },

    { name: 'Amadd9', cat: 'Suspended', frets: 'x 0 2 4 1 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Amadd9', cat: 'Suspended', frets: '5 7 7 5 5 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Bmadd9', cat: 'Suspended', frets: 'x 2 4 4 2 2', startFret: 1, barChord: 1, default: 1 },
    { name: 'Cmadd9', cat: 'Suspended', frets: 'x 3 5 5 3 3', startFret: 3, barChord: 1, default: 1 },
    { name: 'Dmadd9', cat: 'Suspended', frets: 'x x 0 2 3 0', startFret: 1, barChord: 0, default: 1 },
    { name: 'Dmadd9', cat: 'Suspended', frets: 'x 5 7 7 6 5', startFret: 5, barChord: 1, default: 0 },
    { name: 'Emadd9', cat: 'Suspended', frets: '0 2 4 0 0 2', startFret: 1, barChord: 0, default: 1 },
    { name: 'Emadd9', cat: 'Suspended', frets: '0 7 9 9 7 7', startFret: 7, barChord: 1, default: 0 },
    { name: 'Fmadd9', cat: 'Suspended', frets: '1 3 3 1 1 3', startFret: 1, barChord: 1, default: 1 },
    { name: 'Gmadd9', cat: 'Suspended', frets: '3 5 5 3 3 5', startFret: 3, barChord: 1, default: 1 }
];

// -----------------------------------------------------------------------------
// SVG Generators
// -----------------------------------------------------------------------------

/**
 * Generate Circle of Fifths SVG
 */
function buildCircleOfFifthsSvg(selectedIndex) {
    const size = 420;
    const center = size / 2;
    const outerRadius = 196;
    const midRadius = 136;
    const innerRadius = 78;

    let svg = `<svg viewBox="0 0 ${size} ${size}" class="ref-circle-svg" aria-label="Circle of Fifths Interactive Chart">`;
    svg += `<defs>
        <radialGradient id="refCircleGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="var(--bg-card-solid)" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="var(--bg-elevated)" stop-opacity="1"/>
        </radialGradient>
    </defs>`;

    // Background circle
    svg += `<circle cx="${center}" cy="${center}" r="${outerRadius + 6}" fill="var(--bg-card-solid)" stroke="var(--border-subtle)" stroke-width="1.5" />`;

    circleData.forEach((item, index) => {
        const isSelected = index === selectedIndex;
        const angleStep = (2 * Math.PI) / 12;
        const startAngle = (index * angleStep) - (Math.PI / 2) - (angleStep / 2);
        const endAngle = startAngle + angleStep;

        const x1Outer = center + outerRadius * Math.cos(startAngle);
        const y1Outer = center + outerRadius * Math.sin(startAngle);
        const x2Outer = center + outerRadius * Math.cos(endAngle);
        const y2Outer = center + outerRadius * Math.sin(endAngle);

        const midAngle = startAngle + (angleStep / 2);
        const textMajorX = center + ((outerRadius + midRadius) / 2) * Math.cos(midAngle);
        const textMajorY = center + ((outerRadius + midRadius) / 2) * Math.sin(midAngle) + 6;
        const textMinorX = center + ((midRadius + innerRadius) / 2) * Math.cos(midAngle);
        const textMinorY = center + ((midRadius + innerRadius) / 2) * Math.sin(midAngle) + 5;

        const fill = isSelected ? 'var(--accent-primary-alpha)' : 'transparent';
        const stroke = isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)';
        const strokeWidth = isSelected ? '2.5' : '1';
        const majorColor = isSelected ? 'var(--text-primary)' : 'var(--text-primary)';
        const minorColor = isSelected ? 'var(--accent-text)' : 'var(--text-muted)';
        const weight = isSelected ? 'bold' : '600';

        svg += `<path d="M ${center} ${center} L ${x1Outer} ${y1Outer} A ${outerRadius} ${outerRadius} 0 0 1 ${x2Outer} ${y2Outer} Z" 
                    fill="${fill}" 
                    stroke="${stroke}" 
                    stroke-width="${strokeWidth}" 
                    class="ref-circle-slice ${isSelected ? 'active' : ''}" 
                    data-circle-idx="${index}" 
                    role="button" 
                    tabindex="0"
                    aria-label="${item.major} Major / ${item.minor}" />`;

        svg += `<text x="${textMajorX}" y="${textMajorY}" fill="${majorColor}" font-size="16" font-weight="${weight}" text-anchor="middle" pointer-events="none">${item.major}</text>`;
        svg += `<text x="${textMinorX}" y="${textMinorY}" fill="${minorColor}" font-size="12" font-weight="600" text-anchor="middle" pointer-events="none">${item.minor}</text>`;
    });

    // Outer dividing ring between Major and Minor
    svg += `<circle cx="${center}" cy="${center}" r="${midRadius}" fill="none" stroke="var(--border-subtle)" stroke-width="1.2" pointer-events="none" />`;

    // Inner center hub
    svg += `<circle cx="${center}" cy="${center}" r="${innerRadius}" fill="url(#refCircleGlow)" stroke="var(--border-prominent)" stroke-width="2" pointer-events="none" />`;
    const sel = circleData[selectedIndex];
    svg += `<text x="${center}" y="${center - 7}" fill="var(--text-primary)" font-size="16" font-weight="bold" text-anchor="middle" pointer-events="none">${sel.major}</text>`;
    svg += `<text x="${center}" y="${center + 14}" fill="var(--accent-text)" font-size="11" font-weight="600" text-anchor="middle" pointer-events="none">${sel.minor}</text>`;

    svg += `</svg>`;
    return svg;
}

/**
 * Generate Chord Box Diagram SVG (Rotated Left 90 degrees)
 * Nut on left (right-handed) or right (left-handed), frets extending horizontally.
 * Strings are horizontal: High e on top, Low E on bottom (Tab View), or inverted (Player View).
 */
function buildChordDiagramSvg(chordOrFrets, explicitStartFret) {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();

    let fretsStr = '';
    let startFret = explicitStartFret || 1;
    if (typeof chordOrFrets === 'string') {
        fretsStr = chordOrFrets;
    } else if (chordOrFrets && typeof chordOrFrets === 'object') {
        fretsStr = chordOrFrets.frets || '';
        startFret = chordOrFrets.startFret || explicitStartFret || 1;
    }

    const frets = fretsStr.trim().split(/\s+/);
    const startY = 14; // High e string y position (or Low E when flipped)
    const stringGap = 10;
    const stringNamesNormal = ['e', 'B', 'G', 'D', 'A', 'E'];
    const stringNamesFlipped = ['E', 'A', 'D', 'G', 'B', 'e'];
    const stringNames = isFlipped ? stringNamesFlipped : stringNamesNormal;

    // Check base fret
    const numericFrets = frets.map(f => parseInt(f, 10)).filter(f => !isNaN(f) && f > 0);
    const minFret = numericFrets.length > 0 ? Math.min(...numericFrets) : 1;
    const maxFret = numericFrets.length > 0 ? Math.max(...numericFrets) : 1;

    let baseFret = startFret || 1;
    if (minFret < baseFret) {
        baseFret = minFret;
    }
    const numFrets = Math.max(4, maxFret - baseFret + 1);
    const fretGap = numFrets > 4 ? 18 : 22;
    const boardWidth = numFrets * fretGap;
    const width = 30 + boardWidth + 12;
    const height = 82;

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="ref-chord-diagram-svg" aria-hidden="true">`;

    if (!isLeftHanded) {
        const startX = 30; // Nut x position

        // Nut (vertical line)
        svg += `<line x1="${startX}" y1="${startY}" x2="${startX}" y2="${startY + 5 * stringGap}" stroke="${baseFret === 1 ? 'var(--text-primary)' : 'var(--border-prominent)'}" stroke-width="${baseFret === 1 ? 3.5 : 1.8}" stroke-linecap="round"/>`;

        // Fret wire lines (vertical)
        for (let f = 1; f <= numFrets; f++) {
            const x = startX + f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + 5 * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Horizontal string lines and string indicators on the left
        for (let s = 0; s < 6; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((5 - s) * 0.22) : 1 + (s * 0.22);
            // String line
            svg += `<line x1="${startX}" y1="${y}" x2="${startX + boardWidth}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"/>`;

            // String name label at far left
            svg += `<text x="8" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle">${stringNames[s]}</text>`;

            // Corresponding original string in frets array:
            // Standard Tab: s=0 is High e (frets[5]), s=5 is Low E (frets[0])
            // Inverted Player: s=0 is Low E (frets[0]), s=5 is High e (frets[5])
            const origStringIndex = isFlipped ? s : (5 - s);
            const f = frets[origStringIndex] || 'x';

            // Indicator at x=20 (between string letter and nut)
            if (f.toLowerCase() === 'x') {
                svg += `<text x="20" y="${y + 3.5}" fill="#ef4444" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="20" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        // Pressed note dots
        for (let s = 0; s < 6; s++) {
            const origStringIndex = isFlipped ? s : (5 - s);
            const f = frets[origStringIndex];
            if (f && f.toLowerCase() !== 'x' && f !== '0') {
                const fretVal = parseInt(f, 10);
                if (!isNaN(fretVal)) {
                    const relativeFret = fretVal - baseFret + 1;
                    if (relativeFret >= 1 && relativeFret <= numFrets) {
                        const x = startX + (relativeFret - 0.5) * fretGap;
                        const y = startY + s * stringGap;
                        svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--accent-primary)" stroke="var(--text-primary)" stroke-width="1.2" />`;
                    }
                }
            }
        }

        // Fret numbers along the bottom
        for (let f = 1; f <= numFrets; f++) {
            const x = startX + (f - 0.5) * fretGap;
            const fretNumber = baseFret + f - 1;
            svg += `<text x="${x}" y="76" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
        }

        // Base fret badge above fret 1 if shifted
        if (baseFret > 1) {
            svg += `<text x="${startX + (0.5 * fretGap)}" y="8" fill="var(--accent-text)" font-size="8.5" font-weight="bold" text-anchor="middle">${baseFret}fr</text>`;
        }
    } else {
        // Left-handed: Nut on right, frets extending to the left
        const nutX = width - 30; // board extends from 12 to nutX

        // Nut (vertical line)
        svg += `<line x1="${nutX}" y1="${startY}" x2="${nutX}" y2="${startY + 5 * stringGap}" stroke="${baseFret === 1 ? 'var(--text-primary)' : 'var(--border-prominent)'}" stroke-width="${baseFret === 1 ? 3.5 : 1.8}" stroke-linecap="round"/>`;

        // Fret wire lines (vertical)
        for (let f = 1; f <= numFrets; f++) {
            const x = nutX - f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + 5 * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Horizontal string lines and string indicators on the right
        for (let s = 0; s < 6; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((5 - s) * 0.22) : 1 + (s * 0.22);
            // String line
            svg += `<line x1="12" y1="${y}" x2="${nutX}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"/>`;

            // String name label at far right
            svg += `<text x="${nutX + 22}" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle">${stringNames[s]}</text>`;

            // Corresponding original string in frets array
            const origStringIndex = isFlipped ? s : (5 - s);
            const f = frets[origStringIndex] || 'x';

            // Indicator at nutX + 10 (between nut and string letter)
            if (f.toLowerCase() === 'x') {
                svg += `<text x="${nutX + 10}" y="${y + 3.5}" fill="#ef4444" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="${nutX + 10}" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        // Pressed note dots
        for (let s = 0; s < 6; s++) {
            const origStringIndex = isFlipped ? s : (5 - s);
            const f = frets[origStringIndex];
            if (f && f.toLowerCase() !== 'x' && f !== '0') {
                const fretVal = parseInt(f, 10);
                if (!isNaN(fretVal)) {
                    const relativeFret = fretVal - baseFret + 1;
                    if (relativeFret >= 1 && relativeFret <= numFrets) {
                        const x = nutX - (relativeFret - 0.5) * fretGap;
                        const y = startY + s * stringGap;
                        svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--accent-primary)" stroke="var(--text-primary)" stroke-width="1.2" />`;
                    }
                }
            }
        }

        // Fret numbers along the bottom
        for (let f = 1; f <= numFrets; f++) {
            const x = nutX - (f - 0.5) * fretGap;
            const fretNumber = baseFret + f - 1;
            svg += `<text x="${x}" y="76" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
        }

        // Base fret badge above fret 1 if shifted
        if (baseFret > 1) {
            svg += `<text x="${nutX - (0.5 * fretGap)}" y="8" fill="var(--accent-text)" font-size="8.5" font-weight="bold" text-anchor="middle">${baseFret}fr</text>`;
        }
    }

    svg += `</svg>`;
    return svg;
}

/**
 * Generate Scale Fretboard SVG
 * Right-handed or Left-handed neck, Tab View (high e on top) or Inverted Player View (low E on top).
 */
function buildFretboardSvg(scaleKey, rootNote) {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();

    const scale = scaleDefinitions[scaleKey] || scaleDefinitions.majorPentatonic;
    const scaleNotes = scale.intervals;
    const numFrets = 15;
    const fretWidth = 56;
    const stringSpacing = 32;
    const startY = 38;
    const boardWidth = numFrets * fretWidth; // 840
    const totalWidth = 66 + boardWidth + 30; // 936
    const totalHeight = startY + (5 * stringSpacing) + 32; // 230

    // Standard strings: Index 0 is high e, Index 5 is low E (standard tablature)
    const standardStrings = [
        { name: 'e', tuning: 4, gauge: 1.0 },
        { name: 'B', tuning: 11, gauge: 1.35 },
        { name: 'G', tuning: 7, gauge: 1.7 },
        { name: 'D', tuning: 2, gauge: 2.05 },
        { name: 'A', tuning: 9, gauge: 2.4 },
        { name: 'E', tuning: 4, gauge: 2.75 }
    ];
    const visualStrings = isFlipped ? [...standardStrings].reverse() : standardStrings;

    let svg = `<svg viewBox="0 0 ${totalWidth} ${totalHeight}" class="ref-fretboard-svg" style="min-width: 840px;" aria-label="Interactive Scale Fretboard">`;

    if (!isLeftHanded) {
        const startX = 66; // Nut x position

        // Fretboard body
        svg += `<rect x="${startX}" y="${startY}" width="${boardWidth}" height="${5 * stringSpacing}" fill="var(--bg-elevated)" rx="4" stroke="var(--border-subtle)" stroke-width="1" />`;

        // Position inlay dots
        [3, 5, 7, 9, 12, 15].forEach(f => {
            const cx = startX + (f - 0.5) * fretWidth;
            if (f === 12) {
                svg += `<circle cx="${cx}" cy="${startY + stringSpacing * 1.5}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
                svg += `<circle cx="${cx}" cy="${startY + stringSpacing * 3.5}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            } else if (f <= numFrets) {
                svg += `<circle cx="${cx}" cy="${startY + (stringSpacing * 2.5)}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            }
        });

        // Fret lines & numbers
        for (let f = 0; f <= numFrets; f++) {
            const x = startX + (f * fretWidth);
            const isNut = f === 0;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + 5 * stringSpacing}" stroke="${isNut ? 'var(--text-primary)' : 'var(--border-subtle)'}" stroke-width="${isNut ? 5 : 1.5}" stroke-linecap="round"/>`;
            if (f > 0) {
                svg += `<text x="${x - (fretWidth / 2)}" y="${startY - 14}" fill="var(--text-muted)" font-size="11" font-weight="600" text-anchor="middle">${f}</text>`;
            }
        }

        // String lines & Nut note labels
        visualStrings.forEach((s, sIndex) => {
            const y = startY + (sIndex * stringSpacing);
            svg += `<line x1="${startX}" y1="${y}" x2="${startX + boardWidth}" y2="${y}" stroke="var(--border-prominent)" stroke-width="${s.gauge}" opacity="0.85"/>`;
            svg += `<text x="${startX - 44}" y="${y + 4}" fill="var(--text-muted)" font-size="12" font-weight="bold" text-anchor="middle">${s.name}</text>`;
        });

        // Note markers
        visualStrings.forEach((s, sIndex) => {
            const y = startY + (sIndex * stringSpacing);
            for (let f = 0; f <= numFrets; f++) {
                const notePitch = (s.tuning + f) % 12;
                const matched = scaleNotes.find(n => (n.int + rootNote) % 12 === notePitch);
                if (matched) {
                    const x = f === 0 ? startX - 20 : startX + (f * fretWidth) - (fretWidth / 2);
                    const isRoot = matched.lbl === 'R';
                    const circleFill = isRoot ? 'var(--accent-primary)' : 'var(--accent-secondary)';
                    const strokeColor = isRoot ? '#ffffff' : 'var(--bg-elevated)';
                    const noteName = noteNames[notePitch];

                    svg += `<g transform="translate(${x}, ${y})" class="ref-fret-note" data-note="${noteName}">
                        <circle cx="0" cy="0" r="11" fill="${circleFill}" stroke="${strokeColor}" stroke-width="1.6" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.4))"/>
                        <text x="0" y="3.5" fill="#ffffff" font-size="9.5" font-weight="bold" text-anchor="middle">${matched.lbl}</text>
                    </g>`;
                }
            }
        });
    } else {
        // Left-handed: Nut on right (x = 870), frets extending to the left (to x = 30)
        const boardStartX = 30;
        const nutX = boardStartX + boardWidth; // 870

        // Fretboard body
        svg += `<rect x="${boardStartX}" y="${startY}" width="${boardWidth}" height="${5 * stringSpacing}" fill="var(--bg-elevated)" rx="4" stroke="var(--border-subtle)" stroke-width="1" />`;

        // Position inlay dots
        [3, 5, 7, 9, 12, 15].forEach(f => {
            const cx = nutX - (f - 0.5) * fretWidth;
            if (f === 12) {
                svg += `<circle cx="${cx}" cy="${startY + stringSpacing * 1.5}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
                svg += `<circle cx="${cx}" cy="${startY + stringSpacing * 3.5}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            } else if (f <= numFrets) {
                svg += `<circle cx="${cx}" cy="${startY + (stringSpacing * 2.5)}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            }
        });

        // Fret lines & numbers
        for (let f = 0; f <= numFrets; f++) {
            const x = nutX - (f * fretWidth);
            const isNut = f === 0;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + 5 * stringSpacing}" stroke="${isNut ? 'var(--text-primary)' : 'var(--border-subtle)'}" stroke-width="${isNut ? 5 : 1.5}" stroke-linecap="round"/>`;
            if (f > 0) {
                svg += `<text x="${x + (fretWidth / 2)}" y="${startY - 14}" fill="var(--text-muted)" font-size="11" font-weight="600" text-anchor="middle">${f}</text>`;
            }
        }

        // String lines & Nut note labels
        visualStrings.forEach((s, sIndex) => {
            const y = startY + (sIndex * stringSpacing);
            svg += `<line x1="${boardStartX}" y1="${y}" x2="${nutX}" y2="${y}" stroke="var(--border-prominent)" stroke-width="${s.gauge}" opacity="0.85"/>`;
            svg += `<text x="${nutX + 44}" y="${y + 4}" fill="var(--text-muted)" font-size="12" font-weight="bold" text-anchor="middle">${s.name}</text>`;
        });

        // Note markers
        visualStrings.forEach((s, sIndex) => {
            const y = startY + (sIndex * stringSpacing);
            for (let f = 0; f <= numFrets; f++) {
                const notePitch = (s.tuning + f) % 12;
                const matched = scaleNotes.find(n => (n.int + rootNote) % 12 === notePitch);
                if (matched) {
                    const x = f === 0 ? nutX + 20 : nutX - (f * fretWidth) + (fretWidth / 2);
                    const isRoot = matched.lbl === 'R';
                    const circleFill = isRoot ? 'var(--accent-primary)' : 'var(--accent-secondary)';
                    const strokeColor = isRoot ? '#ffffff' : 'var(--bg-elevated)';
                    const noteName = noteNames[notePitch];

                    svg += `<g transform="translate(${x}, ${y})" class="ref-fret-note" data-note="${noteName}">
                        <circle cx="0" cy="0" r="11" fill="${circleFill}" stroke="${strokeColor}" stroke-width="1.6" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.4))"/>
                        <text x="0" y="3.5" fill="#ffffff" font-size="9.5" font-weight="bold" text-anchor="middle">${matched.lbl}</text>
                    </g>`;
                }
            }
        });
    }

    svg += `</svg>`;
    return svg;
}

// -----------------------------------------------------------------------------
// View Renderers
// -----------------------------------------------------------------------------

/**
 * Render Circle of Fifths Section
 */
function renderCircleSection() {
    const data = circleData[selectedCircleIndex];

    const majorChordsHtml = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'].map((deg, i) => `
        <div class="ref-chord-deg-card">
            <span class="ref-deg-label">${deg}</span>
            <span class="ref-deg-chord">${data.majorChords[i]}</span>
        </div>
    `).join('');

    const minorChordsHtml = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'].map((deg, i) => `
        <div class="ref-chord-deg-card">
            <span class="ref-deg-label">${deg}</span>
            <span class="ref-deg-chord">${data.minorChords[i]}</span>
        </div>
    `).join('');

    return `
    <div class="ref-circle-container">
        <!-- SVG Circle (Left / Top) -->
        <div class="ref-circle-left">
            <div class="d-flex align-items-center justify-content-between mb-2">
                <h3 class="ref-section-title mb-0">Circle of fourths and fifths</h3>
            </div>
            <p class="ref-section-subtitle mb-3">Click any key segment to view relative minors, key signatures, and diatonic chords.</p>
            <div class="ref-circle-svg-wrapper" id="refCircleSvgContainer">
                ${buildCircleOfFifthsSvg(selectedCircleIndex)}
            </div>
        </div>

        <!-- Key Details Panel (Right / Bottom) -->
        <div class="ref-circle-right" id="refCircleInfoPanel">
            <div class="ref-key-badge-container mb-3">
                <span class="ref-eyebrow">Selected key info</span>
                <h4 class="ref-key-headline">${data.major} Major / ${data.minor}</h4>
            </div>

            <div class="row g-2 mb-3">
                <div class="col-6">
                    <div class="ref-stat-card">
                        <span class="ref-stat-label">Key signature</span>
                        <span class="ref-stat-value text-truncate" title="${data.accidentals}">${data.accidentals}</span>
                    </div>
                </div>
                <div class="col-6">
                    <div class="ref-stat-card">
                        <span class="ref-stat-label">Relative minor</span>
                        <span class="ref-stat-value text-accent">${data.minor}</span>
                    </div>
                </div>
            </div>

            <div class="mb-3">
                <span class="ref-card-subhead d-block mb-2">Diatonic chords (major key)</span>
                <div class="ref-deg-grid">
                    ${majorChordsHtml}
                </div>
            </div>

            <div>
                <span class="ref-card-subhead d-block mb-2">Diatonic chords (minor key)</span>
                <div class="ref-deg-grid">
                    ${minorChordsHtml}
                </div>
            </div>
        </div>
    </div>
    `;
}

/**
 * Render Chord Reference Library Section
 */
function renderChordsSection() {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();
    const filters = ['all', 'Major', 'Dominant', 'Minor', 'Dim/Aug', 'Suspended'];
    const rootFilters = ['all', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

    const displayedChords = chordData.filter(chord => {
        if (!preferBarChords) return chord.default === 1;
        if (chord.barChord === 1) {
            return chord.default === 1 || chordData.some(c => c.name === chord.name && c.cat === chord.cat && c.default === 1 && c.barChord === 0);
        }
        return chord.default === 1 && !chordData.some(c => c.name === chord.name && c.cat === chord.cat && c.barChord === 1);
    });

    const filteredChords = displayedChords.filter(chord => {
        const matchesCategory = selectedChordFilter === 'all' || chord.cat === selectedChordFilter;
        const chordRoot = chord.name.match(/^[A-G]/)?.[0] || '';
        const matchesRoot = selectedRootFilter === 'all' || chordRoot === selectedRootFilter;
        return matchesCategory && matchesRoot;
    });

    const filterButtonsHtml = filters.map(f => {
        const isActive = selectedChordFilter === f;
        const label = f === 'all' ? 'All' : (f === 'Dim/Aug' ? 'Dim / Aug' : f);
        return `
            <button type="button" class="btn btn-sm ${isActive ? 'btn-theme-primary' : 'btn-theme-outline'} ref-chord-filter-btn" data-filter="${f}">
                ${label}
            </button>
        `;
    }).join('');

    const rootButtonsHtml = rootFilters.map(r => {
        const isActive = selectedRootFilter === r;
        const label = r === 'all' ? 'All' : r;
        return `
            <button type="button" class="btn btn-sm ${isActive ? 'btn-theme-primary' : 'btn-theme-outline'} ref-chord-root-btn" data-root="${r}">
                ${label}
            </button>
        `;
    }).join('');

    const chordCardsHtml = filteredChords.length > 0 ? filteredChords.map(chord => `
        <div class="col">
            <div class="ref-chord-card">
                <div class="ref-chord-card-header">
                    <span class="ref-chord-name">${chord.name}</span>
                    <span class="ref-chord-cat">${chord.cat}</span>
                </div>
                <div class="ref-chord-svg-container">
                    ${buildChordDiagramSvg(chord)}
                </div>
                <span class="ref-chord-frets font-monospace">${chord.frets}</span>
            </div>
        </div>
    `).join('') : `
        <div class="col-12 py-5 text-center text-muted">
            <i class="bi bi-music-note-beamed fs-2 d-block mb-2 opacity-50"></i>
            <p class="mb-0">No chords found matching the selected filters.</p>
        </div>
    `;

    return `
    <div class="ref-section-box">
        <div class="d-flex flex-column gap-3 mb-3">
            <div class="d-flex flex-column flex-sm-row justify-content-between align-items-start align-items-sm-center gap-2">
                <div>
                    <h3 class="ref-section-title mb-1">Chord reference library</h3>
                    <p class="ref-section-subtitle mb-0">Essential guitar chord voicings with fretboard positions and fingerings (${filteredChords.length} chords shown).</p>
                </div>
                <div class="d-flex align-items-center gap-1 flex-shrink-0">
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ${preferBarChords ? 'active' : ''}" id="refChordBarBtn" title="Prefer Bar Chords" aria-label="Prefer Bar Chords" aria-pressed="${preferBarChords}">
                        <i class="bi bi-distribute-vertical"></i>
                        <span class="d-none d-sm-inline ms-1 small">Prefer Bar Chords</span>
                    </button>
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ref-fretboard-flip-btn ${isFlipped ? 'active' : ''}" id="refChordFlipBtn" title="Invert Strings (Tab / Player View)" aria-label="Invert Strings">
                        <i class="bi bi-arrow-down-up"></i>
                        <span class="d-none d-sm-inline ms-1 small">Invert</span>
                    </button>
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ref-fretboard-lh-btn ${isLeftHanded ? 'active' : ''}" id="refChordLhBtn" title="Toggle Left-Handed Neck" aria-label="Toggle Left-Handed Neck">
                        <i class="bi bi-arrow-left-right"></i>
                        <span class="d-none d-sm-inline ms-1 small">Left Handed</span>
                    </button>
                </div>
            </div>

            <div class="d-flex flex-column gap-2 pt-2 border-top border-secondary-subtle">
                <!-- Root Note Filter -->
                <div class="ref-filter-group">
                    <span class="ref-filter-group-label">Root note:</span>
                    <div class="d-flex flex-wrap gap-1 ref-chord-root-filters">
                        ${rootButtonsHtml}
                    </div>
                </div>

                <!-- Family / Category Filter -->
                <div class="ref-filter-group">
                    <span class="ref-filter-group-label">Family:</span>
                    <div class="d-flex flex-wrap gap-1 ref-chord-filters">
                        ${filterButtonsHtml}
                    </div>
                </div>
            </div>
        </div>

        <div class="row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-xl-5 g-3" id="refChordGrid">
            ${chordCardsHtml}
        </div>
    </div>
    `;
}

/**
 * Render Scales and Modes Section
 */
function renderScalesSection() {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();
    const currentScale = scaleDefinitions[selectedScaleKey] || scaleDefinitions.majorPentatonic;
    const rootName = noteNames[selectedRootNote];

    // Compute active notes in scale
    const activeNoteNames = currentScale.intervals.map(item => {
        const noteIndex = (item.int + selectedRootNote) % 12;
        return noteNames[noteIndex];
    }).join(' • ');

    const scaleOptions = Object.keys(scaleDefinitions).map(k => `
        <option value="${k}" ${k === selectedScaleKey ? 'selected' : ''}>${scaleDefinitions[k].name}</option>
    `).join('');

    const rootOptions = noteNames.map((name, idx) => `
        <option value="${idx}" ${idx === selectedRootNote ? 'selected' : ''}>${name}</option>
    `).join('');

    return `
    <div class="ref-section-box">
        <div class="d-flex flex-column gap-3 mb-3">
            <div class="d-flex flex-column flex-sm-row justify-content-between align-items-start align-items-sm-center gap-2">
                <div>
                    <h3 class="ref-section-title mb-1">Interactive scale and mode fretboard</h3>
                    <p class="ref-section-subtitle mb-0">Explore scales and modal intervals across the full fretboard.</p>
                </div>
                <div class="d-flex align-items-center gap-1 flex-shrink-0">
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ref-fretboard-flip-btn ${isFlipped ? 'active' : ''}" id="refScaleFlipBtn" title="Invert Strings (Tab / Player View)" aria-label="Invert Strings">
                        <i class="bi bi-arrow-down-up"></i>
                        <span class="d-none d-sm-inline ms-1 small">Invert</span>
                    </button>
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ref-fretboard-lh-btn ${isLeftHanded ? 'active' : ''}" id="refScaleLhBtn" title="Toggle Left-Handed Neck" aria-label="Toggle Left-Handed Neck">
                        <i class="bi bi-arrow-left-right"></i>
                        <span class="d-none d-sm-inline ms-1 small">Left Handed</span>
                    </button>
                </div>
            </div>
            <div class="d-flex flex-wrap align-items-end gap-2 pt-2 border-top border-secondary-subtle">
                <div class="flex-grow-1 flex-md-grow-0">
                    <label class="ref-select-label" for="refScaleSelect">Scale / Mode</label>
                    <select id="refScaleSelect" class="form-select form-select-sm theme-select">
                        ${scaleOptions}
                    </select>
                </div>
                <div>
                    <label class="ref-select-label" for="refRootSelect">Root (R)</label>
                    <select id="refRootSelect" class="form-select form-select-sm theme-select">
                        ${rootOptions}
                    </select>
                </div>
            </div>
        </div>

        <!-- Formula & Notes Banner -->
        <div class="ref-scale-banner mb-3 d-flex flex-column flex-sm-row justify-content-between align-items-start align-items-sm-center gap-2 p-2 px-3 rounded">
            <div>
                <span class="ref-eyebrow d-block mb-1">Scale formula</span>
                <span class="ref-scale-formula font-monospace text-accent">${currentScale.formula}</span>
            </div>
            <div class="text-sm-end">
                <span class="ref-eyebrow d-block mb-1">${rootName} ${currentScale.name} notes</span>
                <span class="ref-scale-notes fw-semibold text-white">${activeNoteNames}</span>
            </div>
        </div>

        <!-- Fretboard Visualizer with Horizontal Scroll -->
        <div class="ref-fretboard-scroll-container">
            <div class="ref-fretboard-wrapper" id="refFretboardContainer">
                ${buildFretboardSvg(selectedScaleKey, selectedRootNote)}
            </div>
        </div>

        <div class="d-flex align-items-center justify-content-between mt-2 pt-2 border-top border-secondary-subtle">
            <div class="d-flex align-items-center gap-3 small text-muted">
                <span class="d-flex align-items-center gap-2"><span class="ref-legend-dot ref-root-dot"></span> Root (R)</span>
                <span class="d-flex align-items-center gap-2"><span class="ref-legend-dot ref-interval-dot"></span> Scale Interval</span>
            </div>
            <span class="small text-muted d-none d-sm-inline">15 frets • Standard tuning (${isFlipped ? 'E A D G B e' : 'e B G D A E'})</span>
        </div>
    </div>
    `;
}

/**
 * Render Tone Matrix Section
 */
function renderToneSection() {
    const tuneOptions = ['all', 'C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'].map(k => `
        <option value="${k}" ${k === selectedToneKey ? 'selected' : ''}>${k === 'all' ? 'All Keys' : `Key of ${k}`}</option>
    `).join('');

    const filteredRows = selectedToneKey === 'all'
        ? toneMatrixData
        : toneMatrixData.filter(t => t.tune === selectedToneKey);

    const rowsHtml = filteredRows.map(row => {
        const chordsHtml = row.chords.map(c => `
            <div class="ref-matrix-chord-cell">
                <span class="ref-matrix-deg">${c.deg}</span>
                <span class="ref-matrix-chord-name">${c.name}</span>
                <span class="ref-matrix-frets font-monospace">${c.frets}</span>
            </div>
        `).join('');

        return `
        <div class="ref-matrix-row mb-3">
            <div class="ref-matrix-key-badge">
                <span class="ref-eyebrow">Tune</span>
                <span class="ref-matrix-key-name">${row.tune}</span>
            </div>
            <div class="ref-matrix-chords-grid">
                ${chordsHtml}
            </div>
        </div>
        `;
    }).join('');

    return `
    <div class="ref-section-box">
        <div class="d-flex flex-column flex-md-row justify-content-between align-items-start align-items-md-center gap-2 mb-3">
            <div>
                <h3 class="ref-section-title mb-1">Tone matrix: diatonic chords by root tune</h3>
                <p class="ref-section-subtitle mb-0">Harmonic Roman numeral degrees (I to vii° and dominant VII) across keys.</p>
            </div>
            <div>
                <select id="refToneKeySelect" class="form-select form-select-sm theme-select">
                    ${tuneOptions}
                </select>
            </div>
        </div>

        <div class="ref-matrix-container">
            ${rowsHtml}
        </div>
    </div>
    `;
}

// -----------------------------------------------------------------------------
// Main View Export
// -----------------------------------------------------------------------------

// --- Reference modal: opens over any view (song, library, tuner closed) ---------------------------

const REFERENCE_TABS = ['circle', 'chords', 'scales', 'tone'];
let referenceModalEl = null;

function ensureReferenceModal() {
    if (referenceModalEl) return referenceModalEl;
    const backdrop = document.createElement('div');
    backdrop.id = 'referenceModal';
    backdrop.className = 'theme-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'referenceModalTitle');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.style.display = 'none';
    backdrop.innerHTML = `
      <section class="theme-modal-card reference-modal-card">
        <header class="theme-modal-header">
          <div class="theme-modal-title-group">
            <div class="brand-btn p-2 theme-modal-icon" style="width: 36px; height: 36px;"><i class="bi-journal-bookmark fs-5"></i></div>
            <div class="theme-modal-titles">
              <h2 class="theme-modal-title mb-0 fs-6 fw-bold text-white" id="referenceModalTitle">Reference library</h2>
              <div class="small text-white-50">Chords, scales, circle of fifths and tone matrix</div>
            </div>
          </div>
          <div class="theme-modal-actions">
            <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="referenceModalCloseBtn" aria-label="Close modal"><i class="bi-x-lg"></i></button>
          </div>
        </header>
        <div class="theme-modal-body reference-modal-body" id="referenceModalBody"></div>
      </section>`;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeReferenceModal();
    });
    backdrop.querySelector('#referenceModalCloseBtn').addEventListener('click', () => closeReferenceModal());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isReferenceOpen()) closeReferenceModal();
    });

    referenceModalEl = backdrop;
    return backdrop;
}

export function isReferenceOpen() {
    return Boolean(referenceModalEl) && referenceModalEl.style.display !== 'none';
}

export function openReferenceModal(tab = null) {
    const modal = ensureReferenceModal();
    if (REFERENCE_TABS.includes(tab)) activeTab = tab;
    const wasOpen = isReferenceOpen();
    renderReferenceLibraryView(modal.querySelector('#referenceModalBody'));
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    document.getElementById('toolsReferenceItem')?.classList.add('active');
    if (!wasOpen) {
        modal.querySelector('#referenceModalCloseBtn')?.focus();
        refTabChangeListener?.(activeTab);
    }
}

export function closeReferenceModal() {
    if (!isReferenceOpen()) return;
    referenceModalEl.style.display = 'none';
    referenceModalEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    document.getElementById('toolsReferenceItem')?.classList.remove('active');
    // Put the address bar back to whatever sits behind the modal
    import('./utils/urlRouter.js').then(({ updateUrl, clearUrl }) => {
        const libPage = document.getElementById('libraryPage');
        if (libPage && libPage.style.display !== 'none') {
            import('./libraryModal.js').then((m) => updateUrl(m.getActiveLibraryView?.() || 'library'));
        } else {
            clearUrl();
        }
    });
}

/**
 * Render the Reference Library content into a container (the reference modal body)
 */
export function renderReferenceLibraryView(container) {
    if (!container) return;

    if (!REFERENCE_TABS.includes(activeTab)) {
        activeTab = 'chords';
    }

    // Sub-navigation pills
    const tabs = [
        { id: 'chords', label: 'Chord Library', icon: 'bi-grid-3x2-gap' },
        { id: 'scales', label: 'Scales and Modes', icon: 'bi-soundwave' },
        { id: 'circle', label: 'Circle of Fifths', icon: 'bi-circle-half' },
        { id: 'tone', label: 'Tone Matrix', icon: 'bi-table' }
    ];

    const navPillsHtml = tabs.map(t => {
        const isActive = activeTab === t.id;
        return `
            <button type="button" class="btn btn-sm ${isActive ? 'btn-theme-primary active' : 'btn-theme-outline'} ref-tab-btn" data-tab="${t.id}">
                <i class="${t.icon} me-2"></i><span>${t.label}</span>
            </button>
        `;
    }).join('');

    let tabContentHtml = '';
    if (activeTab === 'circle') tabContentHtml = renderCircleSection();
    else if (activeTab === 'chords') tabContentHtml = renderChordsSection();
    else if (activeTab === 'scales') tabContentHtml = renderScalesSection();
    else if (activeTab === 'tone') tabContentHtml = renderToneSection();

    container.innerHTML = `
    <div class="library-page-container ref-page-container">
        <!-- Sub-Navigation Toolbar -->
        <div class="library-body-header ref-header-bar mb-3">
            <div class="d-flex align-items-center gap-2 overflow-x-auto ref-subnav-scroll flex-nowrap w-100 py-1">
                ${navPillsHtml}
            </div>
        </div>

        <!-- Main Tool Content -->
        <div id="refTabContentContainer">
            ${tabContentHtml}
        </div>
    </div>
    `;

    attachReferenceEventListeners(container);
}

/**
 * Attach Event Listeners
 */
function attachReferenceEventListeners(container) {
    // 1. Tab buttons
    container.querySelectorAll('.ref-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetTab = btn.getAttribute('data-tab');
            if (targetTab && targetTab !== activeTab) {
                activeTab = targetTab;
                renderReferenceLibraryView(container);
                refTabChangeListener?.(activeTab);
            }
        });
    });

    // 2. Circle of Fifths slices
    container.querySelectorAll('.ref-circle-slice').forEach(slice => {
        slice.addEventListener('click', () => {
            const idx = parseInt(slice.getAttribute('data-circle-idx'));
            if (!isNaN(idx)) {
                selectedCircleIndex = idx;
                const svgContainer = document.getElementById('refCircleSvgContainer');
                const infoPanel = document.getElementById('refCircleInfoPanel');
                if (svgContainer) svgContainer.innerHTML = buildCircleOfFifthsSvg(selectedCircleIndex);
                if (infoPanel) {
                    const data = circleData[selectedCircleIndex];
                    const majorChordsHtml = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'].map((deg, i) => `
                        <div class="ref-chord-deg-card">
                            <span class="ref-deg-label">${deg}</span>
                            <span class="ref-deg-chord">${data.majorChords[i]}</span>
                        </div>
                    `).join('');
                    const minorChordsHtml = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'].map((deg, i) => `
                        <div class="ref-chord-deg-card">
                            <span class="ref-deg-label">${deg}</span>
                            <span class="ref-deg-chord">${data.minorChords[i]}</span>
                        </div>
                    `).join('');

                    infoPanel.innerHTML = `
                        <div class="ref-key-badge-container mb-3">
                            <span class="ref-eyebrow">Selected key info</span>
                            <h4 class="ref-key-headline">${data.major} Major / ${data.minor}</h4>
                        </div>
                        <div class="row g-2 mb-3">
                            <div class="col-6">
                                <div class="ref-stat-card">
                                    <span class="ref-stat-label">Key signature</span>
                                    <span class="ref-stat-value text-truncate" title="${data.accidentals}">${data.accidentals}</span>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="ref-stat-card">
                                    <span class="ref-stat-label">Relative minor</span>
                                    <span class="ref-stat-value text-accent">${data.minor}</span>
                                </div>
                            </div>
                        </div>
                        <div class="mb-3">
                            <span class="ref-card-subhead d-block mb-2">Diatonic chords (major key)</span>
                            <div class="ref-deg-grid">
                                ${majorChordsHtml}
                            </div>
                        </div>
                        <div>
                            <span class="ref-card-subhead d-block mb-2">Diatonic chords (minor key)</span>
                            <div class="ref-deg-grid">
                                ${minorChordsHtml}
                            </div>
                        </div>
                    `;
                }
                // Re-bind click listeners on newly rendered SVG slices
                attachCircleSliceListeners();
            }
        });
    });

    // 3. Chord Family Filter Buttons
    container.querySelectorAll('.ref-chord-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.getAttribute('data-filter');
            if (filter) {
                selectedChordFilter = filter;
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    const barBtn = container.querySelector('#refChordBarBtn');
    if (barBtn) {
        barBtn.addEventListener('click', () => {
            preferBarChords = !preferBarChords;
            try { localStorage.setItem('majestictab_prefer_bar_chords', String(preferBarChords)); } catch (_) {}
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = renderChordsSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    // Chord Root Note Filter Buttons
    container.querySelectorAll('.ref-chord-root-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const root = btn.getAttribute('data-root');
            if (root) {
                selectedRootFilter = root;
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // 4. Scales and Modes Selectors
    const scaleSelect = container.querySelector('#refScaleSelect');
    if (scaleSelect) {
        scaleSelect.addEventListener('change', () => {
            selectedScaleKey = scaleSelect.value;
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = renderScalesSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    const rootSelect = container.querySelector('#refRootSelect');
    if (rootSelect) {
        rootSelect.addEventListener('change', () => {
            selectedRootNote = parseInt(rootSelect.value);
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = renderScalesSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    // 5. Tone Matrix Select
    const toneSelect = container.querySelector('#refToneKeySelect');
    if (toneSelect) {
        toneSelect.addEventListener('change', () => {
            selectedToneKey = toneSelect.value;
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = renderToneSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    // 6. Invert strings (flip) toggle buttons
    container.querySelectorAll('.ref-fretboard-flip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setIsFlipped(!getIsFlipped());
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                if (activeTab === 'scales') contentContainer.innerHTML = renderScalesSection();
                else if (activeTab === 'chords') contentContainer.innerHTML = renderChordsSection();
                attachReferenceEventListeners(container);
            }
        });
    });

    // 7. Left-handed neck toggle buttons
    container.querySelectorAll('.ref-fretboard-lh-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setIsLeftHanded(!getIsLeftHanded());
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                if (activeTab === 'scales') contentContainer.innerHTML = renderScalesSection();
                else if (activeTab === 'chords') contentContainer.innerHTML = renderChordsSection();
                attachReferenceEventListeners(container);
            }
        });
    });
}

function attachCircleSliceListeners() {
    const svgContainer = document.getElementById('refCircleSvgContainer');
    if (!svgContainer) return;
    svgContainer.querySelectorAll('.ref-circle-slice').forEach(slice => {
        slice.addEventListener('click', () => {
            const idx = parseInt(slice.getAttribute('data-circle-idx'));
            if (!isNaN(idx)) {
                selectedCircleIndex = idx;
                const infoPanel = document.getElementById('refCircleInfoPanel');
                svgContainer.innerHTML = buildCircleOfFifthsSvg(selectedCircleIndex);
                if (infoPanel) {
                    const data = circleData[selectedCircleIndex];
                    const majorChordsHtml = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'].map((deg, i) => `
                        <div class="ref-chord-deg-card">
                            <span class="ref-deg-label">${deg}</span>
                            <span class="ref-deg-chord">${data.majorChords[i]}</span>
                        </div>
                    `).join('');
                    const minorChordsHtml = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'].map((deg, i) => `
                        <div class="ref-chord-deg-card">
                            <span class="ref-deg-label">${deg}</span>
                            <span class="ref-deg-chord">${data.minorChords[i]}</span>
                        </div>
                    `).join('');

                    infoPanel.innerHTML = `
                        <div class="ref-key-badge-container mb-3">
                            <span class="ref-eyebrow">Selected key info</span>
                            <h4 class="ref-key-headline">${data.major} Major / ${data.minor}</h4>
                        </div>
                        <div class="row g-2 mb-3">
                            <div class="col-6">
                                <div class="ref-stat-card">
                                    <span class="ref-stat-label">Key signature</span>
                                    <span class="ref-stat-value text-truncate" title="${data.accidentals}">${data.accidentals}</span>
                                </div>
                            </div>
                            <div class="col-6">
                                <div class="ref-stat-card">
                                    <span class="ref-stat-label">Relative minor</span>
                                    <span class="ref-stat-value text-accent">${data.minor}</span>
                                </div>
                            </div>
                        </div>
                        <div class="mb-3">
                            <span class="ref-card-subhead d-block mb-2">Diatonic chords (major key)</span>
                            <div class="ref-deg-grid">
                                ${majorChordsHtml}
                            </div>
                        </div>
                        <div>
                            <span class="ref-card-subhead d-block mb-2">Diatonic chords (minor key)</span>
                            <div class="ref-deg-grid">
                                ${minorChordsHtml}
                            </div>
                        </div>
                    `;
                }
                attachCircleSliceListeners();
            }
        });
    });
}
