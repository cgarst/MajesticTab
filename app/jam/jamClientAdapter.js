// jamClientAdapter.js
// Client side of Jam Mode: applies host messages to the local player while leaving all
// notation preferences (tracks, zoom, layout, theme, mix) untouched. Synth transport applies
// to GP songs only; YouTube follow-along (jamYouTubeSync.js) applies to every song type.

import { MSG, makeMessage, isGpSong, chunkBase64 } from './jamProtocol.js';
import { nowMs, jam } from './jamTransport.js';
import { ClockSync, DriftFilter, NudgeMonitor, decideDriftAction, DRIFT_IGNORE_MS, DRIFT_SEEK_NO_NUDGE_MS } from './jamClock.js';
import { estimateOutputLatencyMs, createCoalescer, jamSongId, startLag, measureStartLag, waitForPlayerReady, loadSetting, saveSetting, trackPolicyFor } from './jamCommon.js';
import { createYouTubeClient } from './jamYouTubeSync.js';
import { runIdentify } from './jamIdentify.js';
import { jamPlayerControl, onTransportEvent, setTransportInterceptor, reloadSynthSoundFonts } from '../gpProcessor/gpPlayer.js';
import { setSessionSoundFonts } from '../soundFontStore.js';
import { jamYouTubeControl } from '../youtubePlayer.js';
import { base64ToArrayBuffer, arrayBufferToBase64Async } from '../fileStore.js';

const PING_BURST = 10;
const PING_BURST_MS = 100;
const PING_INTERVAL_MS = 5000;
const STATUS_INTERVAL_MS = 2000;
const HARD_SEEK_COOLDOWN_MS = 1500;
const SONG_DOWNLOAD_TIMEOUT_MS = 60000;
const SOUNDFONT_IDLE_TIMEOUT_MS = 30000;

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
    let muted = false;
    const applyMute = (on) => {
        muted = Boolean(on);
        jamPlayerControl.setMuted(muted);
        jamYouTubeControl.setMuted(muted);
    };
    let trackState = null;
    const applyTracks = () => jamPlayerControl.setTrackPolicy(clientId && trackState ? trackPolicyFor(trackState, clientId) : {});
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
    let pendingDownload = null; // { id, resolve, reject, timer, parts }
    const songCache = new Map(); // songId -> { bytes, fileName } (session only)
    const fontCache = new Map(); // `${id}:${size}` -> ArrayBuffer of a host SoundFont (session only)
    const fontDownloads = new Map(); // host SoundFont id -> { resolve, reject, timer, parts }
    let appliedFontSig = null;
    let fontToken = 0;
    let fontSync = Promise.resolve();
    let pingId = 0;

    const send = (type, payload = {}) => jam.clientSend(makeMessage(type, payload)).catch(() => {});

    let hostOutLatency = 0;
    // How much earlier than the host's player position our player must run: our own output
    // latency (plus trim) minus the host's, so both speakers sound together.
    const latencyMs = () => estimateOutputLatencyMs() + (getSettings().trimMs || 0) - hostOutLatency;
    const hostNowEstimate = () => clock.hostFromLocal(nowMs());
    const canControl = () => clientId && (controllerId === clientId || policy === 'anyone');
    const hostSongIsGp = () => isGpSong(hostSong);
    const youtube = createYouTubeClient({
        send,
        hostNowEstimate,
        isClockSynced: () => clock.synced,
        latencyMs,
        canControl: () => Boolean(canControl()),
        isFollowing: () => active && following && Boolean(clientId),
        toast: (...args) => ui.toast?.(...args)
    });
    const status = () => ({
        connected: active && Boolean(clientId),
        hostName,
        rttMs: clock.rtt,
        driftMs: lastDriftMs,
        ytDriftMs: youtube.driftMs(),
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
                ytDriftMs: youtube.driftMs(),
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

    // ---- Host SoundFonts and mixer ----------------------------------------

    function requestSoundFont(font) {
        const key = `${font.id}:${font.size}`;
        if (fontCache.has(key)) return Promise.resolve(fontCache.get(key));
        if (fontDownloads.has(font.id)) return fontDownloads.get(font.id).promise;
        const download = { parts: null, timer: null };
        const fail = (err) => { clearTimeout(download.timer); fontDownloads.delete(font.id); download.reject(err); };
        const arm = () => {
            clearTimeout(download.timer);
            download.timer = setTimeout(() => fail(new Error(`Download of ${font.name} timed out`)), SOUNDFONT_IDLE_TIMEOUT_MS);
        };
        download.promise = new Promise((resolve, reject) => {
            download.resolve = (bytes) => { clearTimeout(download.timer); fontDownloads.delete(font.id); fontCache.set(key, bytes); resolve(bytes); };
            download.reject = reject;
        });
        download.arm = arm;
        fontDownloads.set(font.id, download);
        arm();
        send(MSG.SOUNDFONT_REQUEST, { id: font.id });
        return download.promise;
    }

    function receiveSoundFontPart(msg) {
        const download = fontDownloads.get(msg.id);
        if (!download) return;
        const total = Number(msg.parts) || 1;
        const part = Number(msg.part) || 0;
        if (!download.parts || download.parts.length !== total) download.parts = new Array(total).fill(null);
        if (part < 0 || part >= total) return;
        download.parts[part] = base64ToArrayBuffer(msg.b64 || '');
        download.arm();
        if (download.parts.some((p) => p === null)) return;
        const out = new Uint8Array(download.parts.reduce((n, p) => n + p.byteLength, 0));
        let at = 0;
        for (const p of download.parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
        download.resolve(out.buffer);
    }

    /** Play the host's SoundFonts instead of this device's own, downloading any we don't have yet. */
    function syncSoundFonts(desc) {
        if (!desc || !Array.isArray(desc.fonts)) return fontSync;
        const sig = JSON.stringify(desc);
        if (sig === appliedFontSig) return fontSync;
        const token = ++fontToken;
        fontSync = fontSync.catch(() => {}).then(async () => {
            try {
                const fonts = [];
                for (const f of desc.fonts) {
                    if (f.builtin) { fonts.push({ builtin: true }); continue; }
                    fonts.push({ name: f.name, data: await requestSoundFont(f) });
                    if (token !== fontToken) return;
                }
                if (token !== fontToken) return;
                setSessionSoundFonts({ fonts, strict: desc.strict, forced: desc.forced });
                appliedFontSig = sig;
                await reloadSynthSoundFonts();
            } catch (e) {
                console.error('[Jam] SoundFont sync failed:', e);
                ui.toast?.(`Could not load the host's SoundFonts: ${e.message}`, 'warning');
            }
        });
        return fontSync;
    }

    /** Hand this device's own SoundFonts and mixer back. */
    function releaseHostAudioSettings() {
        fontToken += 1;
        fontDownloads.forEach((d) => { clearTimeout(d.timer); d.reject(new Error('Left the jam')); });
        fontDownloads.clear();
        jamPlayerControl.setHostMixer(null);
        if (appliedFontSig) {
            appliedFontSig = null;
            setSessionSoundFonts(null);
            reloadSynthSoundFonts().catch((e) => console.error('[Jam] SoundFont restore failed:', e));
        }
    }

    // ---- Song loading ------------------------------------------------------

    function requestSongBytes(song) {
        if (songCache.has(song.id)) return Promise.resolve(songCache.get(song.id));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingDownload = null;
                reject(new Error('Song download timed out'));
            }, SONG_DOWNLOAD_TIMEOUT_MS);
            pendingDownload = { id: song.id, resolve, reject, timer, parts: null };
            send(MSG.SONG_REQUEST, { id: song.id });
        });
    }

    async function matchesCurrentFile(song) {
        const cur = getCurrentFile?.();
        if (!cur || cur.name !== song.fileName || cur.size !== song.size) return false;
        try {
            return (await jamSongId(await cur.arrayBuffer(), cur)) === song.id;
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
                    if (song.startPage) {
                        file.startPage = song.startPage;
                        file.endPage = song.endPage || song.startPage;
                    }
                    await loadFile(file);
                    loadedSongId = song.id;
                }
                if (isGpSong(song)) {
                    await fontSync.catch(() => {}); // report ready only once the host's SoundFonts are in
                    const ready = await waitForPlayerReady();
                    if (!ready) throw new Error('Audio engine did not become ready');
                    // Muted warm-up so the first synced start isn't late by the synth's cold start.
                    if (!jamPlayerControl.snapshot().playing) await jamPlayerControl.warmUp();
                }
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
        if (ok && following && pendingTransport && hostSong?.id === song.id && isGpSong(song)) {
            const pending = pendingTransport;
            pendingTransport = null;
            await applyTransportState(pending.transport, pending.hostTs);
        }
        emitStatus();
    }

    async function applySessionState(state, hostTs) {
        controllerId = state.controllerId ?? null;
        policy = state.policy || 'ask';
        applyMute(state.muteGuests);
        trackState = state;
        applyTracks();
        hostSong = state.song || null;
        jamPlayerControl.setHostMixer(state.mixer || {});
        syncSoundFonts(state.soundFonts);
        youtube.apply(state.youtube, hostTs);
        emitStatus();
        if (!hostSong) return;
        pendingTransport = { transport: state.transport, hostTs };
        await loadSongAndCatchUp(hostSong);
    }

    // ---- Drift correction --------------------------------------------------

    function handleHeartbeat(msg) {
        if (!following || !hostSongIsGp() || !songReady()) return;
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
        if (!active || !following || !hostSongIsGp()) return false;
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
        if (e.type === 'loop' && following && canControl() && hostSongIsGp()) {
            send(MSG.CMD_LOOP, { loop: { enabled: e.enabled, startMeasure: e.startMeasure, endMeasure: e.endMeasure } });
        }
    }

    function onFileLoaded(e) {
        const file = e.detail?.file;
        loadedSongId = file?.jamSongId || null;
        // Loading a file resets the YouTube player; put the host's video back.
        youtube.reconcile();
        emitStatus();
    }

    // ---- Incoming messages -------------------------------------------------

    function handleMessage(_from, msg) {
        if (Number.isFinite(msg.outLatencyMs)) hostOutLatency = msg.outLatencyMs;
        switch (msg.type) {
            case MSG.WELCOME:
                clientId = msg.clientId;
                hostName = msg.hostName || 'Host';
                applyTracks();
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
                else { hostSong = msg.state?.song || null; controllerId = msg.state?.controllerId ?? null; policy = msg.state?.policy || 'ask'; applyMute(msg.state?.muteGuests); emitStatus(); }
                break;
            case MSG.SONG_OPEN:
                hostSong = msg.song;
                if (following) jamPlayerControl.setHostMixer({});
                pendingTransport = null;
                lastDriftMs = null;
                lastRawDriftMs = null;
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
                    const total = Number(msg.parts) || 1;
                    if (!pendingDownload.parts || pendingDownload.parts.length !== total) pendingDownload.parts = new Array(total).fill(null);
                    const part = Number(msg.part) || 0;
                    if (part >= 0 && part < total) pendingDownload.parts[part] = msg.b64 || '';
                    if (pendingDownload.parts.some((p) => p === null)) break;
                    clearTimeout(pendingDownload.timer);
                    try {
                        const bytes = base64ToArrayBuffer(pendingDownload.parts.join(''));
                        songCache.set(msg.songId, { bytes, fileName: msg.fileName });
                        pendingDownload.resolve({ bytes, fileName: msg.fileName });
                    } catch (e) {
                        pendingDownload.reject(e);
                    }
                    pendingDownload = null;
                }
                break;
            case MSG.SOUNDFONT_DATA:
                try { receiveSoundFontPart(msg); } catch (e) { fontDownloads.get(msg.id)?.reject(e); }
                break;
            case MSG.SOUNDFONTS:
                if (following) syncSoundFonts(msg.soundFonts);
                break;
            case MSG.MIXER:
                if (following && (msg.songId ?? null) === (hostSong?.id ?? null)) jamPlayerControl.setHostMixer(msg.mixer || {});
                break;
            case MSG.YT_STATE:
                youtube.apply(msg.yt, msg.hostTs);
                break;
            case MSG.PLAY:
                if (!following || !hostSongIsGp()) break;
                hostSpeed = msg.speed ?? hostSpeed;
                if (!songReady()) { pendingTransport = { transport: { playing: true, timeMs: msg.timeMs, speed: hostSpeed, loop: null, _startAt: msg.startAtHostTs }, hostTs: msg.hostTs }; break; }
                if (Number.isFinite(msg.speed) && msg.speed !== jamPlayerControl.snapshot().speed) setHostSpeed(msg.speed);
                schedulePlay(msg.timeMs, msg.startAtHostTs);
                break;
            case MSG.PAUSE:
                if (!following || !hostSongIsGp()) break;
                pendingTransport = null;
                if (songReady()) applyPause(msg.timeMs);
                break;
            case MSG.SEEK:
                if (!following || !hostSongIsGp() || !songReady()) break;
                cancelScheduledPlay();
                remote(() => jamPlayerControl.seekMs(msg.timeMs));
                break;
            case MSG.SPEED:
                if (following && hostSongIsGp() && songReady()) setHostSpeed(msg.speed);
                break;
            case MSG.LOOP:
                if (following && hostSongIsGp() && songReady()) applyLoop(msg.loop);
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
            case MSG.TRACK_ASSIGN:
                trackState = msg;
                if (following) applyTracks();
                break;
            case MSG.IDENTIFY:
                runIdentify();
                break;
            case MSG.GUEST_MUTE:
                applyMute(msg.muteGuests);
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
            jamPlayerControl.setTrackPolicy({});
            releaseHostAudioSettings();
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
            youtube.start();
        },
        stop() {
            active = false;
            applyMute(false);
            releaseHostAudioSettings();
            fontCache.clear();
            trackState = null;
            applyTracks();
            youtube.stop();
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
            const parts = chunkBase64(await arrayBufferToBase64Async(await file.arrayBuffer()));
            for (let part = 0; part < parts.length; part++) {
                await send(MSG.CMD_SONG_OPEN, { fileName: file.name, part, parts: parts.length, b64: parts[part] });
            }
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
