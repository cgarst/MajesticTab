// audioSyncController.js
// Wires a MediaSource, a list of sync points and the loaded score to the follower. Points are stored by score
// position (`{ id, barIndex, occurrence, pos, timeMs }`); `scoreMs` is derived from the score's MIDI tick lookup
// whenever the score or the points change.

import {
    getMidiTickLookup, getAudioLatencyMs, synthPlayerState, onUserSeekTick, setExternalPlayback, updateContinuousPlaybackScroll,
    reanchorPlaybackScroll, playClick, onTransportEvent
} from '../gpProcessor/gpPlayer.js';
import { buildScoreTimeline, playedBarsFromLookup, buildClickList, tickToScoreMs, scoreMsToTick } from './scorePositions.js';
import { scoreToMedia, mediaToScore, ratioAtScore } from './syncMap.js';
import { buildBeatMap } from './beatMap.js';
import { createCursorGlide } from './cursorGlide.js';
import { resolvePoints } from './pointCheck.js';
import { createFollower } from './follower.js';
import { createHeardClock } from './heardClock.js';
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
 * (`stop()`, `setPoints(points)`, `problems()`), or null when no score is loaded. With `alignToCursor` the recording
 * is moved to where the cursor is (as left by the synth or another recording) instead of the cursor jumping to it.
 */
export function startAudioSync({ source, points: storedPoints, alignToCursor = false }) {
    stopAudioSync();
    if (suspended) return null;
    const api = window.gpApi;
    const lookup = api && getMidiTickLookup(api);
    if (!api?.score || !lookup) return null;
    const timeline = buildScoreTimeline(playedBarsFromLookup(lookup), api.score.tempo);
    const map = buildBeatMap(lookup);
    const starts = map.entries.map(e => e.tick);
    const glide = createCursorGlide(api, map);
    const clock = createHeardClock({ source, getLatencyMs: getAudioLatencyMs });
    let stored = storedPoints;
    let resolved = resolvePoints(timeline, stored);

    // The cursor is where the recording is between two beats, and runs on to the next beat in the time that is left
    // (as the synth's cursor does), so a bar of rests is a smooth sweep instead of a stop and a jump.
    let glideTimer = 0;
    function glideNow({ reanchor = false } = {}) {
        clearTimeout(glideTimer);
        if (source.isBuffering?.()) return;
        const playing = source.isPlaying();
        const heard = clock.heard();
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
        // The sound has not reached the start of this run yet: the cursor stands where playback began until it does
        const wait = playing ? clock.waitMs() : 0;
        if (wait > 0) {
            glide.run(located, fraction, 0);
            glideTimer = setTimeout(glideNow, wait + 5);
            return;
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

    // Metronome: the clicks are the score's beats, placed in the recording through the sync points, so they follow
    // the recording's tempo. Scheduled a little ahead on the click audio context so they stay steady.
    const clicks = buildClickList(playedBarsFromLookup(lookup), timeline);
    const firstClickAtOrAfter = (scoreMs) => {
        let lo = 0;
        let hi = clicks.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (clicks[mid].ms < scoreMs) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
    const LOOKAHEAD_MS = 120;
    let nextClick = 0;
    let lastNow = null;
    const clickTimer = setInterval(() => {
        if (!synthPlayerState.metronomeEnabled || !source.isPlaying() || source.isBuffering?.()) { lastNow = null; return; }
        const rate = source.getRate?.() || 1;
        const nowMs = source.getTimeMs();
        if (lastNow === null || nowMs < lastNow || nowMs - lastNow > 400 * rate) {
            nextClick = firstClickAtOrAfter(mediaToScore(resolved, nowMs));
        }
        lastNow = nowMs;
        while (nextClick < clicks.length) {
            const at = scoreToMedia(resolved, clicks[nextClick].ms);
            if (at > nowMs + LOOKAHEAD_MS * rate) break;
            if (at >= nowMs - 5) playClick(clicks[nextClick].accent, Math.max(0, (at - nowMs) / rate / 1000));
            nextClick++;
        }
    }, 25);

    // A count-in for starting the recording here: one bar of beats at the recording's tempo at this spot.
    function countInPlan() {
        const nowMs = source.getTimeMs();
        const scoreMs = mediaToScore(resolved, nowMs);
        let i = Math.max(0, firstClickAtOrAfter(scoreMs) - 1);
        while (i > 0 && !clicks[i].accent) i--;
        const bar = clicks[i];
        if (!bar) return null;
        let beats = 1;
        while (clicks[i + beats] && !clicks[i + beats].accent) beats++;
        const startMedia = scoreToMedia(resolved, bar.ms);
        const endMedia = scoreToMedia(resolved, clicks[i + beats] ? clicks[i + beats].ms : bar.ms + beats * 500);
        const intervalMs = Math.min(3000, Math.max(150, (endMedia - startMedia) / beats / (source.getRate?.() || 1)));
        return { beats, intervalMs };
    }

    const follower = createFollower({
        source,
        timeline,
        getPoints: () => resolved,
        setTick: (tick) => {
            // AlphaTab drops the cursor on the beat when the tick is set; glide from where it is once that is done
            const handler = api.customCursorHandler;
            if (handler) {
                const go = () => { clearTimeout(fallback); handler.afterNextPlace = null; glideNow(); };
                const fallback = setTimeout(go, 120);
                handler.afterNextPlace = go;
            }
            api.tickPosition = tick;
        },
        snapToBeat: (tick) => snapTo(starts, tick),
        getHeardMs: (t) => clock.heard(t)
    });
    // The recording is the clock, so putting the cursor somewhere means moving the recording there too: otherwise
    // the next play carries on from where it was and the cursor jumps back to match it.
    const seekRecordingToTick = (tick) => {
        // Land a hair inside the beat, so mapping back (which rounds) cannot fall on the beat before it
        const mediaMs = scoreToMedia(resolved, tickToScoreMs(timeline, tick)) + 1;
        source.seek(Math.max(0, mediaMs));
        clock.reset();
        follower.refresh();
    };
    const stopListeningForSeeks = onUserSeekTick(seekRecordingToTick);

    // The recording is the clock, so AlphaTab's own loop range cannot stop it: the loop is kept here. The range is
    // the first pass of the bars (a loop end after a repeat still ends at the first time it is played).
    function loopRangeTicks() {
        if (!synthPlayerState.loopEnabled) return null;
        const first = map.bars.find(b => b.barIndex === synthPlayerState.loopStartMeasure - 1);
        if (!first) return null;
        const last = map.bars.find(b => b.barIndex === synthPlayerState.loopEndMeasure - 1 && b.startTick >= first.startTick);
        return last ? { start: first.startTick, end: last.endTick } : null;
    }
    let lastWrapAt = 0;
    function enforceLoop(force = false) {
        const range = loopRangeTicks();
        if (!range || source.isBuffering?.()) return;
        if (!force && !source.isPlaying()) return;
        const heard = clock.heard();
        const tick = scoreMsToTick(timeline, mediaToScore(resolved, heard));
        if (tick >= range.start && tick < range.end) return;
        const now = performance.now();
        if (now - lastWrapAt < 250) return; // the clock is stale right after a seek
        lastWrapAt = now;
        seekRecordingToTick(range.start);
        const handler = api.customCursorHandler;
        if (handler) {
            const go = () => { clearTimeout(fallback); handler.afterNextPlace = null; glideNow(); };
            const fallback = setTimeout(go, 120);
            handler.afterNextPlace = go;
        }
        api.tickPosition = range.start;
    }
    // Choosing a loop (a part, the loop button, the range fields) moves the recording into it, playing or not
    const stopListeningForLoop = onTransportEvent((e) => { if (e.type === 'loop') enforceLoop(true); });
    // The cursor stops with the recording, picks up where it is on play, and re-aims when the speed changes
    const stopListeningToSource = source.on?.((e) => {
        if (e.type === 'rate') glideNow();
        else if (e.type === 'state' || e.type === 'buffering') {
            const running = source.isPlaying() && !source.isBuffering?.();
            if (e.type === 'state' && source.isPlaying()) clock.restart();
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
        countInPlan,
        /** Multiplier on the written tempo at score time `scoreMs`: how fast the recording plays it, at the current rate. */
        tempoFactorAt: (scoreMs) => ratioAtScore(resolved, scoreMs) * (source.getRate?.() || 1),
        problems: () => validatePoints(resolved),
        usable: () => !hasOrderProblems(resolved),
        stop() {
            clearInterval(clickTimer);
            stopListeningForSeeks();
            stopListeningForLoop();
            stopListeningToSource?.();
            setExternalPlayback(false);
            clearTimeout(glideTimer);
            glide.freeze();
            glide.destroy();
            follower.stop();
            stopFretLoop();
            if (active === this) active = null;
        }
    };
    if (alignToCursor) {
        const tick = api.tickPosition;
        if (Number.isFinite(tick)) seekRecordingToTick(snapTo(starts, tick));
    }
    follower.start();

    // The fretboard follows the recording every frame, at the exact position and for every visible track. The
    // follower's ticks only change per drawn beat of the top staff, which is slower than a busier track plays.
    let fretFrame = 0;
    const fretLoop = () => {
        fretFrame = requestAnimationFrame(fretLoop);
        enforceLoop();
        if (!source.isPlaying() || source.isBuffering?.()) return;
        const heard = clock.heard();
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

/** The loaded score's timeline and AlphaTab API, or null until a score is ready. */
export function getScoreContext() {
    const api = window.gpApi;
    const lookup = api && getMidiTickLookup(api);
    if (!api?.score || !lookup) return null;
    return { api, timeline: buildScoreTimeline(playedBarsFromLookup(lookup), api.score.tempo) };
}
