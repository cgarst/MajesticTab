// chordEngine.js
// Source-of-truth chord database engine for MajesticTab.
// Powered by chords-db JSON datasets for 6, 7, and 8-string guitars with Option B Moveable Shape derivation.
// Attribution: guitar chord data derived from chords-db by David Rubert (https://github.com/tombatossals/chords-db, MIT License).

export const KEY_DISPLAY_MAP = {
    C: 'C',
    Csharp: 'C♯',
    D: 'D',
    Eb: 'E♭',
    E: 'E',
    F: 'F',
    Fsharp: 'F♯',
    G: 'G',
    Ab: 'A♭',
    A: 'A',
    Bb: 'B♭',
    B: 'B'
};

export const DISPLAY_KEY_TO_CHORDDB = {
    'C': 'C',
    'C♯': 'Csharp',
    'C#': 'Csharp',
    'D♭': 'Csharp',
    'Db': 'Csharp',
    'D': 'D',
    'D♯': 'Eb',
    'D#': 'Eb',
    'E♭': 'Eb',
    'Eb': 'Eb',
    'E': 'E',
    'F': 'F',
    'F♯': 'Fsharp',
    'F#': 'Fsharp',
    'G♭': 'Fsharp',
    'Gb': 'Fsharp',
    'G': 'G',
    'G♯': 'Ab',
    'G#': 'Ab',
    'A♭': 'Ab',
    'Ab': 'Ab',
    'A': 'A',
    'A♯': 'Bb',
    'A#': 'Bb',
    'B♭': 'Bb',
    'Bb': 'Bb',
    'B': 'B'
};

export const KEY_PITCH_MAP = {
    C: 0,
    Csharp: 1,
    D: 2,
    Eb: 3,
    E: 4,
    F: 5,
    Fsharp: 6,
    G: 7,
    Ab: 8,
    A: 9,
    Bb: 10,
    B: 11
};

export const TUNINGS_MIDI = {
    6: [40, 45, 50, 55, 59, 64],             // E2, A2, D3, G3, B3, E4
    7: [35, 40, 45, 50, 55, 59, 64],         // B1, E2, A2, D3, G3, B3, E4
    8: [30, 35, 40, 45, 50, 55, 59, 64]      // F#1, B1, E2, A2, D3, G3, B3, E4
};

export const DEGREE_MAP = {
    0: 'R',
    1: '♭9',
    2: '9',
    3: '♭3',
    4: '3',
    5: '11',
    6: '♭5',
    7: '5',
    8: '♯5',
    9: '6',
    10: '♭7',
    11: '7'
};

/**
 * Format a chord suffix for UI display.
 */
export function formatSuffix(suffix) {
    if (!suffix || suffix === 'major') return '';
    if (suffix === 'minor') return 'm';
    return suffix
        .replace(/#/g, '♯')
        .replace(/b/g, '♭');
}

/**
 * Categorize a chord suffix into one of MajesticTab's 5 harmonic families.
 */
export function categorizeSuffix(suffix) {
    if (!suffix) return 'Major';
    const s = suffix.toLowerCase();
    if (s.includes('dim') || s.includes('aug') || s.includes('alt')) return 'Dim/Aug';
    if (s.includes('sus')) return 'Suspended';
    if (s.startsWith('m') && !s.startsWith('maj')) return 'Minor';
    if (['7', '9', '11', '13', '7b5', '7b9', '7#9', '9b5', '9#11', '7/g'].includes(s)) return 'Dominant';
    return 'Major';
}

const datasets = {};
const normalizedCache = {};
const moveableCache = {};

/**
 * Load raw chord dataset JSON asynchronously.
 */
export async function getChordDataset(stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    if (datasets[count]) return datasets[count];

    let json;
    if (typeof process !== 'undefined' && process.versions?.node) {
        const fs = await import('node:fs/promises');
        const fileUrl = new URL(`../chordDb/guitar${count}.json`, import.meta.url);
        const data = await fs.readFile(fileUrl, 'utf-8');
        json = JSON.parse(data);
    } else {
        const res = await fetch(new URL(`../chordDb/guitar${count}.json`, import.meta.url));
        json = await res.json();
    }
    datasets[count] = json;
    return json;
}

/**
 * Get normalized chord list (flat array matching referenceLibrary.js chordData schema).
 * Frets are returned as absolute string frets: e.g. "x 3 2 0 1 0" or "8 10 10 9 8 8".
 */
export async function getNormalizedChordList(stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    if (normalizedCache[count]) return normalizedCache[count];

    const ds = await getChordDataset(count);
    const result = [];

    const keys = Object.keys(ds.chords);
    for (const key of keys) {
        const chordList = ds.chords[key] || [];
        const displayKey = KEY_DISPLAY_MAP[key] || key;

        for (const chord of chordList) {
            const suffix = chord.suffix;
            const displayName = displayKey + formatSuffix(suffix);
            const cat = chord.cat || categorizeSuffix(suffix);

            const positions = chord.positions || [];
            for (let i = 0; i < positions.length; i++) {
                const pos = positions[i];
                const baseFret = pos.baseFret || 1;
                // Convert relative frets in chords-db to absolute frets for rendering
                const absFrets = pos.frets.map(f => {
                    if (f < 0) return 'x';
                    if (f === 0) return '0';
                    return String(baseFret + f - 1);
                });

                const isBarre = (pos.barres && pos.barres.length > 0) || (pos.barreChord === 1);
                const isDefault = pos.default !== undefined ? (pos.default ? 1 : 0) : (i === 0 ? 1 : 0);

                result.push({
                    name: displayName,
                    key,
                    suffix,
                    cat: pos.cat || cat,
                    frets: absFrets.join(' '),
                    startFret: baseFret,
                    barreChord: isBarre ? 1 : 0,
                    default: isDefault,
                    barres: pos.barres || []
                });
            }
        }
    }

    normalizedCache[count] = result;
    return result;
}

/**
 * Synchronous accessor for already loaded/cached normalized chord list.
 */
export function getNormalizedChordListSync(stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    return normalizedCache[count] || null;
}

/**
 * Derive moveable chord shapes using Option B (harmonic intervals + standard tuning geometry).
 * Returns pitch-invariant shape templates filtered from closed positions.
 */
export async function deriveMoveableShapes(stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    if (moveableCache[count]) return moveableCache[count];

    const ds = await getChordDataset(count);
    const tuning = TUNINGS_MIDI[count] || TUNINGS_MIDI[6];
    const numStrings = tuning.length;

    const shapesMap = new Map();
    const stringNames = numStrings === 6
        ? ['6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)']
        : numStrings === 7
            ? ['7th (B)', '6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)']
            : ['8th (F♯)', '7th (B)', '6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)'];

    const keys = Object.keys(ds.chords);

    for (const key of keys) {
        const rootPitchClass = KEY_PITCH_MAP[key] ?? 0;
        const chordList = ds.chords[key] || [];

        for (const chord of chordList) {
            const suffix = chord.suffix;
            const cat = chord.cat || categorizeSuffix(suffix);
            const positions = chord.positions || [];

            for (const pos of positions) {
                const baseFret = pos.baseFret || 1;
                // Compute absolute frets
                const absFrets = pos.frets.map(f => {
                    if (f < 0) return -1;
                    if (f === 0) return 0;
                    return baseFret + f - 1;
                });

                // Rule 1: Moveable shapes cannot contain open strings (nut)
                if (absFrets.some(f => f === 0)) continue;

                // Rule 2: Find lowest string with the root note
                let rootString = -1;
                let rootFret = -1;
                for (let s = 0; s < numStrings; s++) {
                    const f = absFrets[s];
                    if (f > 0) {
                        const pitch = tuning[s] + f;
                        if (pitch % 12 === rootPitchClass) {
                            rootString = s;
                            rootFret = f;
                            break;
                        }
                    }
                }

                if (rootString === -1 || rootFret === -1) continue; // Skip rootless voicings for basic moveable view

                // Rule 3: Compute relative offsets and scale degrees
                const offsets = [];
                const labels = [];
                for (let s = 0; s < numStrings; s++) {
                    const f = absFrets[s];
                    if (f < 0) {
                        offsets.push(null);
                        labels.push(null);
                    } else {
                        const offset = f - rootFret;
                        offsets.push(offset);
                        const pitch = tuning[s] + f;
                        const interval = ((pitch - rootPitchClass) % 12 + 12) % 12;
                        labels.push(DEGREE_MAP[interval] || String(interval));
                    }
                }

                // Check fret reach/span (max offset - min offset <= 5)
                const playedOffsets = offsets.filter(o => o !== null);
                if (playedOffsets.length === 0) continue;
                const span = Math.max(...playedOffsets) - Math.min(...playedOffsets);
                if (span > 5) continue;

                // Name the shape (e.g. CAGED naming for 6-string)
                let shapeFamily = `Root on ${stringNames[rootString]}`;
                if (numStrings === 6) {
                    if (rootString === 0 && offsets[1] === 2 && offsets[2] === 2) shapeFamily = 'E shape';
                    else if (rootString === 1 && offsets[2] === 2 && offsets[3] === 2) shapeFamily = 'A shape';
                    else if (rootString === 1 && offsets[2] === -1 && offsets[3] === -3) shapeFamily = 'C shape';
                    else if (rootString === 2 && offsets[3] === 2 && offsets[4] === 3) shapeFamily = 'D shape';
                    else if (rootString === 0 && offsets[1] === -1 && offsets[2] === -3) shapeFamily = 'G shape';
                }

                const signature = `${suffix}|${rootString}|${offsets.join(',')}`;
                if (!shapesMap.has(signature)) {
                    // Normalize relative frets for diagram display so min non-null offset is at least 1
                    const minOffset = Math.min(...playedOffsets);
                    const shift = minOffset < 1 ? (1 - minOffset) : 0;
                    const diagramFrets = offsets.map(o => o === null ? 'x' : String(o + shift)).join(' ');

                    shapesMap.set(signature, {
                        id: signature,
                        name: formatSuffix(suffix) || 'Major',
                        suffix,
                        cat,
                        rootString,
                        rootStringName: stringNames[rootString],
                        shapeFamily,
                        offsets,
                        labels,
                        frets: diagramFrets,
                        startFret: 1,
                        rootFretOffset: shift,
                        barreChord: pos.barres && pos.barres.length > 0 ? 1 : 0,
                        isMoveable: true
                    });
                }
            }
        }
    }

    const shapes = Array.from(shapesMap.values());
    moveableCache[count] = shapes;
    return shapes;
}

/**
 * Synchronous accessor for already derived/cached moveable shapes.
 */
export function deriveMoveableShapesSync(stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    return moveableCache[count] || null;
}
