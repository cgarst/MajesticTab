// urlImport/attachSync.js
// After a score opened from a web address is on screen, places the importer's sync sets (one list of bar start times
// per linked video) on the score's played bars and stores them as that song's points for each video. Waits for the
// score's MIDI tick lookup, since the played bars (repeats included) come from it.

import { getScoreContext } from '../audioSync/audioSyncController.js';
import { getMidiTickLookup } from '../gpProcessor/gpPlayer.js';
import { buildBeatMap } from '../audioSync/beatMap.js';
import { placeBarTimes } from '../audioSync/importers/index.js';
import { saveRecord, SYNC_CHANGED_EVENT } from '../audioSync/syncStore.js';
import { getSongKey } from '../youtubePlayer.js';
import { placeSyncSets } from './urlImport.js';

const WAIT_MS = 20000;
const POLL_MS = 250;

async function playedBarsWhenReady() {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        const ctx = getScoreContext();
        const bars = ctx ? buildBeatMap(getMidiTickLookup(ctx.api)).bars : [];
        if (bars.length) return bars;
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return [];
}

/**
 * @param {Array<{label?: string, videoId: string, barTimesMs: number[]}>} sets
 * @returns {Promise<{ saved: string[], skipped: string[] }>} labels saved, and a reason for each set left out
 */
export async function attachSyncSets(sets) {
    if (!sets?.length) return { saved: [], skipped: [] };
    const bars = await playedBarsWhenReady();
    if (!bars.length) return { saved: [], skipped: ['The score was not ready, so no sync points were added'] };
    const { placed, skipped } = placeSyncSets(sets, times => placeBarTimes(times, bars));
    const songKey = getSongKey();
    for (const { videoId, points } of placed) {
        saveRecord(songKey, { kind: 'youtube', videoId }, points);
    }
    if (placed.length) window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    return { saved: placed.map(p => p.label), skipped };
}
