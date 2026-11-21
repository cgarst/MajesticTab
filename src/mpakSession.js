// mpakSession.js
// The temporary storage of a pack opened from a file. Everything the reader keeps for a song (its audio files, which
// slot plays which, the YouTube videos, the sync points) hangs off the song key, so a pack's key carries a marker and an
// id of its own. It then shares nothing with a library song of the same artist and title, and clearing the pack is
// removing what carries that id. No DOM; the stores are read through dynamic imports so a test can run it without them.

import { plainOwnKey } from './songKey.js';

/** Starts every song key of an opened pack; followed by the pack's id and a space. */
export const PACK_KEY_MARK = 'mpak~';

// The packs opened in this session: the startup sweep leaves them alone
const livePacks = new Set();

export function newPackId() {
    const id = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`).toLowerCase();
    livePacks.add(id);
    return id;
}

const PACK_ID_IN = /mpak~([0-9a-f-]+)/i;
// Is this stored key or song key of a pack to be removed? One pack by its id, or (no id) any pack not open in this session.
const wanted = (text, packId) => {
    const m = PACK_ID_IN.exec(String(text || ''));
    if (!m) return false;
    const id = m[1].toLowerCase();
    return packId ? id === packId : !livePacks.has(id);
};

/** The song key of a pack's song: the key the reader would use, under the pack's own id. */
export const packSongKey = (packId, baseKey) => `${PACK_KEY_MARK}${packId} ${baseKey}`;

export const isPackKey = (key) => typeof key === 'string' && key.startsWith(PACK_KEY_MARK);

/** A song key as a person reads it: without the pack's marker. */
export const plainSongKey = (key) => plainOwnKey(isPackKey(key) ? key.replace(/^mpak~\S+ /, '') : key);

/**
 * Removes what a pack stored: its settings, sync points and audio files. `packId` names one pack; without it every
 * pack's leftovers go (a pack that was never closed cleanly, found at startup). An audio file another song also uses is
 * kept, only unlinked from the pack.
 */
export async function clearPackStorage(packId = null) {
    if (packId) { packId = String(packId).toLowerCase(); livePacks.delete(packId); }
    try {
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && wanted(k, packId)) stale.push(k);
        }
        for (const k of stale) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    try {
        const { recordStorage } = await import('./audioSync/syncRecordStore.js');
        const stale = [];
        for (let i = 0; i < recordStorage.length; i++) {
            const k = recordStorage.key(i);
            if (k && wanted(k, packId)) stale.push(k);
        }
        for (const k of stale) recordStorage.removeItem(k);
    } catch { /* the sync store is not available */ }
    try {
        const { listAudioFiles, unlinkAudioFile } = await import('./audioSync/audioFileStore.js');
        for (const meta of await listAudioFiles()) {
            for (const key of meta.songKeys || []) {
                if (isPackKey(key) && wanted(key, packId)) await unlinkAudioFile(meta.id, key);
            }
        }
    } catch { /* the audio store is not available */ }
}
