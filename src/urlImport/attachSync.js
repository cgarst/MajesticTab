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
 * Extract played bars directly from a file buffer in memory without mounting to DOM.
 * @param {File|Blob|Uint8Array|ArrayBuffer} file
 * @returns {Promise<Array<{barIndex:number, occurrence:number, startTick:number, endTick:number}>>}
 */
export async function extractPlayedBarsFromFile(file) {
    if (!file) return [];
    try {
        const at = typeof alphaTab !== 'undefined' ? alphaTab : (await import('@coderline/alphatab')).default || (await import('@coderline/alphatab'));
        if (!at?.importer?.ScoreLoader || !at?.midi?.MidiFileGenerator) return [];
        let bytes;
        if (file instanceof Uint8Array) {
            bytes = file;
        } else if (file instanceof ArrayBuffer) {
            bytes = new Uint8Array(file);
        } else if (typeof file.arrayBuffer === 'function') {
            bytes = new Uint8Array(await file.arrayBuffer());
        } else {
            return [];
        }
        const settings = new at.Settings();
        const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
        if (!score) return [];
        const midiFile = new at.midi.MidiFile();
        const handler = new at.midi.AlphaSynthMidiFileHandler(midiFile);
        const generator = new at.midi.MidiFileGenerator(score, settings, handler);
        generator.applyTranspositionPitches = false;
        generator.generate();
        if (!generator.tickLookup?.masterBars?.length) return [];
        const { buildBeatMap } = await import('../audioSync/beatMap.js');
        return buildBeatMap(generator.tickLookup).bars || [];
    } catch {
        return [];
    }
}

/**
 * @param {Array<{label?: string, videoId: string, barTimesMs: number[]}>} sets
 * @param {object} [options]
 * @param {string} [options.songKey]
 * @param {Array<{barIndex:number, occurrence:number}>} [options.bars]
 * @returns {Promise<{ saved: string[], skipped: string[] }>} labels saved, and a reason for each set left out
 */
export async function attachSyncSets(sets, { songKey = null, bars = null } = {}) {
    if (!sets?.length) return { saved: [], skipped: [] };
    const playedBars = (bars && bars.length) ? bars : await playedBarsWhenReady();
    if (!playedBars.length) return { saved: [], skipped: ['The score was not ready, so no sync points were added'] };
    const { placed, skipped } = placeSyncSets(sets, times => placeBarTimes(times, playedBars));
    const targetKey = songKey || getSongKey();
    for (const { videoId, points } of placed) {
        saveRecord(targetKey, { kind: 'youtube', videoId }, points);
    }
    if (placed.length) window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    return { saved: placed.map(p => p.label), skipped };
}
