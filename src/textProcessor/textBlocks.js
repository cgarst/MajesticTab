// textProcessor/textBlocks.js
// Turns the lines of a text tab into blocks: the units a page may start or end between. Pure (no DOM), so it runs
// under Node tests.
//
// A page must never split a staff system (its bar-number ruler, the string lines and the fingering or dynamics lines
// that belong to it), so a system is one block. The other lines are single-line blocks, chord-over-lyric pairs are one
// block, and a run of blank lines is one "blank" block, which is where a page prefers to break.
//
// The staff shape follows the Classtab archive (a free classical guitar tab archive; its files are not shipped):
//     cII_              cII_            <- optional marks above the ruler
//   5  |   .   |   .   |               <- bar numbers and beats (ruler)
//   e|-0-----1-0---|-0=====|*----||    <- string lines: = sustain, * repeat dot, || double bar, p h / \ ~ < > ...
//   B|...
//       mf       2                     <- dynamics and fingering below
//                3

const STAFF = /^\s*[A-Ga-g][#b]?\s*\|[|*\d\s]*-/;       // "e|--", "Eb |-", "D||---", "G|*----"
const RULER = /^\s*\d{0,4}[\s.]*\|[^|]*\|/;                 // "5  |   .   |   ." or "0   .  |  .  |"
// One chord definition for classifying a line and for cutting it into chords (longer suffixes before "m").
const CHORD_SRC = '[A-G][#b]?(?:maj|min|dim|aug|sus|add|m|M)?\\d*(?:[#b]\\d+)*(?:\\/[A-G][#b]?)?';
const CHORD_TOKEN = new RegExp(`^${CHORD_SRC}$`);
const chordRegexGlobal = () => new RegExp(CHORD_SRC, 'g');

export const isStaffLine = (line) => STAFF.test(line);
export const isRulerLine = (line) => !STAFF.test(line) && RULER.test(line);
export const isBlank = (line) => line.trim() === '';
export function isChordLine(line) {
    const tokens = line.trim().split(/\s+/);
    return tokens[0] !== '' && tokens.every((t) => CHORD_TOKEN.test(t));
}

/** Cuts a chord line over its lyric line into { chord, lyric } segments, one per chord. */
export function createChordLyricSegments(chordLine, lyricLine) {
    const found = [...chordLine.matchAll(chordRegexGlobal())].map(m => ({ pos: m.index, chord: m[0] }));
    const end = Math.max(chordLine.length, lyricLine.length);
    const segments = [];
    // lyric before the first chord keeps its own chordless segment
    if (found.length && found[0].pos > 0) segments.push({ chord: '', lyric: lyricLine.substring(0, found[0].pos) });
    found.forEach((c, i) => {
        const stop = i + 1 < found.length ? found[i + 1].pos : end;
        segments.push({ chord: c.chord, lyric: lyricLine.substring(c.pos, stop) });
    });
    return segments;
}

const MAX_ABOVE = 2;   // lines directly above the ruler that travel with the system (a mark line, a short heading)
const MAX_BELOW = 6;   // dynamics and fingering lines under the strings

/**
 * @param {string[]} lines without line endings
 * @returns {Array<{kind: 'system'|'chord'|'blank'|'line', start: number, end: number}>} blocks in order, end inclusive
 */
export function groupBlocks(lines) {
    const n = lines.length;
    const blocks = [];
    // 1. find the staff runs (a block of consecutive string lines), with their ruler, above and below lines
    const systems = [];
    for (let i = 0; i < n; i++) {
        if (!isStaffLine(lines[i]) || (i > 0 && isStaffLine(lines[i - 1]))) continue;
        let last = i;
        while (last + 1 < n && isStaffLine(lines[last + 1])) last++;
        // a lone string line is a stray quote of a bar, not a staff: leave it a plain line
        if (last === i) continue;
        let start = i;
        if (start > 0 && isRulerLine(lines[start - 1])) start--;
        for (let k = 0; k < MAX_ABOVE && start > 0; k++) {
            const above = lines[start - 1];
            if (isBlank(above) || isStaffLine(above) || (systems.length && start - 1 <= systems[systems.length - 1].end)) break;
            start--;
        }
        let end = last;
        while (end + 1 < n && end - last < MAX_BELOW) {
            const below = lines[end + 1];
            // the next system's ruler or mark line is not ours; a blank line ends the system
            if (isBlank(below) || isStaffLine(below) || isRulerLine(below)) break;
            end++;
        }
        // marks above the next ruler (no blank line between) belong to the next system
        while (end > last && end + 1 < n && isRulerLine(lines[end + 1])) end--;
        systems.push({ start, end });
        i = last;
    }
    // systems whose "above" lines overlap the previous one's "below" lines: give the line to the later system
    for (let s = 1; s < systems.length; s++) {
        if (systems[s].start <= systems[s - 1].end) systems[s - 1].end = systems[s].start - 1;
    }
    // 2. walk the lines, emitting systems, chord pairs, blank runs and single lines
    let s = 0;
    for (let i = 0; i < n; i++) {
        if (s < systems.length && i === systems[s].start) {
            blocks.push({ kind: 'system', start: i, end: systems[s].end });
            i = systems[s].end;
            s++;
            continue;
        }
        if (isBlank(lines[i])) {
            let j = i;
            while (j + 1 < n && isBlank(lines[j + 1]) && !(s < systems.length && j + 1 === systems[s].start)) j++;
            blocks.push({ kind: 'blank', start: i, end: j });
            i = j;
            continue;
        }
        const next = lines[i + 1];
        const nextIsSystem = s < systems.length && i + 1 === systems[s].start;
        if (next !== undefined && !nextIsSystem && !isBlank(next) && isChordLine(lines[i]) && !isStaffLine(next)) {
            blocks.push({ kind: 'chord', start: i, end: i + 1 });
            i++;
            continue;
        }
        blocks.push({ kind: 'line', start: i, end: i });
    }
    return blocks;
}

/**
 * Greedy fill that only breaks between blocks. `heights[i]` is block i's height, `maxHeight` the room on a page.
 * Returns pages as arrays of block indices. A blank block is a gap: it is dropped at the top and bottom of a page, so a
 * page never opens or ends with empty space. A block taller than a page gets a page to itself.
 * @param {Array<{kind: string}>} blocks
 * @param {number[]} heights
 * @param {number} maxHeight
 */
export function paginate(blocks, heights, maxHeight) {
    const pages = [];
    let cur = [];
    let used = 0;
    const flush = () => {
        while (cur.length && blocks[cur[cur.length - 1]].kind === 'blank') cur.pop();
        if (cur.length) pages.push(cur);
        cur = [];
        used = 0;
    };
    for (let i = 0; i < blocks.length; i++) {
        const gap = blocks[i].kind === 'blank';
        if (!cur.length && gap) continue;
        if (cur.length && used + heights[i] > maxHeight) {
            flush();
            if (gap) continue;
        }
        cur.push(i);
        used += heights[i];
    }
    flush();
    return pages;
}
