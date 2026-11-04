// importers/index.js
// Imports sync points from a web address. The address is only fetched; how its text is read is decided by what the
// text looks like (see detect.js), so no site is known by name. A site that needs more than one request can be handled
// by a multi-step sync source (see builtinSource.js and syncSource.js). A bare list of bar start times has to be placed on the
// score, which `placeBarTimes` does against the score's played bars (repeats included).

import { detectSets } from './detect.js';
import { runSyncSteps } from './syncSource.js';
import { builtinSource } from './builtinSource.js';

/**
 * Fetches `urlText` and returns the candidate sets in it (`{ label, points }` or `{ label, barTimesMs }`).
 * `findSource(url)` may return a custom `{ step }` for the address, which then does the fetching instead of the
 * address being read directly.
 */
export async function loadFromUrl(urlText, fetchText, { findSource = null } = {}) {
    let url;
    try { url = new URL(String(urlText).trim()); } catch { throw new Error('That is not a web address.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses are supported.');
    const source = (findSource ? await findSource(url.href) : null) || (builtinSource.matches(url.href) ? builtinSource : null);
    const text = source ? await runSyncSteps({ url: url.href, step: source.step, fetchText }) : await fetchText(url.href);
    return detectSets(text);
}

const MIN_PREFIX_SHARE = 0.5;
const MAX_PREFIX_ERROR = 0.12;

/**
 * A list shorter than the played bars is accepted only as the start of the score: when the gaps between its times
 * follow the bar lengths at the score's tempo (mean error under 12% of a bar), every point sits on the right bar and
 * the last bars just have no points. Needs the bars' `seconds`; without them a short list is refused.
 */
function fitsScoreStart(barTimesMs, playedBars) {
    const n = barTimesMs.length;
    if (n < 3 || n < playedBars.length * MIN_PREFIX_SHARE) return false;
    let error = 0;
    let length = 0;
    for (let i = 0; i < n - 1; i++) {
        const seconds = playedBars[i].seconds;
        if (!(seconds > 0)) return false;
        error += Math.abs((barTimesMs[i + 1] - barTimesMs[i]) / 1000 - seconds);
        length += seconds;
    }
    return error / length <= MAX_PREFIX_ERROR;
}

/**
 * Places one time per bar on the played bars of the score, repeats included. The counts must match exactly: a
 * different count means a different bar structure, and every point after the difference would land on the wrong bar.
 * The one exception is a shorter list whose times follow the start of the score (see fitsScoreStart); `covered`
 * reports how many bars got points then.
 * @param {number[]} barTimesMs
 * @param {Array<{barIndex:number, occurrence:number, seconds?:number|null}>} playedBars the score's bars in play order
 * @param {{covered?: number}} [info] receives `covered` when only the start of the score is placed
 * @returns {Array<{barIndex:number, occurrence:number, pos:number, timeMs:number}>}
 */
export function placeBarTimes(barTimesMs, playedBars, info = null) {
    const partial = barTimesMs.length < playedBars.length && fitsScoreStart(barTimesMs, playedBars);
    if (barTimesMs.length !== playedBars.length && !partial) {
        throw new Error(`That list has ${barTimesMs.length} bars, but this score plays ${playedBars.length}. They have to match exactly, or the points would land on the wrong bars.`);
    }
    if (partial && info) info.covered = barTimesMs.length;
    // Never below 0 and strictly increasing, as the point list requires
    let last = -1;
    return barTimesMs.map((ms, i) => {
        const timeMs = Math.max(last + 1, Math.round(Math.max(0, ms)));
        last = timeMs;
        return { barIndex: playedBars[i].barIndex, occurrence: playedBars[i].occurrence, pos: 0, timeMs };
    });
}

/** A set as points, whichever form it came in. */
export function setToPoints(set, playedBars) {
    return set.points || placeBarTimes(set.barTimesMs, playedBars);
}

/**
 * The sets that fit this score. A list of bar times fits when it has one time per played bar; when some do, only
 * those are offered, and when none do the error says what was found.
 */
export function setsFittingScore(sets, playedBars) {
    const fitting = sets.filter(s => s.points || s.barTimesMs.length === playedBars.length || fitsScoreStart(s.barTimesMs, playedBars));
    if (fitting.length) return fitting;
    const counts = [...new Set(sets.map(s => s.barTimesMs.length))].join(', ');
    throw new Error(`That address has lists of ${counts} bars, but this score plays ${playedBars.length}. They have to match exactly, or the points would land on the wrong bars.`);
}
