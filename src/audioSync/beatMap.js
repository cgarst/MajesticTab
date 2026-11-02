// beatMap.js
// The beats of a score in play order, from AlphaTab's MIDI tick lookup, for tap mode: which beat a click means in a
// repeated section, and which beat to point at next. Duck-typed on the lookup (like scorePositions.js) so it is unit
// tested in Node with a fake (tests/audioSync/beatMap.test.mjs). Ticks are the MIDI timeline's, repeats expanded.
//
// Entry: { tick, barIndex, occurrence, pos, beat, barEntry } where `barEntry` indexes `bars`.
// Bar:   { barIndex, occurrence, startTick, endTick, firstEntry }

export function buildBeatMap(lookup) {
    const entries = [];
    const bars = [];
    const seenBars = new Map();
    for (const bar of lookup?.masterBars || []) {
        const barIndex = bar.masterBar.index;
        const occurrence = seenBars.get(barIndex) || 0;
        seenBars.set(barIndex, occurrence + 1);
        const length = bar.end - bar.start;
        const barEntry = bars.length;
        bars.push({ barIndex, occurrence, startTick: bar.start, endTick: bar.end, firstEntry: entries.length });
        const seenBeats = new Set();
        for (let slice = bar.firstBeat; slice; slice = slice.nextBeat) {
            const beat = slice.highlightedBeats?.[0]?.beat;
            if (!beat || seenBeats.has(beat) || !Number.isFinite(slice.start)) continue;
            seenBeats.add(beat);
            entries.push({
                tick: bar.start + slice.start, barIndex, occurrence, beat, barEntry,
                pos: length > 0 ? Math.min(1, Math.max(0, slice.start / length)) : 0
            });
        }
    }
    return { entries, bars };
}

/**
 * The positions a clicked beat can mean: one per time its bar is played. `beat.playbackStart` is the beat's offset in
 * its bar, which is the same for every pass, so it works for beats of any track, not only the first.
 * Returns `[{ barIndex, occurrence, pos, tick }]` in play order.
 */
export function candidatesForBeat(map, beat) {
    const barIndex = beat?.voice?.bar?.masterBar?.index;
    if (!Number.isInteger(barIndex)) return [];
    const rel = beat.playbackStart ?? 0;
    return map.bars
        .filter(b => b.barIndex === barIndex)
        .map(b => {
            const length = b.endTick - b.startTick;
            return { barIndex, occurrence: b.occurrence, pos: length > 0 ? Math.min(1, Math.max(0, rel / length)) : 0, tick: b.startTick + rel };
        });
}

/** The beat entry nearest to a stored point position (`{ barIndex, occurrence, pos }`), or null when that pass isn't played. */
export function entryAt(map, { barIndex, occurrence = 0, pos = 0 }) {
    const barEntry = map.bars.findIndex(b => b.barIndex === barIndex && b.occurrence === occurrence);
    if (barEntry < 0) return null;
    let best = null;
    for (let i = map.bars[barEntry].firstEntry; i < map.entries.length && map.entries[i].barEntry === barEntry; i++) {
        if (!best || Math.abs(map.entries[i].pos - pos) < Math.abs(best.pos - pos)) best = map.entries[i];
    }
    return best;
}

/**
 * The beat to point at after a tap at `afterTick`: the first beat of the next bar played ('bar'), or the next beat
 * ('beat'). Null at the end of the score.
 */
export function nextTarget(map, afterTick, granularity = 'bar') {
    if (granularity === 'beat') return map.entries.find(e => e.tick > afterTick) || null;
    const bar = map.bars.find(b => b.startTick > afterTick && b.firstEntry < map.entries.length);
    return bar ? map.entries[bar.firstEntry] || null : null;
}

/**
 * Where to start: the first beat of the first bar played that has no sync point on it. `points` are stored points
 * (`{ barIndex, occurrence, pos }`). Null when every bar has one.
 */
export function firstUnsyncedTarget(map, points) {
    const taken = new Set(points.map(p => `${p.barIndex}:${p.occurrence || 0}`));
    const bar = map.bars.find(b => !taken.has(`${b.barIndex}:${b.occurrence}`));
    return bar ? map.entries[bar.firstEntry] || null : null;
}
