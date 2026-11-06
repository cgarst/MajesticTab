// classtab/catalog.js
// Browsing the parsed catalog: the composer list, the pieces of one composer, search and filters. Pure functions.

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const foldText = fold;

/** "Fernando Sor" sorts under S: the last word of the name is the sort key. */
function sortKey(name) {
    const first = name.split(/\s*(?:&|\/| and )\s*/)[0].trim();
    const words = first.split(/\s+/);
    return fold(words.length > 1 ? `${words.at(-1)} ${words.slice(0, -1).join(' ')}` : first);
}

/**
 * The composer's name split around the word the list is sorted on (the same word sortKey uses):
 * "Fernando Sor" -> { before: "Fernando ", key: "Sor", after: "" }.
 */
export function nameParts(name) {
    const text = String(name || '');
    const first = text.split(/\s*(?:&|\/| and )\s*/)[0].trim();
    const word = first.split(/\s+/).at(-1) || '';
    const at = word ? text.indexOf(first) + first.lastIndexOf(word) : -1;
    if (at < 0) return { before: text, key: '', after: '' };
    return { before: text.slice(0, at), key: word, after: text.slice(at + word.length) };
}

export function composerList(composers) {
    return composers
        .map((c, index) => ({ index, name: c.name, count: c.pieces.length, key: sortKey(c.name) }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/** Plain facts about a piece, in the order they are shown: "Easy · Drop D · MIDI · Video". */
export function pieceFacts(p) {
    const f = [];
    if (p.is_new) f.push('New');
    else if (p.is_updated) f.push('Updated');
    if (p.is_easy) f.push('Easy');
    if (p.is_duet) f.push('Duet');
    if (p.has_lhf) f.push('Fingering');
    if (p.tuning) f.push(p.tuning === 'drop D' ? 'Drop D' : p.tuning === 'lute tuning' ? 'Lute tuning' : 'Other tuning');
    if (p.midi_urls?.length) f.push('MIDI');
    if (p.video_links?.length) f.push('Video');
    return f;
}

export const FILTERS = [
    { id: 'easy', label: 'Easy', test: (p) => p.is_easy },
    { id: 'midi', label: 'Has MIDI', test: (p) => Boolean(p.midi_urls?.length) },
    { id: 'video', label: 'Has video', test: (p) => Boolean(p.video_links?.length) },
    { id: 'dropd', label: 'Drop D', test: (p) => p.tuning === 'drop D' }
];
export const MORE_FILTERS = [
    { id: 'lhf', label: 'Fingering', test: (p) => p.has_lhf },
    { id: 'duet', label: 'Duet', test: (p) => p.is_duet },
    { id: 'lute', label: 'Lute tuning', test: (p) => p.tuning === 'lute tuning' },
    { id: 'othertuning', label: 'Other tuning', test: (p) => p.tuning === 'other tuning' }
];
const ALL_FILTERS = [...FILTERS, ...MORE_FILTERS];

const passes = (p, active) => active.every((id) => ALL_FILTERS.find((f) => f.id === id)?.test(p));
export const passesFilters = passes;

/**
 * @param {Array} composers the catalog
 * @param {{query?: string, filters?: string[], composer?: number}} q
 * @returns {{composerCounts: Map<number, number>, pieces: Array<{composer:number, piece:object}>}}
 *   composerCounts: pieces per composer after the filters (and search); pieces: the list to show
 */
export function browse(composers, { query = '', filters = [], composer = null } = {}) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const composerCounts = new Map();
    const matches = [];
    composers.forEach((c, ci) => {
        const hay = fold(`${c.name} ${c.aliases || ''}`);
        const composerHit = terms.length > 0 && terms.every((t) => hay.includes(t));
        let n = 0;
        for (const p of c.pieces) {
            if (!passes(p, filters)) continue;
            if (terms.length && !composerHit) {
                const title = fold(`${p.title} ${c.name} ${c.aliases || ''}`);
                if (!terms.every((t) => title.includes(t))) continue;
            }
            n++;
            matches.push({ composer: ci, piece: p });
        }
        if (n) composerCounts.set(ci, n);
    });
    // Searching shows pieces across all composers; otherwise just the chosen one
    const pieces = terms.length || composer == null ? matches : matches.filter((m) => m.composer === composer);
    return { composerCounts, pieces };
}

/** "Fernando Sor · 1778–1839" */
export function composerHeading(c) {
    return [c.name, c.dates ? c.dates.replace(/-/g, '–') : ''].filter(Boolean).join(' · ');
}

export function formatUpdated(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
