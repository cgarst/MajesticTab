// audioSyncController.js
// Wires a MediaSource, a list of sync points and the loaded score to the follower. Points are stored by score
// position (`{ id, barIndex, occurrence, pos, timeMs }`); `scoreMs` is derived from the score's MIDI tick lookup
// whenever the score or the points change.

import { getMidiTickLookup, getAudioLatencyMs, synthPlayerState } from '../gpProcessor/gpPlayer.js';
import { buildScoreTimeline, playedBarsFromLookup } from './scorePositions.js';
import { resolvePoints } from './pointCheck.js';
import { createFollower } from './follower.js';
import { hasOrderProblems, validatePoints } from './syncMap.js';

/**
 * Sorted start ticks of every beat played, repeat passes included. Walks each played bar's chain of tick slices
 * (a beat can span several) and keeps the first slice of each beat.
 */
function beatStartTicks(lookup) {
    const starts = new Set();
    for (const bar of lookup?.masterBars || []) {
        const seen = new Set();
        for (let slice = bar.firstBeat; slice; slice = slice.nextBeat) {
            const beat = slice.highlightedBeats?.[0]?.beat;
            if (!beat || seen.has(beat)) continue;
            seen.add(beat);
            // slice ticks are relative to their bar
            if (Number.isFinite(slice.start)) starts.add(bar.start + slice.start);
        }
    }
    return [...starts].sort((a, b) => a - b);
}

/** Largest start <= tick (binary search); the tick itself when there are no beats. */
function snapTo(starts, tick) {
    if (!starts.length) return tick;
    let lo = 0;
    let hi = starts.length - 1;
    let found = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= tick) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return starts[found];
}

let active = null;
let suspended = false;

/** While suspended (tap mode) no follower runs, so the cursor isn't moved by the points being edited. */
export function setAudioSyncSuspended(on) {
    suspended = Boolean(on);
    if (suspended) stopAudioSync();
}

/**
 * Starts following `source` with `storedPoints`. Replaces any earlier session. Returns the session
 * (`stop()`, `setPoints(points)`, `problems()`), or null when no score is loaded.
 */
export function startAudioSync({ source, points: storedPoints }) {
    stopAudioSync();
    if (suspended) return null;
    const api = window.gpApi;
    const lookup = api && getMidiTickLookup(api);
    if (!api?.score || !lookup) return null;
    const timeline = buildScoreTimeline(playedBarsFromLookup(lookup), api.score.tempo);
    const starts = beatStartTicks(lookup);
    let stored = storedPoints;
    let resolved = resolvePoints(timeline, stored);
    const follower = createFollower({
        source,
        timeline,
        getPoints: () => resolved,
        // AlphaTab places its own cursor when the tick is set, but the cursor layer stays hidden until this class is set
        setTick: (tick) => {
            api.tickPosition = tick;
            document.body.classList.add('synth-playback-started');
        },
        snapToBeat: (tick) => snapTo(starts, tick),
        getLatencyMs: getAudioLatencyMs
    });
    active = {
        source,
        setPoints(next) {
            stored = next;
            resolved = resolvePoints(timeline, stored);
            follower.refresh();
        },
        problems: () => validatePoints(resolved),
        usable: () => !hasOrderProblems(resolved),
        stop() {
            follower.stop();
            // The cursor layer is only wanted while something drives it; the synth keeps it once it has played
            if (!synthPlayerState.hasPlayed) document.body.classList.remove('synth-playback-started');
            if (active === this) active = null;
        }
    };
    follower.start();
    return active;
}

export function stopAudioSync() {
    active?.stop();
    active = null;
}

export function getAudioSyncSession() {
    return active;
}

/**
 * A MediaSource backed by the wall clock, for tests and the debug console: time runs from `startMs` at `rate`
 * while playing. Not a real recording.
 */
export function createClockSource({ startMs = 0, rate = 1 } = {}) {
    let base = startMs;
    let from = performance.now();
    let playing = false;
    let r = rate;
    const now = () => (playing ? base + (performance.now() - from) * r : base);
    return {
        kind: 'clock',
        id: 'clock',
        durationMs: null,
        capabilities: { waveform: false, preciseClock: true, pitchPreservedRate: true },
        getTimeMs: now,
        seek(ms) { base = ms; from = performance.now(); },
        play() { base = now(); from = performance.now(); playing = true; },
        pause() { base = now(); playing = false; },
        setRate(next) { base = now(); from = performance.now(); r = next; },
        getRate: () => r,
        isPlaying: () => playing,
        isBuffering: () => false,
        on: () => () => {}
    };
}

/** The loaded score's timeline and AlphaTab API, or null until a score is ready. */
export function getScoreContext() {
    const api = window.gpApi;
    const lookup = api && getMidiTickLookup(api);
    if (!api?.score || !lookup) return null;
    return { api, timeline: buildScoreTimeline(playedBarsFromLookup(lookup), api.score.tempo) };
}
