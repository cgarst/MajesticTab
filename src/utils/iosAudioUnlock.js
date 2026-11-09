// iosAudioUnlock.js
// Provides audio session management and Web Audio routing workarounds for iOS Safari / PWA.
// On iOS, the hardware silent/ringer switch silences Web Audio API (AudioContext) by default.
// Setting navigator.audioSession.type = 'playback' (Safari 16.4+) and playing an HTML5
// silent audio channel routes Web Audio through the media playback channel (AVAudioSessionCategoryPlayback),
// allowing soundfont synthesizer playback to be heard when the iPhone is in silent mode.

const SILENT_MP3 = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA//////////////////////////////////////////////////////////////////8AAABhTEFNRTMuMTAwA8MAAAAAAAAAABQgJAUHQQAB9AAAAnGMHkkIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQxAADgnABGiAAQBCqgCRMAAgEAH/////////////////7+n/9FTuQsQH//////2NG0jWUGlio5gLQTOtIoeR2WX////X4s9Atb/JRVCbBUpeRUq///////////////////9RUi0f2jn/+xDECgPCjAEQAABN4AAANIAAAAQVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

let silentAudioEl = null;
let isAudioUnlocked = false;
let isPlaybackActive = false;
const trackedAudioContexts = new Set();

// The synth's own AudioContext(s): the ones AlphaTab opens while the player is being built. The metronome, click
// and preview contexts are tracked too, but only these decide whether Synth playback can work.
const synthContexts = new Set();
const synthStateListeners = new Set();
let synthCaptureUntil = 0;


/**
 * Detect if running on an iOS device (iPhone, iPad, iPod, or iPadOS with desktop Safari UA).
 */
export function isIOSDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    return (
        /iPad|iPhone|iPod/.test(ua) ||
        (/MacIntel/.test(platform) && navigator.maxTouchPoints > 1) ||
        (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)
    );
}

let captureActive = false;

/**
 * Set navigator.audioSession.type to 'playback' so Web Audio bypasses the iOS silent switch.
 * Must be called within or following user gesture activation. While microphone capture is
 * active the session stays 'play-and-record', since WebKit rejects capture under 'playback'.
 */
export function configureAudioSession() {
    if (typeof navigator !== 'undefined' && 'audioSession' in navigator) {
        const type = captureActive ? 'play-and-record' : 'playback';
        try {
            if (navigator.audioSession.type !== type) {
                navigator.audioSession.type = type;
            }
        } catch (e) {
            // Silently ignore if not supported or temporarily blocked
        }
    }
}

/**
 * Switch the audio session for microphone capture (tuner) and back to playback afterwards.
 */
export function setAudioSessionCapture(active) {
    captureActive = active;
    configureAudioSession();
}

/**
 * Lazily creates and returns the hidden silent audio element.
 */
function getOrCreateSilentAudio() {
    if (!silentAudioEl && typeof document !== 'undefined') {
        const audio = document.createElement('audio');
        audio.setAttribute('x-webkit-airplay', 'deny');
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        audio.disableRemotePlayback = true;
        audio.preload = 'auto';
        audio.loop = true;
        audio.src = SILENT_MP3;
        audio.volume = 0.01;
        audio.style.position = 'fixed';
        audio.style.width = '1px';
        audio.style.height = '1px';
        audio.style.opacity = '0';
        audio.style.pointerEvents = 'none';
        audio.style.bottom = '0';
        audio.style.left = '0';
        (document.body || document.documentElement).appendChild(audio);
        silentAudioEl = audio;
    }
    return silentAudioEl;
}

/**
 * Rebuild the iOS audio session state after returning from the background. iOS leaves the
 * hidden silent <audio> element and the session category in a stale state after an interruption,
 * which makes later synth playback start for a moment and then stall (even for newly opened tabs).
 */
export function resetIOSAudioSession() {
    if (silentAudioEl) {
        try { silentAudioEl.pause(); } catch (e) {}
        silentAudioEl.removeAttribute('src');
        try { silentAudioEl.load(); } catch (e) {}
        silentAudioEl.remove();
        silentAudioEl = null;
    }
    for (const ctx of trackedAudioContexts) {
        if (!ctx || ctx.state === 'closed') trackedAudioContexts.delete(ctx);
    }
    if (typeof navigator !== 'undefined' && 'audioSession' in navigator) {
        try {
            navigator.audioSession.type = 'auto';
            navigator.audioSession.type = captureActive ? 'play-and-record' : 'playback';
        } catch (e) {}
    }
}

/**
 * Register an AudioContext to ensure it is resumed and configured properly.
 */
export function registerAudioContext(ctx) {
    if (!ctx || trackedAudioContexts.has(ctx)) return;
    trackedAudioContexts.add(ctx);

    ctx.addEventListener('statechange', () => {
        if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && isPlaybackActive) {
            ctx.resume().catch(() => {});
        }
    });
}

/**
 * Resume all tracked AudioContexts if they are in suspended state.
 */
export function resumeTrackedAudioContexts() {
    const pending = [];
    for (const ctx of trackedAudioContexts) {
        // iOS reports 'interrupted' after the app was backgrounded or a call/Siri took the session
        if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
            pending.push(ctx.resume().catch(() => {}));
        }
    }
    return Promise.all(pending);
}

/**
 * An AudioContext the app already owns (synth, metronome), or null. Short previews reuse it instead of
 * opening one more context, which on iOS can interrupt the Original audio element.
 */
export function getTrackedAudioContext() {
    for (const ctx of trackedAudioContexts) {
        if (ctx && ctx.state !== 'closed') return ctx;
    }
    return null;
}

/**
 * True when every tracked AudioContext is running (or none exist).
 */
export function areTrackedAudioContextsRunning() {
    let live = 0;
    let closed = 0;
    for (const ctx of trackedAudioContexts) {
        if (!ctx) continue;
        if (ctx.state === 'closed') { closed++; continue; }
        live++;
        if (ctx.state !== 'running') return false;
    }
    // iOS can close the synth's context while the app is away; nothing live then means audio is dead
    return !(closed > 0 && live === 0);
}

/**
 * Call just before AlphaTab's player is built: AudioContexts created in the next few seconds (or until
 * endSynthContextCapture) are the synth's own.
 */
export function beginSynthContextCapture(holdMs = 6000) {
    synthCaptureUntil = Date.now() + holdMs;
}

export function endSynthContextCapture() {
    synthCaptureUntil = 0;
}

function tagSynthContext(ctx) {
    if (!ctx || synthContexts.has(ctx)) return;
    synthContexts.add(ctx);
    // 'closed' and 'interrupted' are reported the moment they happen, even while the app is in the background
    ctx.addEventListener('statechange', () => {
        for (const fn of synthStateListeners) {
            try { fn(ctx.state, ctx); } catch (_) { /* a listener must not break the others */ }
        }
    });
}

/** Forget the synth's contexts (the player was destroyed; the next one opens its own). */
export function forgetSynthContexts() {
    synthContexts.clear();
}

/** Listen for state changes of the synth's context: fn(state, ctx). Returns an unsubscribe function. */
export function onSynthContextState(fn) {
    synthStateListeners.add(fn);
    return () => synthStateListeners.delete(fn);
}

/**
 * True when every context the synth opened is closed (iOS does this to a long-backgrounded page): none can run again.
 * AlphaTab opens and closes a throwaway context of its own while it sets up, so one closed context is not enough.
 */
export function isSynthContextDead() {
    let any = false;
    for (const ctx of synthContexts) {
        if (!ctx) continue;
        any = true;
        if (ctx.state !== 'closed') return false;
    }
    return any;
}

/** The synth's live context, or null (read-only, for the stall check). */
export function getSynthAudioContext() {
    for (const ctx of synthContexts) {
        if (ctx && ctx.state !== 'closed') return ctx;
    }
    return null;
}

/**
 * Resume tracked contexts and wait briefly for them to report running. Resolves false when a
 * context stays suspended/interrupted (iOS needs a user gesture) so the caller can rebuild.
 */
export async function recoverAudioContexts(waitMs = 400) {
    configureAudioSession();
    await Promise.race([resumeTrackedAudioContexts(), new Promise(r => setTimeout(r, waitMs))]);
    if (areTrackedAudioContextsRunning()) return true;
    await new Promise(r => setTimeout(r, waitMs));
    return areTrackedAudioContextsRunning();
}

/**
 * Start the silent audio channel and configure audio session for active synth playback.
 * Called when synth playback starts.
 */
export function enableIOSAudioPlayback() {
    isPlaybackActive = true;
    configureAudioSession();
    resumeTrackedAudioContexts();

    // Start silent audio on iOS (or standalone PWA)
    if (isIOSDevice() || window.navigator?.standalone) {
        let audio = getOrCreateSilentAudio();
        if (audio && (audio.error || audio.ended)) {
            resetIOSAudioSession();
            audio = getOrCreateSilentAudio();
        }
        if (audio && audio.paused) {
            const promise = audio.play();
            if (promise && typeof promise.catch === 'function') {
                promise.catch(() => {
                    // Suppress autoplay policy rejection if user gesture not yet recognized
                });
            }
        }
    }
}

/**
 * Pause the silent audio channel when synth playback stops or pauses.
 */
export function pauseIOSAudioPlayback() {
    isPlaybackActive = false;
    if (silentAudioEl && !silentAudioEl.paused) {
        try {
            silentAudioEl.pause();
        } catch (e) {
            // ignore
        }
    }
}

/**
 * Warm up audio session on first user gesture.
 */
function handleFirstUserGesture() {
    configureAudioSession();
    resumeTrackedAudioContexts();

    if (!isAudioUnlocked && (isIOSDevice() || window.navigator?.standalone)) {
        isAudioUnlocked = true;
        const audio = getOrCreateSilentAudio();
        if (audio && audio.paused) {
            const promise = audio.play();
            if (promise && typeof promise.then === 'function') {
                promise.then(() => {
                    // If synth is not actively playing, pause immediately so we don't display playback widgets
                    if (!isPlaybackActive) {
                        audio.pause();
                    }
                }).catch(() => {});
            }
        }
    }
}

/**
 * Global initialization of iOS Audio unlock handling.
 */
export function initIOSAudioUnlock() {
    if (typeof window === 'undefined') return;

    // Wrap AudioContext to automatically catch instances created by AlphaTab
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (NativeAudioContext) {
        const WrappedAudioContext = function(...args) {
            configureAudioSession();
            const ctx = new NativeAudioContext(...args);
            registerAudioContext(ctx);
            if (Date.now() < synthCaptureUntil) tagSynthContext(ctx);
            return ctx;
        };
        WrappedAudioContext.prototype = NativeAudioContext.prototype;
        try {
            Object.defineProperty(WrappedAudioContext, 'name', { value: NativeAudioContext.name });
        } catch (e) {}

        if (window.AudioContext) window.AudioContext = WrappedAudioContext;
        if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
    }

    // Listen for user gestures to warm up and configure audioSession
    const gestureEvents = ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'];
    for (const evt of gestureEvents) {
        window.addEventListener(evt, handleFirstUserGesture, { capture: true, passive: true });
    }

    // Returning to the app (including from the back/forward cache) leaves contexts interrupted
    const onReturn = () => {
        if (document.hidden) return;
        configureAudioSession();
        resumeTrackedAudioContexts();
    };
    window.addEventListener('pageshow', onReturn);
    window.addEventListener('focus', onReturn);

    // Handle page visibility changes (pause silent audio in background, resume if playing in foreground)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (silentAudioEl && !silentAudioEl.paused) {
                silentAudioEl.pause();
            }
        } else {
            resetIOSAudioSession();
            resumeTrackedAudioContexts();
            if (isPlaybackActive) enableIOSAudioPlayback();
        }
    });
}
