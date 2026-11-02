// scorePositions.js
// Converts between a score position (bar index, repeat pass, 0..1 inside the bar) and `scoreMs`, milliseconds on
// AlphaTab's synth timeline (repeats expanded). Pure: it works on the played-bar list of AlphaTab's MIDI tick
// lookup, which has one entry per bar *played*, in play order (see playedBarsFromLookup). No DOM / AlphaTab access.

/** Ticks per quarter note in AlphaTab's MIDI output. */
export const TICKS_PER_QUARTER = 960;

/**
 * Pulls plain played-bar data out of AlphaTab's MidiTickLookup:
 * `[{ barIndex, start, end, tempoChanges: [{ tick, tempo }] }]`.
 */
export function playedBarsFromLookup(lookup) {
    const bars = lookup?.masterBars;
    if (!Array.isArray(bars)) return [];
    return bars.map(b => ({
        barIndex: b.masterBar.index,
        start: b.start,
        end: b.end,
        tempoChanges: (b.tempoChanges || []).map(c => ({ tick: c.tick, tempo: c.tempo }))
    }));
}

/**
 * Builds the timeline: each played bar gets its `occurrence` (how many times the bar was played before) and
 * `startMs`/`endMs`. A tempo change at a bar boundary or inside a bar is honoured; a bar without one keeps the
 * previous tempo. `defaultTempo` applies until the first tempo is seen.
 */
export function buildScoreTimeline(playedBars, defaultTempo = 120) {
    const seen = new Map();
    const bars = [];
    let tempo = defaultTempo;
    let ms = 0;
    let tick = playedBars.length ? playedBars[0].start : 0;
    const advance = (toTick) => {
        if (toTick > tick) ms += (toTick - tick) * 60000 / (tempo * TICKS_PER_QUARTER);
        tick = Math.max(tick, toTick);
    };
    for (const bar of playedBars) {
        const occurrence = seen.get(bar.barIndex) || 0;
        seen.set(bar.barIndex, occurrence + 1);
        advance(bar.start);
        const entry = { barIndex: bar.barIndex, occurrence, startTick: bar.start, endTick: bar.end, startMs: ms, segments: [] };
        const changes = [...bar.tempoChanges].sort((a, b) => a.tick - b.tick);
        let segTick = bar.start;
        let segMs = ms;
        for (const c of changes) {
            if (c.tick > segTick) {
                entry.segments.push({ tick: segTick, ms: segMs, tempo });
                advance(c.tick);
                segTick = c.tick;
                segMs = ms;
            }
            tempo = c.tempo;
        }
        entry.segments.push({ tick: segTick, ms: segMs, tempo });
        advance(bar.end);
        entry.endMs = ms;
        bars.push(entry);
    }
    return { bars, totalMs: ms };
}

function tickToMsInBar(bar, tick) {
    let seg = bar.segments[0];
    for (const s of bar.segments) {
        if (s.tick <= tick) seg = s;
    }
    return seg.ms + (tick - seg.tick) * 60000 / (seg.tempo * TICKS_PER_QUARTER);
}

function msToTickInBar(bar, ms) {
    let seg = bar.segments[0];
    for (const s of bar.segments) {
        if (s.ms <= ms) seg = s;
    }
    return seg.tick + (ms - seg.ms) * seg.tempo * TICKS_PER_QUARTER / 60000;
}

/** `{ barIndex, occurrence, pos }` to `scoreMs`, or null when that pass of the bar is not played. */
export function positionToScoreMs(timeline, { barIndex, occurrence = 0, pos = 0 }) {
    const bar = timeline.bars.find(b => b.barIndex === barIndex && b.occurrence === occurrence);
    if (!bar) return null;
    const tick = bar.startTick + Math.min(Math.max(pos, 0), 1) * (bar.endTick - bar.startTick);
    return tickToMsInBar(bar, tick);
}

/** `scoreMs` back to `{ barIndex, occurrence, pos }` (clamped into the played range), or null for an empty score. */
export function scoreMsToPosition(timeline, scoreMs) {
    const { bars } = timeline;
    if (!bars.length) return null;
    let bar = bars[0];
    for (const b of bars) {
        if (b.startMs <= scoreMs) bar = b;
    }
    const clamped = Math.min(Math.max(scoreMs, bar.startMs), bar.endMs);
    const tick = msToTickInBar(bar, clamped);
    const span = bar.endTick - bar.startTick;
    return {
        barIndex: bar.barIndex,
        occurrence: bar.occurrence,
        pos: span > 0 ? Math.min(Math.max((tick - bar.startTick) / span, 0), 1) : 0
    };
}

/** `scoreMs` of a MIDI playback tick (repeats expanded): the inverse of `scoreMsToTick`. */
export function tickToScoreMs(timeline, tick) {
    const { bars } = timeline;
    if (!bars.length) return 0;
    let bar = bars[0];
    for (const b of bars) {
        if (b.startTick <= tick) bar = b;
    }
    if (tick >= bars[bars.length - 1].endTick) return bars[bars.length - 1].endMs;
    return tickToMsInBar(bar, Math.max(tick, bars[0].startTick));
}

/** MIDI playback tick (repeats expanded) for a `scoreMs`, for setting `api.tickPosition`. */
export function scoreMsToTick(timeline, scoreMs) {
    const { bars } = timeline;
    if (!bars.length) return 0;
    let bar = bars[0];
    for (const b of bars) {
        if (b.startMs <= scoreMs) bar = b;
    }
    const last = bars[bars.length - 1];
    if (scoreMs >= last.endMs) return last.endTick;
    return Math.round(msToTickInBar(bar, Math.max(scoreMs, bars[0].startMs)));
}

/** Written tempo (bpm) at `scoreMs`, for showing the tempo a sync segment implies. */
export function tempoAtScoreMs(timeline, scoreMs) {
    const { bars } = timeline;
    if (!bars.length) return null;
    let bar = bars[0];
    for (const b of bars) {
        if (b.startMs <= scoreMs) bar = b;
    }
    let seg = bar.segments[0];
    for (const s of bar.segments) {
        if (s.ms <= scoreMs) seg = s;
    }
    return seg.tempo;
}

/** The bar, pass and position under a playback tick (for example the cursor), or null for an empty score. */
export function tickToPosition(timeline, tick) {
    const { bars } = timeline;
    if (!bars.length) return null;
    let bar = bars[0];
    for (const b of bars) {
        if (b.startTick <= tick) bar = b;
    }
    const span = bar.endTick - bar.startTick;
    return {
        barIndex: bar.barIndex,
        occurrence: bar.occurrence,
        pos: span > 0 ? Math.min(Math.max((tick - bar.startTick) / span, 0), 1) : 0
    };
}
