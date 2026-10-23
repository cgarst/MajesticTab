// soundFontProgramMap.js
// Alternate GM program mapping for sparse SoundFonts.
// AlphaTab's synth plays nothing when the loaded SoundFonts lack a track's program, so this picks the closest
// program the fonts do define (e.g. 29 Overdriven Guitar when 30 Distortion Guitar is missing).

/** SF2/SF3 preset headers are uncompressed in both formats; this reads only the 'phdr' chunk. */
export function parseSoundFontPresets(buffer) {
    const view = new DataView(buffer);
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    const melodic = new Set();
    const drumKits = new Set();
    if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') return { melodic, drumKits };
    let o = 12;
    while (o + 8 <= buffer.byteLength) {
        const size = view.getUint32(o + 4, true);
        if (tag(o) === 'LIST' && tag(o + 8) === 'pdta') {
            let p = o + 12;
            const end = o + 8 + size;
            while (p + 8 <= end) {
                const chunkSize = view.getUint32(p + 4, true);
                if (tag(p) === 'phdr') {
                    const count = Math.floor(chunkSize / 38) - 1; // last record is the EOP terminator
                    for (let i = 0; i < count; i++) {
                        const r = p + 8 + i * 38;
                        const program = view.getUint16(r + 20, true);
                        const bank = view.getUint16(r + 22, true);
                        if (bank === 0) melodic.add(program);
                        else if (bank === 128) drumKits.add(program);
                    }
                    return { melodic, drumKits };
                }
                p += 8 + chunkSize + (chunkSize & 1);
            }
        }
        o += 8 + size + (size & 1);
    }
    return { melodic, drumKits };
}

/** Union of several fonts' presets (they are layered, so any one of them can supply a program). */
export function mergePresetSets(sets) {
    const merged = { melodic: new Set(), drumKits: new Set() };
    for (const s of sets) {
        s.melodic.forEach(p => merged.melodic.add(p));
        s.drumKits.forEach(p => merged.drumKits.add(p));
    }
    return merged;
}

// Hand-picked substitutes, best first. Anything not listed (or exhausted) falls back to the nearest program in the
// same 8-program GM family, then to FAMILY_FALLBACKS.
const CHAINS = {
    // Guitars
    24: [25, 26, 27], 25: [24, 26, 27], 26: [27, 25, 24], 27: [26, 28, 25, 24],
    28: [27, 26, 25, 24], 29: [30, 27, 28, 26], 30: [29, 31, 27, 28, 26], 31: [27, 26, 28, 25, 24],
    // Basses
    32: [33, 34, 35, 36], 33: [34, 35, 32, 36, 37], 34: [33, 35, 32, 36, 37], 35: [33, 34, 32],
    36: [37, 33, 34, 38], 37: [36, 33, 34, 39], 38: [39, 36, 33, 34], 39: [38, 37, 33, 34],
    // Pianos and keys
    0: [1, 2, 3, 4], 1: [0, 2, 3], 2: [4, 3, 0, 1], 3: [0, 1, 4], 4: [5, 2, 0], 5: [4, 2, 0], 6: [7, 3, 0], 7: [6, 3, 0],
    // Organs
    16: [17, 18, 19], 17: [16, 18, 19], 18: [17, 16, 19], 19: [20, 18, 16]
};

// Last resort per GM family start (program >> 3) when nothing in the family exists: [program, ...]
const FAMILY_FALLBACKS = {
    3: [24, 25, 26, 27, 29, 30, 0],     // guitar: any guitar, then piano
    4: [33, 34, 38, 36, 35],            // bass: any bass
    5: [48, 49, 50, 44, 51],            // strings: ensemble strings
    6: [48, 49, 50, 51],                // ensemble
    7: [56, 57, 61, 60, 62],            // brass
    8: [64, 65, 66, 68, 71, 73],        // reed
    9: [73, 72, 74, 75, 71],            // pipe
    10: [80, 81, 82, 83, 84, 85, 86, 87, 88], // synth lead
    11: [88, 89, 90, 91, 92],           // synth pad
    0: [0, 1, 2, 3, 4, 5, 7, 8, 11, 24, 25],  // piano / chromatic
    1: [8, 9, 11, 12, 13, 14, 15, 0],
    2: [16, 17, 18, 19, 20, 21, 0]
};

/**
 * Best available program for `program`.
 * @param {number} program requested GM program (0-127)
 * @param {Set<number>} available bank-0 programs the loaded SoundFonts define
 * @param {'similar'|'closest'} [mode] 'similar' only uses hand-picked near-identical substitutes (30 -> 29);
 *   'closest' also borrows from the rest of the GM family, so a track is audible even if it sounds quite different
 * @returns {{program:number, how:'exact'|'chain'|'family'|'fallback'|'none'}}
 */
export function resolveProgram(program, available, mode = 'closest') {
    if (available.has(program)) return { program, how: 'exact' };
    for (const alt of CHAINS[program] || []) {
        if (available.has(alt)) return { program: alt, how: 'chain' };
    }
    if (mode === 'similar') return { program, how: 'none' };
    const base = program & ~7;
    let best = -1;
    for (let p = base; p < base + 8; p++) {
        if (available.has(p) && (best === -1 || Math.abs(p - program) < Math.abs(best - program))) best = p;
    }
    if (best !== -1) return { program: best, how: 'family' };
    for (const alt of FAMILY_FALLBACKS[program >> 3] || []) {
        if (available.has(alt)) return { program: alt, how: 'fallback' };
    }
    return { program, how: 'none' };
}

/**
 * Plan program substitutions for a score.
 * @param {Array<{program:number, isPercussion:boolean}>} tracks
 * @param {{melodic:Set<number>, drumKits:Set<number>}} presets merged presets of the enabled fonts
 * @param {'similar'|'closest'} [mode] see resolveProgram
 * @returns {Array<{program:number, resolved:number, how:string, isPercussion:boolean, silent:boolean}>} one per track
 */
export function planProgramMapping(tracks, presets, mode = 'closest') {
    return tracks.map(({ program, isPercussion }) => {
        if (isPercussion) {
            // AlphaTab already falls back to drum kit 0; a font with no drum bank cannot be helped here.
            const silent = presets.drumKits.size === 0;
            return { program, resolved: program, how: silent ? 'none' : 'exact', isPercussion, silent };
        }
        const r = resolveProgram(program, presets.melodic, mode);
        return { program, resolved: r.program, how: r.how, isPercussion, silent: r.how === 'none' };
    });
}

const AUTOMATION_INSTRUMENT = 2; // AlphaTab AutomationType.Instrument

/**
 * Point each track's playback program at the best program the enabled SoundFonts define.
 * AlphaTab's MIDI generator takes programs from per-beat Instrument automations (the first beat always has one),
 * not only from `playbackInfo.program`, so both are rewritten. The score's own values are kept on
 * `track.originalProgram` / `automation.originalValue` and restored when `presets` is null
 * (the complete built-in font is enabled, or strict mode is on).
 * @returns {boolean} true if any program changed
 */
export function applyProgramMapping(score, presets, mode = 'closest') {
    let changed = false;
    const resolve = (original) => presets ? resolveProgram(original, presets.melodic, mode).program : original;
    for (const track of score?.tracks || []) {
        const info = track.playbackInfo;
        if (!info) continue;
        if (track.originalProgram === undefined) track.originalProgram = info.program;
        const isPercussion = info.primaryChannel === 9 || track.staves?.some(st => st.isPercussion);
        if (isPercussion) continue;
        const next = resolve(track.originalProgram);
        if (info.program !== next) {
            info.program = next;
            changed = true;
        }
        for (const staff of track.staves || []) {
            for (const bar of staff.bars || []) {
                for (const voice of bar.voices || []) {
                    for (const beat of voice.beats || []) {
                        for (const automation of beat.automations || []) {
                            if (automation.type !== AUTOMATION_INSTRUMENT) continue;
                            if (automation.originalValue === undefined) automation.originalValue = automation.value;
                            const value = resolve(automation.originalValue);
                            if (automation.value !== value) {
                                automation.value = value;
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
    }
    return changed;
}
