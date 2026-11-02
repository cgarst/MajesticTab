// follower.js
// Moves the score cursor to follow a MediaSource through the sync points. The recording is the clock: each frame
// reads its time, maps it to a playback tick through `syncMap`, and hands the tick to `setTick` (which sets
// `api.tickPosition`, so AlphaTab places its own cursor). Rate changes need no handling because the mapping is in
// recording time. No DOM or AlphaTab access here; the loop's scheduler is injected.

import { mediaToScore } from './syncMap.js';
import { scoreMsToTick } from './scorePositions.js';

/**
 * @param {object} opts
 * @param {object} opts.source MediaSource
 * @param {() => Array} opts.getPoints sync points sorted by time, `{ id, scoreMs, timeMs }`
 * @param {object} opts.timeline from `buildScoreTimeline`
 * @param {(tick:number)=>void} opts.setTick sets `api.tickPosition`
 * @param {(tick:number)=>number} [opts.snapToBeat] tick to the start of its beat; the tick is only set when the beat changes
 * @param {() => number} [opts.getLatencyMs] audio output latency: the clock leads what the user hears by this much,
 *   so the cursor follows `time - latency`, the same delay the synth path applies to its visuals
 * @param {(cb:Function)=>any} [opts.schedule] defaults to requestAnimationFrame
 * @param {(handle:any)=>void} [opts.cancel] defaults to cancelAnimationFrame
 */
export function createFollower({
    source, getPoints, timeline, setTick, snapToBeat = (t) => t, getLatencyMs = () => 0,
    schedule = (cb) => requestAnimationFrame(cb), cancel = (h) => cancelAnimationFrame(h)
}) {
    let handle = null;
    let lastKey = null;

    /** One update at recording time `timeMs`. Returns the tick set, or null when nothing changed. */
    function step(timeMs = source.getTimeMs()) {
        if (source.isBuffering?.()) return null; // the reported time is stale while buffering
        const heard = timeMs - (getLatencyMs() || 0);
        const scoreMs = mediaToScore(getPoints(), heard);
        const key = snapToBeat(scoreMsToTick(timeline, scoreMs));
        if (key === lastKey) return null;
        lastKey = key;
        setTick(key);
        return key;
    }

    function loop() {
        handle = schedule(loop);
        step();
    }

    return {
        step,
        start() {
            if (handle !== null) return;
            lastKey = null;
            handle = schedule(loop);
        },
        stop() {
            if (handle !== null) cancel(handle);
            handle = null;
        },
        /** Forget the last tick so the next step re-applies it (after a seek or a points edit). */
        refresh() { lastKey = null; },
        get running() { return handle !== null; }
    };
}
