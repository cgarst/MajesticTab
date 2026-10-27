// gpSoundHints.js
// Guitar Pro 7+ files often write MIDI program 30 (Distortion Guitar) for sounds labelled "Clean" or "Acoustic",
// and AlphaTab plays the program number as written. The sound's name is reliable where its program is not, so
// this reads each track's sounds from score.gpif and corrects clean-family tracks that carry a distortion program.

const AUTOMATION_INSTRUMENT = 2; // AlphaTab AutomationType.Instrument
const DISTORTION_PROGRAMS = new Set([29, 30]);
const DRIVEN_NAME = /dist|overdr|crunch|drive|fuzz|high.?gain/i;
// First match wins; programs are GM Nylon, Steel, Jazz and Clean Electric Guitar.
const CLEAN_FAMILY = [
    [/nylon|classical/i, 24],
    [/acous|steel|resonator|mandolin/i, 25],
    [/jazz/i, 26],
    [/clean|cln/i, 27]
];

/** @returns {number|null} the clean-family program a sound name asks for, or null when it names nothing clean */
export function cleanProgramForSoundName(name) {
    if (!name || DRIVEN_NAME.test(name)) return null;
    for (const [pattern, program] of CLEAN_FAMILY) {
        if (pattern.test(name)) return program;
    }
    return null;
}

const tagText = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : '';
};

/**
 * @param {string} xml score.gpif contents
 * @returns {Array<Array<{name:string, program:number}>>} sounds per track, in score track order
 */
export function parseGpifSounds(xml) {
    const tracks = [];
    for (const [, track] of xml.matchAll(/<Track id="\d+">([\s\S]*?)<\/Track>/g)) {
        const sounds = [];
        for (const [, sound] of track.matchAll(/<Sound>([\s\S]*?)<\/Sound>/g)) {
            const program = sound.match(/<Program>(\d+)<\/Program>/);
            if (program) sounds.push({ name: tagText(sound, 'Name'), program: Number(program[1]) });
        }
        tracks.push(sounds);
    }
    return tracks;
}

async function toBytes(source) {
    if (!source) return null;
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
    if (typeof source === 'string' && source.startsWith('data:')) {
        const binary = atob(source.slice(source.indexOf(',') + 1));
        return Uint8Array.from(binary, c => c.charCodeAt(0));
    }
    return null;
}

/** Never rejects; resolves null for anything that is not a readable GP7+ zip. */
export async function readGpSoundHints(source) {
    try {
        const bytes = await toBytes(source);
        if (!bytes || bytes[0] !== 0x50 || bytes[1] !== 0x4b || !globalThis.fflate?.unzipSync) return null;
        const entries = globalThis.fflate.unzipSync(bytes, { filter: f => f.name === 'Content/score.gpif' });
        const gpif = entries['Content/score.gpif'];
        if (!gpif) return null;
        const xml = new TextDecoder().decode(gpif);
        return /^﻿?\s*(?:<\?xml[^>]*>\s*)?<GPIF(?:\s|>)/i.test(xml.slice(0, 8192)) ? parseGpifSounds(xml) : null;
    } catch {
        return null;
    }
}

/**
 * Replace distortion programs on clean-family tracks. Call before applyProgramMapping so the corrected program is
 * the one recorded as the score's own. If a track mixes clean and driven sounds on the same program, only its
 * opening sound is corrected, since AlphaTab's Instrument automations no longer say which sound they came from.
 * @returns {boolean} true if any program changed
 */
export function applyGpSoundHints(score, hints) {
    if (!hints) return false;
    let changed = false;
    (score?.tracks || []).forEach((track, i) => {
        const info = track.playbackInfo;
        const sounds = hints[track.index ?? i];
        if (!info || !sounds?.length || info.primaryChannel === 9) return;
        const first = sounds[0];
        if (!DISTORTION_PROGRAMS.has(first.program) || info.program !== first.program) return;
        const target = cleanProgramForSoundName(first.name);
        if (target === null) return;
        const sameProgram = sounds.filter(s => s.program === first.program);
        const uniform = sameProgram.every(s => cleanProgramForSoundName(s.name) === target);
        info.program = target;
        changed = true;
        let firstBeat = true;
        for (const staff of track.staves || []) {
            for (const bar of staff.bars || []) {
                for (const voice of bar.voices || []) {
                    for (const beat of voice.beats || []) {
                        for (const automation of beat.automations || []) {
                            if (automation.type !== AUTOMATION_INSTRUMENT || automation.value !== first.program) continue;
                            if (uniform || (firstBeat && bar.index === 0)) automation.value = target;
                        }
                        firstBeat = false;
                    }
                }
            }
        }
    });
    return changed;
}
