// tabSets.js
// Tabs that belong together. A pack can hold several scores of one song that are one set: the tablature and the notation of
// each part from one publisher. The pack says so with `origin` on each score (MusicPackSpec section 6.4). The library keeps
// two fields on each tab option:
//   origin     the pack's `origin`, a label for people
//   variantOf  the id of the head tab of the set, on every tab of the set except the head
// The library list and the picker show only the heads. The player's Tabs menu lists the whole set. The pure functions here
// work on plain objects and touch no storage, so import, migration, rebuild and the screens share one rule.

/** The `origin` the one-off migration gives to tabs it finds in sets without one (it matches the converter's own value). */
export const LEGACY_SET_ORIGIN = 'Jammit';

const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Links the tabs of ONE pack into sets. `entries` are `{ id, origin }` in the pack's score order, the primary score first.
 * Scores with the same `origin` (byte for byte) are a set of two or more; its head is the primary score when it is in the
 * set, otherwise the first score of the set. Returns a Map from each variant's id to its head's id. A score with no origin,
 * or a set of one, stays alone and is not in the map.
 */
export function linkSets(entries) {
    const byOrigin = new Map();
    for (const e of entries || []) {
        if (!e || !isStr(e.id) || !isStr(e.origin)) continue;
        if (!byOrigin.has(e.origin)) byOrigin.set(e.origin, []);
        byOrigin.get(e.origin).push(e.id);
    }
    const variantOf = new Map();
    for (const ids of byOrigin.values()) {
        if (ids.length < 2) continue;
        for (const id of ids.slice(1)) variantOf.set(id, ids[0]);
    }
    return variantOf;
}

/**
 * Reads the sets of a song's tab options. A `variantOf` that names a missing tab, the tab itself, or another variant is
 * ignored, so a broken link leaves a tab standing alone and never hides it. Returns
 * `{ heads, variantsOf, headIdOf }`: `heads` are the tabs to list (standalone tabs and set heads, in order), `variantsOf` maps
 * a head's id to its variants, and `headIdOf` maps every tab id to the id of the head of its set (its own id for a head).
 */
export function resolveSets(tabOptions) {
    const tabs = Array.isArray(tabOptions) ? tabOptions.filter((t) => t && isStr(t.id)) : [];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const isHeadLike = (t) => !isStr(t.variantOf);
    const headIdOf = new Map();
    const variantsOf = new Map();
    const heads = [];
    for (const t of tabs) {
        const head = isStr(t.variantOf) && t.variantOf !== t.id ? byId.get(t.variantOf) : null;
        if (head && isHeadLike(head)) {
            headIdOf.set(t.id, head.id);
            if (!variantsOf.has(head.id)) variantsOf.set(head.id, []);
            variantsOf.get(head.id).push(t);
        } else {
            headIdOf.set(t.id, t.id);
            heads.push(t);
        }
    }
    return { heads, variantsOf, headIdOf };
}

/** The tabs to list for a song: its standalone tabs and the heads of its sets. */
export function visibleTabs(song) {
    return resolveSets(song?.tabOptions).heads;
}

/** The set that holds a tab: the head first, then its variants. A tab in no set gives just itself. Empty when the id is unknown. */
export function setOf(song, tabId) {
    const { variantsOf, headIdOf } = resolveSets(song?.tabOptions);
    const headId = headIdOf.get(tabId);
    if (!headId) return [];
    const byId = new Map((song.tabOptions || []).map((t) => [t.id, t]));
    return [byId.get(headId), ...(variantsOf.get(headId) || [])].filter(Boolean);
}

// ---- Packs and library entries made before `origin` existed ----------------------------------------------------------
// The tab names and file names of a converted play-along pack follow a fixed shape: "<Song> - <Part> (Tablature)" and
// "<part>-<n>-tablature.pdf". Two or more PDFs of one song that follow it, with the same prefix, are a set.

const NAME = /^(?:(.+?)\s+-\s+)?(.+?)\s+\((Tablature|Score)\)\s*$/i;
const FILE = /^([a-z]+(?:-\d+)?)-(tablature|score)\.pdf$/i;

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
const isPdfTab = (t) => String(t?.fileType || '').toLowerCase() === 'pdf' || /\.pdf$/i.test(t?.name || '') || /\.pdf$/i.test(t?.relativePath || '');

/** `{ set, part, view }` from a tab's name or, failing that, its file name, or null when neither has the shape. */
function parseLegacy(tab) {
    const n = NAME.exec(String(tab?.name || ''));
    const f = FILE.exec(baseName(tab?.relativePath));
    if (!n && !f) return null;
    const part = (n ? n[2] : f[1]).toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    const view = (n ? n[3] : f[2]).toLowerCase() === 'score' ? 'notation' : 'tab';
    return { set: n && n[1] ? n[1].trim() : '', part, view };
}

/**
 * Finds the sets in one song's tabs that have no `origin` yet. Returns `{ changes, flags }`. `changes` is a list of
 * `{ tabId, origin, variantOf }` (`variantOf` is null for the head). Rules:
 *  - a candidate is a PDF whose name or file name has the shape above, with no `origin` or `variantOf` yet (so a second run finds nothing);
 *  - candidates with the same prefix form a set, and a set needs two or more tabs;
 *  - the Nth time a part and view appears under one prefix it belongs to layer N, and each layer is its own set. A song that
 *    holds one pack twice, or two packs of the same song, so shows two rows and nothing is merged or removed;
 *  - the head is the first tab of the set in the song's order.
 * `flags` lists what a person should look at: `duplicates` (two tabs of one layer-pair with the same `sha256`) and `leftAlone`
 * (candidates that ended up in no set).
 */
export function deriveLegacySets(song, { origin = LEGACY_SET_ORIGIN } = {}) {
    const tabs = Array.isArray(song?.tabOptions) ? song.tabOptions : [];
    const candidates = [];
    tabs.forEach((t, index) => {
        if (!t || !isStr(t.id) || isStr(t.origin) || isStr(t.variantOf) || !isPdfTab(t)) return;
        const p = parseLegacy(t);
        if (p) candidates.push({ tab: t, index, ...p });
    });
    // Order of appearance: addedAt first, then the song's own order, so layer 1 is the oldest import.
    candidates.sort((a, b) => (a.tab.addedAt || 0) - (b.tab.addedAt || 0) || a.index - b.index);
    const seen = new Map();
    for (const c of candidates) {
        const k = `${c.set}\u0000${c.part}\u0000${c.view}`;
        c.layer = (seen.get(k) || 0) + 1;
        seen.set(k, c.layer);
    }
    const groups = new Map();
    for (const c of candidates) {
        const k = `${c.set}\u0000${c.layer}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
    }
    const changes = [];
    const flags = { duplicates: [], leftAlone: [] };
    for (const members of groups.values()) {
        if (members.length < 2) { flags.leftAlone.push(members[0].tab.id); continue; }
        members.sort((a, b) => a.index - b.index);
        const head = members[0].tab;
        for (const m of members) changes.push({ tabId: m.tab.id, origin, variantOf: m.tab === head ? null : head.id });
    }
    const bySha = new Map();
    for (const c of candidates) {
        if (!isStr(c.tab.sha256)) continue;
        const k = `${c.set}\u0000${c.part}\u0000${c.view}\u0000${c.tab.sha256}`;
        if (!bySha.has(k)) bySha.set(k, []);
        bySha.get(k).push(c.tab.id);
    }
    for (const ids of bySha.values()) if (ids.length > 1) flags.duplicates.push(ids);
    return { changes, flags };
}

/**
 * A dry run over a whole library: what `deriveLegacySets` would change, without writing anything. `songs` is the list of
 * song records. Returns `{ changes, report }`: `changes` is `[{ songId, tabId, origin, variantOf }]` and `report` counts
 * the songs and sets found, the list rows before and after, and the songs with more than one set or with duplicates.
 */
export function planTabSetMigration(songs, options = {}) {
    const changes = [];
    const report = { songs: 0, sets: 0, rowsBefore: 0, rowsAfter: 0, multiSet: [], duplicates: [], leftAlone: [] };
    for (const song of songs || []) {
        const { changes: c, flags } = deriveLegacySets(song, options);
        const tabs = song?.tabOptions || [];
        const before = visibleTabs(song).length;
        if (flags.duplicates.length) report.duplicates.push({ songId: song.id, title: song.title, tabIds: flags.duplicates });
        if (flags.leftAlone.length) report.leftAlone.push({ songId: song.id, title: song.title, tabIds: flags.leftAlone });
        if (!c.length) continue;
        const next = tabs.map((t) => {
            const m = c.find((x) => x.tabId === t.id);
            return m ? { ...t, origin: m.origin, variantOf: m.variantOf } : t;
        });
        const heads = c.filter((x) => !x.variantOf).length;
        report.songs += 1;
        report.sets += heads;
        report.rowsBefore += before;
        report.rowsAfter += visibleTabs({ tabOptions: next }).length;
        if (heads > 1) report.multiSet.push({ songId: song.id, title: song.title, sets: heads });
        for (const x of c) changes.push({ songId: song.id, ...x });
    }
    return { changes, report };
}

/**
 * What it takes to undo a migration plan: for each change, the set fields the tab has now, so applying them puts it back
 * (null clears a field). `songs` are the song records the plan was made from.
 */
export function undoRecordFor(changes, songs) {
    const tabs = new Map();
    for (const s of songs || []) for (const t of s?.tabOptions || []) tabs.set(`${s.id}\u0000${t.id}`, t);
    return (changes || []).map((c) => {
        const t = tabs.get(`${c.songId}\u0000${c.tabId}`) || {};
        return { songId: c.songId, tabId: c.tabId, origin: isStr(t.origin) ? t.origin : null, variantOf: isStr(t.variantOf) ? t.variantOf : null };
    });
}

/** Groups a flat list of `{ songId, tabId, origin, variantOf }` into one list of patches for each song, for `applyTabSetPatches`. */
export function patchesBySong(items) {
    const bySong = new Map();
    for (const { songId, ...patch } of items || []) {
        if (!bySong.has(songId)) bySong.set(songId, []);
        bySong.get(songId).push(patch);
    }
    return bySong;
}
