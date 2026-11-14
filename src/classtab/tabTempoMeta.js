// classtab/tabTempoMeta.js
// Extracts tempo (explicit numeric BPM, beat-unit qualifier, or classical Italian tempo marking) and time signature
// from a text tab's header or bar ruler, and resolves them with optional attached MIDI metadata.

const ITALIAN_TEMPOS = [
    { re: /\b(?:largo|largamente|grave|lento|lente|slowly)\b/i, bpm: 56, word: 'Lento' },
    { re: /\b(?:larghetto|adagio)\b/i, bpm: 66, word: 'Adagio' },
    { re: /\b(?:andantino|maestoso)\b/i, bpm: 88, word: 'Andantino' },
    { re: /\bandante\b/i, bpm: 76, word: 'Andante' },
    { re: /\b(?:moderato|moderately)\b/i, bpm: 100, word: 'Moderato' },
    { re: /\ballegretto\b/i, bpm: 112, word: 'Allegretto' },
    { re: /\b(?:allegro|lively)\b/i, bpm: 126, word: 'Allegro' },
    { re: /\b(?:vivace|presto|prestissimo)\b/i, bpm: 152, word: 'Vivace' },
    // Baroque & Classical dance movement fallbacks
    { re: /\b(?:sarabande|sarabanda|saraband)\b/i, bpm: 60, word: 'Sarabande', defaultTimeSig: { num: 3, den: 4 } },
    { re: /\ballemande\b/i, bpm: 76, word: 'Allemande', defaultTimeSig: { num: 4, den: 4 } },
    { re: /\b(?:courante|corrente)\b/i, bpm: 92, word: 'Courante', defaultTimeSig: { num: 3, den: 4 } },
    { re: /\b(?:bourr[eé]e|bouree|gavotte)\b/i, bpm: 116, word: 'Bourrée', defaultTimeSig: { num: 4, den: 4 } },
    { re: /\b(?:minuet|menuet|minuetto)\b/i, bpm: 96, word: 'Minuet', defaultTimeSig: { num: 3, den: 4 } },
    { re: /\b(?:gigue|giga)\b/i, bpm: 116, word: 'Gigue' }
];

const VALID_DENOMS = new Set([2, 4, 8, 16]);

function clampBpm(val) {
    const n = Math.round(Number(val));
    return Number.isFinite(n) && n >= 20 && n <= 320 ? n : null;
}

/**
 * Extracts an explicit numeric BPM and optional beat unit from the header of a text tab.
 * @param {string} text
 * @param {number} [maxLines=45]
 * @returns {{ bpm: number, beatUnit: string, rawBpm: number } | null}
 */
export function bpmFromHeaderText(text, maxLines = 45) {
    if (!text || typeof text !== 'string') return null;
    const head = text.split(/\r?\n/).slice(0, maxLines).join('\n');

    // 1. Note-value equations: "q. = 60", "q = 100", "h = 54", "e = 144", "M.M. = 120", "MM = 108"
    const eqMatch = /\b(q\.|d\.|[qhe]|m\.?m\.?)\s*=\s*(\d{2,3})\b/i.exec(head);
    if (eqMatch) {
        const unitToken = eqMatch[1].toLowerCase();
        const raw = clampBpm(eqMatch[2]);
        if (raw) {
            let beatUnit = 'quarter';
            if (unitToken === 'q.' || unitToken === 'd.') beatUnit = 'dotted-quarter';
            else if (unitToken === 'h') beatUnit = 'half';
            else if (unitToken === 'e') beatUnit = 'eighth';
            return { bpm: raw, beatUnit, rawBpm: raw };
        }
    }

    // 2. Explicit "NNN bpm" or "NNN (quarter notes) bpm"
    const bpmMatch = /\b(\d{2,3})\s*(?:\(([^)]+)\)\s*)?b\.?p\.?m\.?\b/i.exec(head);
    if (bpmMatch) {
        const raw = clampBpm(bpmMatch[1]);
        if (raw) {
            const qual = (bpmMatch[2] || '').toLowerCase();
            let beatUnit = 'quarter';
            if (qual.includes('dotted')) beatUnit = 'dotted-quarter';
            else if (qual.includes('half')) beatUnit = 'half';
            else if (qual.includes('eighth') || qual.includes('8th') || qual.includes('quaver')) beatUnit = 'eighth';
            return { bpm: raw, beatUnit, rawBpm: raw };
        }
    }

    // 3. "tempo: 112", "tempo = 80", "suggested timing - 96"
    const tempoNum = /\b(?:tempo|suggested\s+timing|speed)\s*[:=-]\s*(?:[a-z\s()]+\s*-\s*)?(\d{2,3})\b/i.exec(head);
    if (tempoNum) {
        const raw = clampBpm(tempoNum[1]);
        if (raw) return { bpm: raw, beatUnit: 'quarter', rawBpm: raw };
    }

    return null;
}

/**
 * Extracts a classical Italian tempo word and its mapped BPM from the header of a text tab.
 * @param {string} text
 * @param {number} [maxLines=45]
 * @returns {{ bpm: number, word: string } | null}
 */
export function tempoWordFromHeaderText(text, maxLines = 45) {
    if (!text || typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/).slice(0, maxLines);
    // Strip URLs and emails so we never match words inside addresses
    const cleaned = lines
        .map(l => l.replace(/\S+@\S+|\bhttps?:\/\/\S+/gi, ''))
        .join('\n');

    // Prefer lines that explicitly say "Tempo:" first
    let foundWord = null;
    for (const line of cleaned.split('\n')) {
        if (/\btempo\b/i.test(line)) {
            for (const entry of ITALIAN_TEMPOS) {
                if (entry.re.test(line)) {
                    foundWord = { bpm: entry.bpm, word: entry.word };
                    if (entry.defaultTimeSig) foundWord.defaultTimeSig = entry.defaultTimeSig;
                    break;
                }
            }
            if (foundWord) break;
        }
    }

    if (!foundWord) {
        for (const entry of ITALIAN_TEMPOS) {
            if (entry.re.test(cleaned)) {
                foundWord = { bpm: entry.bpm, word: entry.word };
                if (entry.defaultTimeSig) foundWord.defaultTimeSig = entry.defaultTimeSig;
                break;
            }
        }
    }

    // If the matched tempo word has no defaultTimeSig (e.g. "slowly"), still check if a dance form with a known meter appears in the header
    if (foundWord && !foundWord.defaultTimeSig) {
        for (const entry of ITALIAN_TEMPOS) {
            if (entry.defaultTimeSig && entry.re.test(cleaned)) {
                foundWord.defaultTimeSig = entry.defaultTimeSig;
                break;
            }
        }
    }
    return foundWord;
}

/**
 * Extracts a time signature `{ num, den }` from header text, or null if none is stated.
 */
export function timeSigFromHeaderText(text, maxLines = 45) {
    if (!text || typeof text !== 'string') return null;
    const head = text.split(/\r?\n/).slice(0, maxLines).join('\n');

    // 1. "Time Signature: 3/4", "time sig: 6/8", "time: 4/4", "Timing 3/4", "Time 2/4"
    const m1 = /\b(?:time(?:\s*sig(?:nature)?)?|timing|meter|metre)\s*(?:is\s*)?[:=-]?\s*(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/)/i.exec(head);
    if (m1) {
        const num = parseInt(m1[1], 10);
        const den = parseInt(m1[2], 10);
        if (num >= 1 && num <= 12 && VALID_DENOMS.has(den)) return { num, den };
    }

    // 1b. Common time ("Time Signature: C", "Meter: C", "Common time")
    if (/\b(?:time\s*sig(?:nature)?|meter|metre)\s*[:=-]\s*c\b|\bcommon\s+time\b/i.test(head)) {
        return { num: 4, den: 4 };
    }

    // 2. "2/4 time", "in 3/4", "Played Loud and Lively 6/8" (not part of a date like 4/3/99 or 4/95)
    for (const m2 of head.matchAll(/(?<![/\d])(\d{1,2})\s*\/\s*(\d{1,2})(?![/\d])/g)) {
        const num = parseInt(m2[1], 10);
        const den = parseInt(m2[2], 10);
        if (num < 1 || num > 12 || !VALID_DENOMS.has(den)) continue;
        // Look at surrounding context on the same line to ensure it's a meter, not a revision date (e.g. "4/4" or "6/8" or "3/4" or "2/4" or "3/8" or "9/8" or "12/8")
        const idx = m2.index || 0;
        const lineStart = head.lastIndexOf('\n', idx) + 1;
        const lineEnd = head.indexOf('\n', idx);
        const line = head.slice(lineStart, lineEnd === -1 ? head.length : lineEnd);
        if (/\b(?:revision|revised|date|updated|arranged|tabbed|transcribed|submitted)\b/i.test(line)) continue;
        if (/\b(?:time|meter|beat|counts|waltz|march|played|lively|key)\b/i.test(line) ||
            (den === 4 && num >= 2 && num <= 6) ||
            (den === 8 && (num === 3 || num === 6 || num === 9 || num === 12))) {
            return { num, den };
        }
    }

    return null;
}

/**
 * Counts beat subdivisions from the first system's bar ruler if present (e.g. "1  |  .  |  .  |" -> 3 beats/bar).
 */
export function timeSigFromRuler(blocks) {
    if (!Array.isArray(blocks)) return null;
    const firstSys = blocks.find(b => b.kind === 'system');
    if (!firstSys || !Array.isArray(firstSys.above) || !Array.isArray(firstSys.bars) || !firstSys.bars.length) return null;

    for (const aLine of firstSys.above) {
        const pipeCount = (aLine.match(/\|/g) || []).length;
        if (pipeCount >= 2 && firstSys.bars.length >= 1) {
            const firstBar = firstSys.bars[0];
            const secondBar = firstSys.bars[1];
            // Inspect a full (non-pickup) bar
            const targetBar = (secondBar && (firstBar.colEnd - firstBar.colStart) < (secondBar.colEnd - secondBar.colStart) * 0.6)
                ? secondBar
                : firstBar;
            const seg = aLine.slice(targetBar.colStart, targetBar.colEnd);
            const beatsInBar = (seg.match(/\|/g) || []).length;
            if (beatsInBar >= 2 && beatsInBar <= 6) {
                return { num: beatsInBar, den: 4 };
            }
        }
    }
    return null;
}

/**
 * Resolves the base BPM and time signature for a text tab using the priority order:
 *   BPM:   1. Header numeric BPM -> 2. Attached MIDI primaryBpm -> 3. Header Italian tempo word -> 4. 100 BPM
 *   Meter: 1. Header time sig    -> 2. Attached MIDI 0x58 timeSig -> 3. Ruler beat count      -> 4. 4/4
 *
 * @param {{ headerText?: string, blocks?: Array<any>, midiMeta?: { primaryBpm?: number, initialTimeSig?: { num: number, den: number } } }} input
 */
export function resolveTabTempoAndMeter({ headerText = '', blocks = [], midiMeta = null } = {}) {
    const headerBpm = bpmFromHeaderText(headerText);
    const headerWord = tempoWordFromHeaderText(headerText);

    let baseBpm = 100;
    let bpmSource = 'default';
    let tempoWord = headerWord ? headerWord.word : null;
    let beatUnit = 'quarter';

    if (headerBpm) {
        baseBpm = headerBpm.bpm;
        beatUnit = headerBpm.beatUnit;
        bpmSource = 'header-bpm';
    } else if (midiMeta && clampBpm(midiMeta.primaryBpm)) {
        baseBpm = clampBpm(midiMeta.primaryBpm);
        bpmSource = 'midi';
    } else if (headerWord) {
        baseBpm = headerWord.bpm;
        bpmSource = 'header-word';
    }

    const headerMeter = timeSigFromHeaderText(headerText);
    const rulerMeter = timeSigFromRuler(blocks);

    let timeSig = { num: 4, den: 4 };
    let meterSource = 'default';

    if (headerMeter) {
        timeSig = headerMeter;
        meterSource = 'header';
    } else if (midiMeta && midiMeta.initialTimeSig && midiMeta.initialTimeSig.num && midiMeta.initialTimeSig.den) {
        timeSig = midiMeta.initialTimeSig;
        meterSource = 'midi';
    } else if (rulerMeter) {
        timeSig = rulerMeter;
        meterSource = 'ruler';
    } else if (headerWord?.defaultTimeSig) {
        timeSig = headerWord.defaultTimeSig;
        meterSource = 'header-word';
    }

    return {
        baseBpm,
        bpm: baseBpm,
        bpmSource,
        tempoWord,
        beatUnit,
        timeSig,
        meterSource,
        timeSigSource: meterSource
    };
}
