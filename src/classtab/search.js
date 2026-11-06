// classtab/search.js
// Classical tab results for the library's search box: composers and pieces from the installed archive that match,
// with the pinned ones first. Nothing here when no archive is installed.

import { getCatalogRecord } from './archive.js';
import { browse } from './catalog.js';
import { isComposerPinned, isPiecePinned } from './pins.js';

const MAX_PIECES = 8;
const MAX_COMPOSERS = 3;

/**
 * @param {string} query
 * @returns {Promise<null | {composers: Array<{index:number, name:string, count:number, pinned:boolean}>,
 *   pieces: Array<{composer:object, piece:object, pinned:boolean}>, total:number}>}
 */
export async function searchClasstab(query) {
    const rec = await getCatalogRecord();
    if (!rec || !query.trim()) return null;
    const { composers } = rec;
    const res = browse(composers, { query });
    if (!res.pieces.length) return { composers: [], pieces: [], total: 0 };
    const rank = (m) => (isPiecePinned(composers[m.composer].name, m.piece.title) ? 0 : isComposerPinned(composers[m.composer].name) ? 1 : 2);
    const sorted = res.pieces.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i);
    const pieces = sorted.slice(0, MAX_PIECES).map(({ m }) => ({
        composer: composers[m.composer], piece: m.piece, pinned: isPiecePinned(composers[m.composer].name, m.piece.title)
    }));
    const hits = [...res.composerCounts.entries()]
        .map(([index, count]) => ({ index, name: composers[index].name, count, pinned: isComposerPinned(composers[index].name) }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.count - a.count);
    return { composers: hits.slice(0, MAX_COMPOSERS), pieces, total: res.pieces.length };
}
