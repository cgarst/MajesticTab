// mediaSource.js
// The recording a score is synced to, behind one interface so the follower and the editor don't care whether it
// is a YouTube video or a local audio file:
//   { kind, id, durationMs, getTimeMs(), seek(ms), play(), pause(), setRate(r), isPlaying(), isBuffering(),
//     on(cb) -> off, capabilities: { waveform, preciseClock, pitchPreservedRate } }
// Events passed to `on` callbacks: { type: 'state' | 'time' | 'rate' | 'buffering' | 'ended' | 'video' }.

/**
 * Wraps the YouTube panel's control surface (`jamYouTubeControl`) and event stream (`onYouTubeEvent`); both are
 * injected so this stays free of DOM access. YouTube reports time at about 4 Hz and the control interpolates
 * between reports, so the clock is good to roughly 50 to 100 ms (`preciseClock: false`).
 */
export function createYouTubeSource(control, subscribe) {
    return {
        kind: 'youtube',
        get id() { return control.snapshot().videoId; },
        durationMs: null,
        capabilities: { waveform: false, preciseClock: false, pitchPreservedRate: true },
        getTimeMs: () => control.snapshot().timeSec * 1000,
        seek: (ms) => control.seek(ms / 1000),
        play: () => control.play(),
        pause: () => control.pause(),
        setRate: (rate) => control.setRate(rate),
        isPlaying: () => control.snapshot().playing,
        isBuffering: () => control.snapshot().buffering,
        on: (cb) => subscribe((e) => {
            if (e.type === 'state') cb({ type: e.buffering ? 'buffering' : 'state' });
            else cb({ type: e.type });
        })
    };
}
