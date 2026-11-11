// referenceLibrary.js
// Interactive music theory reference library: Circle of Fifths, Chord Library,
// Scales & Modes, and Triad Inversions & Formulas.
// Optimized for desktop and mobile viewports with MajesticTab finish theme integration.

import { TRACK_PALETTE } from './utils/trackColors.js';
import { fretboardController } from './fretboard/fretboardController.js';
import { getNormalizedChordList, getNormalizedChordListSync, DISPLAY_KEY_TO_CHORDDB, KEY_DISPLAY_MAP, TUNINGS_MIDI } from './utils/chordEngine.js';
import { strumChord, prepareChordSound, playNote } from './utils/chordStrum.js';
import { SHAPE_FAMILIES, SHAPE_TYPES, SHAPE_STRING_NAMES, getShapeTypes, getShapeType, getShapesForType } from './utils/chordShapes.js';
import {
    buildChordDiagramSvg,
    findFingerBars,
    getChordOrientation,
    setChordOrientation,
    getChordViewMode,
    setChordViewMode
} from './utils/chordDiagram.js';

export {
    buildChordDiagramSvg,
    findFingerBars,
    getChordOrientation,
    setChordOrientation,
    getChordViewMode,
    setChordViewMode,
    buildFretboardSvg,
    renderScalesSection,
    renderCircleInfoPanel,
    getChordNotesForSymbol
};

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
let preferMovableShapes = (() => { try { return (localStorage.getItem('majestictab_prefer_movable_shapes') ?? localStorage.getItem('majestictab_prefer_barre_chords') ?? localStorage.getItem('majestictab_prefer_bar_chords')) === 'true'; } catch (_) { return false; } })();
let selectedRootFilter = 'C'; // default to C (no 'all' option)

let selectedRootStringFilter = 'all';
let selectedShapeFamily = 'all';

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
    6: { low: 4, steps: [0, 5, 10, 15, 19, 24], offsets: [0, 1, 2, 3, 4, 5, 6] }, // E A D G B E
    7: { low: 11, steps: [0, 5, 10, 15, 20, 24, 29], offsets: [0, 1, 2] }, // B E A D G B E
    8: { low: 6, steps: [0, 5, 10, 15, 20, 25, 29, 34], offsets: [0, 1, 2] } // F♯ B E A D G B E
};
const sharpNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const flatNames = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const sharpTuningOffsets = [3, 5];

export async function getChordData(strings = 6) {
    return getNormalizedChordList(strings);
}

// -----------------------------------------------------------------------------
// SVG Generators
// -----------------------------------------------------------------------------

/**
 * Generate Circle of Fifths SVG
 */
function buildCircleOfFifthsSvg(selectedIndex) {
    // Flat: wedges are tone steps separated by the ground showing through, the chosen key is one step up
    // and carries the inlay dot. No outlines, glow or gradient.
    const size = 420;
    const center = size / 2;
    const outerRadius = 200;
    const midRadius = 138;
    const innerRadius = 78;
    const angleStep = (2 * Math.PI) / 12;

    let svg = `<svg viewBox="0 0 ${size} ${size}" class="ref-circle-svg" role="group" aria-label="Circle of fifths">`;

    circleData.forEach((item, index) => {
        const isSelected = index === selectedIndex;
        const startAngle = (index * angleStep) - (Math.PI / 2) - (angleStep / 2);
        const endAngle = startAngle + angleStep;
        const midAngle = startAngle + (angleStep / 2);
        const pt = (r, a) => [center + r * Math.cos(a), center + r * Math.sin(a)];
        const [x1, y1] = pt(outerRadius, startAngle);
        const [x2, y2] = pt(outerRadius, endAngle);
        const [tx, ty] = pt((outerRadius + midRadius) / 2, midAngle);
        const [mx, my] = pt((midRadius + innerRadius) / 2, midAngle);
        const [dx, dy] = pt(outerRadius - 12, midAngle);

        svg += `<path d="M ${center} ${center} L ${x1} ${y1} A ${outerRadius} ${outerRadius} 0 0 1 ${x2} ${y2} Z"
                    class="ref-circle-slice ${isSelected ? 'active' : ''}" data-circle-idx="${index}"
                    role="button" tabindex="0" aria-pressed="${isSelected}" aria-label="${item.major} major, relative minor ${item.minor}" />`;
        svg += `<text x="${tx}" y="${ty + 6}" fill="var(--ink)" font-size="17" font-weight="${isSelected ? 700 : 600}" text-anchor="middle" pointer-events="none">${item.major}</text>`;
        svg += `<text x="${mx}" y="${my + 5}" fill="${isSelected ? 'var(--ink)' : 'var(--ink2)'}" font-size="12.5" font-weight="600" text-anchor="middle" pointer-events="none">${item.minor}</text>`;
        if (isSelected) svg += `<circle cx="${dx}" cy="${dy}" r="3.5" fill="var(--hue)" pointer-events="none" />`;
    });

    // The ground shows through as the seam between the major and minor rings and as the hub
    svg += `<circle cx="${center}" cy="${center}" r="${midRadius}" fill="none" stroke="var(--ground)" stroke-width="3" pointer-events="none" />`;
    svg += `<circle cx="${center}" cy="${center}" r="${innerRadius}" fill="var(--ground)" pointer-events="none" />`;

    svg += `</svg>`;
    return svg;
}


/** Fretboard marker color for a scale degree label: root is ink, degrees 2 to 7 take the six guitar track colors. */
function scaleDegreeColor(label) {
    const degree = parseInt(String(label).replace(/[^0-9]/g, ''), 10);
    if (!degree || degree === 1) return 'var(--ink)';
    return TRACK_PALETTE[(degree - 2) % TRACK_PALETTE.length];
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
    const baseMidi = TUNINGS_MIDI[stringCount] || TUNINGS_MIDI[6];
    const standardStrings = openStringNames.map((name, i) => {
        const stringIdx = stringCount - 1 - i;
        const step = tuningSpec.steps[stringIdx];
        const openMidi = (baseMidi[stringIdx] ?? (tuningSpec.low + step + 36)) - getTuningOffset();
        return {
            name,
            tuning: (tuningSpec.low + step - getTuningOffset() + 120) % 12,
            openMidi,
            gauge: 1 + 0.35 * stringIdx
        };
    });
    const visualStrings = isFlipped ? [...standardStrings].reverse() : standardStrings;

    let svg = `<svg viewBox="0 0 ${totalWidth} ${totalHeight}" class="ref-fretboard-svg" style="min-width: 840px;" aria-label="Interactive Scale Fretboard">`;

    if (!isLeftHanded) {
        const startX = 66; // Nut x position

        // Fretboard body
        svg += `<rect x="${startX}" y="${startY}" width="${boardWidth}" height="${boardHeight}" fill="var(--ref-rest)" rx="4" />`;

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
                    const circleFill = scaleDegreeColor(matched.lbl);
                    const textFill = isRoot ? 'var(--ground)' : '#111';
                    const noteName = noteNames[notePitch];
                    const midiNote = s.openMidi + f;
                    const spoken = `${noteName}, fret ${f}, ${s.name} string`;

                    svg += `<g transform="translate(${x}, ${y})" class="ref-fret-note ref-note-play" data-midi="${midiNote}" data-note="${noteName}" role="button" tabindex="0" aria-label="Play ${spoken}">
                        <circle cx="0" cy="0" r="16" fill="transparent"/>
                        <circle cx="0" cy="0" r="${isRoot ? 13 : 10.5}" fill="${circleFill}" class="ref-note-marker" pointer-events="none"/>
                        <text x="0" y="3.5" fill="${textFill}" font-size="${isRoot ? 11 : 9.5}" font-weight="bold" text-anchor="middle" pointer-events="none">${matched.lbl}</text>
                    </g>`;
                }
            }
        });
    } else {
        // Left-handed: Nut on right (x = 870), frets extending to the left (to x = 30)
        const boardStartX = 30;
        const nutX = boardStartX + boardWidth; // 870

        // Fretboard body
        svg += `<rect x="${boardStartX}" y="${startY}" width="${boardWidth}" height="${boardHeight}" fill="var(--ref-rest)" rx="4" />`;

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
                    const circleFill = scaleDegreeColor(matched.lbl);
                    const textFill = isRoot ? 'var(--ground)' : '#111';
                    const noteName = noteNames[notePitch];
                    const midiNote = s.openMidi + f;
                    const spoken = `${noteName}, fret ${f}, ${s.name} string`;

                    svg += `<g transform="translate(${x}, ${y})" class="ref-fret-note ref-note-play" data-midi="${midiNote}" data-note="${noteName}" role="button" tabindex="0" aria-label="Play ${spoken}">
                        <circle cx="0" cy="0" r="16" fill="transparent"/>
                        <circle cx="0" cy="0" r="${isRoot ? 13 : 10.5}" fill="${circleFill}" class="ref-note-marker" pointer-events="none"/>
                        <text x="0" y="3.5" fill="${textFill}" font-size="${isRoot ? 11 : 9.5}" font-weight="bold" text-anchor="middle" pointer-events="none">${matched.lbl}</text>
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

const chordRootFilters = ['A♭', 'A', 'B♭', 'B', 'C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G'];
// Circle of fifths spellings that the chord library files under another name
const chordRootAliases = { 'D♭': 'C♯', 'D♯': 'E♭', 'G♭': 'F♯', 'G♯': 'A♭', 'A♯': 'B♭', 'E♯': 'F', 'B♯': 'C', 'C♭': 'B', 'F♭': 'E' };

function getChordNotesForSymbol(symbol, chordList = null) {
    const list = chordList || getNormalizedChordListSync(stringCount);
    const isDim = symbol.endsWith('°');
    const isMinor = !isDim && symbol.endsWith('m');
    const symbolRoot = symbol.match(/^[A-G][♯♭]?/)[0];
    const canonicalRoot = chordRootAliases[symbolRoot] || symbolRoot;
    const dbKey = DISPLAY_KEY_TO_CHORDDB[canonicalRoot] || canonicalRoot;
    const dispRoot = KEY_DISPLAY_MAP[dbKey] || canonicalRoot;
    const targetName = isDim ? dispRoot + 'dim' : isMinor ? dispRoot + 'm' : dispRoot;

    if (list) {
        const found = list.find(c => c.name === targetName);
        if (found) {
            return chordMidiNotes(parseFrets(found.frets));
        }
    }

    // Direct harmonic fallback if chord dataset is still loading:
    const rootPitch = rootPitchOf(canonicalRoot);
    const baseRoot = 48 + ((rootPitch - (getTuningOffset() % 12) + 12) % 12);
    const third = isMinor || isDim ? 3 : 4;
    const fifth = isDim ? 6 : 7;
    return [baseRoot, baseRoot + third, baseRoot + fifth];
}

/**
 * Render the selected key's info panel (key signature + diatonic chords).
 * Major-key chords link to the Chord Library.
 */
let circleKeyMode = 'major'; // which key's diatonic chords the circle panel lists

function renderCircleInfoPanel() {
    const data = circleData[selectedCircleIndex];
    const isMinor = circleKeyMode === 'minor';
    const degrees = isMinor ? ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'] : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
    const chords = isMinor ? data.minorChords : data.majorChords;
    const chordsHtml = degrees.map((deg, i) => `
        <div class="ref-chord-deg-card" data-chord="${chords[i]}">
            <button type="button" class="ref-deg-chord-btn ref-chord-play" data-chord="${chords[i]}" title="Play ${chords[i]} chord" aria-label="Play ${chords[i]} chord">
                <span class="ref-deg-label">${deg}</span>
                <span class="ref-deg-chord">${chords[i]}</span>
            </button>
            <button type="button" class="ref-deg-link-btn ref-chord-link" data-chord="${chords[i]}" title="Show ${chords[i]} in chord library" aria-label="Show ${chords[i]} in chord library">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11l6-6M6 5h5v5"/></svg>
            </button>
        </div>
    `).join('');
    const seg = (mode, label) => `<button type="button" class="ref-chip ref-circle-mode-btn" data-mode="${mode}" aria-pressed="${circleKeyMode === mode}">${label}</button>`;

    return `
        <h3 class="ref-key-headline">${data.major} major</h3>
        <dl class="ref-kv">
            <div><dt>Key signature</dt><dd>${data.accidentals}</dd></div>
            <div><dt>Relative minor</dt><dd>${data.minor}</dd></div>
        </dl>
        <div class="ref-subhead-row">
            <span class="ref-card-subhead" id="refDegLabel">Chords in the key of</span>
            <div class="ref-chip-row" role="group" aria-labelledby="refDegLabel">${seg('major', data.major + ' major')}${seg('minor', data.minor + ' minor')}</div>
        </div>
        <div class="ref-deg-grid">${chordsHtml}</div>
    `;
}

/**
 * Render Circle of Fifths Section
 */
function renderCircleSection() {
    return `
    <div class="ref-circle-container" role="tabpanel">
        <div class="ref-circle-left">
            <div class="ref-circle-svg-wrapper" id="refCircleSvgContainer">
                ${buildCircleOfFifthsSvg(selectedCircleIndex)}
            </div>
        </div>
        <div class="ref-circle-right" id="refCircleInfoPanel">
            ${renderCircleInfoPanel()}
        </div>
    </div>
    `;
}

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
            <button type="button" class="ref-chip ref-tuning-btn" aria-pressed="${current === offset}" data-offset="${offset}" title="${offset === 0 ? 'Standard tuning' : `Standard tuning, ${offset} semitone${offset === 1 ? '' : 's'} down`}">
                ${getOpenStringNames(offset)[0]}
            </button>
        `).join('');
}

function buildCapoButtonsHtml() {
    return capoFrets.map(fret => `
            <button type="button" class="ref-chip ref-capo-btn" aria-pressed="${capo === fret}" data-capo="${fret}" title="${fret === 0 ? 'No capo' : `Capo on fret ${fret}`}">
                ${fret === 0 ? 'None' : fret}
            </button>
        `).join('');
}

function buildStringCountButtonsHtml() {
    return [6, 7, 8].map(n => `
            <button type="button" class="ref-chip ref-strings-btn" aria-pressed="${stringCount === n}" data-strings="${n}">
                ${n}
            </button>
        `).join('');
}

async function getActiveChordData() {
    const source = await getNormalizedChordList(stringCount);
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
        return { ...chord, name, dbSuffix: chord.suffix, suffix, shapeOf, capo: capo > 0 ? capo : 0 };
    });
    // Keep each chord type together, with roots in the same order as the standard-tuning list
    shifted.sort((a, b) => suffixOrder.indexOf(a.suffix) - suffixOrder.indexOf(b.suffix)
        || chordRootFilters.indexOf(a.name.slice(0, a.name.length - a.suffix.length)) - chordRootFilters.indexOf(b.name.slice(0, b.name.length - b.suffix.length)));
    return shifted;
}


// --- Hearing a chord: click the name or the diagram to strum it on a synthesized acoustic guitar ----

/** MIDI notes (lowest string first, -1 for muted) of a chord as drawn on the current strings, tuning and capo. */
function chordMidiNotes(frets) {
    const base = TUNINGS_MIDI[stringCount] || TUNINGS_MIDI[6];
    const shift = capo - getTuningOffset();
    return frets.map((f, s) => (f >= 0 && base[s] !== undefined ? base[s] + shift + f : -1));
}

/** A movable shape is sounded with its root on C: the lowest placement that has no open strings. */
function shapeMidiNotes(shape) {
    const base = TUNINGS_MIDI[stringCount] || TUNINGS_MIDI[6];
    const rootFret = (((0 - base[shape.rootString]) % 12) + 12) % 12 || 12;
    let start = rootFret - shape.offsets[shape.rootString];
    while (start < 1) start += 12;
    return shape.offsets.map((o, s) => (o === null ? -1 : base[s] + start + o));
}

const playAttrs = (notes, label) => `data-notes="${notes.join(',')}" role="button" tabindex="0" aria-label="Play ${label}"`;

// --- One tile per chord type, stepped through with arrows (Movable Shapes and By Note) -------------

const shapeIndexByType = {};
let tileSignature = '';
let noteEntries = new Map(); // By Note: chord type id -> its shapes for the chosen root, built when the section renders

function getScopeShapeTypes() {
    return selectedShapeFamily === 'all' ? SHAPE_TYPES : getShapeTypes(selectedShapeFamily);
}

const parseFrets = (text) => text.split(' ').map(f => (f.toLowerCase() === 'x' ? -1 : parseInt(f, 10)));
const DB_ALIASES = { '69': ['69', '6/9'], '7b5': ['7b5', '7(-5)'], maj7sharp5: ['maj7#5'], '7sharp9': ['7#9'], '9sharp11': ['9#11'] };
const dbSuffixesOf = (type) => DB_ALIASES[type.id] || [type.id];
const chordDbSuffix = (c) => c.dbSuffix ?? c.suffix;
const rootPitchOf = (name) => (sharpNames.indexOf(name) >= 0 ? sharpNames.indexOf(name) : flatNames.indexOf(name));

/** Every shape of a chord type: root position, then inversions, then drops. */
function collectTypeShapes(typeId) {
    const result = getShapesForType(typeId, stringCount);
    return [
        ...result.root.flatMap(g => g.shapes.map(sh => ({ sh, note: sh.lighter ? 'Lighter shape' : 'Root position' }))),
        ...result.inversions.flatMap(g => g.shapes.map(sh => ({ sh, note: `${g.degree} in the bass` }))),
        ...['drop2', 'drop3'].flatMap(k => result.drops[k].map(sh => ({ sh, note: `${k === 'drop2' ? 'Drop 2' : 'Drop 3'} · ${sh.bassDegree} in the bass` })))
    ];
}

/** Movable Shapes: the shapes drawn relative to their lowest fret, sounded with the root on C. */
function movableEntries(typeId) {
    return collectTypeShapes(typeId)
        .filter(x => selectedRootStringFilter === 'all' || String(x.sh.rootString) === selectedRootStringFilter)
        .map(({ sh, note }) => ({ diagram: sh, startFret: 1, fretsText: sh.frets, midi: shapeMidiNotes(sh), note }));
}

/** A movable shape placed so its root is the chosen note, at the lowest place with no open strings. */
function placedShapeEntry(sh, note) {
    const base = TUNINGS_MIDI[stringCount] || TUNINGS_MIDI[6];
    const rootFret = ((((rootPitchOf(selectedRootFilter) - base[sh.rootString] - capo + getTuningOffset()) % 12) + 12) % 12) || 12;
    let start = rootFret - sh.offsets[sh.rootString];
    while (start < 1) start += 12;
    const frets = sh.offsets.map(o => (o === null ? 'x' : String(start + o)));
    const diagram = { frets: frets.join(' '), startFret: start, labels: sh.labels, rootString: sh.rootString, isMoveable: true, capo: capo > 0 ? capo : 0 };
    return { diagram, startFret: start, fretsText: diagram.frets, midi: chordMidiNotes(parseFrets(diagram.frets)), note: `${note}${capo > 0 ? ` · Capo ${capo}` : ''}` };
}

/** By Note: the database's own fingerings for the chord, or (Prefer movable shapes) the movable shapes placed on the root. */
function buildNoteEntries(type, activeData) {
    const suffixes = dbSuffixesOf(type);
    const rows = activeData.filter(c => (c.name.match(/^[A-G][♯♭]?/)?.[0] || '') === selectedRootFilter && suffixes.includes(chordDbSuffix(c)));
    if (!preferMovableShapes && rows.length) {
        rows.sort((a, b) => (b.default === 1) - (a.default === 1));
        return rows.map(c => ({
            diagram: c,
            startFret: c.startFret,
            fretsText: c.frets,
            midi: chordMidiNotes(parseFrets(c.frets)),
            note: `${c.frets.split(' ').includes('0') ? 'Open shape' : 'Closed shape'}${c.shapeOf ? ` · ${c.shapeOf} shape` : ''}${capo > 0 ? ` · Capo ${capo}` : ''}`
        }));
    }
    return collectTypeShapes(type.id).map(({ sh, note }) => placedShapeEntry(sh, note));
}

const getTileEntries = (typeId) => (getChordViewMode() === 'note' ? (noteEntries.get(typeId) || []) : movableEntries(typeId));

function renderShapeTile(typeId) {
    const type = getShapeType(typeId);
    const list = getTileEntries(typeId);
    if (!list.length) return '';
    const idx = Math.min(Math.max(shapeIndexByType[typeId] || 0, 0), list.length - 1);
    shapeIndexByType[typeId] = idx;
    const e = list[idx];
    const multi = list.length > 1;
    const byNote = getChordViewMode() === 'note';
    const title = byNote ? (type.id === 'major' ? selectedRootFilter : `${selectedRootFilter}${type.symbol}`) : type.symbol;
    const spoken = byNote ? `${selectedRootFilter} ${type.name}${capo > 0 ? `, capo ${capo}` : ''}` : type.name;
    const play = playAttrs(e.midi, spoken);
    return `
        <div class="col" data-shape-tile="${typeId}">
            <div class="ref-chord-card ref-shape-tile ref-chord-play" ${play}>
                <div class="ref-chord-card-header">
                    <span class="ref-chord-name" title="${type.name}">${title}</span>
                    <span class="ref-chord-cat">${e.note}</span>
                </div>
                <div class="ref-chord-svg-container">
                    ${buildChordDiagramSvg(e.diagram, e.startFret, getChordOrientation(), getStringLabelsHighToLow(), byNote ? capo : 0)}
                </div>
                <span class="ref-chord-frets">${e.fretsText}</span>
                <div class="ref-shape-nav">
                    <button type="button" class="ref-shape-nav-btn" data-dir="-1" aria-label="Previous ${spoken} shape" ${multi ? '' : 'disabled'}><i class="bi-chevron-left" aria-hidden="true"></i></button>
                    <span class="ref-shape-count">${idx + 1} / ${list.length}</span>
                    <button type="button" class="ref-shape-nav-btn" data-dir="1" aria-label="Next ${spoken} shape" ${multi ? '' : 'disabled'}><i class="bi-chevron-right" aria-hidden="true"></i></button>
                </div>
            </div>
        </div>`;
}

/**
 * Render Chord Reference Library Section
 */
async function renderChordsSection() {
    const chip = (cls, attrs, on, label, title = '') =>
        `<button type="button" class="ref-chip ${cls}" ${attrs} aria-pressed="${on}"${title ? ` title="${title}"` : ''}>${label}</button>`;
    const group = (label, html) => `<div class="ref-field"><span class="ref-filter-group-label">${label}</span><div class="ref-chip-row">${html}</div></div>`;

    const shapeFamilyButtonsHtml = [{ id: 'all', name: 'All', blurb: 'Every chord type' }, ...SHAPE_FAMILIES].map(f =>
        chip('ref-shape-family-btn', `data-shape-family="${f.id}" title="${f.blurb}"`, selectedShapeFamily === f.id, f.name)).join('');

    // View mode selector (Movable Shapes left of By Note, Movable Shapes is default)
    const modeButtonsHtml = `
        <button type="button" class="ref-chip ref-mode-btn" data-mode="moveable" aria-pressed="${getChordViewMode() === 'moveable'}">Movable Shapes</button>
        <button type="button" class="ref-chip ref-mode-btn" data-mode="note" aria-pressed="${getChordViewMode() === 'note'}">By Note</button>
    `;

    // Orientation toggle (Vertical left of Horizontal, Vertical is default)
    const orientButtonsHtml = `
        <button type="button" class="ref-chip ref-orient-btn" data-orient="vertical" aria-pressed="${getChordOrientation() === 'vertical'}" title="Vertical diagrams (traditional chord chart)">Vertical</button>
        <button type="button" class="ref-chip ref-orient-btn" data-orient="horizontal" aria-pressed="${getChordOrientation() === 'horizontal'}" title="Horizontal diagrams (fretboard style)">Horizontal</button>
    `;

    let cardsHtml = '';
    let totalCount = 0;
    let selectorRowHtml = '';

    if (getChordViewMode() === 'moveable') {
        const scopeTypes = getScopeShapeTypes();
        const rootStrings = [...new Set(scopeTypes.flatMap(t => collectTypeShapes(t.id).map(x => x.sh.rootString)))].sort((x, y) => x - y);
        if (selectedRootStringFilter !== 'all' && !rootStrings.includes(Number(selectedRootStringFilter))) selectedRootStringFilter = 'all';
        const stringOptions = [{ id: 'all', label: 'All strings' }, ...rootStrings.map(i => ({ id: String(i), label: SHAPE_STRING_NAMES[stringCount][i] }))];
        selectorRowHtml = `
            <div class="ref-chip-row ref-root-row" role="group" aria-label="Root string">
                ${stringOptions.map(opt => chip('ref-key ref-root-string-btn', `data-root-string="${opt.id}"`, selectedRootStringFilter === opt.id, opt.label)).join('')}
            </div>`;
        // A change of anything the tiles depend on starts every tile at its first shape
        const sig = ['moveable', selectedShapeFamily, selectedRootStringFilter, stringCount].join('|');
        if (sig !== tileSignature) { tileSignature = sig; Object.keys(shapeIndexByType).forEach(k => delete shapeIndexByType[k]); }
        const tiles = scopeTypes.map(t => renderShapeTile(t.id)).filter(Boolean);
        totalCount = tiles.length;
        cardsHtml = tiles.length ? tiles.join('') : `<div class="col-12 ref-empty">No movable shapes match these filters.</div>`;
    } else {
        if (!selectedRootFilter || selectedRootFilter === 'all') selectedRootFilter = 'C';
        const activeChordData = await getActiveChordData();
        const scopeTypes = getScopeShapeTypes();
        noteEntries = new Map(scopeTypes.map(t => [t.id, buildNoteEntries(t, activeChordData)]));
        const sig = ['note', selectedShapeFamily, selectedRootFilter, preferMovableShapes, stringCount, getTuningOffset(), capo].join('|');
        if (sig !== tileSignature) { tileSignature = sig; Object.keys(shapeIndexByType).forEach(k => delete shapeIndexByType[k]); }

        selectorRowHtml = `
            <div class="ref-chip-row ref-root-row" role="group" aria-label="Root note">
                ${chordRootFilters.map(r => chip('ref-key ref-chord-root-btn', `data-root="${r}"`, selectedRootFilter === r, r)).join('')}
            </div>
        `;
        const tiles = scopeTypes.map(t => renderShapeTile(t.id)).filter(Boolean);
        totalCount = tiles.length;
        cardsHtml = tiles.length ? tiles.join('') : `<div class="col-12 ref-empty">No chords match these filters.</div>`;
    }

    return `
    <div class="ref-section-box" role="tabpanel">
        <div class="ref-subhead-row" style="margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
            <div class="ref-chip-row ref-mode-row" role="group" aria-label="Chord view mode">${modeButtonsHtml}</div>
        </div>
        ${selectorRowHtml}
        <div class="ref-filter-row">
            ${group('Family', shapeFamilyButtonsHtml)}
            ${group('Strings', buildStringCountButtonsHtml())}
            ${getChordViewMode() === 'note' ? group('Tuning', buildTuningButtonsHtml()) : ''}
            ${getChordViewMode() === 'note' ? group('Capo', buildCapoButtonsHtml()) : ''}
        </div>
        <div class="ref-result-row">
            <span class="ref-count">${totalCount} chord types</span>
            <div class="ref-result-actions" style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
                ${getChordViewMode() === 'note' ? `
                <label class="ref-switch" for="refChordMovableBtn">
                    <span>Prefer movable shapes</span>
                    <input type="checkbox" role="switch" class="form-check-input theme-switch" id="refChordMovableBtn" ${preferMovableShapes ? 'checked' : ''}>
                </label>
                ` : ''}
                <div class="ref-chip-row ref-orient-row" role="group" aria-label="Diagram orientation">
                    ${orientButtonsHtml}
                </div>
            </div>
        </div>
        <div class="row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-xl-5 g-2" id="refChordGrid">
            ${cardsHtml}
        </div>
    </div>
    `;
}

function renderScalesSection() {
    const currentScale = scaleDefinitions[selectedScaleKey] || scaleDefinitions.majorPentatonic;
    const rootName = noteNames[selectedRootNote];

    const baseRootMidi = 48 + selectedRootNote;
    const activeNoteButtons = currentScale.intervals.map(item => {
        const noteIndex = (item.int + selectedRootNote) % 12;
        const name = noteNames[noteIndex];
        const midi = baseRootMidi + item.int;
        return `<button type="button" class="ref-scale-note-btn ref-note-play" data-midi="${midi}" aria-label="Play ${name}">${name}</button>`;
    }).join('<span class="ref-scale-note-sep" aria-hidden="true"> · </span>');

    const scaleOptions = Object.keys(scaleDefinitions).map(k => `
        <option value="${k}" ${k === selectedScaleKey ? 'selected' : ''}>${scaleDefinitions[k].name}</option>
    `).join('');

    const rootOptions = noteNames.map((name, idx) => `
        <option value="${idx}" ${idx === selectedRootNote ? 'selected' : ''}>${name}</option>
    `).join('');

    return `
    <div class="ref-section-box ref-scales-section" role="tabpanel">
        <div class="ref-filter-row">
            <div class="ref-field">
                <label class="ref-filter-group-label" for="refScaleSelect">Scale or mode</label>
                <select id="refScaleSelect" class="form-select theme-select ref-select">${scaleOptions}</select>
            </div>
            <div class="ref-field">
                <label class="ref-filter-group-label" for="refRootSelect">Root</label>
                <select id="refRootSelect" class="form-select theme-select ref-select">${rootOptions}</select>
            </div>
            <div class="ref-field">
                <span class="ref-filter-group-label">Strings</span>
                <div class="ref-chip-row">${buildStringCountButtonsHtml()}</div>
            </div>
            <div class="ref-field">
                <span class="ref-filter-group-label">Tuning</span>
                <div class="ref-chip-row">${buildTuningButtonsHtml()}</div>
            </div>
        </div>

        <dl class="ref-kv ref-scale-facts">
            <div><dt>${rootName} ${currentScale.name}</dt><dd class="ref-scale-notes">${activeNoteButtons}</dd></div>
            <div><dt>Formula</dt><dd class="ref-scale-formula">${currentScale.formula}</dd></div>
        </dl>

        <div class="ref-fretboard-scroll-container">
            <div class="ref-fretboard-wrapper" id="refFretboardContainer">
                ${buildFretboardSvg(selectedScaleKey, selectedRootNote)}
            </div>
        </div>
    </div>
    `;
}

// -----------------------------------------------------------------------------

// --- Reference modal: opens over any view (song, library, tuner closed) ---------------------------

const REFERENCE_TABS = ['circle', 'chords', 'scales'];
const REFERENCE_TITLES = { chords: 'Chord library', scales: 'Scales', circle: 'Circle of fifths' };
const REFERENCE_SUBTITLES = { chords: 'Voicings for any tuning and capo', scales: 'Scales and modes on the neck', circle: 'Keys and their chords' };

/** Tell the URL router and the Tools page which tool is showing. */
function notifyReferenceTab() {
    refTabChangeListener?.(activeTab);
    document.dispatchEvent(new CustomEvent('reference-tab', { detail: activeTab }));
}
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
            <div class="theme-modal-titles">
              <h2 class="theme-modal-title mb-0 fs-6 fw-bold text-white" id="referenceModalTitle">Chord library</h2>
              <div class="small text-white-50" id="referenceModalSubtitle">Voicings for any tuning and capo</div>
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

function syncToolsMenuActive() {
    const open = isReferenceOpen();
    document.querySelectorAll('.tools-ref-item').forEach((el) => el.classList.toggle('active', open && el.dataset.refTab === activeTab));
}

export async function openReferenceModal(tab = null) {
    const modal = ensureReferenceModal();
    const previousTab = activeTab;
    if (REFERENCE_TABS.includes(tab)) activeTab = tab;
    const wasOpen = isReferenceOpen();
    await renderReferenceLibraryView(modal.querySelector('#referenceModalBody'));
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    syncToolsMenuActive();
    if (!wasOpen) {
        modal.querySelector('#referenceModalCloseBtn')?.focus();
    }
    if (!wasOpen || activeTab !== previousTab) notifyReferenceTab();
}

export function closeReferenceModal() {
    if (!isReferenceOpen()) return;
    referenceModalEl.style.display = 'none';
    referenceModalEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    syncToolsMenuActive();
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
export async function renderReferenceLibraryView(container) {
    if (!container) return;

    if (!REFERENCE_TABS.includes(activeTab)) {
        activeTab = 'chords';
    }

    // One screen, three tools: the dialog's title names the tool that is open
    const titleEl = document.getElementById('referenceModalTitle');
    if (titleEl) titleEl.textContent = REFERENCE_TITLES[activeTab];
    const subEl = document.getElementById('referenceModalSubtitle');
    if (subEl) subEl.textContent = REFERENCE_SUBTITLES[activeTab];

    let tabContentHtml = '';
    if (activeTab === 'circle') { prepareChordSound(); getChordData(stringCount).catch(() => {}); tabContentHtml = renderCircleSection(); }
    else if (activeTab === 'chords') { prepareChordSound(); tabContentHtml = await renderChordsSection(); }
    else if (activeTab === 'scales') { prepareChordSound(); tabContentHtml = renderScalesSection(); }

    container.innerHTML = `
    <div class="ref-page-container">
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
    // 2. Circle of Fifths slices
    attachCircleSliceListeners();
    attachCircleChordLinks(container);

    // Chord View Mode (By Note vs Movable Shapes)
    container.querySelectorAll('.ref-mode-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const mode = btn.getAttribute('data-mode');
            if (mode && (mode === 'note' || mode === 'moveable')) {
                setChordViewMode(mode);
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = await renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Chord Diagram Orientation (Horizontal vs Vertical)
    container.querySelectorAll('.ref-orient-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orient = btn.getAttribute('data-orient');
            if (orient && (orient === 'horizontal' || orient === 'vertical')) {
                setChordOrientation(orient);
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = await renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Movable Shapes: family and chord type
    const rerenderChords = async () => {
        const contentContainer = document.getElementById('refTabContentContainer');
        if (contentContainer) {
            contentContainer.innerHTML = await renderChordsSection();
            attachReferenceEventListeners(container);
        }
    };
    container.querySelectorAll('.ref-shape-family-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedShapeFamily = btn.getAttribute('data-shape-family');
            Object.keys(shapeIndexByType).forEach(k => delete shapeIndexByType[k]);
            rerenderChords();
        });
    });
    container.querySelectorAll('.ref-root-string-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedRootStringFilter = btn.getAttribute('data-root-string');
            Object.keys(shapeIndexByType).forEach(k => delete shapeIndexByType[k]);
            rerenderChords();
        });
    });
    const chordGrid = container.querySelector('#refChordGrid');
    if (chordGrid) {
        const playFrom = (el) => {
            const notes = (el.getAttribute('data-notes') || '').split(',').map(Number);
            strumChord(notes);
        };
        chordGrid.addEventListener('click', (e) => {
            if (e.target.closest('.ref-shape-nav')) {
                const btn = e.target.closest('.ref-shape-nav-btn');
                if (btn && !btn.disabled) {
                    const tile = btn.closest('[data-shape-tile]');
                    if (!tile) return;
                    const typeId = tile.getAttribute('data-shape-tile');
                    const count = getTileEntries(typeId).length;
                    const dir = parseInt(btn.getAttribute('data-dir'), 10);
                    shapeIndexByType[typeId] = (((shapeIndexByType[typeId] || 0) + dir) % count + count) % count;
                    tile.outerHTML = renderShapeTile(typeId);
                    chordGrid.querySelector(`[data-shape-tile="${typeId}"] .ref-shape-nav-btn[data-dir="${dir}"]`)?.focus();
                }
                return;
            }
            const target = e.target.closest('.ref-chord-play');
            if (target) playFrom(target);
        });
        chordGrid.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('.ref-shape-nav')) return;
            const target = e.target.closest('.ref-chord-play');
            if (!target) return;
            e.preventDefault();
            playFrom(target);
        });
    }

    const movableBtn = container.querySelector('#refChordMovableBtn') || container.querySelector('#refChordBarreBtn');
    if (movableBtn) {
        movableBtn.addEventListener('change', async () => {
            preferMovableShapes = movableBtn.checked;
            try {
                localStorage.setItem('majestictab_prefer_movable_shapes', String(preferMovableShapes));
                localStorage.setItem('majestictab_prefer_barre_chords', String(preferMovableShapes));
            } catch (_) {}
            const contentContainer = document.getElementById('refTabContentContainer');
            if (contentContainer) {
                contentContainer.innerHTML = await renderChordsSection();
                attachReferenceEventListeners(container);
            }
        });
    }

    // String Count Buttons (6 / 7 / 8), shared by the chord and scale views
    container.querySelectorAll('.ref-strings-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const count = parseInt(btn.getAttribute('data-strings'), 10);
            if ([6, 7, 8].includes(count)) {
                stringCount = count;
                try { localStorage.setItem('majestictab_string_count', String(count)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = activeTab === 'scales' ? renderScalesSection() : await renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Tuning Buttons (standard tuning, tuned down), shared by the chord and scale views
    container.querySelectorAll('.ref-tuning-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const offset = parseInt(btn.getAttribute('data-offset'), 10);
            if (tuningSpecs[stringCount].offsets.includes(offset)) {
                tuningOffset = offset;
                try { localStorage.setItem('majestictab_tuning_offset', String(offset)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = activeTab === 'scales' ? renderScalesSection() : await renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Capo Buttons
    container.querySelectorAll('.ref-capo-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const fret = parseInt(btn.getAttribute('data-capo'), 10);
            if (capoFrets.includes(fret)) {
                capo = fret;
                try { localStorage.setItem('majestictab_capo', String(fret)); } catch (_) {}
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = await renderChordsSection();
                    attachReferenceEventListeners(container);
                }
            }
        });
    });

    // Chord Root Note Filter Buttons
    container.querySelectorAll('.ref-chord-root-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const root = btn.getAttribute('data-root');
            if (root) {
                selectedRootFilter = root;
                const contentContainer = document.getElementById('refTabContentContainer');
                if (contentContainer) {
                    contentContainer.innerHTML = await renderChordsSection();
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

    // 8. Scale note audio playback (fretboard notes and scale notes)
    const scalesSection = container.querySelector('.ref-scales-section');
    if (scalesSection) {
        const playScaleNoteFrom = (el) => {
            const midi = parseInt(el.getAttribute('data-midi'), 10);
            if (!Number.isFinite(midi)) return;
            playNote(midi);
            el.classList.add('playing');
            setTimeout(() => el.classList.remove('playing'), 250);
        };
        scalesSection.addEventListener('click', (e) => {
            const target = e.target.closest('.ref-note-play');
            if (target) playScaleNoteFrom(target);
        });
        scalesSection.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const target = e.target.closest('.ref-note-play');
            if (!target) return;
            e.preventDefault();
            playScaleNoteFrom(target);
        });
    }
}

function attachCircleSliceListeners() {
    const svgContainer = document.getElementById('refCircleSvgContainer');
    if (!svgContainer) return;
    svgContainer.querySelectorAll('.ref-circle-slice').forEach(slice => {
        const choose = () => {
            const idx = parseInt(slice.getAttribute('data-circle-idx'));
            if (!isNaN(idx)) {
                selectedCircleIndex = idx;
                refreshCircleSection();
                document.querySelector(`.ref-circle-slice[data-circle-idx="${idx}"]`)?.focus();
            }
        };
        slice.addEventListener('click', choose);
        slice.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
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

// Jump to the Chord Library filtered to the clicked chord's root and family, or play chord sound
function attachCircleChordLinks(container) {
    const infoPanel = document.getElementById('refCircleInfoPanel');
    if (!infoPanel || !container) return;
    infoPanel.querySelectorAll('.ref-circle-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            circleKeyMode = btn.dataset.mode === 'minor' ? 'minor' : 'major';
            refreshCircleSection();
        });
    });
    infoPanel.querySelectorAll('.ref-chord-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const symbol = btn.getAttribute('data-chord');
            const isDim = symbol.endsWith('°');
            const isMinor = !isDim && symbol.endsWith('m');
            const symbolRoot = symbol.match(/^[A-G][♯♭]?/)[0];
            selectedRootFilter = chordRootAliases[symbolRoot] || symbolRoot;
            selectedShapeFamily = isDim ? 'dim' : isMinor ? 'minor' : 'major';
            setChordViewMode('note');
            activeTab = 'chords';
            renderReferenceLibraryView(container);
            notifyReferenceTab();
        });
    });
    infoPanel.querySelectorAll('.ref-deg-chord-btn').forEach(btn => {
        const playChord = async () => {
            const symbol = btn.getAttribute('data-chord');
            if (!symbol) return;
            let list = getNormalizedChordListSync(stringCount);
            if (!list) {
                try {
                    list = await getNormalizedChordList(stringCount);
                } catch (_) {}
            }
            const notes = getChordNotesForSymbol(symbol, list);
            if (notes && notes.length) {
                strumChord(notes);
            }
            const card = btn.closest('.ref-chord-deg-card') || btn;
            card.classList.add('playing');
            setTimeout(() => card.classList.remove('playing'), 250);
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            playChord();
        });
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                playChord();
            }
        });
    });
}
