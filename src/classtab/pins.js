// classtab/pins.js
// Pinned composers and pieces in the Classical tab library.
//
// A pin is stored by name, never by position or file name: a composer is its name, a piece is its composer's name plus
// its title. Names are compared folded (no accents, case or extra spaces), so a re-numbered catalog, a moved tab file
// or a different spelling of the same letters in a newer archive keeps every pin. A pin whose composer or piece is not
// in the installed catalog is kept (it comes back if a later archive has it again) and simply not shown.
// Pins are kept in localStorage and travel with the backup's settings.

import { foldText } from './catalog.js';

export const CLASSTAB_PINS_KEY = 'majestictab_classtab_pins';

const norm = (s) => foldText(s).replace(/\s+/g, ' ').trim();

function read() {
    try {
        const v = JSON.parse(localStorage.getItem(CLASSTAB_PINS_KEY) || 'null');
        return {
            composers: Array.isArray(v?.composers) ? v.composers.filter((n) => typeof n === 'string' && n) : [],
            pieces: Array.isArray(v?.pieces) ? v.pieces.filter((p) => p && typeof p.composer === 'string' && typeof p.title === 'string') : []
        };
    } catch {
        return { composers: [], pieces: [] };
    }
}

function write(pins) {
    try { localStorage.setItem(CLASSTAB_PINS_KEY, JSON.stringify(pins)); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('classtabPinsChanged'));
}

export function isComposerPinned(composerName) {
    const n = norm(composerName);
    return read().composers.some((c) => norm(c) === n);
}

export function isPiecePinned(composerName, title) {
    const c = norm(composerName);
    const t = norm(title);
    return read().pieces.some((p) => norm(p.composer) === c && norm(p.title) === t);
}

/** @returns {boolean} whether the composer is pinned afterwards */
export function toggleComposerPin(composerName) {
    const pins = read();
    const n = norm(composerName);
    const had = pins.composers.some((c) => norm(c) === n);
    pins.composers = had ? pins.composers.filter((c) => norm(c) !== n) : [...pins.composers, composerName];
    write(pins);
    return !had;
}

/** @returns {boolean} whether the piece is pinned afterwards */
export function togglePiecePin(composerName, title) {
    const pins = read();
    const c = norm(composerName);
    const t = norm(title);
    const had = pins.pieces.some((p) => norm(p.composer) === c && norm(p.title) === t);
    pins.pieces = had
        ? pins.pieces.filter((p) => !(norm(p.composer) === c && norm(p.title) === t))
        : [...pins.pieces, { composer: composerName, title }];
    write(pins);
    return !had;
}

/**
 * The pins that exist in this catalog.
 * @param {Array} composers the catalog's composers
 * @returns {{composers: number[], pieces: Array<{composer:number, piece:object}>}} composer indexes and pieces, in the order pinned
 */
export function resolvePins(composers) {
    const pins = read();
    const byName = new Map();
    composers.forEach((c, i) => { const k = norm(c.name); if (!byName.has(k)) byName.set(k, i); });
    const comps = [];
    for (const name of pins.composers) {
        const i = byName.get(norm(name));
        if (i != null && !comps.includes(i)) comps.push(i);
    }
    const pieces = [];
    for (const p of pins.pieces) {
        const ci = byName.get(norm(p.composer));
        if (ci == null) continue;
        const t = norm(p.title);
        const piece = composers[ci].pieces.find((x) => norm(x.title) === t);
        if (piece && !pieces.some((m) => m.piece === piece)) pieces.push({ composer: ci, piece });
    }
    return { composers: comps, pieces };
}
