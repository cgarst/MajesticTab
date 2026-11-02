// localAudioSource.js
// A MediaSource (see mediaSource.js) that plays an audio file the user supplied, through an HTMLAudioElement so
// large files stream from the object URL and `preservesPitch` handles slow-down practice. `currentTime` is good
// to a few ms where the platform updates it every frame; where it updates in coarse steps the clock is carried
// forward from the last change (at most 100 ms) so the cursor doesn't stutter.

const MAX_EXTRAPOLATE_MS = 100;
const BACKWARD_SLACK_MS = 80;

/**
 * @param {object} file `{ id, name, type, data: ArrayBuffer, durationMs }`
 * @returns the MediaSource, with `destroy()` to release the object URL
 */
export function createLocalAudioSource(file) {
    const url = URL.createObjectURL(new Blob([file.data], { type: file.type || 'audio/mpeg' }));
    const audio = new Audio();
    audio.preload = 'auto';
    for (const prop of ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch']) {
        if (prop in audio) audio[prop] = true;
    }
    audio.src = url;

    const listeners = new Set();
    const emit = (type, detail = {}) => listeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[Audio Sync] listener error:', e); }
    });

    let buffering = false;
    let lastReadMs = -1;
    let lastChangeAt = 0;
    let lastEstimate = 0;

    const resetClock = () => { lastReadMs = -1; lastEstimate = audio.currentTime * 1000; };

    audio.addEventListener('play', () => { resetClock(); emit('state', { playing: true }); });
    audio.addEventListener('pause', () => { resetClock(); emit('state', { playing: false }); });
    audio.addEventListener('ended', () => { emit('state', { playing: false }); emit('ended'); });
    audio.addEventListener('ratechange', () => { resetClock(); emit('rate', { rate: audio.playbackRate }); });
    audio.addEventListener('seeked', () => { resetClock(); emit('time'); });
    audio.addEventListener('timeupdate', () => emit('time'));
    audio.addEventListener('waiting', () => { buffering = true; emit('buffering', { buffering: true }); });
    for (const t of ['playing', 'canplay']) {
        audio.addEventListener(t, () => {
            if (buffering) { buffering = false; emit('buffering', { buffering: false }); }
        });
    }

    return {
        kind: 'local',
        id: file.id,
        get durationMs() {
            return Number.isFinite(audio.duration) ? audio.duration * 1000 : (file.durationMs ?? null);
        },
        capabilities: { waveform: true, preciseClock: true, pitchPreservedRate: true },
        getTimeMs() {
            const reported = audio.currentTime * 1000;
            const now = performance.now();
            if (reported !== lastReadMs) {
                lastReadMs = reported;
                lastChangeAt = now;
            }
            if (audio.paused || audio.ended) {
                lastEstimate = reported;
                return reported;
            }
            let estimate = reported + Math.min(now - lastChangeAt, MAX_EXTRAPOLATE_MS) * audio.playbackRate;
            // A fresh report can land slightly behind the carried-forward value; hold steady instead of stepping back
            if (estimate < lastEstimate && lastEstimate - estimate < BACKWARD_SLACK_MS) estimate = lastEstimate;
            lastEstimate = estimate;
            return estimate;
        },
        seek(ms) {
            audio.currentTime = Math.max(0, ms) / 1000;
            resetClock();
        },
        play() { return audio.play(); },
        pause() { audio.pause(); },
        setRate(rate) { audio.playbackRate = rate; },
        getRate: () => audio.playbackRate,
        isPlaying: () => !audio.paused && !audio.ended,
        isBuffering: () => buffering,
        on(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        get error() { return audio.error; },
        /** Resolves with the duration in ms once the element can read the file, or rejects if it can't decode it. */
        ready() {
            if (audio.readyState >= 1) return Promise.resolve(this.durationMs);
            return new Promise((resolve, reject) => {
                audio.addEventListener('loadedmetadata', () => resolve(this.durationMs), { once: true });
                audio.addEventListener('error', () => reject(new Error('This audio format is not supported on this device')), { once: true });
            });
        },
        destroy() {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            URL.revokeObjectURL(url);
            listeners.clear();
        }
    };
}
