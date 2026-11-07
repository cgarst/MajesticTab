// recordSync.js
// Three-way sync for the small records that backups carry besides tab files: settings,
// collections, songs, recents and setlists. Each record has a key, a fingerprint of its value, and the
// fingerprint it had at the last sync (the base). Comparing this device, the snapshot and the base tells
// an edit or a deletion from a new record, the same way syncEngine treats tabs.

export const RECORD_ACTION = {
    PULL: 'pull',                    // the snapshot's copy replaces (or adds) this device's
    PUSH: 'push',                    // this device's copy goes into the next snapshot
    DELETE_LOCAL: 'delete-local',    // removed in the snapshot since the last sync
    DELETE_REMOTE: 'delete-remote'   // removed on this device since the last sync
};

/** Same JSON for the same value, whatever order its keys were written in. */
export function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Short fingerprint (two FNV-1a passes) of a record's value; the base holds one per record, not the record. */
export function fingerprintValue(value) {
    const text = stableStringify(value);
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    }
    return `${a.toString(36)}${b.toString(36)}.${text.length}`;
}

/**
 * What to do with one record.
 * @param {string|undefined} mine fingerprint on this device (undefined: absent)
 * @param {string|undefined} theirs fingerprint in the snapshot
 * @param {string|undefined} was fingerprint at the last sync
 * @param {function(): 'mine'|'theirs'|null} [tie] settles a record changed on both sides; without it this device wins
 * @returns {{action: string, conflict?: boolean}|null} null when nothing needs to move
 */
export function decideRecord(mine, theirs, was, tie) {
    if (mine !== undefined && theirs !== undefined) {
        if (mine === theirs) return null;
        const here = was !== mine, there = was !== theirs;
        if (here && !there) return { action: RECORD_ACTION.PUSH };
        if (there && !here) return { action: RECORD_ACTION.PULL };
        const winner = tie ? tie() : null;
        return { action: winner === 'theirs' ? RECORD_ACTION.PULL : RECORD_ACTION.PUSH, conflict: true };
    }
    if (mine !== undefined) {
        if (was === undefined) return { action: RECORD_ACTION.PUSH };
        if (was === mine) return { action: RECORD_ACTION.DELETE_LOCAL };
        return { action: RECORD_ACTION.PUSH, conflict: true };
    }
    if (theirs !== undefined) {
        if (was === undefined) return { action: RECORD_ACTION.PULL };
        if (was === theirs) return { action: RECORD_ACTION.DELETE_REMOTE };
        return { action: RECORD_ACTION.PULL, conflict: true };
    }
    return null;
}

/**
 * Decide every record of the kinds both sides know. `mine` and `theirs` are Maps of key to
 * { kind, id, label, fp, value, time? }; `base` is an object of key to fingerprint.
 * `skipKinds` are kinds the snapshot does not carry at all (an older version wrote it), where absence means nothing.
 * @returns {Array<{key, kind, id, label, action, conflict?: boolean, value?: any}>}
 */
export function planRecords(mine, theirs, base, skipKinds = new Set()) {
    const out = [];
    for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
        const m = mine.get(key), t = theirs.get(key);
        const kind = (m || t).kind;
        if (skipKinds.has(kind)) continue;
        const tie = (m && t && m.time != null && t.time != null)
            ? () => (t.time > m.time ? 'theirs' : m.time > t.time ? 'mine' : null)
            : null;
        const d = decideRecord(m?.fp, t?.fp, base ? base[key] : undefined, tie);
        if (!d) continue;
        out.push({ key, kind, id: (m || t).id, label: (m || t).label, ...d, value: t?.value });
    }
    return out;
}

const NOUN = {
    setting: ['setting', 'settings'], syncpoints: ['sync point set', 'sync point sets'], collection: ['collection', 'collections'],
    song: ['song', 'songs'], recent: ['recent', 'recents'], setlist: ['setlist', 'setlists']
};
const noun = (kind, n) => NOUN[kind][n === 1 ? 0 : 1];
const OTHER_KIND = { setting: 'setting', syncpoints: 'setting', collection: 'collection', song: 'song', recent: 'song', setlist: 'collection' };

/** Plan lines for the sync screen, one per kind and direction: { receive, send }. */
export function describeRecords(decisions) {
    const receive = [], send = [];
    const names = (list) => {
        const shown = list.slice(0, 4).map(d => d.label).filter(Boolean);
        return shown.length ? `: ${shown.join(', ')}${list.length > shown.length ? `, +${list.length - shown.length} more` : ''}` : '';
    };
    for (const kind of Object.keys(NOUN)) {
        const mine = decisions.filter(d => d.kind === kind);
        const line = (list, text, into) => { if (list.length) into.push({ kind: OTHER_KIND[kind], text: `${list.length} ${noun(kind, list.length)} ${text}${names(list)}` }); };
        const of = (action, conflict) => mine.filter(d => d.action === action && Boolean(d.conflict) === conflict);
        const pull = of(RECORD_ACTION.PULL, false), push = of(RECORD_ACTION.PUSH, false);
        line(pull, 'new or changed in the snapshot', receive);
        line(of(RECORD_ACTION.PULL, true), 'changed on both sides; the snapshot is newer', receive);
        line(of(RECORD_ACTION.DELETE_LOCAL, false), 'removed in the snapshot, removed here', receive);
        line(push, 'new or changed on this device', send);
        line(of(RECORD_ACTION.PUSH, true), 'changed on both sides; this device\'s copy is kept', send);
        line(of(RECORD_ACTION.DELETE_REMOTE, false), 'removed on this device, removed from the snapshot', send);
    }
    return { receive, send };
}
