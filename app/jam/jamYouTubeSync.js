// jamYouTubeSync.js
// YouTube follow-along for Jam Mode, independent of the song type (GP, PDF or text).
// The host broadcasts its video, play state, position and rate; clients load the same video
// and keep it aligned. The iframe API has no scheduled start, and a seek while playing lands
// hundreds of ms off after buffering (Android), so clients correct small drift by nudging the
// playback rate (pitch is preserved) and large drift by a restart: pause, seek to where the
// host will be shortly, then play at that moment, early by a learned per-device play delay.

import { MSG } from './jamProtocol.js';
import { DriftFilter, median } from './jamClock.js';
import { loadSetting, saveSetting } from './jamCommon.js';
import { jamYouTubeControl, onYouTubeEvent } from '../youtubePlayer.js';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const HOST_HEARTBEAT_MS = 1000;
const HOST_JUMP_SEC = 0.75; // position jump while playing that counts as a seek
const HOST_PAUSED_SEEK_SEC = 0.25;
const CLIENT_TICK_MS = 500;
const DRIFT_SEC = 0.05; // start nudging beyond this
const NUDGE_DONE_SEC = 0.02;
const NUDGE_BIG_SEC = 0.3; // nudge harder beyond this
// YouTube only accepts rates in 0.05 steps.
const NUDGE_STEP = 0.05;
const NUDGE_BIG_STEP = 0.1;
const NUDGE_CHECK_MS = 1500; // the reported rate must follow a request within this
const RESTART_SEC = 0.4; // drift beyond this restarts instead of nudging
const RESTART_NO_NUDGE_SEC = 0.15; // restart threshold where rate changes are ignored
const RESTART_MS = 800; // pause-to-play gap of a restart; leaves time for the seek to buffer
const START_LAG_MAX_SEC = 0.5;
const START_LAG_SAMPLES = 5;
const CORRECTION_COOLDOWN_MS = 2500;
const COMMAND_SETTLE_MS = 1500; // state echoes of our own commands arrive within this
const USER_SEEK_SEC = 1.5;
const AUTOPLAY_HINT_MS = 4000;

const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

function ytState() {
    const s = jamYouTubeControl.snapshot();
    return { videoId: s.videoId || null, playing: s.playing, timeSec: round3(s.timeSec), rate: s.rate || 1 };
}

export function createYouTubeHost({ broadcast }) {
    let unsubscribe = null;
    let heartbeat = null;
    let last = null; // { timeSec, at, playing, rate } as last broadcast

    function publish() {
        const yt = ytState();
        last = { timeSec: yt.timeSec, at: performance.now(), playing: yt.playing, rate: yt.rate };
        broadcast(MSG.YT_STATE, { yt });
    }

    function onEvent(e) {
        if (e.type !== 'time' || !last) {
            publish();
            return;
        }
        // Seeks inside the iframe only show up as a position jump.
        const elapsedSec = (performance.now() - last.at) / 1000;
        const expected = last.timeSec + (last.playing ? elapsedSec * last.rate : 0);
        const tolerance = last.playing ? HOST_JUMP_SEC : HOST_PAUSED_SEEK_SEC;
        if (Math.abs(jamYouTubeControl.snapshot().timeSec - expected) > tolerance) publish();
    }

    function handleCommand(msg) {
        const t = Number(msg.timeSec);
        switch (msg.action) {
            case 'play':
                if (Number.isFinite(t)) jamYouTubeControl.seek(t);
                jamYouTubeControl.play();
                break;
            case 'pause':
                jamYouTubeControl.pause();
                if (Number.isFinite(t)) jamYouTubeControl.seek(t);
                break;
            case 'seek':
                if (Number.isFinite(t)) {
                    jamYouTubeControl.seek(t);
                    publish();
                }
                break;
            case 'video':
                if (VIDEO_ID_RE.test(String(msg.videoId || ''))) jamYouTubeControl.load(msg.videoId, { playing: false });
                break;
            default:
        }
    }

    return {
        start() {
            unsubscribe = onYouTubeEvent(onEvent);
            heartbeat = setInterval(() => { if (jamYouTubeControl.snapshot().playing) publish(); }, HOST_HEARTBEAT_MS);
        },
        stop() {
            unsubscribe?.();
            unsubscribe = null;
            clearInterval(heartbeat);
            last = null;
        },
        state: ytState,
        handleCommand
    };
}

export function createYouTubeClient({ send, hostNowEstimate, isClockSynced, latencyMs, canControl, isFollowing, toast }) {
    const driftFilter = new DriftFilter(3);
    let host = null; // { videoId, playing, timeSec, rate, hostTs }
    let lastCommandAt = 0;
    let lastCorrectionAt = 0;
    let restart = null; // { timer } while a restart waits to press play
    let nudge = null; // { rate, sign, at, checked } while the rate is nudged
    let nudgeBroken = false; // this player ignores rate changes
    let measureLag = false; // next settled drift sample refines startLagSec
    // Seconds between playVideo() and the video actually running, learned per device (~0.2 s on
    // an Android WebView, ~0 in desktop Chromium). Median of recent restarts, so one slow start
    // (a far seek still buffering) can't skew it.
    let startLagSamples = (loadSetting('ytStartLagSamples', []) || []).filter(Number.isFinite).slice(-START_LAG_SAMPLES);
    let startLagSec = startLagSamples.length ? median(startLagSamples) : 0.1;
    let lastDriftSec = null;
    let prevSample = null; // { timeSec, at, playing } for spotting local seeks
    let tickTimer = null;
    let hintTimer = null;
    let unsubscribe = null;

    const settling = () => performance.now() - lastCommandAt < COMMAND_SETTLE_MS;
    const command = (fn) => { lastCommandAt = performance.now(); fn(); };
    const hostRate = () => host?.rate || 1;

    /** Where the host's video is now, shifted by our output latency relative to the host's. */
    function expectedSec() {
        if (!host.playing) return host.timeSec;
        return host.timeSec + (hostNowEstimate() - host.hostTs + latencyMs()) / 1000 * hostRate();
    }

    function hostControlsToast() {
        toast?.('Host controls this. Use Detach to practice on your own.', 'info', 2500, 'jam-host-controls');
    }

    function armAutoplayHint() {
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => {
            if (host?.playing && isFollowing() && !jamYouTubeControl.snapshot().playing && !jamYouTubeControl.hasPlayed()) {
                toast?.('Tap play on the YouTube video to join in.', 'info', 5000, 'jam-yt-autoplay');
            }
        }, AUTOPLAY_HINT_MS);
    }

    function setNudge(rate, sign) {
        if (nudge?.rate === rate) return;
        nudge = { rate, sign, at: performance.now(), checked: false };
        jamYouTubeControl.setRate(rate);
    }

    function clearNudge() {
        if (!nudge) return;
        nudge = null;
        jamYouTubeControl.setRate(hostRate());
    }

    function cancelRestart() {
        if (restart) {
            clearTimeout(restart.timer);
            restart = null;
        }
    }

    /** Pause, seek to where the host will be in RESTART_MS, and play right then. */
    function scheduleRestart() {
        cancelRestart();
        clearNudge();
        driftFilter.reset();
        lastCorrectionAt = performance.now();
        command(() => {
            jamYouTubeControl.pause();
            jamYouTubeControl.seek(expectedSec() + RESTART_MS / 1000 * hostRate());
        });
        const timer = setTimeout(() => {
            restart = null;
            if (!host?.playing || !isFollowing()) return;
            measureLag = true;
            command(() => jamYouTubeControl.play());
            armAutoplayHint();
        }, Math.max(0, RESTART_MS - startLagSec * 1000));
        restart = { timer };
    }

    function correctDrift(snap) {
        const raw = snap.timeSec - expectedSec();
        if (measureLag) {
            measureLag = false;
            if (Math.abs(raw) < 1) {
                // Ahead after a start means play() was called too early (and vice versa).
                startLagSamples.push(round3(Math.min(START_LAG_MAX_SEC, Math.max(0, startLagSec - raw))));
                if (startLagSamples.length > START_LAG_SAMPLES) startLagSamples.shift();
                startLagSec = median(startLagSamples);
                saveSetting('ytStartLagSamples', startLagSamples);
            }
        }
        lastDriftSec = driftFilter.push(raw);
        const abs = Math.abs(lastDriftSec);
        const now = performance.now();
        const restartAbove = nudgeBroken ? RESTART_NO_NUDGE_SEC : RESTART_SEC;
        if (abs > restartAbove && now - lastCorrectionAt > CORRECTION_COOLDOWN_MS) {
            scheduleRestart();
            return;
        }
        if (nudge && !nudge.checked && now - nudge.at > NUDGE_CHECK_MS) {
            nudge.checked = true;
            if (Math.abs(snap.rate - nudge.rate) > 1e-3) {
                nudgeBroken = true;
                console.info('[Jam] YouTube ignores playback rate changes here; correcting drift with restarts');
                clearNudge();
                return;
            }
        }
        // Stop on the raw sample: the median lags and would overshoot.
        if (nudge && (Math.abs(raw) < NUDGE_DONE_SEC || Math.sign(raw) !== nudge.sign)) {
            clearNudge();
            return;
        }
        if (nudgeBroken || (!nudge && abs <= DRIFT_SEC)) return;
        const step = Math.abs(raw) > NUDGE_BIG_SEC ? NUDGE_BIG_STEP : NUDGE_STEP;
        const rate = Math.round((hostRate() - Math.sign(raw) * step) / NUDGE_STEP) * NUDGE_STEP;
        setNudge(Math.min(2, Math.max(0.25, round3(rate))), Math.sign(raw));
    }

    function reconcile() {
        if (!host || !isFollowing() || !isClockSynced()) return;
        const snap = jamYouTubeControl.snapshot();
        if (!host.videoId) {
            cancelRestart();
            nudge = null;
            if (snap.playing) command(() => jamYouTubeControl.pause());
            lastDriftSec = null;
            return;
        }
        if (snap.videoId !== host.videoId) {
            if (settling()) return;
            cancelRestart();
            nudge = null;
            driftFilter.reset();
            measureLag = false;
            lastDriftSec = null;
            command(() => jamYouTubeControl.load(host.videoId, { playing: host.playing, timeSec: expectedSec() }));
            if (host.playing) armAutoplayHint();
            return;
        }
        if (!nudge && !settling() && Math.abs(snap.rate - hostRate()) > 1e-3) jamYouTubeControl.setRate(hostRate());
        if (!host.playing) {
            cancelRestart();
            clearNudge();
            lastDriftSec = null;
            if (snap.playing) {
                command(() => {
                    jamYouTubeControl.pause();
                    jamYouTubeControl.seek(host.timeSec);
                });
            } else if (!settling() && Math.abs(snap.timeSec - host.timeSec) > DRIFT_SEC) {
                command(() => jamYouTubeControl.seek(host.timeSec));
            }
            return;
        }
        if (restart || snap.buffering || settling()) return;
        if (!snap.playing) {
            scheduleRestart();
            return;
        }
        correctDrift(snap);
    }

    /** Send a controller command; hold off reconcile() until the host echoes the new state. */
    function forward(cmd) {
        lastCommandAt = performance.now();
        send(MSG.CMD_YT, cmd);
    }

    function forwardOrRevert(cmd) {
        if (canControl()) {
            forward(cmd);
        } else {
            hostControlsToast();
            reconcile();
        }
    }

    function onEvent(e) {
        if (!host || !isFollowing()) return;
        if (e.type === 'video') {
            if (e.source !== 'user') return;
            if (canControl()) {
                if (e.videoId) forward({ action: 'video', videoId: e.videoId });
            } else {
                hostControlsToast();
                lastCommandAt = 0;
                reconcile();
            }
            return;
        }
        if (e.type === 'state') {
            if (settling() || e.playing === host.playing) return;
            forwardOrRevert({ action: e.playing ? 'play' : 'pause', timeSec: round3(jamYouTubeControl.snapshot().timeSec) });
            return;
        }
        if (e.type === 'time') {
            // A seek in the iframe only shows up as a jump in reported time. Non-controllers are
            // pulled back by reconcile(); a controller's seek moves everyone.
            const snap = jamYouTubeControl.snapshot();
            const now = performance.now();
            const prev = prevSample;
            prevSample = { timeSec: snap.timeSec, at: now, playing: snap.playing && !snap.buffering };
            if (!prev || settling() || !canControl()) return;
            const expected = prev.timeSec + (prev.playing ? (now - prev.at) / 1000 * snap.rate : 0);
            if (Math.abs(snap.timeSec - expected) > (prev.playing ? USER_SEEK_SEC : HOST_PAUSED_SEEK_SEC)) {
                forward({ action: 'seek', timeSec: round3(snap.timeSec) });
            }
        }
    }

    return {
        start() {
            unsubscribe = onYouTubeEvent(onEvent);
            tickTimer = setInterval(reconcile, CLIENT_TICK_MS);
        },
        stop() {
            unsubscribe?.();
            unsubscribe = null;
            clearInterval(tickTimer);
            clearTimeout(hintTimer);
            cancelRestart();
            clearNudge();
            host = null;
            lastDriftSec = null;
        },
        apply(yt, hostTs) {
            if (!yt) return;
            const prev = host && isClockSynced() ? { ...host, nowSec: expectedSec() } : null;
            host = {
                videoId: VIDEO_ID_RE.test(String(yt.videoId || '')) ? yt.videoId : null,
                playing: Boolean(yt.playing),
                timeSec: Number(yt.timeSec) || 0,
                rate: Number(yt.rate) || 1,
                hostTs: Number(hostTs) || hostNowEstimate()
            };
            // A host seek, play or pause supersedes any correction in flight; a seek while
            // playing restarts at the new position straight away rather than after the filter.
            const jumped = prev && isClockSynced() && (prev.playing !== host.playing || prev.videoId !== host.videoId
                || Math.abs(prev.nowSec - expectedSec()) > HOST_JUMP_SEC);
            if (jumped && isFollowing()) {
                cancelRestart();
                lastCommandAt = 0;
                const snap = jamYouTubeControl.snapshot();
                if (host.playing && prev.playing && host.videoId && snap.videoId === host.videoId && snap.playing) {
                    scheduleRestart();
                    return;
                }
            }
            reconcile();
        },
        reconcile,
        driftMs: () => (lastDriftSec === null ? null : Math.round(lastDriftSec * 1000)),
        hostVideoId: () => host?.videoId || null
    };
}
