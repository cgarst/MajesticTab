// referenceLibrary.js
// Interactive music theory reference library: Circle of Fifths, Chord Library,
// Scales & Modes, and Triad Inversions & Formulas.
// Optimized for desktop and mobile viewports with MajesticTab finish theme integration.

import { fretboardController } from './fretboard/fretboardController.js';
import { chordData7, chordData8 } from './extendedRangeChords.js';

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

let activeTab = 'chords'; // 'circle', 'chords', 'scales'
let refTabChangeListener = null;

export function getActiveReferenceTab() {
    return activeTab;
}

export function setActiveReferenceTab(tab) {
    if (['circle', 'chords', 'scales'].includes(tab)) {
        activeTab = tab;
    }
}

export function setReferenceTabChangeListener(fn) {
    refTabChangeListener = fn;
}
let selectedCircleIndex = 0; // default C Major / Am
let selectedScaleKey = 'majorPentatonic';
let selectedRootNote = 0; // C (0 to 11)
let stringCount = (() => { try { const n = parseInt(localStorage.getItem('majestictab_string_count'), 10); return [6, 7, 8].includes(n) ? n : 6; } catch (_) { return 6; } })();
let tuningOffset = (() => { try { const n = parseInt(localStorage.getItem('majestictab_tuning_offset'), 10); return Number.isInteger(n) ? n : 0; } catch (_) { return 0; } })();
const capoFrets = [0, 1, 2, 3, 4, 5, 6, 7];
let capo = (() => { try { const n = parseInt(localStorage.getItem('majestictab_capo'), 10); return capoFrets.includes(n) ? n : 0; } catch (_) { return 0; } })();
let selectedChordFilter = 'all'; // 'all', 'Major', 'Dominant', 'Minor', 'Suspended'
let preferBarreChords = (() => { try { return (localStorage.getItem('majestictab_prefer_barre_chords') ?? localStorage.getItem('majestictab_prefer_bar_chords')) === 'true'; } catch (_) { return false; } })();
let selectedRootFilter = 'all'; // 'all' or a root from chordRootFilters

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
// Standard tunings per string count: lowest string's pitch class, each string's semitones above it,
// and how many semitones the whole set can be tuned down (the options offered in the library).
const tuningSpecs = {
    6: { low: 4, steps: [0, 5, 10, 15, 19, 24], offsets: [0, 1, 2, 3, 5, 6] }, // E A D G B E
    7: { low: 11, steps: [0, 5, 10, 15, 20, 24, 29], offsets: [0, 1, 2] }, // B E A D G B E
    8: { low: 6, steps: [0, 5, 10, 15, 20, 25, 29, 34], offsets: [0, 1, 2] } // F♯ B E A D G B E
};
const sharpNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const flatNames = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const sharpTuningOffsets = [3, 5];

export const chordData = [
    // === MAJOR FAMILY (IMG_6420)[cite: 13] ===
    { name: 'A♭', cat: 'Major', frets: '4 3 1 1 1 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A', cat: 'Major', frets: 'x 0 2 2 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A', cat: 'Major', frets: '5 7 7 6 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭', cat: 'Major', frets: 'x 1 3 3 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B', cat: 'Major', frets: 'x 2 4 4 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C', cat: 'Major', frets: 'x 3 2 0 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'C', cat: 'Major', frets: '8 10 10 9 8 8', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯', cat: 'Major', frets: 'x 4 3 1 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D', cat: 'Major', frets: 'x x 0 2 3 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D', cat: 'Major', frets: 'x 5 7 7 7 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭', cat: 'Major', frets: 'x x 1 3 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E', cat: 'Major', frets: '0 2 2 1 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E', cat: 'Major', frets: 'x 7 9 9 9 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'F', cat: 'Major', frets: '1 3 3 2 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯', cat: 'Major', frets: '2 4 4 3 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G', cat: 'Major', frets: '3 2 0 0 0 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'G', cat: 'Major', frets: '3 5 5 4 3 3', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭maj7', cat: 'Major', frets: '4 x 1 1 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Amaj7', cat: 'Major', frets: 'x 0 2 1 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Amaj7', cat: 'Major', frets: '5 x 6 6 5 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭maj7', cat: 'Major', frets: 'x 1 3 2 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bmaj7', cat: 'Major', frets: 'x 2 4 3 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cmaj7', cat: 'Major', frets: 'x 3 2 0 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cmaj7', cat: 'Major', frets: '8 x 9 9 8 x', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯maj7', cat: 'Major', frets: 'x 4 3 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dmaj7', cat: 'Major', frets: 'x x 0 2 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dmaj7', cat: 'Major', frets: 'x 5 7 6 7 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭maj7', cat: 'Major', frets: 'x x 1 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Emaj7', cat: 'Major', frets: '0 2 1 1 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Emaj7', cat: 'Major', frets: 'x 7 9 8 9 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fmaj7', cat: 'Major', frets: 'x x 3 2 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Fmaj7', cat: 'Major', frets: '1 x 2 2 1 x', startFret: 1, barreChord: 1, default: 0 },
    { name: 'F♯maj7', cat: 'Major', frets: 'x x 4 3 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gmaj7', cat: 'Major', frets: '3 2 0 0 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gmaj7', cat: 'Major', frets: '3 x 4 4 3 x', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭maj9', cat: 'Major', frets: '4 1 1 1 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Amaj9', cat: 'Major', frets: 'x 0 2 4 2 4', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Amaj9', cat: 'Major', frets: '5 x 6 6 5 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭maj9', cat: 'Major', frets: '1 3 3 3 3 5', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bmaj9', cat: 'Major', frets: 'x 2 1 3 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Bmaj9', cat: 'Major', frets: '7 x 8 8 7 9', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Cmaj9', cat: 'Major', frets: 'x 3 0 0 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cmaj9', cat: 'Major', frets: '8 x 9 9 8 10', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯maj9', cat: 'Major', frets: 'x 4 1 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dmaj9', cat: 'Major', frets: 'x 5 4 2 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dmaj9', cat: 'Major', frets: 'x 5 4 6 5 x', startFret: 4, barreChord: 1, default: 0 },
    { name: 'E♭maj9', cat: 'Major', frets: 'x 6 3 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Emaj9', cat: 'Major', frets: '0 2 1 1 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Emaj9', cat: 'Major', frets: 'x 7 6 8 7 x', startFret: 6, barreChord: 1, default: 0 },
    { name: 'Fmaj9', cat: 'Major', frets: '1 x 2 2 1 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'F♯maj9', cat: 'Major', frets: '2 x 3 3 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gmaj9', cat: 'Major', frets: '3 0 0 0 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gmaj9', cat: 'Major', frets: '3 x 4 4 3 5', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭maj7-11', cat: 'Major', frets: '4 3 5 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Amaj7-11', cat: 'Major', frets: 'x 0 1 1 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Amaj7-11', cat: 'Major', frets: '5 4 6 6 4 x', startFret: 4, barreChord: 1, default: 0 },
    { name: 'B♭maj7-11', cat: 'Major', frets: 'x 1 2 2 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bmaj7-11', cat: 'Major', frets: 'x 2 3 3 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cmaj7-11', cat: 'Major', frets: 'x 3 2 0 0 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cmaj7-11', cat: 'Major', frets: '8 7 9 9 7 x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'C♯maj7-11', cat: 'Major', frets: 'x 4 3 1 1 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dmaj7-11', cat: 'Major', frets: 'x x 0 1 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dmaj7-11', cat: 'Major', frets: 'x 5 6 6 7 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭maj7-11', cat: 'Major', frets: 'x x 1 2 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Emaj7-11', cat: 'Major', frets: '0 1 1 2 0 4', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Emaj7-11', cat: 'Major', frets: 'x 7 8 8 9 x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fmaj7-11', cat: 'Major', frets: '1 0 3 2 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Fmaj7-11', cat: 'Major', frets: '1 x 2 2 0 x', startFret: 1, barreChord: 1, default: 0 },
    { name: 'F♯maj7-11', cat: 'Major', frets: '2 1 4 3 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gmaj7-11', cat: 'Major', frets: '3 2 0 0 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gmaj7-11', cat: 'Major', frets: '3 2 4 4 2 x', startFret: 2, barreChord: 1, default: 0 },

    { name: 'A♭maj7-13', cat: 'Major', frets: '4 3 3 3 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Amaj7-13', cat: 'Major', frets: 'x 0 2 1 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Amaj7-13', cat: 'Major', frets: '5 x 6 6 7 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭maj7-13', cat: 'Major', frets: 'x 1 3 2 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bmaj7-13', cat: 'Major', frets: 'x 2 4 3 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cmaj7-13', cat: 'Major', frets: 'x 3 2 2 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cmaj7-13', cat: 'Major', frets: '8 x 9 9 10 x', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯maj7-13', cat: 'Major', frets: 'x 4 3 3 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dmaj7-13', cat: 'Major', frets: 'x 5 7 6 7 7', startFret: 4, barreChord: 1, default: 1 },
    { name: 'E♭maj7-13', cat: 'Major', frets: 'x 6 8 7 8 8', startFret: 5, barreChord: 1, default: 1 },
    { name: 'Emaj7-13', cat: 'Major', frets: '0 2 1 1 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Emaj7-13', cat: 'Major', frets: 'x 7 9 8 9 9', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fmaj7-13', cat: 'Major', frets: '1 0 3 2 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Fmaj7-13', cat: 'Major', frets: '1 x 2 2 3 x', startFret: 1, barreChord: 1, default: 0 },
    { name: 'F♯maj7-13', cat: 'Major', frets: '2 1 3 3 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gmaj7-13', cat: 'Major', frets: '3 0 2 4 5 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gmaj7-13', cat: 'Major', frets: '3 x 4 4 5 x', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭6', cat: 'Major', frets: '4 3 1 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A6', cat: 'Major', frets: 'x 0 2 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B♭6', cat: 'Major', frets: 'x 1 3 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B6', cat: 'Major', frets: 'x 2 4 4 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C6', cat: 'Major', frets: 'x 3 2 2 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'C6', cat: 'Major', frets: '8 10 10 9 10 8', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯6', cat: 'Major', frets: 'x 4 3 3 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D6', cat: 'Major', frets: 'x x 0 2 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D6', cat: 'Major', frets: 'x 5 7 7 7 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭6', cat: 'Major', frets: 'x x 1 3 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E6', cat: 'Major', frets: '0 2 2 1 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E6', cat: 'Major', frets: 'x 7 9 9 9 9', startFret: 7, barreChord: 1, default: 0 },
    { name: 'F6', cat: 'Major', frets: 'x x 3 2 3 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'F6', cat: 'Major', frets: '1 3 3 2 3 1', startFret: 1, barreChord: 1, default: 0 },
    { name: 'F♯6', cat: 'Major', frets: 'x x 4 3 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G6', cat: 'Major', frets: '3 2 0 0 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'G6', cat: 'Major', frets: '3 5 5 4 5 3', startFret: 3, barreChord: 1, default: 0 },

    // === DOMINANT FAMILY (IMG_6420)[cite: 13] ===
    { name: 'A♭7', cat: 'Dominant', frets: '4 x 1 1 1 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A7', cat: 'Dominant', frets: 'x 0 2 0 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A7', cat: 'Dominant', frets: '5 7 5 6 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭7', cat: 'Dominant', frets: 'x 1 3 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7', cat: 'Dominant', frets: 'x 2 1 2 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'B7', cat: 'Dominant', frets: '7 9 7 8 7 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'C7', cat: 'Dominant', frets: 'x 3 2 3 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'C7', cat: 'Dominant', frets: '8 10 8 9 8 8', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯7', cat: 'Dominant', frets: 'x 4 x 4 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D7', cat: 'Dominant', frets: 'x x 0 2 1 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D7', cat: 'Dominant', frets: 'x 5 7 5 7 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭7', cat: 'Dominant', frets: 'x x 1 3 2 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E7', cat: 'Dominant', frets: '0 2 0 1 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E7', cat: 'Dominant', frets: 'x 7 9 7 9 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'F7', cat: 'Dominant', frets: '1 3 1 2 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7', cat: 'Dominant', frets: '2 4 2 3 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7', cat: 'Dominant', frets: '3 2 0 0 0 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'G7', cat: 'Dominant', frets: '3 5 3 4 3 3', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭9', cat: 'Dominant', frets: '4 3 4 3 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A9', cat: 'Dominant', frets: 'x 0 2 4 2 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A9', cat: 'Dominant', frets: '5 x 5 6 5 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭9', cat: 'Dominant', frets: '1 3 3 3 3 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B9', cat: 'Dominant', frets: 'x 2 1 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C9', cat: 'Dominant', frets: 'x 3 2 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯9', cat: 'Dominant', frets: 'x 4 3 4 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D9', cat: 'Dominant', frets: 'x 5 4 5 5 5', startFret: 4, barreChord: 1, default: 1 },
    { name: 'E♭9', cat: 'Dominant', frets: 'x 6 5 6 6 6', startFret: 5, barreChord: 1, default: 1 },
    { name: 'E9', cat: 'Dominant', frets: '0 2 0 1 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E9', cat: 'Dominant', frets: 'x 7 6 7 7 7', startFret: 6, barreChord: 1, default: 0 },
    { name: 'F9', cat: 'Dominant', frets: '1 x 1 2 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯9', cat: 'Dominant', frets: '2 x 2 3 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G9', cat: 'Dominant', frets: '3 2 3 2 3 3', startFret: 1, barreChord: 1, default: 1 },

    { name: 'A♭7-11', cat: 'Dominant', frets: '4 3 4 3 3 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A7-11', cat: 'Dominant', frets: 'x 0 0 0 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A7-11', cat: 'Dominant', frets: '5 x 5 6 4 x', startFret: 4, barreChord: 1, default: 0 },
    { name: 'B♭7-11', cat: 'Dominant', frets: 'x 1 1 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7-11', cat: 'Dominant', frets: 'x 2 1 2 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C7-11', cat: 'Dominant', frets: 'x 3 2 3 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯7-11', cat: 'Dominant', frets: 'x 4 3 4 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D7-11', cat: 'Dominant', frets: 'x 5 4 5 5 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'E♭7-11', cat: 'Dominant', frets: 'x 6 5 6 6 5', startFret: 5, barreChord: 1, default: 1 },
    { name: 'E7-11', cat: 'Dominant', frets: '0 0 0 1 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E7-11', cat: 'Dominant', frets: 'x 7 7 7 9 6', startFret: 6, barreChord: 1, default: 0 },
    { name: 'F7-11', cat: 'Dominant', frets: '1 1 1 2 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7-11', cat: 'Dominant', frets: '2 2 2 3 5 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7-11', cat: 'Dominant', frets: '3 2 3 2 2 3', startFret: 1, barreChord: 1, default: 1 },

    { name: 'A♭7-13', cat: 'Dominant', frets: '4 x 4 3 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A7-13', cat: 'Dominant', frets: 'x 0 2 0 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B♭7-13', cat: 'Dominant', frets: 'x 1 3 1 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7-13', cat: 'Dominant', frets: 'x 2 4 2 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C7-13', cat: 'Dominant', frets: 'x 3 5 3 5 5', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯7-13', cat: 'Dominant', frets: '4 2 3 3 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D7-13', cat: 'Dominant', frets: 'x 5 7 5 7 7', startFret: 4, barreChord: 1, default: 1 },
    { name: 'E♭7-13', cat: 'Dominant', frets: 'x 6 8 6 8 8', startFret: 5, barreChord: 1, default: 1 },
    { name: 'E7-13', cat: 'Dominant', frets: '0 2 0 1 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F7-13', cat: 'Dominant', frets: '1 3 1 2 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7-13', cat: 'Dominant', frets: '2 4 2 3 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7-13', cat: 'Dominant', frets: '3 5 3 4 5 x', startFret: 1, barreChord: 1, default: 1 },

    // === MINOR FAMILY (IMG_6421)[cite: 14] ===
    { name: 'A♭m', cat: 'Minor', frets: '4 6 6 4 4 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am', cat: 'Minor', frets: 'x 0 2 2 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am', cat: 'Minor', frets: '5 7 7 5 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭m', cat: 'Minor', frets: 'x 1 3 3 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm', cat: 'Minor', frets: 'x 2 4 4 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm', cat: 'Minor', frets: 'x 3 5 5 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m', cat: 'Minor', frets: 'x 4 6 6 5 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm', cat: 'Minor', frets: 'x x 0 2 3 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dm', cat: 'Minor', frets: 'x 5 7 7 6 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭m', cat: 'Minor', frets: 'x x 1 3 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Em', cat: 'Minor', frets: '0 2 2 0 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em', cat: 'Minor', frets: 'x 7 9 9 8 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fm', cat: 'Minor', frets: '1 3 3 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m', cat: 'Minor', frets: '2 4 4 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm', cat: 'Minor', frets: '3 5 5 3 3 3', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭m6', cat: 'Minor', frets: '4 6 6 4 6 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am6', cat: 'Minor', frets: 'x 0 2 2 1 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am6', cat: 'Minor', frets: '5 7 7 5 7 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭m6', cat: 'Minor', frets: 'x 1 3 3 2 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm6', cat: 'Minor', frets: 'x 2 4 4 3 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm6', cat: 'Minor', frets: 'x 3 5 5 4 5', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m6', cat: 'Minor', frets: 'x 4 6 6 5 6', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm6', cat: 'Minor', frets: 'x x 0 2 0 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dm6', cat: 'Minor', frets: 'x 5 7 7 6 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭m6', cat: 'Minor', frets: 'x x 1 3 1 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Em6', cat: 'Minor', frets: '0 2 2 0 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em6', cat: 'Minor', frets: 'x 7 9 9 8 9', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fm6', cat: 'Minor', frets: '1 3 3 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m6', cat: 'Minor', frets: '2 4 4 2 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm6', cat: 'Minor', frets: '3 5 5 3 5 3', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭m7', cat: 'Minor', frets: '4 6 4 4 4 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am7', cat: 'Minor', frets: 'x 0 2 0 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am7', cat: 'Minor', frets: '5 7 5 5 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭m7', cat: 'Minor', frets: 'x 1 3 1 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm7', cat: 'Minor', frets: 'x 2 4 2 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm7', cat: 'Minor', frets: 'x 3 5 3 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m7', cat: 'Minor', frets: 'x 4 6 4 5 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm7', cat: 'Minor', frets: 'x x 0 2 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E♭m7', cat: 'Minor', frets: 'x x 1 3 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Em7', cat: 'Minor', frets: '0 2 2 0 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em7', cat: 'Minor', frets: 'x 7 9 7 8 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fm7', cat: 'Minor', frets: '1 3 1 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m7', cat: 'Minor', frets: '2 4 2 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm7', cat: 'Minor', frets: '3 5 3 3 3 3', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭m9', cat: 'Minor', frets: '4 6 4 4 4 6', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am9', cat: 'Minor', frets: 'x 0 2 4 1 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am9', cat: 'Minor', frets: '5 7 5 5 5 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭m9', cat: 'Minor', frets: '6 4 x 5 x 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm9', cat: 'Minor', frets: '7 4 7 7 7 7', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm9', cat: 'Minor', frets: 'x 3 1 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m9', cat: 'Minor', frets: 'x 4 2 4 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm9', cat: 'Minor', frets: 'x 5 3 5 5 5', startFret: 3, barreChord: 1, default: 1 },
    { name: 'E♭m9', cat: 'Minor', frets: 'x 6 4 6 6 6', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Em9', cat: 'Minor', frets: '0 2 0 0 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em9', cat: 'Minor', frets: 'x 7 5 7 7 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'Fm9', cat: 'Minor', frets: '1 3 1 1 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m9', cat: 'Minor', frets: '2 4 2 2 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm9', cat: 'Minor', frets: '3 5 3 3 3 5', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭m7-11', cat: 'Minor', frets: '4 4 4 4 4 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am7-11', cat: 'Minor', frets: 'x 0 0 0 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am7-11', cat: 'Minor', frets: '5 x 5 5 3 x', startFret: 3, barreChord: 1, default: 0 },
    { name: 'B♭m7-11', cat: 'Minor', frets: 'x 1 1 1 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm7-11', cat: 'Minor', frets: 'x 2 2 2 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm7-11', cat: 'Minor', frets: 'x 3 3 3 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m7-11', cat: 'Minor', frets: 'x 4 4 4 5 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm7-11', cat: 'Minor', frets: 'x 5 5 5 6 5', startFret: 5, barreChord: 1, default: 1 },
    { name: 'E♭m7-11', cat: 'Minor', frets: 'x 6 6 6 7 6', startFret: 6, barreChord: 1, default: 1 },
    { name: 'Em7-11', cat: 'Minor', frets: '0 0 0 0 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em7-11', cat: 'Minor', frets: 'x 7 7 7 8 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fm7-11', cat: 'Minor', frets: '1 1 1 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m7-11', cat: 'Minor', frets: '2 2 2 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm7-11', cat: 'Minor', frets: '3 3 3 3 3 3', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭m7-13', cat: 'Minor', frets: '4 6 4 4 6 6', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Am7-13', cat: 'Minor', frets: 'x 0 2 0 1 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Am7-13', cat: 'Minor', frets: '5 x 5 5 7 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭m7-13', cat: 'Minor', frets: 'x 1 3 1 2 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bm7-13', cat: 'Minor', frets: 'x 2 4 2 3 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cm7-13', cat: 'Minor', frets: 'x 3 5 3 4 5', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯m7-13', cat: 'Minor', frets: 'x 4 6 4 5 6', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dm7-13', cat: 'Minor', frets: 'x 5 5 5 6 7', startFret: 3, barreChord: 1, default: 1 },
    { name: 'E♭m7-13', cat: 'Minor', frets: 'x 6 6 6 7 8', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Em7-13', cat: 'Minor', frets: '0 2 0 0 2 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Em7-13', cat: 'Minor', frets: 'x 7 7 7 8 9', startFret: 6, barreChord: 1, default: 0 },
    { name: 'Fm7-13', cat: 'Minor', frets: '1 3 1 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯m7-13', cat: 'Minor', frets: '2 4 2 2 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gm7-13', cat: 'Minor', frets: '3 5 3 3 5 5', startFret: 3, barreChord: 1, default: 1 },

    // === DIMINISHED & AUGMENTED (IMG_6421)[cite: 14] ===
    { name: 'A♭dim', cat: 'Dim/Aug', frets: '4 5 6 4 x x', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Adim', cat: 'Dim/Aug', frets: 'x 0 1 2 1 x', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Adim', cat: 'Dim/Aug', frets: '5 6 7 5 x x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭dim', cat: 'Dim/Aug', frets: 'x 1 2 3 2 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bdim', cat: 'Dim/Aug', frets: 'x 2 3 4 3 x', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Bdim', cat: 'Dim/Aug', frets: '7 8 9 7 x x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Cdim', cat: 'Dim/Aug', frets: 'x 3 4 5 4 x', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cdim', cat: 'Dim/Aug', frets: '8 9 10 8 x x', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯dim', cat: 'Dim/Aug', frets: 'x 4 5 6 5 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Ddim', cat: 'Dim/Aug', frets: 'x x 0 1 3 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Ddim', cat: 'Dim/Aug', frets: 'x 5 6 7 6 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭dim', cat: 'Dim/Aug', frets: 'x x 1 2 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Edim', cat: 'Dim/Aug', frets: '0 1 2 0 x x', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Edim', cat: 'Dim/Aug', frets: 'x 7 8 9 8 x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fdim', cat: 'Dim/Aug', frets: '1 2 3 1 x x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯dim', cat: 'Dim/Aug', frets: '2 3 4 2 x x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gdim', cat: 'Dim/Aug', frets: '3 4 5 3 x x', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭dim7', cat: 'Dim/Aug', frets: '4 5 6 4 6 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Adim7', cat: 'Dim/Aug', frets: 'x 0 1 2 1 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Adim7', cat: 'Dim/Aug', frets: '5 6 7 5 7 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭dim7', cat: 'Dim/Aug', frets: 'x 1 2 3 2 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bdim7', cat: 'Dim/Aug', frets: 'x 2 3 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cdim7', cat: 'Dim/Aug', frets: 'x 3 4 2 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯dim7', cat: 'Dim/Aug', frets: 'x 4 5 3 5 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Ddim7', cat: 'Dim/Aug', frets: 'x x 0 1 0 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Ddim7', cat: 'Dim/Aug', frets: 'x 5 6 4 6 4', startFret: 4, barreChord: 1, default: 0 },
    { name: 'E♭dim7', cat: 'Dim/Aug', frets: 'x x 1 2 1 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Edim7', cat: 'Dim/Aug', frets: '0 1 2 0 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Edim7', cat: 'Dim/Aug', frets: 'x 7 8 6 8 6', startFret: 6, barreChord: 1, default: 0 },
    { name: 'Fdim7', cat: 'Dim/Aug', frets: '1 2 3 1 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯dim7', cat: 'Dim/Aug', frets: '2 3 4 2 4 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gdim7', cat: 'Dim/Aug', frets: '3 4 5 3 5 3', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭aug', cat: 'Dim/Aug', frets: '4 x 2 1 1 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Aaug', cat: 'Dim/Aug', frets: 'x 0 3 2 2 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Aaug', cat: 'Dim/Aug', frets: '5 8 7 6 x x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭aug', cat: 'Dim/Aug', frets: 'x 1 4 3 3 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Baug', cat: 'Dim/Aug', frets: 'x 2 1 0 0 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Baug', cat: 'Dim/Aug', frets: '7 10 9 8 x x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Caug', cat: 'Dim/Aug', frets: 'x 3 2 1 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Caug', cat: 'Dim/Aug', frets: '8 11 10 9 x x', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯aug', cat: 'Dim/Aug', frets: 'x 4 3 2 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Daug', cat: 'Dim/Aug', frets: 'x x 0 3 3 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Daug', cat: 'Dim/Aug', frets: 'x 5 4 3 3 x', startFret: 3, barreChord: 1, default: 0 },
    { name: 'E♭aug', cat: 'Dim/Aug', frets: 'x x 1 4 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Eaug', cat: 'Dim/Aug', frets: '0 3 2 1 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Eaug', cat: 'Dim/Aug', frets: 'x 7 6 5 5 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'Faug', cat: 'Dim/Aug', frets: '1 x 3 2 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯aug', cat: 'Dim/Aug', frets: '2 x 4 3 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gaug', cat: 'Dim/Aug', frets: '3 x 1 0 0 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gaug', cat: 'Dim/Aug', frets: '3 6 5 4 x x', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭7(-5)', cat: 'Dim/Aug', frets: '4 3 4 x 3 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'A7(-5)', cat: 'Dim/Aug', frets: 'x 0 1 0 2 x', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A7(-5)', cat: 'Dim/Aug', frets: '5 6 7 6 8 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭7(-5)', cat: 'Dim/Aug', frets: 'x 1 2 1 3 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7(-5)', cat: 'Dim/Aug', frets: 'x 2 1 2 0 1', startFret: 1, barreChord: 0, default: 1 },
    { name: 'B7(-5)', cat: 'Dim/Aug', frets: '7 8 9 8 10 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'C7(-5)', cat: 'Dim/Aug', frets: 'x 3 4 3 5 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'C7(-5)', cat: 'Dim/Aug', frets: '8 9 10 9 11 8', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯7(-5)', cat: 'Dim/Aug', frets: 'x 4 3 4 x 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D7(-5)', cat: 'Dim/Aug', frets: 'x x 0 1 1 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D7(-5)', cat: 'Dim/Aug', frets: 'x 5 6 5 7 x', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭7(-5)', cat: 'Dim/Aug', frets: 'x x 1 2 2 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E7(-5)', cat: 'Dim/Aug', frets: '0 1 0 1 x 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E7(-5)', cat: 'Dim/Aug', frets: 'x 7 8 7 9 x', startFret: 7, barreChord: 1, default: 0 },
    { name: 'F7(-5)', cat: 'Dim/Aug', frets: '1 2 1 2 x x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7(-5)', cat: 'Dim/Aug', frets: '2 3 2 3 x x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7(-5)', cat: 'Dim/Aug', frets: '3 2 3 x 2 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'G7(-5)', cat: 'Dim/Aug', frets: '3 4 5 4 6 3', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭6/9', cat: 'Major', frets: '4 3 3 3 4 4', startFret: 3, barreChord: 1, default: 1 },
    { name: 'A6/9', cat: 'Major', frets: '5 2 2 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B♭6/9', cat: 'Major', frets: '6 3 3 3 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B6/9', cat: 'Major', frets: 'x 2 1 1 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C6/9', cat: 'Major', frets: 'x 3 2 2 3 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯6/9', cat: 'Major', frets: 'x 4 3 3 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'D6/9', cat: 'Major', frets: 'x 5 4 2 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D6/9', cat: 'Major', frets: 'x 5 4 4 5 5', startFret: 4, barreChord: 1, default: 0 },
    { name: 'E♭6/9', cat: 'Major', frets: 'x 6 3 5 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E6/9', cat: 'Major', frets: '0 2 2 1 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F6/9', cat: 'Major', frets: 'x 8 7 7 8 8', startFret: 7, barreChord: 1, default: 1 },
    { name: 'F♯6/9', cat: 'Major', frets: 'x 9 8 8 9 9', startFret: 8, barreChord: 1, default: 1 },
    { name: 'G6/9', cat: 'Major', frets: '3 2 2 2 3 3', startFret: 2, barreChord: 1, default: 1 },

    // === SUSPENDED & ADD FAMILY (IMG_6421)[cite: 14] ===
    { name: 'A♭sus2', cat: 'Suspended', frets: '4 1 1 1 x x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Asus2', cat: 'Suspended', frets: 'x 0 2 2 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Asus2', cat: 'Suspended', frets: '5 7 7 x 5 7', startFret: 4, barreChord: 1, default: 0 },
    { name: 'B♭sus2', cat: 'Suspended', frets: 'x 1 3 3 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bsus2', cat: 'Suspended', frets: 'x 2 4 4 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Csus2', cat: 'Suspended', frets: 'x 3 0 0 1 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Csus2', cat: 'Suspended', frets: '8 10 10 x 8 10', startFret: 7, barreChord: 1, default: 0 },
    { name: 'C♯sus2', cat: 'Suspended', frets: 'x 4 1 1 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dsus2', cat: 'Suspended', frets: 'x x 0 2 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dsus2', cat: 'Suspended', frets: 'x 5 7 7 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭sus2', cat: 'Suspended', frets: 'x x 1 3 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Esus2', cat: 'Suspended', frets: '0 2 4 4 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Esus2', cat: 'Suspended', frets: 'x 7 9 9 7 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'Fsus2', cat: 'Suspended', frets: 'x 3 3 0 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯sus2', cat: 'Suspended', frets: 'x 4 4 1 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gsus2', cat: 'Suspended', frets: '3 0 0 0 3 3', startFret: 1, barreChord: 1, default: 1 },

    { name: 'A♭sus4', cat: 'Suspended', frets: '4 4 1 1 2 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Asus4', cat: 'Suspended', frets: 'x 0 2 2 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Asus4', cat: 'Suspended', frets: '5 7 7 7 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭sus4', cat: 'Suspended', frets: 'x 1 3 3 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bsus4', cat: 'Suspended', frets: 'x 2 4 4 5 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Csus4', cat: 'Suspended', frets: 'x 3 3 0 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C♯sus4', cat: 'Suspended', frets: 'x 4 4 1 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dsus4', cat: 'Suspended', frets: 'x x 0 2 3 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dsus4', cat: 'Suspended', frets: 'x 5 7 7 8 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭sus4', cat: 'Suspended', frets: 'x x 1 3 4 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Esus4', cat: 'Suspended', frets: '0 2 2 2 0 0', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Fsus4', cat: 'Suspended', frets: '1 3 3 3 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯sus4', cat: 'Suspended', frets: '2 4 4 4 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gsus4', cat: 'Suspended', frets: '3 3 0 0 1 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gsus4', cat: 'Suspended', frets: '3 5 5 5 3 3', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭7sus2', cat: 'Suspended', frets: '4 x 4 3 4 4', startFret: 3, barreChord: 1, default: 1 },
    { name: 'A7sus2', cat: 'Suspended', frets: 'x 0 2 0 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A7sus2', cat: 'Suspended', frets: '5 x 5 4 5 5', startFret: 4, barreChord: 1, default: 0 },
    { name: 'B♭7sus2', cat: 'Suspended', frets: 'x 1 3 1 1 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7sus2', cat: 'Suspended', frets: 'x 2 4 2 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C7sus2', cat: 'Suspended', frets: 'x 3 5 3 3 3', startFret: 3, barreChord: 1, default: 1 },
    { name: 'C♯7sus2', cat: 'Suspended', frets: 'x 4 6 4 4 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'D7sus2', cat: 'Suspended', frets: 'x x 0 2 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D7sus2', cat: 'Suspended', frets: 'x 5 7 5 5 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭7sus2', cat: 'Suspended', frets: 'x x 1 3 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E7sus2', cat: 'Suspended', frets: 'x x 2 4 3 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F7sus2', cat: 'Suspended', frets: '1 3 1 x 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7sus2', cat: 'Suspended', frets: '2 4 2 x 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7sus2', cat: 'Suspended', frets: '3 x 3 2 3 3', startFret: 2, barreChord: 1, default: 1 },

    { name: 'A♭7sus4', cat: 'Suspended', frets: '4 6 4 6 4 x', startFret: 4, barreChord: 1, default: 1 },
    { name: 'A7sus4', cat: 'Suspended', frets: 'x 0 2 0 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'A7sus4', cat: 'Suspended', frets: '5 5 5 7 8 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭7sus4', cat: 'Suspended', frets: 'x 1 3 1 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'B7sus4', cat: 'Suspended', frets: 'x 2 4 2 5 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'C7sus4', cat: 'Suspended', frets: 'x 3 3 3 6 3', startFret: 3, barreChord: 1, default: 1 },
    { name: 'C♯7sus4', cat: 'Suspended', frets: 'x 4 4 4 7 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'D7sus4', cat: 'Suspended', frets: 'x x 0 2 1 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'D7sus4', cat: 'Suspended', frets: 'x 5 7 5 8 5', startFret: 5, barreChord: 1, default: 0 },
    { name: 'E♭7sus4', cat: 'Suspended', frets: 'x x 1 3 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'E7sus4', cat: 'Suspended', frets: '0 2 0 2 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'E7sus4', cat: 'Suspended', frets: 'x 7 9 7 10 7', startFret: 7, barreChord: 1, default: 0 },
    { name: 'F7sus4', cat: 'Suspended', frets: '1 3 1 3 1 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯7sus4', cat: 'Suspended', frets: '2 4 2 4 2 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'G7sus4', cat: 'Suspended', frets: '3 5 3 5 3 x', startFret: 3, barreChord: 1, default: 1 },

    { name: 'A♭add9', cat: 'Major', frets: '4 1 1 3 1 x', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Aadd9', cat: 'Major', frets: 'x 0 2 4 2 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Aadd9', cat: 'Major', frets: '5 7 7 6 5 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭add9', cat: 'Major', frets: 'x 1 3 5 3 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Badd9', cat: 'Major', frets: 'x 2 1 x 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cadd9', cat: 'Major', frets: 'x 3 2 0 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Cadd9', cat: 'Major', frets: '8 10 10 9 8 10', startFret: 8, barreChord: 1, default: 0 },
    { name: 'C♯add9', cat: 'Major', frets: 'x 4 1 1 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Dadd9', cat: 'Major', frets: 'x x 0 2 5 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dadd9', cat: 'Major', frets: 'x 5 2 2 5 2', startFret: 2, barreChord: 1, default: 0 },
    { name: 'E♭add9', cat: 'Major', frets: 'x 1 3 3 4 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Eadd9', cat: 'Major', frets: '0 2 4 1 0 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Eadd9', cat: 'Major', frets: 'x 7 4 4 7 4', startFret: 4, barreChord: 1, default: 0 },
    { name: 'Fadd9', cat: 'Major', frets: 'x 8 5 5 6 5', startFret: 5, barreChord: 1, default: 1 },
    { name: 'F♯add9', cat: 'Major', frets: 'x 9 6 6 7 6', startFret: 6, barreChord: 1, default: 1 },
    { name: 'Gadd9', cat: 'Major', frets: '3 0 0 2 0 3', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Gadd9', cat: 'Major', frets: '3 5 5 4 3 5', startFret: 3, barreChord: 1, default: 0 },

    { name: 'A♭madd9', cat: 'Minor', frets: '4 6 6 4 4 6', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Amadd9', cat: 'Minor', frets: 'x 0 2 4 1 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Amadd9', cat: 'Minor', frets: '5 7 7 5 5 7', startFret: 5, barreChord: 1, default: 0 },
    { name: 'B♭madd9', cat: 'Minor', frets: 'x 1 x 5 2 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Bmadd9', cat: 'Minor', frets: '2 5 4 4 2 2', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Cmadd9', cat: 'Minor', frets: '3 6 5 5 3 3', startFret: 3, barreChord: 1, default: 1 },
    { name: 'C♯madd9', cat: 'Minor', frets: '4 7 6 6 4 4', startFret: 4, barreChord: 1, default: 1 },
    { name: 'Dmadd9', cat: 'Minor', frets: 'x 5 3 x 3 0', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Dmadd9', cat: 'Minor', frets: 'x 5 3 x 5 5', startFret: 2, barreChord: 1, default: 0 },
    { name: 'E♭madd9', cat: 'Minor', frets: 'x 1 4 x 4 1', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Emadd9', cat: 'Minor', frets: '0 2 4 0 0 2', startFret: 1, barreChord: 0, default: 1 },
    { name: 'Emadd9', cat: 'Minor', frets: 'x 7 5 x 7 7', startFret: 4, barreChord: 1, default: 0 },
    { name: 'Fmadd9', cat: 'Minor', frets: '1 3 3 1 1 3', startFret: 1, barreChord: 1, default: 1 },
    { name: 'F♯madd9', cat: 'Minor', frets: '2 4 4 2 2 4', startFret: 1, barreChord: 1, default: 1 },
    { name: 'Gmadd9', cat: 'Minor', frets: '3 5 5 3 3 5', startFret: 3, barreChord: 1, default: 1 }
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
 * Work out which fingers have to lie across several strings. A fret shared by strings with a
 * higher-fretted string between them is always barred (the finger bridges the gap, as in D major).
 * With four or more fretted notes every finger is in use, so the index finger also bars the lowest
 * fret, and with more than four notes the next frets are barred until four fingers are enough. A bar only passes over strings fretted higher up or muted,
 * never over a string that is open or held at a lower fret, so a fret shared by strings on both sides
 * of such a string is split into separate bars.
 * Returns [{ fret, strings: [indices into the frets array] }].
 */
function findFingerBars(frets) {
    const fretNumbers = frets.map(f => parseInt(f, 10));
    const groups = new Map();
    fretNumbers.forEach((fret, i) => {
        if (fret > 0) groups.set(fret, [...(groups.get(fret) || []), i]);
    });
    const totalNotes = [...groups.values()].reduce((sum, strings) => sum + strings.length, 0);
    const sortedFrets = [...groups.keys()].sort((a, b) => a - b);
    let fingersNeeded = totalNotes;
    const bars = [];
    for (const fret of sortedFrets) {
        const isIndexFret = fret === sortedFrets[0];
        const runs = [];
        for (const string of groups.get(fret)) {
            const run = runs[runs.length - 1];
            const blocked = run && fretNumbers.slice(run[run.length - 1] + 1, string).some(other => other < fret);
            if (run && !blocked) run.push(string);
            else runs.push([string]);
        }
        for (const strings of runs) {
            if (strings.length < 2) continue;
            const bridgesHigherFret = fretNumbers.slice(strings[0] + 1, strings[strings.length - 1]).some(other => other > fret);
            if (bridgesHigherFret || (totalNotes >= 4 && isIndexFret) || fingersNeeded > 4) {
                bars.push({ fret, strings });
                fingersNeeded -= strings.length - 1;
            }
        }
    }
    return bars;
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
    const capoOn = Boolean(chordOrFrets && typeof chordOrFrets === 'object' && chordOrFrets.shapeOf);
    if (typeof chordOrFrets === 'string') {
        fretsStr = chordOrFrets;
    } else if (chordOrFrets && typeof chordOrFrets === 'object') {
        fretsStr = chordOrFrets.frets || '';
        startFret = chordOrFrets.startFret || explicitStartFret || 1;
    }

    const frets = fretsStr.trim().split(/\s+/);
    const numStrings = Math.max(6, frets.length);
    const lastString = numStrings - 1;
    const startY = 14; // High e string y position (or Low E when flipped)
    const stringGap = 10;
    const stringNamesNormal = getStringLabelsHighToLow().slice(0, numStrings);
    const stringNamesFlipped = [...stringNamesNormal].reverse();
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
    const fretNumY = startY + lastString * stringGap + 12;
    const height = fretNumY + 6;

    const fingerBars = findFingerBars(frets);
    const buildBarsSvg = fretX => fingerBars.map(bar => {
        const relativeFret = bar.fret - baseFret + 1;
        if (relativeFret < 1 || relativeFret > numFrets) return '';
        const rows = bar.strings.map(i => isFlipped ? i : (lastString - i));
        const y1 = startY + Math.min(...rows) * stringGap;
        const y2 = startY + Math.max(...rows) * stringGap;
        return `<rect class="ref-chord-barre" x="${fretX(relativeFret) - 4.5}" y="${y1 - 4.5}" width="9" height="${y2 - y1 + 9}" rx="4.5" fill="var(--accent-primary)" fill-opacity="0.3" stroke="var(--accent-primary)" stroke-opacity="0.55" stroke-width="1.2" />`;
    }).join('');

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="ref-chord-diagram-svg" style="aspect-ratio: ${width} / ${height}" aria-hidden="true">`;

    if (!isLeftHanded) {
        const startX = 30; // Nut x position

        // Nut (vertical line)
        svg += `<line x1="${startX}" y1="${startY}" x2="${startX}" y2="${startY + lastString * stringGap}" stroke="${baseFret === 1 ? (capoOn ? 'var(--accent-primary)' : 'var(--text-primary)') : 'var(--border-prominent)'}" stroke-width="${baseFret === 1 ? (capoOn ? 5 : 3.5) : 1.8}" stroke-linecap="round"/>`;

        // Fret wire lines (vertical)
        for (let f = 1; f <= numFrets; f++) {
            const x = startX + f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + lastString * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Horizontal string lines and string indicators on the left
        for (let s = 0; s < numStrings; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((lastString - s) * 0.22) : 1 + (s * 0.22);
            // String line
            svg += `<line x1="${startX}" y1="${y}" x2="${startX + boardWidth}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"/>`;

            // String name label at far left
            svg += `<text x="8" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle">${stringNames[s]}</text>`;

            // Corresponding original string in frets array:
            // Standard Tab: s=0 is High e (frets[5]), s=5 is Low E (frets[0])
            // Inverted Player: s=0 is Low E (frets[0]), s=5 is High e (frets[5])
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex] || 'x';

            // Indicator at x=20 (between string letter and nut)
            if (f.toLowerCase() === 'x') {
                svg += `<text x="20" y="${y + 3.5}" fill="#ef4444" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="20" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        // Bars for fingers that lie across several strings (drawn faintly under the dots), then the pressed note dots
        svg += buildBarsSvg(relativeFret => startX + (relativeFret - 0.5) * fretGap);
        for (let s = 0; s < numStrings; s++) {
            const origStringIndex = isFlipped ? s : (lastString - s);
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
            svg += `<text x="${x}" y="${fretNumY}" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
        }

        // Base fret badge above fret 1 if shifted
        if (baseFret > 1) {
            svg += `<text x="${startX + (0.5 * fretGap)}" y="8" fill="var(--accent-text)" font-size="8.5" font-weight="bold" text-anchor="middle">${baseFret}fr</text>`;
        }
    } else {
        // Left-handed: Nut on right, frets extending to the left
        const nutX = width - 30; // board extends from 12 to nutX

        // Nut (vertical line)
        svg += `<line x1="${nutX}" y1="${startY}" x2="${nutX}" y2="${startY + lastString * stringGap}" stroke="${baseFret === 1 ? (capoOn ? 'var(--accent-primary)' : 'var(--text-primary)') : 'var(--border-prominent)'}" stroke-width="${baseFret === 1 ? (capoOn ? 5 : 3.5) : 1.8}" stroke-linecap="round"/>`;

        // Fret wire lines (vertical)
        for (let f = 1; f <= numFrets; f++) {
            const x = nutX - f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + lastString * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Horizontal string lines and string indicators on the right
        for (let s = 0; s < numStrings; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((lastString - s) * 0.22) : 1 + (s * 0.22);
            // String line
            svg += `<line x1="12" y1="${y}" x2="${nutX}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"/>`;

            // String name label at far right
            svg += `<text x="${nutX + 22}" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle">${stringNames[s]}</text>`;

            // Corresponding original string in frets array
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex] || 'x';

            // Indicator at nutX + 10 (between nut and string letter)
            if (f.toLowerCase() === 'x') {
                svg += `<text x="${nutX + 10}" y="${y + 3.5}" fill="#ef4444" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="${nutX + 10}" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        // Bars for fingers that lie across several strings (drawn faintly under the dots), then the pressed note dots
        svg += buildBarsSvg(relativeFret => nutX - (relativeFret - 0.5) * fretGap);
        for (let s = 0; s < numStrings; s++) {
            const origStringIndex = isFlipped ? s : (lastString - s);
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
            svg += `<text x="${x}" y="${fretNumY}" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
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
    const boardHeight = (stringCount - 1) * stringSpacing;
    const startY = 38;
    const boardWidth = numFrets * fretWidth; // 840
    const totalWidth = 66 + boardWidth + 30; // 936
    const totalHeight = startY + boardHeight + 32; // 230 with six strings

    // Standard strings: Index 0 is high e, Index 5 is low E (standard tablature)
    const tuningSpec = tuningSpecs[stringCount];
    const openStringNames = getStringLabelsHighToLow();
    const standardStrings = openStringNames.map((name, i) => {
        const step = tuningSpec.steps[stringCount - 1 - i];
        return { name, tuning: (tuningSpec.low + step - getTuningOffset() + 120) % 12, gauge: 1 + 0.35 * (stringCount - 1 - i) };
    });
    const visualStrings = isFlipped ? [...standardStrings].reverse() : standardStrings;

    let svg = `<svg viewBox="0 0 ${totalWidth} ${totalHeight}" class="ref-fretboard-svg" style="min-width: 840px;" aria-label="Interactive Scale Fretboard">`;

    if (!isLeftHanded) {
        const startX = 66; // Nut x position

        // Fretboard body
        svg += `<rect x="${startX}" y="${startY}" width="${boardWidth}" height="${boardHeight}" fill="var(--bg-elevated)" rx="4" stroke="var(--border-subtle)" stroke-width="1" />`;

        // Position inlay dots
        [3, 5, 7, 9, 12, 15].forEach(f => {
            const cx = startX + (f - 0.5) * fretWidth;
            if (f === 12) {
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2 - stringSpacing}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2 + stringSpacing}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            } else if (f <= numFrets) {
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            }
        });

        // Fret lines & numbers
        for (let f = 0; f <= numFrets; f++) {
            const x = startX + (f * fretWidth);
            const isNut = f === 0;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + boardHeight}" stroke="${isNut ? 'var(--text-primary)' : 'var(--border-subtle)'}" stroke-width="${isNut ? 5 : 1.5}" stroke-linecap="round"/>`;
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
        svg += `<rect x="${boardStartX}" y="${startY}" width="${boardWidth}" height="${boardHeight}" fill="var(--bg-elevated)" rx="4" stroke="var(--border-subtle)" stroke-width="1" />`;

        // Position inlay dots
        [3, 5, 7, 9, 12, 15].forEach(f => {
            const cx = nutX - (f - 0.5) * fretWidth;
            if (f === 12) {
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2 - stringSpacing}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2 + stringSpacing}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            } else if (f <= numFrets) {
                svg += `<circle cx="${cx}" cy="${startY + boardHeight / 2}" r="4.5" fill="var(--border-prominent)" opacity="0.6"/>`;
            }
        });

        // Fret lines & numbers
        for (let f = 0; f <= numFrets; f++) {
            const x = nutX - (f * fretWidth);
            const isNut = f === 0;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + boardHeight}" stroke="${isNut ? 'var(--text-primary)' : 'var(--border-subtle)'}" stroke-width="${isNut ? 5 : 1.5}" stroke-linecap="round"/>`;
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
 * Render the selected key's info panel (key signature + diatonic chords).
 * Major-key chords link to the Chord Library.
 */
function renderCircleInfoPanel() {
    const data = circleData[selectedCircleIndex];

    const majorChordsHtml = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'].map((deg, i) => `
        <button type="button" class="ref-chord-deg-card ref-chord-link" data-chord="${data.majorChords[i]}" title="Show ${data.majorChords[i]} in the Chord Library">
            <span class="ref-deg-label">${deg}</span>
            <span class="ref-deg-chord">${data.majorChords[i]}</span>
        </button>
    `).join('');

    const minorChordsHtml = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'].map((deg, i) => `
        <button type="button" class="ref-chord-deg-card ref-chord-link" data-chord="${data.minorChords[i]}" title="Show ${data.minorChords[i]} in the Chord Library">
            <span class="ref-deg-label">${deg}</span>
            <span class="ref-deg-chord">${data.minorChords[i]}</span>
        </button>
    `).join('');

    return `
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

/**
 * Render Circle of Fifths Section
 */
function renderCircleSection() {
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
            ${renderCircleInfoPanel()}
        </div>
    </div>
    `;
}

const chordRootFilters = ['A♭', 'A', 'B♭', 'B', 'C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G'];
// Circle of fifths spellings that the chord library files under another name
const chordRootAliases = { 'D♭': 'C♯', 'D♯': 'E♭', 'G♭': 'F♯', 'G♯': 'A♭', 'A♯': 'B♭', 'E♯': 'F', 'B♯': 'C', 'C♭': 'B', 'F♭': 'E' };

/** Semitones the strings are tuned down for the current string count (0 when the stored choice isn't offered). */
function getTuningOffset() {
    return tuningSpecs[stringCount].offsets.includes(tuningOffset) ? tuningOffset : 0;
}

/** Open-string note names from the lowest string up, e.g. ['E', 'A', 'D', 'G', 'B', 'E'] or ['E♭', 'A♭', ...]. */
function getOpenStringNames(offset = getTuningOffset()) {
    const spec = tuningSpecs[stringCount];
    const names = offset !== 0 && !sharpTuningOffsets.includes(offset) ? flatNames : sharpNames;
    return spec.steps.map(step => names[(spec.low + step - offset + 120) % 12]);
}

/** String labels for the diagrams, highest string first. The top string of a standard tuning is shown as 'e'. */
function getStringLabelsHighToLow() {
    const names = getOpenStringNames();
    if (getTuningOffset() === 0) names[names.length - 1] = 'e';
    return names.reverse();
}

function buildTuningButtonsHtml() {
    const current = getTuningOffset();
    return tuningSpecs[stringCount].offsets.map(offset => `
            <button type="button" class="btn btn-sm ${current === offset ? 'btn-theme-primary' : 'btn-theme-outline'} ref-tuning-btn" data-offset="${offset}" title="${offset === 0 ? 'Standard tuning' : `Standard tuning, ${offset} semitone${offset === 1 ? '' : 's'} down`}">
                ${getOpenStringNames(offset)[0]}
            </button>
        `).join('');
}

function buildCapoButtonsHtml() {
    return capoFrets.map(fret => `
            <button type="button" class="btn btn-sm ${capo === fret ? 'btn-theme-primary' : 'btn-theme-outline'} ref-capo-btn" data-capo="${fret}" title="${fret === 0 ? 'No capo' : `Capo on fret ${fret}`}">
                ${fret === 0 ? 'None' : fret}
            </button>
        `).join('');
}

function buildStringCountButtonsHtml() {
    return [6, 7, 8].map(n => `
            <button type="button" class="btn btn-sm ${stringCount === n ? 'btn-theme-primary' : 'btn-theme-outline'} ref-strings-btn" data-strings="${n}">
                ${n}
            </button>
        `).join('');
}

function getActiveChordData() {
    const source = stringCount === 7 ? chordData7 : stringCount === 8 ? chordData8 : chordData;
    // A capo raises the open strings like tuning up, so it cancels out the tuned-down semitones
    const offset = getTuningOffset() - capo;
    if (offset === 0 && capo === 0) return source;

    // Tuned down by `offset`, chord X sounds with the standard-tuning shape of the chord `offset` semitones higher
    const rootPitch = Object.fromEntries(chordRootFilters.map(name => [name, sharpNames.indexOf(name) >= 0 ? sharpNames.indexOf(name) : flatNames.indexOf(name)]));
    const rootByPitch = Object.fromEntries(chordRootFilters.map(name => [rootPitch[name], name]));
    const suffixOrder = [];
    const shifted = source.map(chord => {
        const [, root, suffix] = chord.name.match(/^([A-G][♯♭]?)(.*)$/);
        if (!suffixOrder.includes(suffix)) suffixOrder.push(suffix);
        const soundingPitch = (rootPitch[root] - offset + 120) % 12;
        const name = rootByPitch[soundingPitch] + suffix;
        // With a capo the chord is played as the shape of the chord `capo` semitones lower
        const shapeOf = capo > 0 ? rootByPitch[(soundingPitch - capo + 120) % 12] + suffix : undefined;
        return { ...chord, name, suffix, shapeOf };
    });
    // Keep each chord type together, with roots in the same order as the standard-tuning list
    shifted.sort((a, b) => suffixOrder.indexOf(a.suffix) - suffixOrder.indexOf(b.suffix)
        || chordRootFilters.indexOf(a.name.slice(0, a.name.length - a.suffix.length)) - chordRootFilters.indexOf(b.name.slice(0, b.name.length - b.suffix.length)));
    return shifted;
}

/**
 * Render Chord Reference Library Section
 */
function renderChordsSection() {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();
    const filters = ['all', 'Major', 'Dominant', 'Minor', 'Dim/Aug', 'Suspended'];
    const rootFilters = ['all', ...chordRootFilters];

    const activeChordData = getActiveChordData();
    const displayedChords = activeChordData.filter(chord => {
        if (!preferBarreChords) return chord.default === 1;
        if (chord.barreChord === 1) {
            return chord.default === 1 || activeChordData.some(c => c.name === chord.name && c.cat === chord.cat && c.default === 1 && c.barreChord === 0);
        }
        return chord.default === 1 && !activeChordData.some(c => c.name === chord.name && c.cat === chord.cat && c.barreChord === 1);
    });

    const filteredChords = displayedChords.filter(chord => {
        const matchesCategory = selectedChordFilter === 'all' || chord.cat === selectedChordFilter;
        const chordRoot = chord.name.match(/^[A-G][♯♭]?/)?.[0] || '';
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

    const stringCountButtonsHtml = buildStringCountButtonsHtml();

    const chordCardsHtml = filteredChords.length > 0 ? filteredChords.map(chord => `
        <div class="col">
            <div class="ref-chord-card">
                <div class="ref-chord-card-header">
                    <span class="ref-chord-name">${chord.name}</span>
                    <span class="ref-chord-cat">${chord.cat}${chord.shapeOf ? ` • ${chord.shapeOf} shape` : ''}</span>
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
                    <button type="button" class="btn btn-sm theme-control-btn ref-control-btn ${preferBarreChords ? 'active' : ''}" id="refChordBarreBtn" title="Prefer Barre Chords" aria-label="Prefer Barre Chords" aria-pressed="${preferBarreChords}">
                        <i class="bi bi-distribute-vertical"></i>
                        <span class="d-none d-sm-inline ms-1 small">Prefer Barre Chords</span>
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

                <!-- String Count -->
                <div class="ref-filter-group">
                    <span class="ref-filter-group-label">Strings:</span>
                    <div class="d-flex flex-wrap gap-1 ref-string-filters">
                        ${stringCountButtonsHtml}
                    </div>
                </div>

                <!-- Tuning -->
                <div class="ref-filter-group">
                    <span class="ref-filter-group-label">Tuning:</span>
                    <div class="d-flex flex-wrap gap-1 ref-tuning-filters">
                        ${buildTuningButtonsHtml()}
                    </div>
                </div>

                <!-- Capo -->
                <div class="ref-filter-group">
                    <span class="ref-filter-group-label">Capo:</span>
                    <div class="d-flex flex-wrap gap-1 ref-capo-filters">
                        ${buildCapoButtonsHtml()}
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
    const stringLabels = getStringLabelsHighToLow();
    const tuningLabel = getTuningOffset() === 0 ? 'standard tuning' : `${getOpenStringNames()[0]} standard tuning`;

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
                <div>
                    <span class="ref-select-label d-block">Strings</span>
                    <div class="d-flex gap-1 ref-string-filters">
                        ${buildStringCountButtonsHtml()}
                    </div>
                </div>
                <div>
                    <span class="ref-select-label d-block">Tuning</span>
                    <div class="d-flex flex-wrap gap-1 ref-tuning-filters">
                        ${buildTuningButtonsHtml()}
                    </div>
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
            <span class="small text-muted d-none d-sm-inline">15 frets • ${stringCount}-string ${tuningLabel} (${(isFlipped ? [...stringLabels].reverse() : stringLabels).join(' ')})</span>
        </div>
    </div>
    `;
}

// -----------------------------------------------------------------------------
// Main View Export
// -----------------------------------------------------------------------------

// --- Reference modal: opens over any view (song, library, tuner closed) ---------------------------

const REFERENCE_TABS = ['circle', 'chords', 'scales'];
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
              <div class="small text-white-50">Chords, scales and circle of fifths</div>
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
        { id: 'circle', label: 'Circle of Fifths', icon: 'bi-circle-half' }
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
    attachCircleSliceListeners();
    attachCircleChordLinks(container);

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

    const barreBtn = [...container.querySelectorAll('#refChordBarreBtn')].find(b => !b.closest('#refCircleInfoPanel'));
    if (barreBtn) {
        barreBtn.addEventListener('click', () => {
            preferBarreChords = !preferBarreChords;
            try { localStorage.setItem('majestictab_prefer_barre_chords', String(preferBarreChords)); } catch (_) {}
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = renderChordsSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    // String Count Buttons (6 / 7 / 8), shared by the chord and scale views
    container.querySelectorAll('.ref-strings-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const count = parseInt(btn.getAttribute('data-strings'), 10);
            if ([6, 7, 8].includes(count)) {
                stringCount = count;
                try { localStorage.setItem('majestictab_string_count', String(count)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = activeTab === 'scales' ? renderScalesSection() : renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Tuning Buttons (standard tuning, tuned down), shared by the chord and scale views
    container.querySelectorAll('.ref-tuning-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const offset = parseInt(btn.getAttribute('data-offset'), 10);
            if (tuningSpecs[stringCount].offsets.includes(offset)) {
                tuningOffset = offset;
                try { localStorage.setItem('majestictab_tuning_offset', String(offset)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = activeTab === 'scales' ? renderScalesSection() : renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Capo Buttons
    container.querySelectorAll('.ref-capo-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const fret = parseInt(btn.getAttribute('data-capo'), 10);
            if (capoFrets.includes(fret)) {
                capo = fret;
                try { localStorage.setItem('majestictab_capo', String(fret)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

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

    // 6. Invert strings (flip) toggle buttons
    [...container.querySelectorAll('.ref-fretboard-flip-btn')].filter(b => !b.closest('#refCircleInfoPanel')).forEach(btn => {
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
    [...container.querySelectorAll('.ref-fretboard-lh-btn')].filter(b => !b.closest('#refCircleInfoPanel')).forEach(btn => {
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
                refreshCircleSection();
            }
        });
    });
}

function refreshCircleSection() {
    const svgContainer = document.getElementById('refCircleSvgContainer');
    const infoPanel = document.getElementById('refCircleInfoPanel');
    if (svgContainer) svgContainer.innerHTML = buildCircleOfFifthsSvg(selectedCircleIndex);
    if (infoPanel) infoPanel.innerHTML = renderCircleInfoPanel();
    attachCircleSliceListeners();
    attachCircleChordLinks(document.getElementById('refCircleInfoPanel')?.closest('.ref-page-container')?.parentElement);
}

// Jump to the Chord Library filtered to the clicked chord's root and family
function attachCircleChordLinks(container) {
    const infoPanel = document.getElementById('refCircleInfoPanel');
    if (!infoPanel || !container) return;
    infoPanel.querySelectorAll('.ref-chord-link').forEach(btn => {
        btn.addEventListener('click', () => {
            const symbol = btn.getAttribute('data-chord');
            const isDim = symbol.endsWith('°');
            const isMinor = !isDim && symbol.endsWith('m');
            const symbolRoot = symbol.match(/^[A-G][♯♭]?/)[0];
            selectedRootFilter = chordRootAliases[symbolRoot] || symbolRoot;
            selectedChordFilter = isDim ? 'Dim/Aug' : isMinor ? 'Minor' : 'Major';
            activeTab = 'chords';
            renderReferenceLibraryView(container);
            refTabChangeListener?.(activeTab);
        });
    });
}
