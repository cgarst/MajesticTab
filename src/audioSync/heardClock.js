// heardClock.js
// What the player hears, as a recording time. The recording's clock leads the sound by the audio latency, so the
// cursor follows `time - latency`. Just after play (or a seek) that would put the cursor L ms before where the
// recording starts, so it would drift back and run through music that was never heard. Instead the cursor stands
// where playback started until the sound has caught up (`waitMs()`), then moves. Pure: no DOM or AlphaTab access.

const BACK_SLACK_MS = 150; // a clock that steps back by less than this is jitter, not a seek
const FORWARD_JUMP_MS = 500; // a clock that jumps ahead by more than this (in recording time) is a seek

/**
 * @param {object} opts
 * @param {object} opts.source MediaSource
 * @param {() => number} opts.getLatencyMs audio output latency
 */
export function createHeardClock({ source, getLatencyMs }) {
    let anchor = null; // recording time where the current run of playback began
    let lastT = null;
    let lastHeard = null;
    let wait = 0;

    /** The recording time being heard at clock reading `timeMs`. */
    function heard(timeMs = source.getTimeMs()) {
        const latency = getLatencyMs() || 0;
        const rate = source.getRate?.() || 1;
        if (latency <= 0) {
            anchor = null; lastT = timeMs; lastHeard = timeMs; wait = 0;
            return timeMs;
        }
        const forward = source.isPlaying?.() ? FORWARD_JUMP_MS * rate : BACK_SLACK_MS;
        if (anchor === null || lastT === null || timeMs < lastT - BACK_SLACK_MS || timeMs > lastT + forward) anchor = timeMs;
        lastT = timeMs;
        const value = Math.max(anchor, timeMs - latency);
        wait = Math.max(0, (anchor + latency - timeMs) / rate);
        lastHeard = value;
        return value;
    }

    return {
        heard,
        /** Wall-clock ms until the sound reaches the start of this run: the cursor stands still for this long. */
        waitMs: () => wait,
        /** The recording was moved (a seek the player asked for): the next reading starts a new run. */
        reset() { anchor = null; lastT = null; lastHeard = null; wait = 0; },
        /**
         * Playback started. From a standing start the run begins at the clock; resuming where it paused keeps the
         * cursor where it was (it moves on at once, as the sound that was already on its way arrives).
         */
        restart(timeMs = source.getTimeMs()) {
            const resumed = lastHeard !== null && lastT !== null && timeMs >= lastT - BACK_SLACK_MS && timeMs - lastT < BACK_SLACK_MS;
            anchor = resumed ? Math.min(lastHeard, timeMs) : timeMs;
            lastT = timeMs;
        }
    };
}
