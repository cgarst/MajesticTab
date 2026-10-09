// tuningUtils.js
// Helpers for parsing, formatting, and detecting guitar tunings & string counts from score data and binary files.
import { applyFileAdapters } from '../fileAdapters.js';

export const KNOWN_TUNINGS = [
    { name: 'Standard (E A D G B E)', shortName: 'E Standard', midi: [64, 59, 55, 50, 45, 40], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'] },
    { name: 'Drop D (D A D G B E)', shortName: 'Drop D', midi: [64, 59, 55, 50, 45, 38], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'D2'] },
    { name: 'Eb Standard (Eb Ab Db Gb Bb Eb)', shortName: 'Eb Standard', midi: [63, 58, 54, 49, 44, 39], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Eb2'] },
    { name: 'Drop Db (Db Ab Db Gb Bb Eb)', shortName: 'Drop Db', midi: [63, 58, 54, 49, 44, 37], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Db2'] },
    { name: 'D Standard (D G C F A D)', shortName: 'D Standard', midi: [62, 57, 53, 48, 43, 38], strings: ['D4', 'A3', 'F3', 'C3', 'G2', 'D2'] },
    { name: 'Drop C (C G C F A D)', shortName: 'Drop C', midi: [62, 57, 53, 48, 43, 36], strings: ['D4', 'A3', 'F3', 'C3', 'G2', 'C2'] },
    { name: 'C# Standard (C# F# B E G# C#)', shortName: 'C# Standard', midi: [61, 56, 52, 47, 42, 37], strings: ['C#4', 'G#3', 'E3', 'B2', 'F#2', 'C#2'] },
    { name: 'Drop B (B F# B E G# C#)', shortName: 'Drop B', midi: [61, 56, 52, 47, 42, 35], strings: ['C#4', 'G#3', 'E3', 'B2', 'F#2', 'B1'] },
    { name: 'C Standard (C F Bb Eb G C)', shortName: 'C Standard', midi: [60, 55, 51, 46, 41, 36], strings: ['C4', 'G3', 'Eb3', 'Bb2', 'F2', 'C2'] },
    { name: 'Drop A# (A# F A# D# G C)', shortName: 'Drop A#', midi: [60, 55, 51, 46, 41, 34], strings: ['C4', 'G3', 'Eb3', 'Bb2', 'F2', 'Bb1'] },
    { name: 'B Standard (B E A D F# B)', shortName: 'B Standard', midi: [59, 54, 50, 45, 40, 35], strings: ['B3', 'F#3', 'D3', 'A2', 'E2', 'B1'] },
    { name: 'Drop A (A E A D F# B)', shortName: 'Drop A', midi: [59, 54, 50, 45, 40, 33], strings: ['B3', 'F#3', 'D3', 'A2', 'E2', 'A1'] },
    { name: 'Open D (D A D F# A D)', shortName: 'Open D', midi: [62, 57, 54, 50, 45, 38], strings: ['D4', 'A3', 'F#3', 'D3', 'A2', 'D2'] },
    { name: 'Open G (D G D G B D)', shortName: 'Open G', midi: [62, 59, 55, 50, 43, 38], strings: ['D4', 'B3', 'G3', 'D3', 'G2', 'D2'] },
    { name: 'Open E (E B E G# B E)', shortName: 'Open E', midi: [64, 59, 56, 52, 47, 40], strings: ['E4', 'B3', 'G#3', 'E3', 'B2', 'E2'] },
    { name: 'Open A (E A E A C# E)', shortName: 'Open A', midi: [64, 61, 57, 52, 45, 40], strings: ['E4', 'C#4', 'A3', 'E3', 'A2', 'E2'] },
    { name: 'DADGAD (D A D G A D)', shortName: 'DADGAD', midi: [62, 57, 55, 50, 45, 38], strings: ['D4', 'A3', 'G3', 'D3', 'A2', 'D2'] },
    // 7-String
    { name: '7-String Standard (B E A D G B E)', shortName: '7-String Standard', midi: [64, 59, 55, 50, 45, 40, 35], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1'] },
    { name: '7-String Drop A (A E A D G B E)', shortName: '7-String Drop A', midi: [64, 59, 55, 50, 45, 40, 33], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'A1'] },
    { name: '7-String Drop G (G D G C F A D)', shortName: '7-String Drop G', midi: [62, 57, 53, 48, 43, 38, 31], strings: ['D4', 'A3', 'F3', 'C3', 'G2', 'D2', 'G1'] },
    { name: '7-String Drop E (E B E A D G B)', shortName: '7-String Drop E', midi: [59, 55, 50, 45, 40, 35, 28], strings: ['B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'E1'] },
    { name: '7-String Half-Step Down (Bb Eb Ab Db Gb Bb Eb)', shortName: '7-String Eb', midi: [63, 58, 54, 49, 44, 39, 34], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Eb2', 'Bb1'] },
    // 8-String
    { name: '8-String Standard (F# B E A D G B E)', shortName: '8-String Standard', midi: [64, 59, 55, 50, 45, 40, 35, 30], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'F#1'] },
    { name: '8-String Drop E (E B E A D G B E)', shortName: '8-String Drop E', midi: [64, 59, 55, 50, 45, 40, 35, 28], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'E1'] },
    { name: '8-String Half-Step Down (F Bb Eb Ab Db Gb Bb Eb)', shortName: '8-String F', midi: [63, 58, 54, 49, 44, 39, 34, 29], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Eb2', 'Bb1', 'F1'] },
    // Bass (4-string)
    { name: 'Bass Standard (E A D G)', shortName: 'Bass Standard', midi: [43, 38, 33, 28], strings: ['G2', 'D2', 'A1', 'E1'] },
    { name: 'Bass Drop D (D A D G)', shortName: 'Bass Drop D', midi: [43, 38, 33, 26], strings: ['G2', 'D2', 'A1', 'D1'] },
    { name: 'Bass Eb Standard (Eb Ab Db Gb)', shortName: 'Bass Eb', midi: [42, 37, 32, 27], strings: ['Gb2', 'Db2', 'Ab1', 'Eb1'] },
    { name: 'Bass D Standard (D G C F)', shortName: 'Bass D Standard', midi: [41, 36, 31, 26], strings: ['F2', 'C2', 'G1', 'D1'] },
    // Bass (5-string)
    { name: '5-String Bass (B E A D G)', shortName: '5-String Bass', midi: [43, 38, 33, 28, 23], strings: ['G2', 'D2', 'A1', 'E1', 'B0'] },
    { name: '5-String Bass Drop A (A E A D G)', shortName: '5-String Bass Drop A', midi: [43, 38, 33, 28, 21], strings: ['G2', 'D2', 'A1', 'E1', 'A-1'] },
    // Bass (6-string)
    { name: '6-String Bass (B E A D G C)', shortName: '6-String Bass', midi: [48, 43, 38, 33, 28, 23], strings: ['C3', 'G2', 'D2', 'A1', 'E1', 'B0'] },
];

export const CUSTOM_TUNINGS_STORAGE_KEY = 'majestictab_custom_tuning_names';
export const INSTRUMENT_MODE_STORAGE_KEY = 'majestictab_instrument_mode';

export function getInstrumentMode() {
    try {
        if (typeof localStorage === 'undefined') return 'guitar';
        const mode = localStorage.getItem('instrumentMode') || localStorage.getItem(INSTRUMENT_MODE_STORAGE_KEY);
        return mode === 'bass' ? 'bass' : 'guitar';
    } catch {
        return 'guitar';
    }
}

export function setInstrumentMode(mode) {
    const safeMode = mode === 'bass' ? 'bass' : 'guitar';
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('instrumentMode', safeMode);
            localStorage.setItem(INSTRUMENT_MODE_STORAGE_KEY, safeMode);
        }
    } catch (e) {
        console.warn('Could not save instrument mode:', e);
    }
    return safeMode;
}

export function isBassTuning(tuningInput) {
    if (!tuningInput) return false;
    const str = typeof tuningInput === 'string' ? tuningInput.trim() : '';
    if (str && /\bbass\b/i.test(str)) return true;

    const info = (typeof tuningInput === 'object' && tuningInput !== null && tuningInput.key)
        ? tuningInput
        : getTuningInfo(tuningInput);

    if (!info) {
        return /\bbass\b/i.test(str);
    }

    if (/\bbass\b/i.test(info.displayName || '') ||
        /\bbass\b/i.test(info.defaultName || '') ||
        /\bbass\b/i.test(info.notes || '')) {
        return true;
    }
    if (info.key && (info.key.toLowerCase().includes('bass') || info.key === 'EADG' || info.key === 'DADG' || info.key === 'BEADG' || info.key === 'BEADGC' || info.key === 'AEADG' || info.key === 'EbAbDbGb' || info.key === 'DGCF')) {
        return true;
    }
    return false;
}

export function isGuitarTuning(tuningInput) {
    return !isBassTuning(tuningInput);
}

export function isTuningMatchingInstrument(tuningInput, instrumentMode = getInstrumentMode()) {
    return instrumentMode === 'bass' ? isBassTuning(tuningInput) : isGuitarTuning(tuningInput);
}

export function getCustomTuningNames() {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(CUSTOM_TUNINGS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

export function getCustomTuningName(tuningKey) {
    if (!tuningKey) return null;
    const names = getCustomTuningNames();
    return names[tuningKey] || null;
}

export function setCustomTuningName(tuningKey, name) {
    if (!tuningKey || typeof localStorage === 'undefined') return;
    const names = getCustomTuningNames();
    if (name && name.trim()) {
        names[tuningKey] = name.trim();
    } else {
        delete names[tuningKey];
    }
    try {
        localStorage.setItem(CUSTOM_TUNINGS_STORAGE_KEY, JSON.stringify(names));
    } catch (e) {
        console.warn('Could not save custom tuning name:', e);
    }
}

function noteToPitchClass(noteStr) {
    const clean = (noteStr || '').replace(/[^a-zA-Z#b]/g, '').toUpperCase();
    const map = {
        'C': 0, 'B#': 0,
        'C#': 1, 'DB': 1,
        'D': 2,
        'D#': 3, 'EB': 3,
        'E': 4, 'FB': 4,
        'F': 5, 'E#': 5,
        'F#': 6, 'GB': 6,
        'G': 7,
        'G#': 8, 'AB': 8,
        'A': 9,
        'A#': 10, 'BB': 10,
        'B': 11, 'CB': 11
    };
    return map[clean] ?? null;
}

function arePitchClassesEqual(arr1, arr2) {
    if (!arr1 || !arr2 || arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
        const p1 = noteToPitchClass(arr1[i]);
        const p2 = noteToPitchClass(arr2[i]);
        if (p1 === null || p2 === null || p1 !== p2) return false;
    }
    return true;
}

/**
 * Returns structured tuning metadata: canonical key (e.g. EADGBE), notes (e.g. E A D G B E),
 * default name, display name (with user override), and string count.
 */
export function getTuningInfo(tuningInput) {
    if (!tuningInput || typeof tuningInput !== 'string') return null;
    const trimmed = tuningInput.trim();
    if (!trimmed || trimmed === 'Untuned / Other' || trimmed.toLowerCase() === 'untuned' || trimmed.toLowerCase() === 'other') return null;

    // 1. Direct match on KNOWN_TUNINGS by name, shortName, key, notes, etc.
    for (const known of KNOWN_TUNINGS) {
        const noteArr = [...known.strings].reverse().map(s => s.replace(/[^a-zA-Z#b]/g, ''));
        const key = noteArr.join('');
        const notes = noteArr.join(' ');
        const nameBeforeParen = known.name.split('(')[0].trim();
        const notesInsideParen = known.name.match(/\(([^)]+)\)/)?.[1]?.trim() || '';
        const defaultName = known.shortName === 'E Standard' ? 'Standard' : (known.shortName || nameBeforeParen);

        if (
            trimmed.toLowerCase() === key.toLowerCase() ||
            trimmed.toLowerCase() === notes.toLowerCase() ||
            trimmed.toLowerCase() === known.name.toLowerCase() ||
            trimmed.toLowerCase() === (known.shortName || '').toLowerCase() ||
            trimmed.toLowerCase() === defaultName.toLowerCase() ||
            trimmed.toLowerCase() === nameBeforeParen.toLowerCase() ||
            (notesInsideParen && trimmed.toLowerCase() === notesInsideParen.toLowerCase()) ||
            (known.shortName === 'E Standard' && trimmed.toLowerCase() === 'standard')
        ) {
            const customName = getCustomTuningName(key);
            return {
                key,
                notes,
                defaultName,
                displayName: customName || defaultName || notes,
                stringCount: known.strings.length
            };
        }
    }

    // 2. Check if string contains parentheses with notes, e.g. "Custom (D A D G B E)" or is note string
    let noteSource = trimmed;
    const parenMatch = trimmed.match(/\(([^)]+)\)/);
    if (parenMatch) {
        noteSource = parenMatch[1];
    }

    // Extract note tokens (A-G with optional sharp/flat)
    let noteTokens = [];
    if (/\s+/.test(noteSource.trim())) {
        const tokens = noteSource.trim().split(/\s+/);
        noteTokens = tokens.map(t => {
            const m = t.match(/^[A-G](?:#+|b+|♭)?/i);
            return m ? m[0] : null;
        }).filter(Boolean);
    } else {
        const matches = noteSource.match(/[A-G](?:#+|b+|♭)?/g);
        noteTokens = matches || [];
    }

    if (noteTokens.length >= 3) {
        const noteArr = noteTokens.map(n => {
            const clean = n.replace(/[^a-zA-Z#b♭]/g, '');
            if (clean.length === 1) return clean.toUpperCase();
            return clean.charAt(0).toUpperCase() + clean.slice(1);
        });
        const key = noteArr.join('');
        const notes = noteArr.join(' ');

        // Check if this matches a known tuning by pitch classes (handles enharmonics)
        for (const known of KNOWN_TUNINGS) {
            const kArr = [...known.strings].reverse().map(s => s.replace(/[^a-zA-Z#b]/g, ''));
            if (arePitchClassesEqual(noteArr, kArr)) {
                const kKey = kArr.join('');
                const kNotes = kArr.join(' ');
                const defaultName = known.shortName === 'E Standard' ? 'Standard' : (known.shortName || known.name.split('(')[0].trim());
                const customName = getCustomTuningName(kKey) || getCustomTuningName(key);
                return {
                    key: kKey,
                    notes: kNotes,
                    defaultName,
                    displayName: customName || defaultName || kNotes,
                    stringCount: known.strings.length
                };
            }
        }

        const customName = getCustomTuningName(key);
        const inferredName = noteArr.length === 4 ? `Bass (${notes})` : (noteArr.length > 6 ? `${noteArr.length}-String (${notes})` : notes);
        return {
            key,
            notes,
            defaultName: inferredName,
            displayName: customName || inferredName,
            stringCount: noteArr.length
        };
    }

    // 3. Fallback: if inferTuningFromTextOrName can detect a known tuning name
    const inferred = inferTuningFromTextOrName(trimmed);
    if (inferred && inferred !== trimmed) {
        const result = getTuningInfo(inferred);
        if (result) return result;
    }

    const cleanKey = trimmed.replace(/[^a-zA-Z0-9#]/g, '');
    if (!cleanKey) return null;
    const customName = getCustomTuningName(cleanKey);
    return {
        key: cleanKey,
        notes: trimmed,
        defaultName: trimmed,
        displayName: customName || trimmed,
        stringCount: 6
    };
}

export const GUITAR_PROGRAM_WHITELIST = [24, 25, 26, 27, 28, 29, 30, 31];
export const BASS_PROGRAM_WHITELIST = [32, 33, 34, 35, 36, 37, 38, 39];

export function isTrackPercussion(track) {
    if (!track) return false;
    return Boolean(
        track.isPercussion ||
        track.playbackInfo?.isPercussion ||
        track.staves?.some(s => s.isPercussion)
    );
}

export function isTrackBass(track) {
    if (!track || isTrackPercussion(track)) return false;
    const program = track.playbackInfo?.program ?? track.program;
    if (typeof program === 'number' && BASS_PROGRAM_WHITELIST.includes(program)) {
        return true;
    }
    const name = (track.name || '').toLowerCase();
    if (/\bbass\b/i.test(name)) {
        return true;
    }

    // Check staff strings and tuning
    let maxStrings = 0;
    let hasBassTuning = false;
    for (const staff of (track.staves || [])) {
        if (staff.isPercussion) continue;
        const tunings = staff.stringTuning?.tunings || [];
        if (tunings.length > maxStrings) maxStrings = tunings.length;
        if (tunings.length > 0) {
            const formatted = formatTuningFromMidi(tunings);
            if (formatted && isBassTuning(formatted)) {
                hasBassTuning = true;
            }
        }
    }
    if (track.tuning && Array.isArray(track.tuning) && track.tuning.length > 0) {
        if (track.tuning.length > maxStrings) maxStrings = track.tuning.length;
        const formatted = formatTuningFromMidi(track.tuning);
        if (formatted && isBassTuning(formatted)) {
            hasBassTuning = true;
        }
    }

    if (hasBassTuning) return true;
    if ((maxStrings === 4 || maxStrings === 5) && !name.includes('ukulele') && !name.includes('banjo') && !name.includes('mandolin') && !name.includes('violin') && !name.includes('cello')) {
        return true;
    }

    return false;
}

export function isTrackGuitar(track) {
    if (!track || isTrackPercussion(track)) return false;
    if (isTrackBass(track)) return false;
    const program = track.playbackInfo?.program ?? track.program;
    if (typeof program === 'number' && GUITAR_PROGRAM_WHITELIST.includes(program)) {
        return true;
    }
    const name = (track.name || '').toLowerCase();
    if (
        name.includes('guitar') ||
        name.includes('gtr') ||
        name.includes('rhythm') ||
        name.includes('lead') ||
        name.includes('clean') ||
        name.includes('distort') ||
        name.includes('overdrive') ||
        name.includes('acoustic') ||
        name.includes('electric')
    ) {
        return true;
    }

    let maxStrings = 0;
    for (const staff of (track.staves || [])) {
        if (staff.isPercussion) continue;
        const tunings = staff.stringTuning?.tunings || [];
        if (tunings.length > maxStrings) maxStrings = tunings.length;
    }
    if (track.tuning && Array.isArray(track.tuning)) {
        if (track.tuning.length > maxStrings) maxStrings = track.tuning.length;
    }
    if (maxStrings >= 6) return true;

    // If program is unspecified/default (e.g. 24 or 25) and not an excluded non-guitar instrument
    const nonGuitarTerms = ['piano', 'organ', 'keyboard', 'synth', 'vocal', 'voice', 'strings', 'brass', 'sax', 'trumpet', 'flute', 'drum'];
    if (!nonGuitarTerms.some(term => name.includes(term))) {
        return true;
    }

    return false;
}

export function getGuitarTracks(score) {
    if (!score || !Array.isArray(score.tracks)) return [];
    return score.tracks
        .map((track, index) => ({ track, index }))
        .filter(ti => isTrackGuitar(ti.track));
}

export function getBassTracks(score) {
    if (!score || !Array.isArray(score.tracks)) return [];
    return score.tracks
        .map((track, index) => ({ track, index }))
        .filter(ti => isTrackBass(ti.track));
}

export function getActiveInstrumentTracks(score, mode = getInstrumentMode()) {
    if (!score || !Array.isArray(score.tracks)) return [];
    if (mode === 'bass') {
        const bass = getBassTracks(score);
        if (bass.length > 0) return bass;
        const nonPerc = score.tracks
            .map((track, index) => ({ track, index }))
            .filter(ti => !isTrackPercussion(ti.track));
        return nonPerc.length > 0 ? nonPerc : score.tracks.map((track, index) => ({ track, index }));
    } else {
        const guitar = getGuitarTracks(score);
        if (guitar.length > 0) return guitar;
        const nonPerc = score.tracks
            .map((track, index) => ({ track, index }))
            .filter(ti => !isTrackPercussion(ti.track));
        return nonPerc.length > 0 ? nonPerc : score.tracks.map((track, index) => ({ track, index }));
    }
}

/**
 * Categorizes a tuning into string-count sections:
 * 1. 6-String (Standard guitar range: lowest string above B)
 * 2. 6-String Baritone (6-string guitar with lowest string at B or below)
 * 3. 7-String
 * 4. 8-String
 * 5. 9-String+
 * 6. 5-String (Bass / Extended)
 * 7. 4-String (Bass / Standard)
 */
export function getTuningCategory(tuningInputOrGroup, instrumentMode = getInstrumentMode()) {
    let stringCount = 6;
    let notes = '';
    let defaultName = '';
    let name = '';

    if (typeof tuningInputOrGroup === 'object' && tuningInputOrGroup !== null) {
        const info = (tuningInputOrGroup.key || tuningInputOrGroup.tuning) ? getTuningInfo(tuningInputOrGroup.key || tuningInputOrGroup.tuning) : null;
        notes = tuningInputOrGroup.notes || info?.notes || '';
        const noteTokenCount = notes ? notes.trim().split(/\s+/).length : 0;
        stringCount = info?.stringCount || (noteTokenCount >= 3 ? noteTokenCount : (tuningInputOrGroup.stringCount || 6));
        defaultName = tuningInputOrGroup.defaultName || info?.defaultName || '';
        name = tuningInputOrGroup.name || info?.displayName || '';
    } else if (typeof tuningInputOrGroup === 'string') {
        const info = getTuningInfo(tuningInputOrGroup);
        if (info) {
            stringCount = info.stringCount;
            notes = info.notes;
            defaultName = info.defaultName;
            name = info.displayName;
        }
    }

    const isBass = (defaultName && defaultName.toLowerCase().includes('bass')) ||
                   (name && name.toLowerCase().includes('bass')) ||
                   (instrumentMode === 'bass') ||
                   isBassTuning(tuningInputOrGroup);

    if (stringCount === 6 && isBass) {
        return {
            id: '6-string-bass',
            title: '6-String Bass',
            label: '6-String Bass',
            order: instrumentMode === 'bass' ? 3 : 8,
            stringCount: 6,
            isBaritone: false
        };
    }

    if (stringCount === 6 && !isBass) {
        const noteTokens = (notes || '').trim().split(/\s+/);
        const lowestNote = (noteTokens[0] || '').replace(/[^a-zA-Z#b]/g, '');

        // Standard 6-string lowest notes above B are C, C#, Db, D, D#, Eb, E, F (octave 2)
        // Baritone lowest notes at B or below are B, Bb, A#, A, Ab, G#, G, Gb, F# (octave 1)
        const BARITONE_LOWEST_NOTES = ['B', 'Bb', 'A#', 'A', 'Ab', 'G#', 'G', 'Gb', 'F#'];
        const isBaritone = BARITONE_LOWEST_NOTES.includes(lowestNote) ||
            /\bbaritone\b/i.test(defaultName) ||
            /\bdrop b\b/i.test(defaultName) ||
            /\bb standard\b/i.test(defaultName) ||
            /\bdrop a#\b/i.test(defaultName) ||
            /\bdrop bb\b/i.test(defaultName) ||
            /\bdrop a\b/i.test(defaultName) ||
            /\bdrop g#\b/i.test(defaultName) ||
            /\bdrop ab\b/i.test(defaultName) ||
            /\bdrop g\b/i.test(defaultName) ||
            /\bdrop f#\b/i.test(defaultName) ||
            /\bdrop f\b/i.test(defaultName);

        if (isBaritone) {
            return {
                id: '6-string-baritone',
                title: '6-String Baritone',
                label: '6-String Baritone',
                order: 2,
                stringCount: 6,
                isBaritone: true
            };
        }

        return {
            id: '6-string',
            title: '6-String',
            label: '6-String',
            order: 1,
            stringCount: 6,
            isBaritone: false
        };
    }

    if (stringCount === 7) {
        return {
            id: '7-string',
            title: '7-String',
            label: '7-String',
            order: 3,
            stringCount: 7,
            isBaritone: false
        };
    }

    if (stringCount === 8) {
        return {
            id: '8-string',
            title: '8-String',
            label: '8-String',
            order: 4,
            stringCount: 8,
            isBaritone: false
        };
    }

    if (stringCount > 8) {
        return {
            id: `${stringCount}-string`,
            title: `${stringCount}-String`,
            label: `${stringCount}-String`,
            order: 5,
            stringCount,
            isBaritone: false
        };
    }

    if (stringCount === 5) {
        return {
            id: '5-string',
            title: isBass ? '5-String Bass' : '5-String',
            label: isBass ? '5-String Bass' : '5-String',
            order: instrumentMode === 'bass' ? 2 : 6,
            stringCount: 5,
            isBaritone: false
        };
    }

    if (stringCount === 4) {
        return {
            id: '4-string',
            title: isBass ? '4-String Bass' : '4-String',
            label: isBass ? '4-String Bass' : '4-String',
            order: instrumentMode === 'bass' ? 1 : 7,
            stringCount: 4,
            isBaritone: false
        };
    }

    return {
        id: `${stringCount}-string`,
        title: `${stringCount}-String`,
        label: `${stringCount}-String`,
        order: 8,
        stringCount,
        isBaritone: false
    };
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNoteName(midiNumber) {
    if (typeof midiNumber !== 'number' || isNaN(midiNumber)) return '';
    const note = NOTE_NAMES[midiNumber % 12];
    const octave = Math.floor(midiNumber / 12) - 1;
    return `${note}${octave}`;
}

export function formatTuningFromMidi(midiArray) {
    if (!Array.isArray(midiArray) || midiArray.length === 0) return null;

    // Normalize order (highest to lowest)
    const normalized = [...midiArray];
    if (normalized[0] < normalized[normalized.length - 1]) {
        normalized.reverse();
    }

    for (const known of KNOWN_TUNINGS) {
        if (known.midi.length === normalized.length) {
            let match = true;
            for (let i = 0; i < normalized.length; i++) {
                if (normalized[i] !== known.midi[i]) {
                    match = false;
                    break;
                }
            }
            if (match) return known.shortName || known.name;
        }
    }

    // Format notes from lowest string to highest string
    const notes = normalized.map(m => NOTE_NAMES[m % 12]).reverse().join(' ');
    if (normalized.length === 7) return `7-String (${notes})`;
    if (normalized.length === 8) return `8-String (${notes})`;
    if (normalized.length > 8) return `${normalized.length}-String (${notes})`;
    if (normalized.length === 4) return `Bass (${notes})`;
    if (normalized.length === 5) return `5-String Bass (${notes})`;
    return notes;
}

/**
 * Extract rich score metadata including tunings, max guitar string count, primary tuning, title, artist, album.
 */
export function extractScoreMetadata(score, instrumentMode = getInstrumentMode()) {
    if (!score || !Array.isArray(score.tracks)) {
        return {
            tunings: [],
            stringCount: instrumentMode === 'bass' ? 4 : 6,
            primaryTuning: null,
            title: null,
            artist: null,
            album: null,
            guitarTunings: [],
            bassTunings: [],
            allTunings: [],
            primaryGuitarTuning: null,
            primaryBassTuning: null
        };
    }

    const guitarTunings = [];
    const bassTunings = [];
    const otherTunings = [];
    let maxGuitarStrings = 0;
    let maxBassStrings = 0;

    for (const track of score.tracks) {
        if (isTrackPercussion(track)) continue;

        const staffTunings = [];
        for (const staff of (track.staves || [])) {
            if (staff.isPercussion) continue;
            if (staff.stringTuning?.tunings && staff.stringTuning.tunings.length > 0) {
                staffTunings.push(staff.stringTuning.tunings);
            }
        }
        if (staffTunings.length === 0 && track.tuning && Array.isArray(track.tuning) && track.tuning.length > 0) {
            staffTunings.push(track.tuning);
        }

        const isBass = isTrackBass(track);
        const isGuitar = !isBass && isTrackGuitar(track);

        for (const rawTuning of staffTunings) {
            const formatted = formatTuningFromMidi(rawTuning);
            const strCount = rawTuning.length;
            if (isGuitar) {
                if (strCount > maxGuitarStrings) maxGuitarStrings = strCount;
                if (formatted && !guitarTunings.some(g => g.tuning === formatted)) {
                    guitarTunings.push({ tuning: formatted, strings: strCount });
                }
            } else if (isBass) {
                if (strCount > maxBassStrings) maxBassStrings = strCount;
                if (formatted && !bassTunings.some(b => b.tuning === formatted)) {
                    bassTunings.push({ tuning: formatted, strings: strCount });
                }
            } else {
                if (isBassTuning(formatted) || strCount <= 5) {
                    if (strCount > maxBassStrings) maxBassStrings = strCount;
                    if (formatted && !bassTunings.some(b => b.tuning === formatted)) {
                        bassTunings.push({ tuning: formatted, strings: strCount });
                    }
                } else {
                    if (strCount >= 6 && strCount > maxGuitarStrings) maxGuitarStrings = strCount;
                    if (formatted && !otherTunings.some(o => o.tuning === formatted)) {
                        otherTunings.push({ tuning: formatted, strings: strCount });
                    }
                }
            }
        }
    }

    // Sort tunings so maximum string count comes first
    guitarTunings.sort((a, b) => b.strings - a.strings);
    bassTunings.sort((a, b) => b.strings - a.strings);
    otherTunings.sort((a, b) => b.strings - a.strings);

    const guitarTuningNames = guitarTunings.map(g => g.tuning);
    const bassTuningNames = bassTunings.map(b => b.tuning);
    const otherTuningNames = otherTunings.map(o => o.tuning);

    // Combine all unique tunings across guitar, other, and bass tracks
    const allTunings = Array.from(new Set([
        ...guitarTuningNames,
        ...otherTuningNames,
        ...bassTuningNames
    ]));

    const primaryGuitarTuning = guitarTuningNames[0] || otherTuningNames[0] || null;
    const primaryBassTuning = bassTuningNames[0] || null;

    let activeTunings = [];
    let defaultStringCount = 6;
    let primaryTuning = null;

    if (instrumentMode === 'bass') {
        activeTunings = bassTuningNames.length > 0 ? bassTuningNames : (otherTuningNames.length > 0 ? otherTuningNames : guitarTuningNames);
        primaryTuning = primaryBassTuning || primaryGuitarTuning || (allTunings[0] || null);
        defaultStringCount = maxBassStrings > 0 ? maxBassStrings : (primaryTuning?.includes('5-String') ? 5 : 4);
    } else {
        activeTunings = guitarTuningNames.length > 0 ? guitarTuningNames : (otherTuningNames.length > 0 ? otherTuningNames : bassTuningNames);
        primaryTuning = primaryGuitarTuning || primaryBassTuning || (allTunings[0] || null);
        if (maxGuitarStrings > 0) {
            defaultStringCount = maxGuitarStrings;
        } else if (primaryTuning) {
            if (primaryTuning.includes('8-String')) defaultStringCount = 8;
            else if (primaryTuning.includes('7-String')) defaultStringCount = 7;
            else defaultStringCount = 6;
        }
    }

    return {
        tunings: activeTunings,
        stringCount: defaultStringCount,
        primaryTuning,
        tuning: primaryTuning,
        guitarTunings: guitarTuningNames,
        bassTunings: bassTuningNames,
        allTunings,
        primaryGuitarTuning,
        primaryBassTuning,
        title: score.title?.trim() || null,
        artist: score.artist?.trim() || null,
        album: score.album?.trim() || null
    };
}

export function extractScoreTunings(score, instrumentMode = getInstrumentMode()) {
    const meta = extractScoreMetadata(score, instrumentMode);
    return meta.tunings;
}

export function inferTuningFromTextOrName(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    if (lower.includes('drop c#') || lower.includes('drop db')) return 'Drop Db';
    if (lower.includes('drop c')) return 'Drop C';
    if (lower.includes('drop b')) return 'Drop B';
    if (lower.includes('drop a#') || lower.includes('drop bb')) return 'Drop A#';
    if (lower.includes('7 string drop a') || lower.includes('7-string drop a')) return '7-String Drop A';
    if (lower.includes('7 string drop e') || lower.includes('7-string drop e')) return '7-String Drop E';
    if (lower.includes('8 string drop e') || lower.includes('8-string drop e')) return '8-String Drop E';
    if (lower.includes('8 string') || lower.includes('8-string')) return '8-String Standard';
    if (lower.includes('7 string') || lower.includes('7-string')) return '7-String Standard';
    if (lower.includes('drop a')) return 'Drop A';
    if (lower.includes('drop d')) return 'Drop D';
    if (lower.includes('eb standard') || lower.includes('half step down') || lower.includes('1/2 step down') || lower.includes('d# standard')) return 'Eb Standard';
    if (lower.includes('d standard') || lower.includes('one step down') || lower.includes('1 step down') || lower.includes('whole step down')) return 'D Standard';
    if (lower.includes('c# standard') || lower.includes('db standard')) return 'C# Standard';
    if (lower.includes('c standard')) return 'C Standard';
    if (lower.includes('b standard')) return 'B Standard';
    if (lower.includes('dadgad')) return 'DADGAD';
    if (lower.includes('open d')) return 'Open D';
    if (lower.includes('open g')) return 'Open G';
    if (lower.includes('open e')) return 'Open E';
    if (lower.includes('open a')) return 'Open A';
    if (lower.includes('standard')) return 'E Standard';

    return null;
}

/**
 * Asynchronously detect tuning, string count, and score metadata from a File, Blob, ArrayBuffer, or Uint8Array
 */
export async function detectFileMetadata(fileOrData, fileName = '') {
    const name = fileName || (fileOrData && fileOrData.name) || '';
    const ext = name.split('.').pop().toLowerCase();
    const isGp = ['gp', 'gp3', 'gp4', 'gp5', 'gpx'].includes(ext);

    let inferredTuning = inferTuningFromTextOrName(name);
    let inferredStrings = inferredTuning?.includes('8-String') ? 8 : (inferredTuning?.includes('7-String') ? 7 : 6);

    const fallback = {
        tunings: inferredTuning ? [inferredTuning] : [],
        stringCount: inferredStrings,
        primaryTuning: inferredTuning,
        title: null,
        artist: null,
        album: null
    };

    if (!isGp || !fileOrData) {
        return fallback;
    }

    try {
        let fileObj = null;
        if (fileOrData instanceof File) {
            fileObj = fileOrData;
        } else if (fileOrData instanceof Blob) {
            fileObj = new File([fileOrData], name || 'score.gp', { type: fileOrData.type || 'application/octet-stream' });
        } else if (fileOrData instanceof Uint8Array || fileOrData instanceof ArrayBuffer) {
            fileObj = new File([fileOrData], name || 'score.gp', { type: 'application/octet-stream' });
        }

        // Run any registered file adapter extensions (e.g. decrypting locked GP files)
        if (fileObj) {
            try {
                fileObj = await applyFileAdapters(fileObj);
            } catch (adapterErr) {
                console.warn('[detectFileMetadata] File adapter error:', adapterErr);
            }
        }

        let uint8 = null;
        if (fileObj) {
            const buf = await fileObj.arrayBuffer();
            uint8 = new Uint8Array(buf);
        } else if (fileOrData instanceof Uint8Array) {
            uint8 = fileOrData;
        } else if (fileOrData instanceof ArrayBuffer) {
            uint8 = new Uint8Array(fileOrData);
        }

        if (!uint8) return fallback;

        // Try AlphaTab importer
        const at = typeof alphaTab !== 'undefined' ? alphaTab : (typeof window !== 'undefined' ? window.alphaTab : null);
        if (at && at.importer && typeof at.importer.ScoreLoader?.loadScoreFromBytes === 'function') {
            const score = at.importer.ScoreLoader.loadScoreFromBytes(uint8);
            const scoreMeta = extractScoreMetadata(score);
            if (scoreMeta.tunings.length > 0 || scoreMeta.stringCount) {
                return scoreMeta;
            }
        }
    } catch (e) {
        console.warn('Could not parse score binary for tuning/strings:', e);
    }

    return fallback;
}
