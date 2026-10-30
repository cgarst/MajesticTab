// setlistStore.js
// IndexedDB storage for setlists: ordered lists of library tabs ({ songId, tabId }).

import { getDB, STORE_SETLISTS } from './fileStore.js';
import { hasSupporter } from './channel.js';

function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Creating and changing setlists is a Supporter feature; reading, playing, restoring and importing are not.
// The UI shows the paywall first, so this only stops callers that skip it.
function assertCanEdit() {
    if (!hasSupporter()) throw new Error('Editing setlists needs MajesticTab Supporter');
}

function tx(mode, run) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const t = db.transaction(STORE_SETLISTS, mode);
        const req = run(t.objectStore(STORE_SETLISTS));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}

export async function getAllSetlists() {
    const all = (await tx('readonly', s => s.getAll())) || [];
    return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function getSetlist(id) {
    return (await tx('readonly', s => s.get(id))) || null;
}

async function saveSetlist(setlist) {
    setlist.updatedAt = Date.now();
    await tx('readwrite', s => s.put(setlist));
    return setlist;
}

export async function createSetlist(name) {
    assertCanEdit();
    const trimmed = String(name || '').trim() || 'Untitled setlist';
    return saveSetlist({ id: genId('setlist'), name: trimmed, items: [], createdAt: Date.now() });
}

export async function renameSetlist(id, name) {
    assertCanEdit();
    const setlist = await getSetlist(id);
    const trimmed = String(name || '').trim();
    if (!setlist || !trimmed) return null;
    setlist.name = trimmed;
    return saveSetlist(setlist);
}

export async function deleteSetlist(id) {
    assertCanEdit();
    await tx('readwrite', s => s.delete(id));
}

/** Append a tab to a setlist. A null tabId means "the song's default tab" at play time. */
export async function addToSetlist(setlistId, songId, tabId = null) {
    assertCanEdit();
    const setlist = await getSetlist(setlistId);
    if (!setlist || !songId) return null;
    setlist.items.push({ id: genId('sli'), songId, tabId: tabId || null });
    return saveSetlist(setlist);
}

export async function removeFromSetlist(setlistId, itemId) {
    assertCanEdit();
    const setlist = await getSetlist(setlistId);
    if (!setlist) return null;
    setlist.items = setlist.items.filter(i => i.id !== itemId);
    return saveSetlist(setlist);
}

/** Move an item by delta positions (-1 up, +1 down). */
export async function moveSetlistItem(setlistId, itemId, delta) {
    assertCanEdit();
    const setlist = await getSetlist(setlistId);
    if (!setlist) return null;
    const from = setlist.items.findIndex(i => i.id === itemId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= setlist.items.length) return setlist;
    const [item] = setlist.items.splice(from, 1);
    setlist.items.splice(to, 0, item);
    return saveSetlist(setlist);
}

export async function clearAllSetlists() {
    await tx('readwrite', s => s.clear());
}

export async function importSetlists(setlists = [], { wipe = false } = {}) {
    let count = 0;
    for (const sl of setlists) {
        if (!sl || !sl.id || !Array.isArray(sl.items)) continue;
        if (!wipe && await getSetlist(sl.id)) continue;
        await tx('readwrite', s => s.put(sl));
        count++;
    }
    return count;
}
