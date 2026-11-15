// audioSync/anchors.js
// Turns the units that textSync.js works with (a text block number, or the index of a PDF canvas) into the places a
// Music Pack sync point names (SPEC sections 9.2 and 9.3): the page in the PDF file, or the line of the text file. The
// store keeps the places, so a point stays right when the text is parsed differently or the PDF is cut to another
// range of pages; the unit is only what the open tab needs to draw and follow.
//
//   PDF   unit = canvas index; canvas 0 is the first page the tab shows, `firstPage` (the tab's `startPage`, or 1).
//   text  unit = index in the block list `groupBlocks` returns for the file's lines; a point names the line of the
//         block's top string row, and any line inside a block names that block.
//
// It also names the key a text or PDF tab's points are stored under.

import { decodeText } from '../utils/decodeText.js';
import { groupBlocks } from '../textProcessor/textBlocks.js';
import { loadRecord, saveRecord, deleteRecord } from './syncStore.js';

/**
 * The song key a text or PDF tab's sync points are stored under: the song and the score file (its SHA-256, the
 * identity that anchors are valid for, SPEC section 6), so two tabs of one song sync separately. The store makes a
 * storage key of it as for any other song key.
 */
export const scoreSyncKey = (songKey, sha256) => `score:${sha256}:${songKey}`;

/**
 * The song key of earlier versions, shared by every text and PDF tab of a song. Records under it are claimed by the
 * first tab that opens (textSync.js) and are still read when a tab is exported.
 */
export const legacyScoreSyncKey = (songKey) => `text:${songKey}`;

/** The lines of a text score as the spec counts them (section 9.3): decoded, with CRLF and CR made LF. */
export function textLines(bytes) {
    return decodeText(bytes).replace(/\r\n?/g, '\n').split('\n');
}

/** The blocks of a text score, in the order its sync units number them (the `data-block` of textProcessor.js). */
export const textBlocksOf = (bytes) => groupBlocks(textLines(bytes));

/** `{ unit }` points to stored `pdf` or `text` points. Points whose unit is not in the tab are dropped. */
export function unitsToPoints(points, anchorType, { firstPage = 1, blocks = [] } = {}) {
    const out = [];
    for (const p of points || []) {
        const base = { ...(p.id ? { id: p.id } : {}), timeMs: p.timeMs, source: p.source || 'manual' };
        const unit = p.unit ?? p.barIndex;
        if (!Number.isInteger(unit) || unit < 0) continue;
        if (anchorType === 'pdf') out.push({ ...base, page: firstPage + unit });
        else {
            const blk = blocks[unit];
            if (blk && blk.kind !== 'blank') out.push({ ...base, line: blk.staffStart ?? blk.start });
        }
    }
    return out;
}

/** Stored `pdf` or `text` points to the points textSync.js uses, `{ barIndex: unit, occurrence: 0, pos: 0 }`. */
export function pointsToUnits(points, anchorType, { firstPage = 1, blocks = [] } = {}) {
    const out = [];
    for (const p of points || []) {
        let unit = -1;
        if (anchorType === 'pdf') unit = p.page - firstPage;
        else unit = blocks.findIndex((b) => b.kind !== 'blank' && p.line >= b.start && p.line <= b.end);
        if (unit < 0) continue;
        out.push({ ...(p.id ? { id: p.id } : {}), barIndex: unit, occurrence: 0, pos: 0, timeMs: p.timeMs, source: p.source || 'manual' });
    }
    return out;
}

/**
 * Before the key named the score, one record per recording was shared by every text and PDF tab of a song. The first tab
 * of its kind to open takes it over: its points are saved under the tab's own key and the old record is removed. A
 * record of units (the first version) goes to whichever tab opens first. A record of the other kind of tab is left
 * alone. Returns the record now stored under `key`, or null when there was nothing to take.
 */
export function claimLegacyRecord(songKey, media, key, anchorType, ctx, storage) {
    const legacyKey = legacyScoreSyncKey(songKey);
    const legacy = loadRecord(legacyKey, media, storage);
    if (!legacy?.points.length || (legacy.anchorType !== 'unit' && legacy.anchorType !== anchorType)) return null;
    const native = legacy.anchorType === 'unit' ? unitsToPoints(legacy.points, anchorType, ctx) : legacy.points;
    const claimed = saveRecord(key, media, native, storage, legacy.updatedAt, anchorType);
    deleteRecord(legacyKey, media, storage);
    return claimed?.points.length ? claimed : null;
}
