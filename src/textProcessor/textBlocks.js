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

const PROSE_DIVIDER = /^\s*(?:[#*=~_-]{10,}|#[-]+PLEASE NOTE[-]+#)\s*$/i;
const ENDING_BRACKET_LINE = /^\s*\+[-=_]{6,}\+\s*$/;

// Single-line staff patterns across the Classtab archive:
// 1. Named string lines: "e|--", "Eb |-", "D||---", "G|*----", "e:---", "E-||---", "E*--7--", "e  ---0---", "E 4---2---|", "E+--7---+", "E  ---]"
// 2. Unnamed bar-first staves: "|-12-10---|", "||o-6-5---|", "||*---0---|" (must contain at least 3 dashes/underscores or end with a barline)
// 3. Pickup dash-first staves: "---7---||--3---|", "   -----0-----0-|", "-*-7--9---|"
const NAMED_STAFF = /^\s*(?:[A-Ga-g][#b]?|[1-6])\s*(?:(?:\|[|*\d\s:o=]*|:)[-_=\d]|[-=*:+|\]]+\s*[-=_|+*\d:o()[\]<>]|[\s:|*+=]+[-_=]{2,}|[\s:|*+=]+\d+[-_=]{2,})/;
const UNNAMED_BAR_STAFF = /^\s*[|:o*+]{1,4}\s*[-_=\d][\d\-_=|:*+o()[\]<>hHpPsSlL/\\~^xX.=<> ]{6,}(?:[|+\]]|[-_=]{3,})/;
const PICKUP_DASH_STAFF = /^\s*[-_=]{2,}[\d*()-_=|][\d\-_=|:*+o()[\]<>hHpPsSlL/\\~^xX.=<> ]{10,}[|+\]]/;

// Context-aware candidate for barless 6-line dash/underscore staves (e.g. Andrew York / Luys de Narvaez lute tabs)
const BARLESS_STAFF_CANDIDATE = /^\s*[-_=0-9|:*o()[\]<>hHpPsSlL/\\~^xX.\s]{12,}$/;

const RULER = /^\s*\d{0,4}[\s.]*\|[^|]*\|/;                 // "5  |   .   |   ." or "0   .  |  .  |"
// One chord definition for classifying a line and for cutting it into chords (longer suffixes before "m").
const CHORD_SRC = '[A-G][#b]?(?:maj|min|dim|aug|sus|add|m|M)?\\d*(?:[#b]\\d+)*(?:\\/[A-G][#b]?)?';
const CHORD_TOKEN = new RegExp(`^${CHORD_SRC}$`);
const chordRegexGlobal = () => new RegExp(CHORD_SRC, 'g');

export function isStaffLine(line) {
    if (!line || PROSE_DIVIDER.test(line) || ENDING_BRACKET_LINE.test(line)) return false;
    const dashCount = (line.match(/[-_=]/g) || []).length;
    if (dashCount < 1) return false;
    if (NAMED_STAFF.test(line)) {
        // Digit-labeled lines (e.g. "1-1 4" fingering) need >= 3 dashes or a barline + >= 2 dashes to be a real string line
        if (/^\s*[1-6]\b/.test(line) && dashCount < 3 && !(/\|/.test(line) && dashCount >= 2)) return false;
        return true;
    }
    if (UNNAMED_BAR_STAFF.test(line)) {
        // Reject legend prose like "o|| - end of repeat" that contains words
        const trimmed = line.trim();
        if (/[a-zA-Z]{3,}/.test(trimmed)) return false;
        return dashCount >= 3;
    }
    if (PICKUP_DASH_STAFF.test(line)) {
        const trimmed = line.trim();
        if (/[a-zA-Z]{3,}/.test(trimmed)) return false;
        return dashCount >= 4;
    }
    return false;
}

function isBarlessStaffCandidate(line, neighborLen = 0) {
    if (!line) return false;
    const s = line.trim();
    if (s.length < 12 || !BARLESS_STAFF_CANDIDATE.test(line)) return false;
    // Allow an unplayed all-dash string line if its length matches its neighboring barless staff lines
    if (PROSE_DIVIDER.test(line)) {
        if (!/^[-_]+$/.test(s) || (neighborLen > 0 && Math.abs(s.length - neighborLen) > 2)) return false;
        return /\d/.test(s) || neighborLen > 0;
    }
    if (/[a-zA-Z]{3,}/.test(s)) return false;
    let dashCount = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '-' || s[i] === '_') dashCount++;
    }
    return dashCount >= s.length * 0.4;
}

export const isRulerLine = (line) => !isStaffLine(line) && RULER.test(line);
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

const FINGERING = /^[\d\s_o]+$/;                            // a fingering line: digits, slurs and "o" marks only
const LEGEND_HEADING = /^[\s*~=-]*(?:notes\s+and\s+legend|tablature\s+explanation|explanation\s+of\s+symbols|symbols?\s+explanation|legend\s*:?)\s*[:~=-]*\s*$/i;
const VERSION_HEADING = /^[\s*~=-]*(?:(?:2nd|3rd|second|third)\s+version|version\s+[23]\b)/i;
const DUET_LABEL = /^\s*(?:gtr\.?\s*(?:i{1,2}|[12])|guitar\s*(?:i{1,2}|[12])|part\s*(?:i{1,2}|[12])|treble|bass)\b/i;

const MAX_ABOVE = 3;   // lines directly above the ruler that travel with the system (a mark line, a short heading)
const MAX_BELOW = 6;   // dynamics and fingering lines under the strings

/**
 * Slices `trimCols` from the left of an `above` or `below` annotation line while preserving any non-whitespace
 * leading token (like a bar number at column 0 of a ruler line) by consuming matching spaces immediately to its right.
 */
export function sliceAnnotationCols(line, trimCols) {
    if (!line || trimCols <= 0) return line || '';
    if (line.length <= trimCols) return line.trim();
    const prefix = line.slice(0, trimCols);
    const rest = line.slice(trimCols);
    const token = prefix.trim();
    if (!token) return rest;
    const spaceMatch = rest.match(/^\s+/);
    const availSpaces = spaceMatch ? spaceMatch[0].length : 0;
    if (availSpaces >= token.length) {
        return token + rest.slice(token.length);
    }
    return token + ' ' + rest.trimStart();
}

/**
 * Extracts string labels, trimCols, and visual bars from a system's string lines and above/below lines.
 */
export function decomposeSystem(lines, sys) {
    const rawStaffRuns = sys.staffRuns || [{ start: sys.staffStart, end: sys.staffEnd }];
    const firstRun = rawStaffRuns[0];
    const lastRun = rawStaffRuns[rawStaffRuns.length - 1];

    const above = lines.slice(sys.start, firstRun.start);
    const below = lines.slice(lastRun.end + 1, sys.end + 1);
    const staves = rawStaffRuns.map((run, idx) => {
        const sAbove = idx === 0 ? above : lines.slice(rawStaffRuns[idx - 1].end + 1, run.start);
        const sStrings = lines.slice(run.start, run.end + 1);
        const sBelow = idx === rawStaffRuns.length - 1 ? below : [];
        return { above: sAbove, strings: sStrings, below: sBelow };
    });

    // If a single contiguous run has 12 lines, split it into 2 6-string duet staves
    if (staves.length === 1 && staves[0].strings.length === 12) {
        const allStrings = staves[0].strings;
        staves.length = 0;
        staves.push(
            { above, strings: allStrings.slice(0, 6), below: [] },
            { above: [], strings: allStrings.slice(6, 12), below }
        );
    }

    const primaryStrings = staves[0].strings;
    const allStrings = staves.flatMap(st => st.strings);

    // Determine string tuning labels and left prefix width (trimCols) before the first barline or staff body
    const stringLabels = [];
    let trimCols = Infinity;
    for (const s of allStrings) {
        const m = s.match(/^(\s*([A-Ga-g][#b]?|[1-6])[\s\-*:+]*)(?=[|+\]\-_0-9(])/);
        if (m) {
            stringLabels.push(m[2]);
            if (m[1].length < trimCols) trimCols = m[1].length;
        } else {
            const lead = s.match(/^(\s*)(?=[|+\]\-_0-9(])/);
            stringLabels.push('');
            if (lead && lead[1].length < trimCols) trimCols = lead[1].length;
        }
    }
    if (!Number.isFinite(trimCols)) trimCols = 0;

    // Detect bar-line character used by this system ('|', ']', or '+')
    const maxLen = Math.max(0, ...primaryStrings.map(s => s.length));
    const minStrHit = Math.max(2, Math.ceil(primaryStrings.length * 0.5));
    const barCols = [];
    for (let c = trimCols; c < maxLen; c++) {
        let hits = 0;
        for (let r = 0; r < primaryStrings.length; r++) {
            const ch = primaryStrings[r][c];
            if (ch === '|' || ch === ']' || (ch === '+' && c > trimCols)) hits++;
        }
        if (hits >= minStrHit) barCols.push(c);
    }

    // Group adjacent bar-line columns (or bar columns separated only by repeat dots *, o, :) into bar boundaries
    const boundaries = [];
    for (const c of barCols) {
        const prev = boundaries[boundaries.length - 1];
        if (prev && c - prev.end <= 2) {
            // Check if any intermediate column is just repeat dots / spaces / bar chars
            let mergeable = true;
            for (let k = prev.end + 1; k < c; k++) {
                for (let r = 0; r < primaryStrings.length; r++) {
                    const ch = primaryStrings[r][k] || ' ';
                    if (!/[|\]+*o:\s]/.test(ch)) { mergeable = false; break; }
                }
            }
            if (mergeable) {
                prev.end = c;
                prev.count++;
                continue;
            }
        }
        boundaries.push({ start: c, end: c, count: 1 });
    }

    // Inspect repeat markers (*, o, :) immediately left/right of each boundary
    for (const b of boundaries) {
        let repStart = false;
        let repEnd = false;
        for (let r = 0; r < primaryStrings.length; r++) {
            const leftSlice = primaryStrings[r].slice(Math.max(trimCols, b.start - 2), b.end + 1);
            const rightSlice = primaryStrings[r].slice(b.start, Math.min(maxLen, b.end + 3));
            if (/[*o:]\s*[|\]+]/.test(leftSlice)) repEnd = true;
            if (/[|\]+]\s*[*o:]/.test(rightSlice)) repStart = true;
        }
        b.repeatStart = repStart;
        b.repeatEnd = repEnd;
        b.doubleBar = b.count >= 2;
    }

    // Build visual bar spans between boundaries
    const rawSpans = [];
    const hasPlayableContent = (c0, c1) => {
        if (c1 - c0 < 2) return false;
        for (let r = 0; r < primaryStrings.length; r++) {
            const seg = primaryStrings[r].slice(c0, c1);
            if (/[-_0-9]/.test(seg)) return true;
        }
        return false;
    };

    if (boundaries.length === 0) {
        // Barless staff: partition into ~16-column virtual bars
        const width = Math.max(1, maxLen - trimCols);
        const step = width > 24 ? 16 : width;
        for (let c = trimCols; c < maxLen; c += step) {
            const cEnd = Math.min(maxLen, c + step);
            if (cEnd > c) {
                rawSpans.push({
                    colStart: c,
                    colEnd: cEnd,
                    repeatStart: false,
                    repeatEnd: false,
                    doubleBar: false
                });
            }
        }
    } else {
        // Content before first boundary (pickup bar or bar without opening barline, e.g. "G*-0===")
        if (hasPlayableContent(trimCols, boundaries[0].start)) {
            let leadingRepeatStart = false;
            for (let r = 0; r < primaryStrings.length; r++) {
                const headSlice = primaryStrings[r].slice(0, Math.min(primaryStrings[r].length, trimCols + 3));
                if (/[A-Ga-g1-6][#b]?\s*[*:]/.test(headSlice)) leadingRepeatStart = true;
            }
            rawSpans.push({
                colStart: trimCols,
                colEnd: boundaries[0].end + 1,
                repeatStart: leadingRepeatStart,
                repeatEnd: boundaries[0].repeatEnd,
                doubleBar: boundaries[0].doubleBar
            });
        }
        for (let idx = 0; idx < boundaries.length - 1; idx++) {
            const bLeft = boundaries[idx];
            const bRight = boundaries[idx + 1];
            const c0 = idx === 0 && rawSpans.length === 0 ? bLeft.start : bLeft.end + 1;
            const c1 = bRight.end + 1;
            if (hasPlayableContent(bLeft.end + 1, bRight.start)) {
                rawSpans.push({
                    colStart: c0,
                    colEnd: c1,
                    repeatStart: bLeft.repeatStart,
                    repeatEnd: bRight.repeatEnd,
                    doubleBar: bLeft.doubleBar || bRight.doubleBar
                });
            }
        }
        // Content after last boundary (unclosed trailing bar)
        const bLast = boundaries[boundaries.length - 1];
        if (hasPlayableContent(bLast.end + 1, maxLen)) {
            rawSpans.push({
                colStart: boundaries.length === 1 && rawSpans.length === 0 ? bLast.start : bLast.end + 1,
                colEnd: maxLen,
                repeatStart: bLast.repeatStart,
                repeatEnd: false,
                doubleBar: bLast.doubleBar
            });
        }
    }

    if (rawSpans.length === 0 && maxLen > trimCols) {
        rawSpans.push({
            colStart: trimCols,
            colEnd: maxLen,
            repeatStart: false,
            repeatEnd: false,
            doubleBar: false
        });
    }

    // Parse system-level bar number / ruler numbers and endings from `above` lines
    let systemStartBarNum = null;
    for (const aLine of above) {
        const m = aLine.match(/^\s*(\d{1,3})(?:\b|\s|\|)/);
        if (m) {
            systemStartBarNum = parseInt(m[1], 10);
            break;
        }
    }

    const bars = rawSpans.map((span, idx) => {
        // Check for explicit bar number or 1st/2nd ending above this bar's columns
        let barNumber = systemStartBarNum !== null ? systemStartBarNum + idx : null;
        let ending = null;
        for (let aIdx = 0; aIdx < above.length; aIdx++) {
            const aLine = above[aIdx];
            const slice = aLine.slice(Math.max(0, span.colStart - 2), Math.min(aLine.length, span.colEnd));
            const endMatch = slice.match(/(?:\[|\b)([12])\s*(?:\.[_-]*|[_-]{2,}|\])/);
            if (endMatch) {
                ending = parseInt(endMatch[1], 10);
                break;
            }
            // Two-line ending bracket: a standalone "1" or "2" above a "+-----+" or "_____" bracket line
            const loneNum = slice.match(/^\s*([12])\.?\s*$/);
            if (loneNum) {
                const nextLine = above[aIdx + 1] || '';
                const nextSlice = nextLine.slice(Math.max(0, span.colStart - 4), Math.min(nextLine.length, span.colEnd + 2));
                if (/[+_=-]{4,}/.test(nextSlice)) {
                    ending = parseInt(loneNum[1], 10);
                    break;
                }
            }
        }

        // Extract noteOnsets across all strings inside [colStart, colEnd)
        const noteOnsets = [];
        const skipR = new Set();
        for (let c = span.colStart; c < span.colEnd; c++) {
            const frets = [];
            for (let r = 0; r < allStrings.length; r++) {
                const key = `${r}:${c}`;
                if (skipR.has(key)) continue;
                const sLine = allStrings[r];
                const ch = sLine[c];
                if (ch >= '0' && ch <= '9') {
                    const nextCh = sLine[c + 1];
                    let fret = ch.charCodeAt(0) - 48;
                    if (c + 1 < span.colEnd && nextCh >= '0' && nextCh <= '9') {
                        const twoDigit = fret * 10 + (nextCh.charCodeAt(0) - 48);
                        if (twoDigit >= 10 && twoDigit <= 24) {
                            fret = twoDigit;
                            skipR.add(`${r}:${c + 1}`);
                        }
                    }
                    frets.push({ string: r + 1, fret });
                }
            }
            if (frets.length > 0) {
                noteOnsets.push({ colOffset: c - span.colStart, col: c, frets });
            }
        }

        return {
            colStart: span.colStart,
            colEnd: span.colEnd,
            barNumber,
            repeatStart: span.repeatStart,
            repeatEnd: span.repeatEnd,
            doubleBar: span.doubleBar,
            ending,
            noteOnsets
        };
    });

    // Check for navigation directives (D.C., D.S., Fine, Coda) in above/below lines
    const annoText = [...above, ...below].join(' ');
    const directives = {
        dc: /\bD\.?\s*C\.?\b|\bDa\s+Capo\b/i.test(annoText),
        ds: /\bD\.?\s*S\.?\b|\bDal\s+Segno\b/i.test(annoText),
        segno: /\bsegno\b|(?:^|\s)[%§](?:\s|$)/i.test(annoText),
        fine: /\bFine\b/i.test(annoText),
        coda: /\bCoda\b|\bTo\s+Coda\b/i.test(annoText)
    };

    return {
        above,
        strings: allStrings,
        below,
        staves,
        stringLabels,
        trimCols,
        bars,
        directives
    };
}

/**
 * @param {string[]} lines without line endings
 * @returns {Array<{kind: 'system'|'chord'|'blank'|'line'|'legend', start: number, end: number}>} blocks in order, end inclusive
 */
export function groupBlocks(lines) {
    const n = lines.length;
    const blocks = [];

    // Pre-mark which lines are staff lines (including context-aware 6-line barless staff runs)
    const staffFlags = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        if (isStaffLine(lines[i])) staffFlags[i] = true;
    }
    let candStart = -1;
    let refLen = 0;
    for (let i = 0; i <= n; i++) {
        if (i < n && (staffFlags[i] || isBarlessStaffCandidate(lines[i], refLen))) {
            if (candStart === -1) {
                candStart = i;
                refLen = lines[i].trim().length;
            }
        } else {
            if (candStart !== -1 && i - candStart >= 6) {
                // Ensure at least one line in the run has a fret digit so 6 divider lines don't match
                const hasFret = lines.slice(candStart, i).some(l => /\d/.test(l));
                if (hasFret) {
                    for (let k = candStart; k < i; k++) staffFlags[k] = true;
                }
            }
            candStart = -1;
            refLen = 0;
        }
    }

    const isStaffAt = (idx) => idx >= 0 && idx < n && staffFlags[idx];
    const isRulerAt = (idx) => idx >= 0 && idx < n && !staffFlags[idx] && RULER.test(lines[idx]);
    const startsRuler = (idx) => isRulerAt(idx) && idx + 1 < n && isStaffAt(idx + 1);

    // 1. Find the staff runs (a block of consecutive string lines), with their ruler, above and below lines
    const rawSystems = [];
    for (let i = 0; i < n; i++) {
        if (!isStaffAt(i) || (i > 0 && isStaffAt(i - 1))) continue;
        let last = i;
        while (last + 1 < n && isStaffAt(last + 1)) last++;
        // a lone string line is a stray quote of a bar, not a staff: leave it a plain line
        if (last === i) continue;
        const staffStart = i;
        const staffEnd = last;
        let start = i;
        if (start > 0 && isRulerAt(start - 1)) start--;
        for (let k = 0; k < MAX_ABOVE && start > 0; k++) {
            const above = lines[start - 1];
            if (isBlank(above) || isStaffAt(start - 1) || LEGEND_HEADING.test(above) || PROSE_DIVIDER.test(above) || (rawSystems.length && start - 1 <= rawSystems[rawSystems.length - 1].end)) break;
            start--;
        }
        let end = last;
        while (end + 1 < n && end - last < MAX_BELOW) {
            const below = lines[end + 1];
            // the next system's ruler or mark line is not ours; a blank line ends the system
            if (isBlank(below) || isStaffAt(end + 1) || LEGEND_HEADING.test(below) || PROSE_DIVIDER.test(below) || startsRuler(end + 1)) break;
            end++;
        }
        // a blank line may separate the stems from the fingering under them: a short run of digit-only lines that is
        // itself followed by a blank line (or the end) is ours, unlike a label sitting right above the next ruler
        if (end > last && end + 1 < n && isBlank(lines[end + 1])) {
            let j = end + 2;
            while (j < n && j - end - 1 <= MAX_BELOW && FINGERING.test(lines[j]) && !isBlank(lines[j])) j++;
            if (j > end + 2 && (j >= n || isBlank(lines[j]))) end = j - 1;
        }
        // marks above the next ruler (no blank line between) belong to the next system
        while (end > last && end + 1 < n && startsRuler(end + 1)) end--;
        rawSystems.push({
            start,
            end,
            staffStart,
            staffEnd,
            staffRuns: [{ start: staffStart, end: staffEnd }]
        });
        i = last;
    }

    // Systems whose "above" lines overlap the previous one's "below" lines: give the line to the later system
    for (let s = 1; s < rawSystems.length; s++) {
        if (rawSystems[s].start <= rawSystems[s - 1].end) rawSystems[s - 1].end = rawSystems[s].start - 1;
    }

    // Merge duet systems: two 6-string staves separated only by a duet part label or shared ruler with no blank lines
    const systems = [];
    for (let s = 0; s < rawSystems.length; s++) {
        const cur = rawSystems[s];
        const next = rawSystems[s + 1];
        const curLines = cur.staffEnd - cur.staffStart + 1;
        const nextLines = next ? next.staffEnd - next.staffStart + 1 : 0;
        if (next && curLines === 6 && nextLines === 6 && next.staffStart - cur.staffEnd - 1 <= 4) {
            const mid = lines.slice(cur.staffEnd + 1, next.staffStart);
            const hasBlankMid = mid.some(isBlank);
            const hasDuetCue = mid.length === 0
                || mid.some(l => DUET_LABEL.test(l) || isRulerLine(l) || /^\s*\|/.test(l))
                || DUET_LABEL.test(lines[cur.start]);
            if (!hasBlankMid && hasDuetCue) {
                systems.push({
                    start: cur.start,
                    end: next.end,
                    staffStart: cur.staffStart,
                    staffEnd: next.staffEnd,
                    staffRuns: [...cur.staffRuns, ...next.staffRuns]
                });
                s++;
                continue;
            }
        }
        systems.push(cur);
    }

    // 2. Walk the lines, tracking footer legend and multi-version boundaries, and emitting blocks
    let s = 0;
    let seenPlayableSystem = false;
    let inLegend = false;
    let currentVersion = 1;

    for (let i = 0; i < n; i++) {
        // Check for multi-version boundary after at least one playable system
        if (seenPlayableSystem) {
            const isDoubleStar = /^\s*\*{15,}\s*$/.test(lines[i]) && i + 1 < n && /^\s*\*{15,}\s*$/.test(lines[i + 1]);
            if (isDoubleStar || VERSION_HEADING.test(lines[i])) {
                // Only advance version if there is at least one full 4+ string system ahead
                const hasFullSystemAhead = systems.slice(s).some(sys => (sys.staffEnd - sys.staffStart + 1) >= 4);
                if (hasFullSystemAhead) {
                    currentVersion++;
                    inLegend = false;
                }
            } else if (!inLegend && LEGEND_HEADING.test(lines[i])) {
                inLegend = true;
            }
        }

        if (s < systems.length && i === systems[s].start) {
            const sys = systems[s];
            const stringCount = sys.staffRuns.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
            // Inside a footer legend, short 2-3 line symbol examples stay 'legend' blocks instead of playable systems
            if (inLegend && stringCount < 4) {
                blocks.push({ kind: 'legend', start: i, end: sys.end, inLegend: true, version: currentVersion });
            } else {
                if (inLegend && stringCount >= 6) {
                    // A full 6-string system after a legend starts a new version/appendix
                    inLegend = false;
                }
                const decomposed = decomposeSystem(lines, sys);
                blocks.push({
                    kind: 'system',
                    start: i,
                    end: sys.end,
                    version: currentVersion,
                    ...decomposed
                });
                seenPlayableSystem = true;
            }
            i = sys.end;
            s++;
            continue;
        }
        if (isBlank(lines[i])) {
            let j = i;
            while (j + 1 < n && isBlank(lines[j + 1]) && !(s < systems.length && j + 1 === systems[s].start)) j++;
            const blk = { kind: 'blank', start: i, end: j, version: currentVersion };
            if (inLegend) blk.inLegend = true;
            blocks.push(blk);
            i = j;
            continue;
        }
        const next = lines[i + 1];
        const nextIsSystem = s < systems.length && i + 1 === systems[s].start;
        if (!inLegend && next !== undefined && !nextIsSystem && !isBlank(next) && isChordLine(lines[i]) && !isStaffAt(i + 1)) {
            blocks.push({ kind: 'chord', start: i, end: i + 1, version: currentVersion });
            i++;
            continue;
        }
        const lineBlk = { kind: 'line', start: i, end: i, text: lines[i], version: currentVersion };
        if (inLegend) lineBlk.inLegend = true;
        blocks.push(lineBlk);
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
