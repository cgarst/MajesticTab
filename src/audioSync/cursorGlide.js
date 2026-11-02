// cursorGlide.js
// Makes the cursor move smoothly while a recording plays. Synth playback has AlphaTab animate the cursor from beat to
// beat; the follower only knows the recording's time, and setting the tick just drops the cursor on a beat, so it
// stood still until the next beat (a whole bar of rests, for example) and then jumped. This places the cursor
// exactly where the recording is between two beats and glides it to the next beat in the time that is left, using
// the same cursor animation the synth uses, so it looks the same in scroll and page view.
// Everything about timing comes from the caller; this only works out where the cursor is and moves it.

/**
 * Positions of the beats on the page, by bar: `Map(barIndex -> [{ rel, bounds }])` from the top staff of each bar,
 * where `bounds` is AlphaTab's BeatBounds. Beats are matched by their offset in the bar (`rel`, in ticks), because the
 * tick lookup's beats belong to the first track and `findBeat` only resolves tracks that are drawn.
 */
function indexBeatBounds(api) {
    const index = new Map();
    for (const system of api.renderer?.boundsLookup?.staffSystems || []) {
        for (const masterBar of system.bars || []) {
            const trackBar = masterBar.bars?.[0];
            const beats = (trackBar?.beats || []).map(b => ({ rel: b.beat?.playbackStart ?? 0, bounds: b }));
            if (beats.length) index.set(masterBar.index, beats);
        }
    }
    return index;
}

const startOf = (b) => b.onNotesX ?? b.visualBounds?.x ?? b.realBounds?.x ?? 0;

/**
 * @param {object} api AlphaTab API (its `customCursorHandler` is what moves the cursor)
 * @param {{ bars: Array }} map from `buildBeatMap`: the bars as played, with their start ticks
 */
export function createCursorGlide(api, map) {
    let index = null;
    const stale = () => { index = null; };
    api.renderFinished?.on(stale);

    const beatsOf = (barIndex) => {
        index ||= indexBeatBounds(api);
        return index.get(barIndex) || null;
    };

    return {
        /**
         * The beat drawn at `tick` (the last one starting at or before it) and the one drawn after it, which may be
         * the first of the next bar played. The cursor moves between the beats that are drawn, which are not all the
         * beats in the tick lookup: tracks that are not shown have their own.
         * @returns {{ from: object, fromTick: number, next: {bounds: object, tick: number}|null }|null}
         */
        locate(tick) {
            let barEntry = -1;
            for (let i = 0; i < map.bars.length && map.bars[i].startTick <= tick; i++) barEntry = i;
            const bar = map.bars[barEntry];
            const beats = bar && beatsOf(bar.barIndex);
            if (!beats) return null;
            const rel = tick - bar.startTick;
            let at = 0;
            for (let k = 0; k < beats.length; k++) if (beats[k].rel <= rel) at = k;
            let next = null;
            if (beats[at + 1]) {
                next = { bounds: beats[at + 1].bounds, tick: bar.startTick + beats[at + 1].rel };
            } else {
                const following = map.bars[barEntry + 1];
                const firstOfNext = following && beatsOf(following.barIndex)?.[0];
                if (firstOfNext) next = { bounds: firstOfNext.bounds, tick: following.startTick + firstOfNext.rel };
            }
            return { from: beats[at].bounds, fromTick: bar.startTick + beats[at].rel, next };
        },
        /**
         * Puts the cursor `fraction` (0 to 1) of the way from the located beat to the next and glides it to the next
         * in `durationMs`.
         */
        run(located, fraction, durationMs) {
            const handler = api.customCursorHandler;
            if (!handler || !located?.from) return;
            const { from, next } = located;
            const startX = startOf(from);
            let endX = null;
            if (next?.bounds) {
                const sameRow = from.barBounds?.masterBarBounds?.staffSystemBounds === next.bounds.barBounds?.masterBarBounds?.staffSystemBounds;
                if (sameRow) endX = startOf(next.bounds);
            }
            // The next beat is on another row (or a repeat jumps elsewhere): run to the end of this bar, then it moves on
            if (endX === null || endX <= startX) {
                const bar = from.barBounds?.masterBarBounds?.visualBounds;
                endX = bar ? bar.x + bar.w : null;
            }
            if (endX === null || endX <= startX) return;
            const x0 = startX + Math.min(1, Math.max(0, fraction)) * (endX - startX);
            handler.placeBeatCursorNow(null, from, x0);
            if (durationMs > 20 && x0 < endX) handler.transitionBeatCursor(null, from, x0, endX, durationMs);
        },
        /** Stops the cursor where it is (the recording paused). */
        freeze() {
            api.customCursorHandler?.freezeBeatCursor?.();
        },
        destroy() {
            api.renderFinished?.off?.(stale);
        }
    };
}
