// fillStore.js
// Keeps what "Fill in missing tabs" has settled in a cache file (one JSON entry in the browser's Cache Storage, like the
// album artwork), so a restart does not lose it: the songs a run has added, the ones that wait for a pick (with the address
// of each match), the ones that failed, and the ones no provider had. It is a cache: Settings > Clear cached data removes it,
// and it is never in a backup or the sync. Nothing here fails the caller: without Cache Storage the state lasts the session.
// Unit tested in tests/fillRun.test.mjs.

export const FILL_CACHE_NAME = 'majestictab-fill-run';
const ENTRY = '/majestictab-fill-run.json';
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** What a run keeps: only settled states, and for a pick only what is needed to ask again. */
export function snapshotOf({ songIds, items, notFound }) {
    const kept = {};
    for (const [id, item] of items) {
        if (!['added', 'pick', 'failed'].includes(item.state)) continue;
        kept[id] = { state: item.state, label: item.label || '', message: item.message || '' };
        if (item.state === 'pick' && item.choose) {
            const { title, query, options, sourceId, addresses } = item.choose;
            kept[id].choose = { title, query, options, sourceId, addresses };
        }
    }
    return { v: 1, at: Date.now(), songIds: [...songIds], items: kept, notFound: [...notFound] };
}

/** @returns {Promise<object|null>} the saved state, or null when there is none, it is stale, or it cannot be read */
export async function loadFillState(cacheStorage = globalThis.caches) {
    if (!cacheStorage) return null;
    try {
        const cache = await cacheStorage.open(FILL_CACHE_NAME);
        const hit = await cache.match(ENTRY);
        if (!hit) return null;
        const state = await hit.json();
        if (state?.v !== 1 || Date.now() - state.at > MAX_AGE_MS) return null;
        return state;
    } catch { return null; }
}

export async function saveFillState(state, cacheStorage = globalThis.caches) {
    if (!cacheStorage) return false;
    try {
        const cache = await cacheStorage.open(FILL_CACHE_NAME);
        await cache.put(ENTRY, new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
        return true;
    } catch { return false; }
}

export async function clearFillState(cacheStorage = globalThis.caches) {
    if (!cacheStorage) return;
    try { await cacheStorage.delete(FILL_CACHE_NAME); } catch { /* nothing to clear */ }
}
