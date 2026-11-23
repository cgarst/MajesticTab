// fetchForSong.js
// Asks one search provider that fetches files (a service that describes itself, see urlImport/) for one song's tab,
// with no dialog. The answer is one of:
//   { kind: 'file', file, sourceUrl }   the tab, downloaded
//   { kind: 'choose', choose }          several matches and none is the song: a person has to pick (choose.addressFor(value) asks again)
//   { kind: 'missing' }                 the service has no tab for it
// Anything else throws. An error with `fatal` set means the whole run should stop (no connection, token refused), not
// only this song. Unit tested in tests/fillRun.test.mjs.

import { buildSearchUrl, applySourceToken, formatSearchQueryForSource, extractSourceWebsite } from '../webSearch.js';
import { stripParams } from '../urlImport/asyncJob.js';
import { sameArtist, sameTitle } from '../bulkImport/pairing.js';

/** The one option that is plainly this song (same title, same artist), or null when none or several are. */
export function confidentChoice(options, song) {
    const hits = (options || []).filter((o) => sameTitle(o.label, song.title) && sameArtist(o.detail, song.artist));
    return hits.length === 1 ? hits[0] : null;
}

const defaults = async () => {
    const { probeAddress } = await import('../urlImport/openFromUrl.js');
    const { followJob } = await import('../urlImport/jobImport.js');
    return { probe: (address) => probeAddress(address, { strict: true }), follow: followJob };
};

/**
 * @param {{id: string, title: string, artist: string}} song
 * @param {object} source a search provider that fetches
 * @param {object} [options]
 * @param {string} [options.address] ask this address instead of searching (after a pick)
 * @param {AbortSignal} [options.signal]
 * @param {(update: {state: string, fraction: number|null, label: string}) => void} [options.onProgress]
 * @param {Function} [options.probe] (address) => probeAddress result; replaceable for tests
 * @param {Function} [options.follow] (job, {onProgress, signal}) => File; replaceable for tests
 */
export async function fetchTabForSong(song, source, options = {}) {
    const { signal, onProgress } = options;
    const { probe, follow } = options.probe && options.follow ? options : await defaults();
    const query = formatSearchQueryForSource(source, song.artist, song.title);
    const address = options.address || applySourceToken(buildSearchUrl(source, query), source);
    let probed;
    try {
        probed = await probe(address);
    } catch (error) {
        if (error?.status === 404) return { kind: 'missing' };
        throw error;
    }
    if (probed?.choose) {
        const pick = confidentChoice(probed.choose.options, song);
        if (pick && !options.address) return fetchTabForSong(song, source, { ...options, probe, follow, address: probed.choose.addressFor(pick.value) });
        return { kind: 'choose', choose: probed.choose };
    }
    if (!probed) return { kind: 'missing' };
    let file;
    let sourceUrl = address;
    if (probed.job) {
        file = await follow(probed.job, { onProgress, signal });
        sourceUrl = stripParams(address, probed.job.strip);
    } else {
        file = probed.file;
    }
    file.sourceUrl = sourceUrl;
    file.sourceWebsite = extractSourceWebsite(sourceUrl);
    return { kind: 'file', file, sourceUrl };
}
