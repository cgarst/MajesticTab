// textProcessor/textEditing.js
// Pure helpers behind the "Edit text" window (editableText.js): the blocks it inserts and the rules for typing on a staff.
// No DOM, so they run under Node tests. The staff it writes is the named-string shape the reader already recognises
// as a staff (`e|---0---|`), so a jotted riff reads, pages and tracks bars like any other staff tab.

import { isStaffLine, isChordLine } from './textBlocks.js';

const STRING_NAMES = { 6: ['e', 'B', 'G', 'D', 'A', 'E'], 7: ['e', 'B', 'G', 'D', 'A', 'E', 'B'], 8: ['e', 'B', 'G', 'D', 'A', 'E', 'B', 'F#'] };
export const SECTIONS = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Bridge', 'Solo', 'Outro'];
export const CHORD_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const CHORD_QUALITIES = [['', 'Major'], ['m', 'Minor'], ['7', '7'], ['maj7', 'Maj7'], ['m7', 'Min7'], ['sus2', 'Sus2'], ['sus4', 'Sus4'], ['dim', 'Dim'], ['aug', 'Aug'], ['add9', 'Add9']];
// What a staff takes when typed on: fret digits and the technique marks the reader draws
const STAFF_CHAR = /^[0-9hpbsrx~/\\()<>^*=.]$/;
export const BAR_COLUMNS = 16;

const lineBounds = (value, caret) => {
    const start = value.lastIndexOf('\n', caret - 1) + 1;
    const nl = value.indexOf('\n', caret);
    return { start, end: nl < 0 ? value.length : nl };
};

/** A staff of `bars` bars, one line per string: 6, 7 or 8 strings. */
export function buildStaff(stringCount = 6, bars = 2, columns = BAR_COLUMNS) {
    const names = STRING_NAMES[stringCount] || STRING_NAMES[6];
    const width = Math.max(...names.map((n) => n.length));
    const body = ('-'.repeat(columns) + '|').repeat(bars);
    return names.map((n) => `${n.padEnd(width)}|${body}`).join('\n');
}

/**
 * Where a block goes: on the caret's own line when it is empty, else after it with a blank line between.
 * Returns { at, text } for an insertion; the caret ends after the block.
 */
export function insertBlockEdit(value, caret, block) {
    // On a staff, a label goes on its own line above the staff, never between its strings
    const blk = staffBlockAt(value, caret);
    if (blk) return { at: blk.starts[blk.first], text: `${block}\n` };
    const { start, end } = lineBounds(value, caret);
    if (value.slice(start, end).trim() === '') return { at: start, text: `${block}\n` };
    return { at: end, text: `\n\n${block}\n` };
}

/** The consecutive staff lines around the caret as { start, end } offsets, or null when it is not on a staff. */
function staffBlockAt(value, caret) {
    const lines = value.split('\n');
    let offset = 0;
    let idx = -1;
    const starts = lines.map((l) => { const s = offset; offset += l.length + 1; return s; });
    for (let i = 0; i < lines.length; i++) if (caret >= starts[i] && caret <= starts[i] + lines[i].length) { idx = i; break; }
    if (idx < 0 || !isStaffLine(lines[idx])) return null;
    let a = idx, b = idx;
    while (a > 0 && isStaffLine(lines[a - 1])) a--;
    while (b < lines.length - 1 && isStaffLine(lines[b + 1])) b++;
    return { first: a, last: b, lines, starts };
}

/** One more bar on every string of the staff the caret is in. Returns { value, caret } or null. */
export function addBar(value, caret, columns = BAR_COLUMNS) {
    const blk = staffBlockAt(value, caret);
    if (!blk) return null;
    const add = '-'.repeat(columns) + '|';
    const lines = blk.lines.slice();
    for (let i = blk.first; i <= blk.last; i++) lines[i] = lines[i].replace(/\s+$/, '') + add;
    return { value: lines.join('\n'), caret: Math.min(caret, lines.join('\n').length) };
}

/**
 * What a key does on a staff. `ch` is the typed character, or 'Backspace'.
 * Returns null to leave the key alone (not on a staff string), else { replace: [from, to, text], caret } to apply.
 */
export function staffKey(value, caret, ch) {
    const { start, end } = lineBounds(value, caret);
    const line = value.slice(start, end);
    const bar = line.indexOf('|');
    const col = caret - start;
    if (!isStaffLine(line) || bar < 0 || col <= bar) return null;
    if (ch === 'Backspace') {
        const prev = line[col - 1];
        if (col - 1 <= bar || prev === '|' || prev === '-') return { replace: null, caret: caret - 1 };
        return { replace: [caret - 1, caret, '-'], caret: caret - 1 };
    }
    // A space steps over a column; anything else that is not staff notation is ignored
    if (ch === ' ') return { replace: null, caret: col < line.length ? caret + 1 : caret };
    if (!STAFF_CHAR.test(ch)) return { replace: null, caret };
    if (col >= line.length || line[col] === '|') return { replace: null, caret };
    return { replace: [caret, caret + 1, ch], caret: caret + 1 };
}

/**
 * A chord name: at the caret in lyrics or empty space, but on a staff it joins the chord line above the staff,
 * or starts one there. Returns { at, to, text } to replace [at, to) with text.
 */
export function chordEdit(value, caret, selectionEnd, name) {
    const blk = staffBlockAt(value, caret);
    if (!blk) return { at: caret, to: selectionEnd, text: `${name}  ` };
    const above = blk.first > 0 ? blk.lines[blk.first - 1] : '';
    if (above.trim() && isChordLine(above)) {
        const end = blk.starts[blk.first - 1] + above.length;
        return { at: end, to: end, text: `  ${name}` };
    }
    const at = blk.starts[blk.first];
    return { at, to: at, text: `${name}\n` };
}
