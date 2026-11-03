// extensionDedupe.js
// Exact-duplicate removal for the list of installed extensions, shared by backup restore and sync.

/** Two extensions are the same when their code is: ids are made per install, so the same file added on two devices differs only by id. */
export function extensionKey(ext) {
    return String(ext.source).replace(/\r\n/g, '\n').trim();
}

/**
 * Drops exact duplicates (same source) from a list of extensions. The copy with the lowest id stays, so every device
 * that sees the same copies keeps the same one and a sync settles instead of trading ids back and forth. The kept
 * copy is enabled if any of them was. Entries without a source are left alone.
 * @returns {Array} a new list, in the order the kept copies first appeared
 */
export function dedupeExtensions(list) {
    const groups = new Map();
    const out = [];
    for (const ext of list) {
        if (!ext || typeof ext.source !== 'string') { out.push(ext); continue; }
        const key = extensionKey(ext);
        const group = groups.get(key);
        if (!group) {
            const copy = { ...ext };
            groups.set(key, copy);
            out.push(copy);
        } else {
            if (String(ext.id) < String(group.id)) {
                const slot = out.indexOf(group);
                const copy = { ...ext };
                groups.set(key, copy);
                out[slot] = copy;
                copy.enabled = Boolean(copy.enabled || group.enabled);
            } else {
                group.enabled = Boolean(group.enabled || ext.enabled);
            }
        }
    }
    return out;
}
