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
    const names = new Map(); // bank-0 program -> preset name
    if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') return { melodic, drumKits, names };
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
                        if (bank === 0) {
                            melodic.add(program);
                            if (!names.has(program)) {
                                let name = '';
                                for (let c = 0; c < 20; c++) {
                                    const code = view.getUint8(r + c);
                                    if (code === 0) break;
                                    name += String.fromCharCode(code);
                                }
                                names.set(program, name.trim());
                            }
                        }
                        else if (bank === 128) drumKits.add(program);
                    }
                    return { melodic, drumKits, names };
                }
                p += 8 + chunkSize + (chunkSize & 1);
            }
        }
        o += 8 + size + (size & 1);
    }
    return { melodic, drumKits, names };
}

/**
 * Union of several fonts' presets plus the per-font `layers` in load order (later fonts override earlier ones).
 * @param {Array<{melodic:Set<number>, drumKits:Set<number>}>} sets one per enabled font, in load order
 */
export function mergePresetSets(sets) {
    const merged = { melodic: new Set(), drumKits: new Set(), layers: sets };
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
 * Resolve against the layered fonts, highest priority (last loaded) first: a font gets to substitute with its own
 * closest program before the fonts it overrides are consulted, so lower fonts take over as much as they can.
 * @param {number} program requested GM program (0-127)
 * @param {{melodic:Set<number>, layers?:Array<{melodic:Set<number>}>}} presets from mergePresetSets
 * @returns {{program:number, how:string}}
 */
export function resolveProgramLayered(program, presets, mode = 'closest') {
    const layers = presets.layers?.length ? presets.layers : [presets];
    for (let i = layers.length - 1; i >= 0; i--) {
        const r = resolveProgram(program, layers[i].melodic, mode);
        if (r.how !== 'none') return r;
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
        const r = resolveProgramLayered(program, presets, mode);
        return { program, resolved: r.program, how: r.how, isPercussion, silent: r.how === 'none' };
    });
}

const AUTOMATION_INSTRUMENT = 2; // AlphaTab AutomationType.Instrument

/**
 * Point each track's playback program at the best program the enabled SoundFonts define.
 * AlphaTab's MIDI generator takes programs from per-beat Instrument automations (the first beat always has one),
 * not only from `playbackInfo.program`, so both are rewritten. The score's own values are kept on
 * `track.originalProgram` / `automation.originalValue` and restored when `presets` is null
 * (the complete built-in font is enabled, or strict mode is on). `presets.forcedProgram` maps every
 * non-percussion track and instrument change to that one program.
 * @returns {boolean} true if any program changed
 */
export function applyProgramMapping(score, presets, mode = 'closest') {
    let changed = false;
    const forced = presets?.forcedProgram;
    const resolve = (original) => {
        if (!presets) return original;
        return forced !== undefined && forced !== null ? forced : resolveProgramLayered(original, presets, mode).program;
    };
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

/** General MIDI program names, indexed by program (0-127). */
export const GM_PROGRAM_NAMES = [
    'Acoustic Grand Piano',
    'Bright Acoustic Piano',
    'Electric Grand Piano',
    'Honky-tonk Piano',
    'Electric Piano 1',
    'Electric Piano 2',
    'Harpsichord',
    'Clavinet',
    'Celesta',
    'Glockenspiel',
    'Music Box',
    'Vibraphone',
    'Marimba',
    'Xylophone',
    'Tubular Bells',
    'Dulcimer',
    'Drawbar Organ',
    'Percussive Organ',
    'Rock Organ',
    'Church Organ',
    'Reed Organ',
    'Accordion',
    'Harmonica',
    'Tango Accordion',
    'Nylon Guitar',
    'Steel Guitar',
    'Jazz Guitar',
    'Clean Guitar',
    'Muted Guitar',
    'Overdriven Guitar',
    'Distortion Guitar',
    'Guitar Harmonics',
    'Acoustic Bass',
    'Fingered Bass',
    'Picked Bass',
    'Fretless Bass',
    'Slap Bass 1',
    'Slap Bass 2',
    'Synth Bass 1',
    'Synth Bass 2',
    'Violin',
    'Viola',
    'Cello',
    'Contrabass',
    'Tremolo Strings',
    'Pizzicato Strings',
    'Orchestral Harp',
    'Timpani',
    'String Ensemble 1',
    'String Ensemble 2',
    'Synth Strings 1',
    'Synth Strings 2',
    'Choir Aahs',
    'Voice Oohs',
    'Synth Voice',
    'Orchestra Hit',
    'Trumpet',
    'Trombone',
    'Tuba',
    'Muted Trumpet',
    'French Horn',
    'Brass Section',
    'Synth Brass 1',
    'Synth Brass 2',
    'Soprano Sax',
    'Alto Sax',
    'Tenor Sax',
    'Baritone Sax',
    'Oboe',
    'English Horn',
    'Bassoon',
    'Clarinet',
    'Piccolo',
    'Flute',
    'Recorder',
    'Pan Flute',
    'Blown Bottle',
    'Shakuhachi',
    'Whistle',
    'Ocarina',
    'Square Lead',
    'Sawtooth Lead',
    'Calliope Lead',
    'Chiff Lead',
    'Charang Lead',
    'Voice Lead',
    'Fifths Lead',
    'Bass and Lead',
    'New Age Pad',
    'Warm Pad',
    'Polysynth Pad',
    'Choir Pad',
    'Bowed Pad',
    'Metallic Pad',
    'Halo Pad',
    'Sweep Pad',
    'Rain FX',
    'Soundtrack FX',
    'Crystal FX',
    'Atmosphere FX',
    'Brightness FX',
    'Goblins FX',
    'Echoes FX',
    'Sci-Fi FX',
    'Sitar',
    'Banjo',
    'Shamisen',
    'Koto',
    'Kalimba',
    'Bagpipe',
    'Fiddle',
    'Shanai',
    'Tinkle Bell',
    'Agogo',
    'Steel Drums',
    'Woodblock',
    'Taiko Drum',
    'Melodic Tom',
    'Synth Drum',
    'Reverse Cymbal',
    'Guitar Fret Noise',
    'Breath Noise',
    'Seashore',
    'Bird Tweet',
    'Telephone Ring',
    'Helicopter',
    'Applause',
    'Gunshot'
];
