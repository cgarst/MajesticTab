// jamClientAdapter.js
// Client side of Jam Mode: applies host messages to the local player while leaving all
// notation preferences (tracks, zoom, layout, theme, mix) untouched.

import { MSG, makeMessage } from './jamProtocol.js';
import { nowMs, jam } from './jamTransport.js';
import { ClockSync, DriftFilter, NudgeMonitor, decideDriftAction, DRIFT_IGNORE_MS, DRIFT_SEEK_NO_NUDGE_MS } from './jamClock.js';
import { estimateOutputLatencyMs, createCoalescer, sha256Hex, startLag, measureStartLag, waitForPlayerReady, loadSetting, saveSetting } from './jamCommon.js';
import { jamPlayerControl, onTransportEvent, setTransportInterceptor } from '../gpProcessor/gpPlayer.js';
import { base64ToArrayBuffer, arrayBufferToBase64Async } from '../fileStore.js';

const PING_BURST = 10;
const PING_BURST_MS = 100;
const PING_INTERVAL_MS = 5000;
const STATUS_INTERVAL_MS = 2000;
const HARD_SEEK_COOLDOWN_MS = 1500;
const SONG_DOWNLOAD_TIMEOUT_MS = 60000;

export function createClientAdapter({ loadFile, getCurrentFile, recordFileToRecents, ui, getSettings }) {
    const clock = new ClockSync();
    const driftFilter = new DriftFilter(5);
    const nudgeMonitor = new NudgeMonitor();
    // Learned per device: some engines (WebKit) ignore small playbackSpeed changes. The check
    // compares against the expected closing rate, so a slow nudge at low speed isn't misread.
    let nudgeWorks = loadSetting('nudgeEffective', true);
    let active = false;
    let clientId = null;
    let hostName = '';
    let following = true;
    let controllerId = null;
    let policy = 'ask';
    let hostSong = null;
    let loadedSongId = null;
    let loadingSong = null; // { id, promise }
    let pendingTransport = null; // { transport, hostTs }
    let hostSpeed = 1;
    let scheduledPlay = null;
    let pingTimers = [];
    let statusTimer = null;
    let unsubscribe = null;
    let applyingRemote = false;
    let lastDriftMs = null;
    let lastRawDriftMs = null;
    let lastHardSeekAt = 0;
    let nudging = false;
    let pendingDownload = null; // { id, resolve, reject, timer }
    const songCache = new Map(); // songId -> { bytes, fileName } (session only)
    let pingId = 0;

    const send = (type, payload = {}) => jam.clientSend(makeMessage(type, payload)).catch(() => {});

    let hostOutLatency = 0;
    // How much earlier than the host's player position our player must run: our own output
    // latency (plus trim) minus the host's, so both speakers sound together.
    const latencyMs = () => estimateOutputLatencyMs() + (getSettings().trimMs || 0) - hostOutLatency;
    const hostNowEstimate = () => clock.hostFromLocal(nowMs());
    const canControl = () => clientId && (controllerId === clientId || policy === 'anyone');
    const status = () => ({
        connected: active && Boolean(clientId),
        hostName,
        rttMs: clock.rtt,
        driftMs: lastDriftMs,
        following,
        controllerId,
        policy,
        canControl: Boolean(canControl()),
        loading: Boolean(loadingSong),
        song: hostSong,
        songLoaded: Boolean(hostSong && loadedSongId === hostSong.id),
        synced: clock.synced
    });
    const emitStatus = () => ui.onStatus?.(status());

    function remote(fn) {
        applyingRemote = true;
        try { return fn(); } finally { applyingRemote = false; }
    }

    // ---- Clock sync --------------------------------------------------------

    function sendPing() {
        pingId += 1;
        send(MSG.PING, { id: pingId });
    }

    function startClockSync() {
        stopClockSync();
        clock.reset();
        for (let i = 0; i < PING_BURST; i++) {
            pingTimers.push(setTimeout(sendPing, i * PING_BURST_MS));
        }
        pingTimers.push(setInterval(sendPing, PING_INTERVAL_MS));
        statusTimer = setInterval(() => {
            send(MSG.STATUS, {
                rttMs: Math.round(clock.rtt * 10) / 10,
                driftMs: lastDriftMs === null ? null : Math.round(lastDriftMs),
                // Diagnostics for the host roster / test tools.
                rawDriftMs: lastRawDriftMs === null ? null : Math.round(lastRawDriftMs),
                nudgeWorks,
                speedFactor: Math.round(jamPlayerControl.actualSpeed() / (hostSpeed || 1) * 1000) / 1000,
                startLagMs: Math.round(startLag.get()),
                state: loadingSong ? 'loading' : (!following ? 'detached' : (hostSong && loadedSongId === hostSong.id ? 'synced' : 'idle'))
            });
            emitStatus();
        }, STATUS_INTERVAL_MS);
    }

    function stopClockSync() {
        pingTimers.forEach((t) => { clearTimeout(t); clearInterval(t); });
        pingTimers = [];
        clearInterval(statusTimer);
        statusTimer = null;
    }

    function waitForClock(timeoutMs = 2000) {
        if (clock.synced) return Promise.resolve();
        return new Promise((resolve) => {
            const started = performance.now();
            const iv = setInterval(() => {
                if (clock.synced || performance.now() - started > timeoutMs) {
                    clearInterval(iv);
                    resolve();
                }
            }, 25);
        });
    }

    // ---- Song loading ------------------------------------------------------

    function requestSongBytes(song) {
        if (songCache.has(song.id)) return Promise.resolve(songCache.get(song.id));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingDownload = null;
                reject(new Error('Song download timed out'));
            }, SONG_DOWNLOAD_TIMEOUT_MS);
            pendingDownload = { id: song.id, resolve, reject, timer };
            send(MSG.SONG_REQUEST, { id: song.id });
        });
    }

    async function matchesCurrentFile(song) {
        const cur = getCurrentFile?.();
        if (!cur || cur.name !== song.fileName || cur.size !== song.size) return false;
        try {
            return (await sha256Hex(await cur.arrayBuffer())) === song.id;
        } catch (_) {
            return false;
        }
    }

    function ensureSong(song) {
        if (!song) return Promise.resolve(false);
        if (loadedSongId === song.id) return Promise.resolve(true);
        if (loadingSong?.id === song.id) return loadingSong.promise;
        const promise = (async () => {
            const started = performance.now();
            try {
                if (await matchesCurrentFile(song)) {
                    const cur = getCurrentFile();
                    cur.jamSongId = song.id;
                    loadedSongId = song.id;
                } else {
                    const { bytes, fileName } = await requestSongBytes(song);
                    const file = new File([bytes], fileName || song.fileName, { type: 'application/octet-stream' });
                    file.jamTransient = !getSettings().alwaysSaveSongs;
                    file.jamSongId = song.id;
                    file.songTitle = song.title;
                    await loadFile(file);
                    loadedSongId = song.id;
                }
                const ready = await waitForPlayerReady();
                if (!ready) throw new Error('Audio engine did not become ready');
                // Muted warm-up so the first synced start isn't late by the synth's cold start.
                if (!jamPlayerControl.snapshot().playing) await jamPlayerControl.warmUp();
                send(MSG.SONG_READY, { songId: song.id, loadMs: Math.round(performance.now() - started) });
                return true;
            } catch (e) {
                console.error('[Jam] song load failed:', e);
                ui.toast?.(`Could not load "${song.title}": ${e.message}`, 'error');
                send(MSG.STATUS, { state: 'error' });
                return false;
            } finally {
                loadingSong = null;
                emitStatus();
            }
        })();
        loadingSong = { id: song.id, promise };
        emitStatus();
        return promise;
    }

    // ---- Transport application --------------------------------------------

    // `scheduledPlay` stays set until the post-start latency measurement finishes, so
    // heartbeat drift correction doesn't act on a start that is still settling.
    function cancelScheduledPlay() {
        if (scheduledPlay) {
            clearTimeout(scheduledPlay.timer);
            scheduledPlay = null;
        }
    }

    function settleAfterStart(timeMs, targetLocalMs, usedLagMs) {
        const entry = {};
        entry.timer = measureStartLag({
            timeMs,
            targetLocalMs,
            usedLagMs,
            speed: hostSpeed || 1,
            isStillValid: () => scheduledPlay === entry,
            onDone: () => { if (scheduledPlay === entry) scheduledPlay = null; }
        });
        scheduledPlay = entry;
    }

    function setHostSpeed(speed) {
        if (!Number.isFinite(speed)) return;
        hostSpeed = speed;
        nudging = false;
        remote(() => jamPlayerControl.setSpeed(speed));
    }

    /** Song ms elapsed over `realMs` of wall time at the host's nominal speed. */
    const songMs = (realMs) => realMs * (hostSpeed || 1);

    /** Seek to `timeMs` and start at `startAtHostTs` (host clock), compensating our audio latency. */
    function schedulePlay(timeMs, startAtHostTs) {
        cancelScheduledPlay();
        driftFilter.reset();
        const target = clock.localFromHost(startAtHostTs) - latencyMs();
        const lag = startLag.get();
        const delay = target - nowMs();
        if (delay - lag <= 2) {
            // Too late to schedule: start now at the position the host will have reached.
            const startPos = timeMs + songMs(Math.max(0, lag - delay));
            remote(() => jamPlayerControl.seekMs(startPos));
            remote(() => jamPlayerControl.play());
            settleAfterStart(timeMs, target, lag);
            return;
        }
        if (jamPlayerControl.snapshot().playing) {
            // Already playing (host resync after a seek, jump or loop wrap). If we will already be
            // where the host is at `target` (e.g. we wrapped the loop too), leave playback alone.
            // Otherwise stop and do a normal scheduled start: seeking while audio runs lands at a
            // platform-dependent offset (WebKit was off by -70..+140 ms), a scheduled start doesn't.
            const projected = jamPlayerControl.timeMs() + songMs(delay);
            if (Math.abs(projected - timeMs) < DRIFT_IGNORE_MS) return;
            remote(() => jamPlayerControl.pause());
        }
        remote(() => jamPlayerControl.seekMs(timeMs));
        // Call play() early by the learned start latency so audio is running at `target`.
        const fireAt = target - lag;
        const coarse = Math.max(0, fireAt - nowMs() - 10);
        const timer = setTimeout(() => {
            scheduledPlay = null;
            // Final few ms: spin on the clock for tight alignment.
            while (nowMs() < fireAt) { /* busy wait (<= ~10ms) */ }
            // AlphaTab can drop a seek issued right after pause(), so seek again at start time.
            remote(() => {
                jamPlayerControl.seekMs(timeMs);
                jamPlayerControl.play();
            });
            settleAfterStart(timeMs, target, lag);
        }, coarse);
        scheduledPlay = { timer };
    }

    function applyPause(timeMs) {
        cancelScheduledPlay();
        remote(() => {
            jamPlayerControl.pause();
            if (Number.isFinite(timeMs)) jamPlayerControl.seekMs(timeMs);
        });
        resetNudge();
    }

    function resetNudge() {
        if (nudging) {
            nudging = false;
            jamPlayerControl.nudgeSpeed(1);
        }
    }

    function applyLoop(loop) {
        if (!loop) return;
        remote(() => jamPlayerControl.setLoop(loop));
    }

    function songReady() {
        return Boolean(hostSong && loadedSongId === hostSong.id && !loadingSong && jamPlayerControl.isReady());
    }

    async function applyTransportState(transport, hostTs) {
        if (!transport) return;
        await waitForClock();
        setHostSpeed(transport.speed ?? 1);
        applyLoop(transport.loop);
        if (transport.playing && Number.isFinite(transport._startAt)) {
            schedulePlay(transport.timeMs, transport._startAt);
        } else if (transport.playing) {
            const projected = transport.timeMs + songMs(Math.max(0, hostNowEstimate() - hostTs));
            // Play right away from the projected host position.
            schedulePlay(projected, hostNowEstimate());
        } else {
            applyPause(transport.timeMs);
        }
    }

    /** Load the host's song, then apply whatever transport state arrived meanwhile. */
    async function loadSongAndCatchUp(song) {
        const ok = await ensureSong(song);
        if (ok && following && pendingTransport && hostSong?.id === song.id) {
            const pending = pendingTransport;
            pendingTransport = null;
            await applyTransportState(pending.transport, pending.hostTs);
        }
        emitStatus();
    }

    async function applySessionState(state, hostTs) {
        controllerId = state.controllerId ?? null;
        policy = state.policy || 'ask';
        hostSong = state.song || null;
        emitStatus();
        if (!hostSong) return;
        pendingTransport = { transport: state.transport, hostTs };
        await loadSongAndCatchUp(hostSong);
    }

    // ---- Drift correction --------------------------------------------------

    function handleHeartbeat(msg) {
        if (!following || !songReady()) return;
        const snap = jamPlayerControl.snapshot();
        if (!msg.playing) return;
        if (!snap.playing) {
            if (!scheduledPlay) {
                const projected = msg.timeMs + songMs(Math.max(0, hostNowEstimate() - msg.hostTs));
                schedulePlay(projected, hostNowEstimate());
            }
            return;
        }
        if (scheduledPlay || !clock.synced) return;
        // Heartbeats carry the host speed, so a missed transport.speed (e.g. across a reconnect)
        // is repaired here instead of drifting at the wrong tempo.
        if (Number.isFinite(msg.speed) && Math.abs(msg.speed - jamPlayerControl.snapshot().speed) > 1e-6) {
            setHostSpeed(msg.speed);
            driftFilter.reset();
            return;
        }
        // Our speaker lags the host's by `latencyMs`, so our player should run that far ahead.
        const expected = msg.timeMs + songMs(hostNowEstimate() - msg.hostTs + latencyMs());
        const drift = snap.timeMs - expected;
        lastRawDriftMs = drift;
        lastDriftMs = driftFilter.push(drift);
        if (nudgeMonitor.update(nowMs(), lastDriftMs, nudging, hostSpeed)) {
            nudgeWorks = false;
            saveSetting('nudgeEffective', false);
            console.info('[Jam] speed nudges have no effect here; correcting drift with short re-seeks');
        }
        const allowNudge = getSettings().smoothDrift !== false && nudgeWorks;
        const decision = decideDriftAction(lastDriftMs, {
            allowNudge,
            hardSeekMs: allowNudge ? undefined : DRIFT_SEEK_NO_NUDGE_MS
        });
        if (decision.action === 'seek') {
            if (nowMs() - lastHardSeekAt < HARD_SEEK_COOLDOWN_MS) return;
            lastHardSeekAt = nowMs();
            resetNudge();
            driftFilter.reset();
            remote(() => jamPlayerControl.seekMs(expected));
        } else if (decision.action === 'nudge') {
            nudging = true;
            jamPlayerControl.nudgeSpeed(decision.speedFactor);
        } else {
            resetNudge();
        }
    }

    // ---- Local control (interceptor) --------------------------------------

    const sendSeekCommand = createCoalescer((timeMs) => send(MSG.CMD_SEEK, { timeMs }), 100);

    function interceptor(action, payload) {
        if (!active || !following || !hostSong) return false;
        if (!canControl()) {
            ui.toast?.('Host controls this. Use Detach to practice on your own.', 'info', 2500, 'jam-host-controls');
            return true;
        }
        switch (action) {
            case 'playPause':
                if (payload.playing) send(MSG.CMD_PAUSE);
                else send(MSG.CMD_PLAY, { timeMs: jamPlayerControl.snapshot().timeMs });
                break;
            case 'seekMs':
                sendSeekCommand(payload.timeMs);
                break;
            case 'seekTick':
                send(MSG.CMD_SEEK, { tick: payload.tick });
                break;
            case 'speed':
                send(MSG.CMD_SPEED, { speed: payload.speed });
                break;
            default:
                return false;
        }
        return true;
    }

    function onPlayerEvent(e) {
        if (!active || applyingRemote) return;
        if (e.type === 'loop' && following && canControl() && hostSong) {
            send(MSG.CMD_LOOP, { loop: { enabled: e.enabled, startMeasure: e.startMeasure, endMeasure: e.endMeasure } });
        }
    }

    function onFileLoaded(e) {
        const file = e.detail?.file;
        loadedSongId = file?.jamSongId || null;
        emitStatus();
    }

    // ---- Incoming messages -------------------------------------------------

    function handleMessage(_from, msg) {
        if (Number.isFinite(msg.outLatencyMs)) hostOutLatency = msg.outLatencyMs;
        switch (msg.type) {
            case MSG.WELCOME:
                clientId = msg.clientId;
                hostName = msg.hostName || 'Host';
                startClockSync();
                emitStatus();
                break;
            case MSG.REJECT: {
                const text = { pin: 'Wrong PIN.', version: 'The host runs an incompatible version of Jam mode.', full: 'The jam is full.' }[msg.reason] || 'The host rejected the connection.';
                ui.toast?.(text, 'error');
                break;
            }
            case MSG.PONG:
                clock.addSample(msg.t0, msg.t1, msg.t1b, msg.rxTs);
                if (clock.synced) emitStatus();
                break;
            case MSG.STATE:
                if (following) applySessionState(msg.state, msg.hostTs);
                else { hostSong = msg.state?.song || null; controllerId = msg.state?.controllerId ?? null; policy = msg.state?.policy || 'ask'; emitStatus(); }
                break;
            case MSG.SONG_OPEN:
                hostSong = msg.song;
                pendingTransport = null;
                cancelScheduledPlay();
                if (following) loadSongAndCatchUp(msg.song);
                emitStatus();
                break;
            case MSG.SONG_CLOSE:
                hostSong = null;
                cancelScheduledPlay();
                ui.toast?.('The host closed the song.', 'info');
                emitStatus();
                break;
            case MSG.SONG_DATA:
                if (pendingDownload && pendingDownload.id === msg.songId) {
                    clearTimeout(pendingDownload.timer);
                    try {
                        const bytes = base64ToArrayBuffer(msg.b64);
                        songCache.set(msg.songId, { bytes, fileName: msg.fileName });
                        pendingDownload.resolve({ bytes, fileName: msg.fileName });
                    } catch (e) {
                        pendingDownload.reject(e);
                    }
                    pendingDownload = null;
                }
                break;
            case MSG.PLAY:
                if (!following || !hostSong) break;
                hostSpeed = msg.speed ?? hostSpeed;
                if (!songReady()) { pendingTransport = { transport: { playing: true, timeMs: msg.timeMs, speed: hostSpeed, loop: null, _startAt: msg.startAtHostTs }, hostTs: msg.hostTs }; break; }
                if (Number.isFinite(msg.speed) && msg.speed !== jamPlayerControl.snapshot().speed) setHostSpeed(msg.speed);
                schedulePlay(msg.timeMs, msg.startAtHostTs);
                break;
            case MSG.PAUSE:
                if (!following) break;
                pendingTransport = null;
                if (songReady()) applyPause(msg.timeMs);
                break;
            case MSG.SEEK:
                if (!following || !songReady()) break;
                cancelScheduledPlay();
                remote(() => jamPlayerControl.seekMs(msg.timeMs));
                break;
            case MSG.SPEED:
                if (following && songReady()) setHostSpeed(msg.speed);
                break;
            case MSG.LOOP:
                if (following && songReady()) applyLoop(msg.loop);
                break;
            case MSG.HEARTBEAT:
                handleHeartbeat(msg);
                break;
            case MSG.CONTROL_GRANT:
                controllerId = msg.controllerId;
                if (controllerId === clientId) {
                    ui.toast?.('You have control.', 'success');
                    if (!following) setFollowing(true);
                }
                emitStatus();
                break;
            case MSG.CONTROL_REVOKE:
                if (controllerId === clientId) ui.toast?.('The host took back control.', 'info');
                controllerId = null;
                emitStatus();
                break;
            case MSG.CONTROL_DENY:
                ui.toast?.(msg.reason || 'Control request denied.', 'warning');
                break;
            case MSG.CONTROL_POLICY:
                policy = msg.policy || 'ask';
                emitStatus();
                break;
            default:
        }
    }

    function setFollowing(on) {
        if (following === on) return;
        following = on;
        if (!on) {
            cancelScheduledPlay();
            resetNudge();
            remote(() => jamPlayerControl.setSpeed(jamPlayerControl.snapshot().speed));
        } else {
            send(MSG.STATE_REQUEST);
        }
        emitStatus();
    }

    return {
        start() {
            active = true;
            following = true;
            clientId = null;
            unsubscribe = onTransportEvent(onPlayerEvent);
            setTransportInterceptor(interceptor);
            window.addEventListener('majestictab:file-loaded', onFileLoaded);
        },
        stop() {
            active = false;
            stopClockSync();
            cancelScheduledPlay();
            resetNudge();
            unsubscribe?.();
            unsubscribe = null;
            setTransportInterceptor(null);
            window.removeEventListener('majestictab:file-loaded', onFileLoaded);
            if (pendingDownload) { clearTimeout(pendingDownload.timer); pendingDownload = null; }
            clientId = null;
            hostSong = null;
            controllerId = null;
            loadingSong = null;
            pendingTransport = null;
            songCache.clear();
            emitStatus();
        },
        connectionLost() {
            stopClockSync();
            cancelScheduledPlay();
            resetNudge();
            clientId = null;
            emitStatus();
        },
        handleMessage,
        setFollowing,
        rejoin: () => { following = false; setFollowing(true); },
        requestControl: (reason) => send(MSG.CONTROL_REQUEST, { reason }),
        releaseControl: () => send(MSG.CONTROL_RELEASE),
        async openSongAsController(file) {
            const b64 = await arrayBufferToBase64Async(await file.arrayBuffer());
            send(MSG.CMD_SONG_OPEN, { fileName: file.name, b64 });
        },
        saveCurrentSongToLibrary() {
            const cur = getCurrentFile?.();
            if (cur?.jamTransient) {
                cur.jamTransient = false;
                recordFileToRecents?.(cur);
                return true;
            }
            return false;
        },
        getStatus: status
    };
}
