// chordShapes.js
// Generates the movable chord shape catalogue (no open strings, so one shape plays all twelve roots) from the
// intervals of each chord type and the geometry of the tuning, grouped by family > chord type > root string.
//
// How it works: every chord type is a set of degrees. Root C is placed on the tuning and every fret window of
// five frets (1 to 12) is searched, string by string, for notes that are chord tones. A voicing is kept when it
// holds the root and every required degree, is played on adjacent strings (one muted string inside is allowed),
// stays inside a five-fret stretch, and can be fingered with four fingers (one of them a barre on the lowest
// fret). The shape is then identified by its frets relative to its lowest fret, so the twelve roots collapse
// into one shape. A bounded number is kept per string set and bass note, which is the grid a method book
// teaches rather than every shape that is mathematically possible.

import { TUNINGS_MIDI } from './chordEngine.js';

const SEMI = {
    'R': 0, '♭9': 1, '♭2': 1, '2': 2, '9': 2, '♯9': 3, '♭3': 3, '3': 4, '4': 5, '11': 5, '♯11': 6, '♭5': 6,
    '5': 7, '♯5': 8, '♭13': 8, '6': 9, '13': 9, '♭♭7': 9, '♭7': 10, '7': 11
};

export const SHAPE_FAMILIES = [
    { id: 'major', name: 'Major', blurb: 'root, major third, fifth' },
    { id: 'minor', name: 'Minor', blurb: 'root, minor third, fifth' },
    { id: 'dominant', name: 'Dominant seventh', blurb: 'root, major third, fifth, minor seventh' },
    { id: 'altered', name: 'Altered dominant', blurb: 'a dominant seventh with its fifth or ninth moved' },
    { id: 'sus', name: 'Suspended and power', blurb: 'root and fifth, with a second or fourth where the third would be, or nothing at all' },
    { id: 'dim', name: 'Diminished and half-diminished', blurb: 'root, minor third, flat fifth' },
    { id: 'aug', name: 'Augmented', blurb: 'root, major third, sharp fifth' }
];

// tones: every degree of the chord. optional: degrees a voicing may leave out. anyOf: at least one of these must sound.
const T = (family, id, symbol, name, tones, optional = [], extra = {}) => ({ family, id, symbol, name, tones, optional, ...extra });

export const SHAPE_TYPES = [
    T('major', 'major', 'maj', 'Major triad', ['R', '3', '5']),
    T('major', 'maj7', 'maj7', 'Major seventh', ['R', '3', '5', '7'], ['5']),
    T('major', 'maj7b5', 'maj7♭5', 'Major seven flat five', ['R', '3', '♭5', '7']),
    T('major', 'maj7sharp5', 'maj7♯5', 'Major seven sharp five', ['R', '3', '♯5', '7']),
    T('major', 'maj9', 'maj9', 'Major ninth', ['R', '3', '5', '7', '9'], ['5']),
    T('major', 'maj11', 'maj11', 'Major eleventh', ['R', '3', '5', '7', '9', '11'], ['5', '9']),
    T('major', 'maj13', 'maj13', 'Major thirteenth', ['R', '3', '5', '7', '9', '13'], ['5', '9']),
    T('major', 'add9', 'add9', 'Add nine', ['R', '3', '5', '9'], ['5']),
    T('major', '6', '6', 'Major sixth', ['R', '3', '5', '6'], ['5']),
    T('major', '69', '69', 'Six-nine', ['R', '3', '5', '6', '9'], ['5']),

    T('minor', 'minor', 'm', 'Minor triad', ['R', '♭3', '5']),
    T('minor', 'm6', 'm6', 'Minor sixth', ['R', '♭3', '5', '6'], ['5']),
    T('minor', 'm69', 'm69', 'Minor six-nine', ['R', '♭3', '5', '6', '9'], ['5']),
    T('minor', 'm7', 'm7', 'Minor seventh', ['R', '♭3', '5', '♭7'], ['5']),
    T('minor', 'm9', 'm9', 'Minor ninth', ['R', '♭3', '5', '♭7', '9'], ['5']),
    T('minor', 'm11', 'm11', 'Minor eleventh', ['R', '♭3', '5', '♭7', '9', '11'], ['5', '9']),
    T('minor', 'mmaj7', 'mmaj7', 'Minor major seventh', ['R', '♭3', '5', '7'], ['5']),
    T('minor', 'mmaj9', 'mmaj9', 'Minor major ninth', ['R', '♭3', '5', '7', '9'], ['5']),
    T('minor', 'mmaj11', 'mmaj11', 'Minor major eleventh', ['R', '♭3', '5', '7', '9', '11'], ['5', '9']),
    T('minor', 'madd9', 'madd9', 'Minor add nine', ['R', '♭3', '5', '9'], ['5']),

    T('dominant', '7', '7', 'Dominant seventh', ['R', '3', '5', '♭7'], ['5']),
    T('dominant', '9', '9', 'Dominant ninth', ['R', '3', '5', '♭7', '9'], ['5']),
    T('dominant', '11', '11', 'Dominant eleventh', ['R', '3', '5', '♭7', '9', '11'], ['5', '9']),
    T('dominant', '13', '13', 'Dominant thirteenth', ['R', '3', '5', '♭7', '9', '13'], ['5', '9']),

    T('altered', '7b5', '7♭5', 'Seven flat five', ['R', '3', '♭5', '♭7']),
    T('altered', 'alt', 'alt', 'Altered dominant', ['R', '3', '♭7', '♭9', '♯9', '♭5', '♯5'], ['♭9', '♯9', '♭5', '♯5'], { anyOf: ['♭9', '♯9', '♭5', '♯5'] }),
    T('altered', 'aug7', 'aug7', 'Augmented seventh', ['R', '3', '♯5', '♭7']),
    T('altered', '9b5', '9♭5', 'Nine flat five', ['R', '3', '♭5', '♭7', '9']),
    T('altered', 'aug9', 'aug9', 'Augmented ninth', ['R', '3', '♯5', '♭7', '9']),
    T('altered', '7b9', '7♭9', 'Seven flat nine', ['R', '3', '5', '♭7', '♭9'], ['5']),
    T('altered', '7sharp9', '7♯9', 'Seven sharp nine', ['R', '3', '5', '♭7', '♯9'], ['5']),
    T('altered', '9sharp11', '9♯11', 'Nine sharp eleven', ['R', '3', '5', '♭7', '9', '♯11'], ['5']),

    T('sus', 'sus2', 'sus2', 'Suspended second', ['R', '2', '5']),
    T('sus', 'sus4', 'sus4', 'Suspended fourth', ['R', '4', '5']),
    T('sus', 'sus2sus4', 'sus2sus4', 'Suspended second and fourth', ['R', '2', '4', '5']),
    T('sus', '5', '5', 'Power chord', ['R', '5']),
    T('sus', '7sus4', '7sus4', 'Dominant seventh suspended fourth', ['R', '4', '5', '♭7'], ['5']),

    T('dim', 'dim', 'dim', 'Diminished triad', ['R', '♭3', '♭5']),
    T('dim', 'dim7', 'dim7', 'Diminished seventh', ['R', '♭3', '♭5', '♭♭7']),
    T('dim', 'm7b5', 'm7♭5', 'Half-diminished seventh', ['R', '♭3', '♭5', '♭7']),
    T('dim', 'mmaj7b5', 'mmaj7♭5', 'Minor major seven flat five', ['R', '♭3', '♭5', '7']),

    T('aug', 'aug', 'aug', 'Augmented triad', ['R', '3', '♯5'])
];

export const SHAPE_STRING_NAMES = {
    6: ['6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)'],
    7: ['7th (B)', '6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)'],
    8: ['8th (F♯)', '7th (B)', '6th (E)', '5th (A)', '4th (D)', '3rd (G)', '2nd (B)', '1st (e)']
};

const WINDOW = 4;          // frets in a stretch
const MAX_FRET_START = 12; // the lowest fret of a shape: twelve starts cover all twelve roots
const INVERSION_BASS = new Set(['3', '♭3', '2', '4', '5', '♭5', '♯5', '♭7', '7', '♭♭7', '6']); // members a bass note may be

// Close-position tetrads dropped: 'drop2' lowers the second voice from the top an octave, 'drop3' the third
function dropKind(pitches) {
    if (pitches.length !== 4) return null;
    const [a, b, c, d] = pitches;
    if (d - b >= 12) return null;
    if (a + 12 > c && a + 12 < d) return 'drop2';
    if (a + 12 > b && a + 12 < c) return 'drop3';
    return null;
}

export function getShapeTypes(familyId) {
    return SHAPE_TYPES.filter(t => t.family === familyId);
}

export function getShapeType(typeId) {
    return SHAPE_TYPES.find(t => t.id === typeId) || null;
}

function generateForType(type, stringCount) {
    const tuning = TUNINGS_MIDI[stringCount] || TUNINGS_MIDI[6];
    const n = tuning.length;
    const degBySemi = new Map(type.tones.map(d => [SEMI[d], d]));
    const required = type.tones.filter(d => !type.optional.includes(d) && !(type.anyOf || []).includes(d));
    const requiredSemis = required.map(d => SEMI[d]);
    const anyOfSemis = (type.anyOf || []).map(d => SEMI[d]);
    const minNotes = Math.min(3, Math.max(2, required.length));
    const found = new Map(); // signature -> shape
    const buckets = new Map(); // setKey|bass -> shapes

    for (let w = 1; w <= MAX_FRET_START; w++) {
        const options = [];
        for (let s = 0; s < n; s++) {
            const o = [-1];
            for (let f = w; f < w + WINDOW; f++) if (degBySemi.has((tuning[s] + f) % 12)) o.push(f);
            options.push(o);
        }
        const frets = new Array(n).fill(-1);
        const visit = (s) => {
            if (s === n) { consider(frets, w); return; }
            for (const f of options[s]) { frets[s] = f; visit(s + 1); }
            frets[s] = -1;
        };
        visit(0);
    }

    function consider(frets, w) {
        const played = [];
        for (let s = 0; s < n; s++) if (frets[s] > 0) played.push(s);
        if (played.length < minNotes) return;
        const lo = played[0], hi = played[played.length - 1];
        if ((hi - lo + 1) - played.length > 1) return; // at most one muted string inside
        let minFret = Infinity, maxFret = 0;
        for (const s of played) { minFret = Math.min(minFret, frets[s]); maxFret = Math.max(maxFret, frets[s]); }
        if (minFret !== w || maxFret - minFret > WINDOW - 1) return;
        const semis = new Set(played.map(s => (tuning[s] + frets[s]) % 12));
        if (!semis.has(0)) return;
        if (!requiredSemis.every(x => semis.has(x))) return;
        if (anyOfSemis.length && !anyOfSemis.some(x => semis.has(x))) return;
        const atLow = played.filter(s => frets[s] === minFret).length;
        const fingers = (played.length - atLow) + (atLow > 0 ? 1 : 0);
        if (fingers > 4) return;

        const rel = frets.map(f => (f > 0 ? f - minFret : null));
        const signature = rel.map(v => (v === null ? 'x' : v)).join(',');
        if (found.has(signature)) return;

        const bassSemi = (tuning[lo] + frets[lo]) % 12;
        const adjacent = hi - lo + 1 === played.length;
        const degs = new Set(played.map(x => degBySemi.get((tuning[x] + frets[x]) % 12)));
        let drop = bassSemi !== 0 && degs.size === 4 ? dropKind(played.map(x => tuning[x] + frets[x])) : null;
        if (drop === 'drop2' && !adjacent) drop = null;
        if (drop === 'drop3' && played[1] - played[0] !== 2) drop = null;
        if (bassSemi !== 0 && !drop && !INVERSION_BASS.has(degBySemi.get(bassSemi))) return;
        const rootString = played.find(s => (tuning[s] + frets[s]) % 12 === 0);
        const labels = frets.map((f, s) => (f > 0 ? degBySemi.get((tuning[s] + f) % 12) : null));
        const shape = {
            id: `${type.id}|${signature}`,
            typeId: type.id,
            family: type.family,
            name: type.symbol,
            suffix: type.id,
            rootString,
            rootStringName: SHAPE_STRING_NAMES[stringCount][rootString],
            lowString: lo,
            bassDegree: degBySemi.get(bassSemi),
            isInversion: bassSemi !== 0,
            drop,
            offsets: rel,
            labels,
            frets: rel.map(v => (v === null ? 'x' : String(v + 1))).join(' '),
            startFret: 1,
            notes: played.length,
            tones: semis.size,
            span: maxFret - minFret + 1,
            barreChord: atLow > 1 ? 1 : 0,
            isMoveable: true
        };
        found.set(signature, shape);
        const key = drop ? `${drop}|${played.join('.')}` : (bassSemi === 0 ? `root|${lo}` : `inv|${lo}|${bassSemi}`);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(shape);
    }

    // The basic voicing (fewest notes, then most compact) per root string, bass note or string set, and for root
    // position also the fullest one (most chord tones). This is the grid a method book teaches.
    const cmpBasic = (a, b) => a.notes - b.notes || a.span - b.span || a.offsets.join().localeCompare(b.offsets.join());
    const cmpFull = (a, b) => b.tones - a.tones || a.span - b.span || b.notes - a.notes;
    const kept = [];
    for (const [key, list] of buckets) {
        list.sort(cmpBasic);
        const basic = list[0];
        kept.push(basic);
        if (key.startsWith('root|')) {
            const full = [...list].sort(cmpFull)[0];
            if (full !== basic && full.tones > basic.tones) { full.fuller = true; kept.push(full); }
        }
    }
    kept.sort((a, b) => a.lowString - b.lowString || a.notes - b.notes || a.span - b.span);
    return kept;
}

const cache = {};

/**
 * Movable shapes for one chord type: { root: [{ string, name, shapes }...], inversions: [{ degree, shapes }...] }
 * Root-position shapes are grouped by the string the root sits on, inversions by the degree in the bass.
 */
export function getShapesForType(typeId, stringCount = 6) {
    const count = [6, 7, 8].includes(Number(stringCount)) ? Number(stringCount) : 6;
    const type = getShapeType(typeId);
    if (!type) return { root: [], inversions: [], drops: { drop2: [], drop3: [] }, total: 0 };
    const key = `${count}|${typeId}`;
    if (!cache[key]) {
        const shapes = generateForType(type, count);
        const root = [];
        const inversions = [];
        const drops = { drop2: [], drop3: [] };
        for (const sh of shapes) {
            if (sh.drop) {
                drops[sh.drop].push(sh);
            } else if (!sh.isInversion) {
                let g = root.find(x => x.string === sh.lowString);
                if (!g) { g = { string: sh.lowString, name: SHAPE_STRING_NAMES[count][sh.lowString], shapes: [] }; root.push(g); }
                g.shapes.push(sh);
            } else {
                let g = inversions.find(x => x.degree === sh.bassDegree);
                if (!g) { g = { degree: sh.bassDegree, shapes: [] }; inversions.push(g); }
                g.shapes.push(sh);
            }
        }
        root.sort((a, b) => a.string - b.string);
        const order = type.tones;
        inversions.sort((a, b) => order.indexOf(a.degree) - order.indexOf(b.degree));
        drops.drop2.sort((a, b) => a.lowString - b.lowString);
        drops.drop3.sort((a, b) => a.lowString - b.lowString);
        cache[key] = { root, inversions, drops, total: shapes.length, type };
    }
    return cache[key];
}
