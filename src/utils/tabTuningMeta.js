// tabTuningMeta.js
// Where a PDF or text tab's tuning comes from, and which source wins. Guitar Pro tabs carry their tuning in the file,
// so this is only for tabs that do not.
//
// Sources, strongest first:
//   user      the player set it in the Song menu; nothing replaces it
//   classtab  the classical archive's own flag for the piece (drop D, lute tuning, other tuning)
//   header    the tab's own header text ("tuning: D A D G B E", "6th string to D", "drop D")
//   filename  a tuning named in the file name
// A tab with no source is "Not set". We never guess a tuning the data does not give.

import { inferTuningFromTextOrName } from './tuningUtils.js';

export const TUNING_SOURCES = ['user', 'classtab', 'header', 'filename'];
const RANK = { user: 4, classtab: 3, header: 2, filename: 1 };

/** Notes of the classical guitar's lute tuning, low string to high: the 3rd string lowered a half step to F sharp. */
export const LUTE_TUNING = 'E A D F# B E';

const STANDARD_LOW_TO_HIGH = ['E', 'A', 'D', 'G', 'B', 'E'];

/** True when a tuning from `incoming` may replace one that came from `current` (no source means nothing is stored). */
export function canReplaceTuning(current, incoming) {
    if (!incoming) return false;
    return (RANK[incoming] || 0) > (RANK[current] || 0);
}

/** The tuning for the archive's flag on a piece, or null (an "other tuning" piece says only that it is not standard). */
export function tuningFromClassicalFlag(flag) {
    if (flag === 'drop D') return 'Drop D';
    if (flag === 'lute tuning') return LUTE_TUNING;
    return null;
}

const NOTE = '([A-Ga-g](?:#|b|♯|♭)?)';

function cleanNote(n) {
    const s = n.replace('♯', '#').replace('♭', 'b');
    return s[0].toUpperCase() + s.slice(1);
}

/** A tuning named in the first lines of a text tab, or null. Only explicit statements count. */
export function tuningFromHeaderText(text, maxLines = 30) {
    if (!text || typeof text !== 'string') return null;
    const head = text.split(/\r?\n/).slice(0, maxLines).join('\n');

    // "tuning: D A D G B E" or "tuned: DADGBE": six or more notes, low string first
    // Capital letters only, so the "b" of "GBE" is a string and not a flat
    const listed = /[Tt]un(?:ing|ed)\s*[:=-]?\s*((?:[A-G](?:#|b|♯|♭)?[\s,-]*){6,10})/.exec(head);
    if (listed) {
        const notes = listed[1].match(/[A-G](?:#|b|♯|♭)?/g);
        if (notes && notes.length >= 6) return notes.map(cleanNote).join(' ');
    }

    // "6th string to D", "sixth string in D", "(6=D)" and "(3 = F#)": changes to the standard strings, 6 is the lowest
    const changes = new Map();
    const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
    const wordRe = new RegExp(`\\b(first|second|third|fourth|fifth|sixth|[1-6](?:st|nd|rd|th)?)\\s+string\\s+(?:is\\s+)?(?:tuned\\s+)?(?:down\\s+)?(?:to|in|=)\\s+${NOTE}`, 'gi');
    const eqRe = new RegExp(`\\(\\s*([1-6])\\s*=\\s*${NOTE}\\s*\\)`, 'g');
    for (const m of head.matchAll(wordRe)) {
        const n = words[m[1].toLowerCase()] || parseInt(m[1], 10);
        if (n >= 1 && n <= 6) changes.set(n, cleanNote(m[2]));
    }
    for (const m of head.matchAll(eqRe)) changes.set(parseInt(m[1], 10), cleanNote(m[2]));
    if (changes.size > 0) {
        // string 6 is index 0 (lowest)
        const notes = STANDARD_LOW_TO_HIGH.map((std, i) => changes.get(6 - i) || std);
        return notes.join(' ');
    }

    if (/\blute tuning\b/i.test(head)) return LUTE_TUNING;
    if (/\bdrop\s*d\b/i.test(head) || /\bdadgbe\b/i.test(head)) return 'Drop D';
    if (/\bdadgad\b/i.test(head)) return 'DADGAD';
    return null;
}

/**
 * The best tuning the data gives for a PDF or text tab, with its source.
 * @param {{classtabFlag?: string, headerText?: string, fileName?: string}} input
 * @returns {{tuning: string|null, source: 'classtab'|'header'|'filename'|null}}
 */
export function resolveTabTuning({ classtabFlag, headerText, fileName } = {}) {
    const fromFlag = tuningFromClassicalFlag(classtabFlag);
    if (fromFlag) return { tuning: fromFlag, source: 'classtab' };
    const fromHeader = tuningFromHeaderText(headerText);
    if (fromHeader) return { tuning: fromHeader, source: 'header' };
    const fromName = inferTuningFromTextOrName(fileName || '');
    if (fromName) return { tuning: fromName, source: 'filename' };
    return { tuning: null, source: null };
}
