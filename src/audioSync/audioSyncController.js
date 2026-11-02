// audioSyncController.js
// Wires a MediaSource, a list of sync points and the loaded score to the follower. Points are stored by score
// position (`{ id, barIndex, occurrence, pos, timeMs }`); `scoreMs` is derived from the score's MIDI tick lookup
// whenever the score or the points change.

import {
    getMidiTickLookup, getAudioLatencyMs, synthPlayerState, onUserSeekTick, setExternalPlayback, updateContinuousPlaybackScroll,
    reanchorPlaybackScroll
} from '../gpProcessor/gpPlayer.js';
import { buildScoreTimeline, playedBarsFromLookup, tickToScoreMs, scoreMsToTick } from './scorePositions.js';
import { scoreToMedia, mediaToScore } from './syncMap.js';
import { buildBeatMap } from './beatMap.js';
import { createCursorGlide } from './cursorGlide.js';
import { resolvePoints } from './pointCheck.js';
import { createFollower } from './follower.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { hasOrderProblems, validatePoints } from './syncMap.js';

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
    const map = buildBeatMap(lookup);
    const starts = map.entries.map(e => e.tick);
    const glide = createCursorGlide(api, map);
    let stored = storedPoints;
    let resolved = resolvePoints(timeline, stored);

    // The cursor is where the recording is between two beats, and runs on to the next beat in the time that is left
    // (as the synth's cursor does), so a bar of rests is a smooth sweep instead of a stop and a jump.
    let glideTimer = 0;
    function glideNow({ reanchor = false } = {}) {
        clearTimeout(glideTimer);
        if (source.isBuffering?.()) return;
        const playing = source.isPlaying();
        const heard = source.getTimeMs() - getAudioLatencyMs();
        const scoreMs = mediaToScore(resolved, heard);
        const tick = scoreMsToTick(timeline, scoreMs);
        const located = glide.locate(tick);
        if (!located) return;
        let fraction = 0;
        let duration = 0;
        if (located.next) {
            const fromMs = tickToScoreMs(timeline, located.fromTick);
            const toMs = tickToScoreMs(timeline, located.next.tick);
            fraction = toMs > fromMs ? (scoreMs - fromMs) / (toMs - fromMs) : 0;
            duration = Math.min(60000, Math.max(0, (scoreToMedia(resolved, toMs) - heard) / (source.getRate?.() || 1)));
        }
        // Paused, the cursor stands exactly where the recording is, between the beats, and does not move
        glide.run(located, fraction, playing ? duration : 0);
        // The view follows the cursor down the page as it does for the synth. Tap mode has its own toolbar and scrolling.
        if (playing && !document.body.classList.contains('sync-mode')) {
            if (reanchor) reanchorPlaybackScroll(tick, located.barIndex);
            else updateContinuousPlaybackScroll(tick, false, null, located.barIndex);
        }
        // On reaching that beat, start the next leg: the beats that are drawn are not all in the tick lookup, so the
        // follower's own ticks can stay put for a whole bar. Each leg is worked out from the clock again.
        if (playing && located.next) glideTimer = setTimeout(glideNow, Math.max(30, duration + 5));
    }

    const follower = createFollower({
        source,
        timeline,
        getPoints: () => resolved,
        // AlphaTab places its own cursor when the tick is set, but the cursor layer stays hidden until this class is set
        setTick: (tick) => {
            // AlphaTab drops the cursor on the beat when the tick is set; glide from where it is once that is done
            const handler = api.customCursorHandler;
            if (handler) {
                const go = () => { clearTimeout(fallback); handler.afterNextPlace = null; glideNow(); };
                const fallback = setTimeout(go, 120);
                handler.afterNextPlace = go;
            }
            api.tickPosition = tick;
            document.body.classList.add('synth-playback-started');
        },
        snapToBeat: (tick) => snapTo(starts, tick),
        getLatencyMs: getAudioLatencyMs
    });
    // The recording is the clock, so putting the cursor somewhere means moving the recording there too: otherwise
    // the next play carries on from where it was and the cursor jumps back to match it.
    const seekRecordingToTick = (tick) => {
        // Land a hair inside the beat, so mapping back (which rounds) cannot fall on the beat before it
        const mediaMs = scoreToMedia(resolved, tickToScoreMs(timeline, tick)) + 1;
        source.seek(Math.max(0, mediaMs));
        follower.refresh();
    };
    const stopListeningForSeeks = onUserSeekTick(seekRecordingToTick);
    // The cursor stops with the recording, picks up where it is on play, and re-aims when the speed changes
    const stopListeningToSource = source.on?.((e) => {
        if (e.type === 'rate') glideNow();
        else if (e.type === 'state' || e.type === 'buffering') {
            const running = source.isPlaying() && !source.isBuffering?.();
            setExternalPlayback(source.isPlaying());
            if (running) glideNow({ reanchor: e.type === 'state' }); else { clearTimeout(glideTimer); glide.freeze(); }
        }
    });
    setExternalPlayback(source.isPlaying());

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
            stopListeningForSeeks();
            stopListeningToSource?.();
            setExternalPlayback(false);
            clearTimeout(glideTimer);
            glide.freeze();
            glide.destroy();
            follower.stop();
            stopFretLoop();
            // The cursor layer is only wanted while something drives it; the synth keeps it once it has played
            if (!synthPlayerState.hasPlayed) document.body.classList.remove('synth-playback-started');
            if (active === this) active = null;
        }
    };
    follower.start();

    // The fretboard follows the recording every frame, at the exact position and for every visible track. The
    // follower's ticks only change per drawn beat of the top staff, which is slower than a busier track plays.
    let fretFrame = 0;
    const fretLoop = () => {
        fretFrame = requestAnimationFrame(fretLoop);
        if (!source.isPlaying() || source.isBuffering?.()) return;
        const heard = source.getTimeMs() - getAudioLatencyMs();
        const tick = scoreMsToTick(timeline, mediaToScore(resolved, heard));
        let bar = null;
        for (let i = 0; i < map.bars.length && map.bars[i].startTick <= tick; i++) bar = map.bars[i];
        if (bar) fretboardController.followPosition(bar.barIndex, tick - bar.startTick);
    };
    fretFrame = requestAnimationFrame(fretLoop);
    const stopFretLoop = () => cancelAnimationFrame(fretFrame);
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
