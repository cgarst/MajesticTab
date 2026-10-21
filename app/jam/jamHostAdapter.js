// jamHostAdapter.js
// Host side of Jam Mode: observes the local player and file loads, and broadcasts the
// authoritative session state. Also validates and applies client control commands.

import { MSG, makeMessage, isGpFileName, JAM_MAX_UPLOAD_BYTES, JAM_GP_EXTENSIONS } from './jamProtocol.js';
import { nowMs, jam } from './jamTransport.js';
import { computeLeadMs } from './jamClock.js';
import { sha256Hex, songTitleFromName, startLag, measureStartLag, waitForPlayerReady, estimateOutputLatencyMs } from './jamCommon.js';
import { jamPlayerControl, onTransportEvent, setTransportInterceptor } from '../gpProcessor/gpPlayer.js';
import { arrayBufferToBase64Async, base64ToArrayBuffer } from '../fileStore.js';

const HEARTBEAT_MS = 500;
const JUMP_THRESHOLD_MS = 400;
const HOST_PRIORITY_WINDOW_MS = 200;
const CONTROLLER_GRACE_MS = 5000;

export function createHostAdapter({ loadFile, ui, getSettings }) {
    const roster = new Map(); // id -> { id, name, ready, rttMs, driftMs, status }
    const session = {
        song: null,
        songBytes: null,
        playing: false,
        controllerId: null, // null = host
        policy: 'ask'
    };
    let unsubscribe = null;
    let heartbeatTimer = null;
    let startTimer = null;
    let startingLocal = false;
    let startToken = 0;
    let lagTimer = null;
    let lastPos = { timeMs: 0, at: 0, playing: false };
    let suppressJumpUntil = 0;
    let lastHostActionAt = 0;
    let seekDebounce = null;
    let controllerGraceTimer = null;
    let pendingRequests = new Map(); // id -> { id, name, reason }
    let active = false;

    const emitRoster = () => ui.onRosterChange?.(Array.from(roster.values()), session);
    // The host's own position runs ahead of what its speaker plays by its output latency;
    // every message carries it so clients align with what the host actually sounds like.
    const hostOutputLatency = () => Math.round((estimateOutputLatencyMs() + (getSettings().trimMs || 0)) * 10) / 10;
    const stamp = (payload) => ({ hostTs: nowMs(), outLatencyMs: hostOutputLatency(), ...payload });
    const broadcast = (type, payload = {}) => jam.hostSend(makeMessage(type, stamp(payload))).catch(() => {});
    const sendTo = (id, type, payload = {}) => jam.hostSend(makeMessage(type, stamp(payload)), id).catch(() => {});

    const currentLead = () => computeLeadMs(
        Array.from(roster.values()).map((p) => p.rttMs || 0),
        { override: getSettings().leadOverrideMs || 0 }
    );

    const transportSnapshot = () => {
        const snap = jamPlayerControl.snapshot();
        return {
            playing: snap.playing,
            timeMs: snap.timeMs,
            speed: snap.speed,
            loop: snap.loop
        };
    };

    const sessionState = () => ({
        song: session.song,
        transport: transportSnapshot(),
        controllerId: session.controllerId,
        policy: session.policy
    });

    // ---- Play / seek -------------------------------------------------------

    function setStartingUI(on) {
        document.body.classList.toggle('jam-starting', on);
        ui.onStarting?.(on);
    }

    function allReady() {
        return Array.from(roster.values()).every((p) => p.ready || !session.song);
    }

    /** Scheduled play: the host delays its own start by the same lead as every client. */
    function startPlayback(timeMs) {
        if (!jamPlayerControl.hasPlayer()) return;
        if (getSettings().waitForEveryone && !allReady()) {
            ui.toast?.('Waiting for everyone to finish loading the song.', 'warning');
            return;
        }
        clearTimeout(startTimer);
        clearTimeout(lagTimer);
        const lead = currentLead();
        const startAt = nowMs() + lead;
        const pos = timeMs ?? jamPlayerControl.snapshot().timeMs;
        const token = ++startToken;
        // Call play() early by this device's learned start latency so audio is actually
        // running at `startAt`, the same instant every client targets.
        const lag = Math.min(startLag.get(), lead);
        suppressJumpUntil = nowMs() + lead + 500;
        jamPlayerControl.seekMs(pos);
        session.playing = true;
        startingLocal = true;
        setStartingUI(true);
        broadcast(MSG.PLAY, { timeMs: pos, startAtHostTs: startAt, speed: jamPlayerControl.snapshot().speed });
        startTimer = setTimeout(() => {
            startTimer = null;
            // AlphaTab can drop a seek issued right after pause(), so seek again at start time.
            jamPlayerControl.seekMs(pos);
            jamPlayerControl.play();
            setTimeout(() => { startingLocal = false; setStartingUI(false); }, 150 + lag);
            lagTimer = measureStartLag({
                timeMs: pos,
                targetLocalMs: startAt,
                usedLagMs: lag,
                speed: jamPlayerControl.snapshot().speed,
                isStillValid: () => token === startToken && session.playing
            });
        }, lead - lag);
    }

    function pausePlayback() {
        clearTimeout(startTimer);
        clearTimeout(lagTimer);
        startTimer = null;
        startingLocal = false;
        setStartingUI(false);
        session.playing = false;
        if (jamPlayerControl.snapshot().playing) jamPlayerControl.pause();
        const timeMs = jamPlayerControl.snapshot().timeMs;
        suppressJumpUntil = nowMs() + 300;
        broadcast(MSG.PAUSE, { timeMs });
    }

    function seekTo(timeMs) {
        if (session.playing || jamPlayerControl.snapshot().playing) {
            // Seek while playing = pause + seek + scheduled play with the normal lead.
            clearTimeout(startTimer);
            if (jamPlayerControl.snapshot().playing) jamPlayerControl.pause();
            startPlayback(timeMs);
        } else {
            suppressJumpUntil = nowMs() + 300;
            jamPlayerControl.seekMs(timeMs);
            broadcast(MSG.SEEK, { timeMs });
        }
    }

    /** Host-side local transport is routed through here so clients stay in step. */
    function interceptor(action, payload) {
        if (!active || !session.song) return false;
        lastHostActionAt = nowMs();
        if (action === 'playPause') {
            if (payload.playing || session.playing) pausePlayback();
            else startPlayback();
            return true;
        }
        if (action === 'seekMs') {
            seekTo(payload.timeMs);
            return true;
        }
        return false;
    }

    // ---- Player event handling --------------------------------------------

    function onPlayerEvent(e) {
        if (!active || !session.song) return;
        if (e.type === 'state') {
            if (e.playing && !session.playing && !startingLocal) {
                // Started by something other than the intercepted button (e.g. gamepad): resync as a scheduled play.
                const lead = currentLead();
                const speed = jamPlayerControl.snapshot().speed;
                broadcast(MSG.PLAY, {
                    timeMs: e.timeMs + lead * speed,
                    startAtHostTs: nowMs() + lead,
                    speed
                });
                session.playing = true;
            } else if (!e.playing && session.playing && !startingLocal) {
                session.playing = false;
                broadcast(MSG.PAUSE, { timeMs: e.timeMs });
            }
            return;
        }
        if (e.type === 'speed') {
            broadcast(MSG.SPEED, { speed: e.speed });
            return;
        }
        if (e.type === 'loop') {
            broadcast(MSG.LOOP, { loop: { enabled: e.enabled, startMeasure: e.startMeasure, endMeasure: e.endMeasure } });
            return;
        }
        if (e.type === 'position') {
            const t = nowMs();
            const prev = lastPos;
            lastPos = { timeMs: e.timeMs, at: t, playing: e.playing };
            if (t < suppressJumpUntil || startingLocal) return;
            if (e.playing && prev.playing) {
                const expected = prev.timeMs + (t - prev.at) * jamPlayerControl.snapshot().speed;
                if (Math.abs(e.timeMs - expected) > JUMP_THRESHOLD_MS) {
                    // Jump while playing (beat click, loop wrap, scrubber): resync everyone to a future point.
                    const lead = currentLead();
                    const speed = jamPlayerControl.snapshot().speed;
                    broadcast(MSG.PLAY, {
                        timeMs: e.timeMs + lead * speed,
                        startAtHostTs: t + lead,
                        speed
                    });
                }
            } else if (!e.playing && !prev.playing && Math.abs(e.timeMs - prev.timeMs) > 1) {
                clearTimeout(seekDebounce);
                seekDebounce = setTimeout(() => {
                    broadcast(MSG.SEEK, { timeMs: jamPlayerControl.snapshot().timeMs });
                }, 80);
            }
        }
    }

    function sendHeartbeat() {
        if (!active || !session.playing || startingLocal) return;
        const snap = jamPlayerControl.snapshot();
        if (!snap.playing) return;
        broadcast(MSG.HEARTBEAT, { timeMs: snap.timeMs, playing: true, speed: snap.speed });
    }

    // ---- Song publishing ---------------------------------------------------

    async function publishFile(file) {
        if (!active || !file) return;
        if (file.jamTransient) return; // came from the host's own jam download (never the case on a host)
        if (!isGpFileName(file.name)) {
            session.song = null;
            session.songBytes = null;
            session.playing = false;
            broadcast(MSG.SONG_CLOSE);
            roster.forEach((p) => { p.ready = false; });
            emitRoster();
            return;
        }
        try {
            const bytes = await file.arrayBuffer();
            const id = await sha256Hex(bytes);
            session.songBytes = bytes;
            session.song = {
                id,
                title: file.songTitle || file.librarySongTitle || songTitleFromName(file.name),
                fileName: file.name,
                size: bytes.byteLength,
                type: 'gp'
            };
            session.playing = false;
            roster.forEach((p) => { p.ready = false; });
            emitRoster();
            broadcast(MSG.SONG_OPEN, { song: session.song });
            // Warm the synth while everyone else downloads, so the first start is on time.
            const songId = id;
            waitForPlayerReady().then((ready) => {
                if (ready && active && session.song?.id === songId && !session.playing) jamPlayerControl.warmUp();
            });
        } catch (e) {
            console.error('[Jam] publish failed:', e);
        }
    }

    async function sendSongData(id, requested) {
        if (!session.song || !session.songBytes || requested.id !== session.song.id) return;
        const b64 = await arrayBufferToBase64Async(session.songBytes);
        sendTo(id, MSG.SONG_DATA, { songId: session.song.id, fileName: session.song.fileName, b64 });
    }

    // ---- Control requests --------------------------------------------------

    function grantControl(id) {
        session.controllerId = id;
        clearTimeout(controllerGraceTimer);
        pendingRequests.delete(id);
        broadcast(MSG.CONTROL_GRANT, { controllerId: id });
        ui.onRequestsChanged?.(Array.from(pendingRequests.values()));
        emitRoster();
    }

    function revokeControl() {
        session.controllerId = null;
        clearTimeout(controllerGraceTimer);
        broadcast(MSG.CONTROL_REVOKE, { controllerId: null });
        emitRoster();
    }

    function setPolicy(policy) {
        session.policy = policy;
        if (policy === 'host' && session.controllerId) revokeControl();
        broadcast(MSG.CONTROL_POLICY, { policy });
        emitRoster();
    }

    function handleControlRequest(id, msg) {
        const peer = roster.get(id);
        if (!peer) return;
        if (session.policy === 'host') {
            sendTo(id, MSG.CONTROL_DENY, { reason: 'The host has not enabled client control.' });
        } else if (session.policy === 'anyone') {
            grantControl(id);
        } else {
            pendingRequests.set(id, { id, name: peer.name, reason: msg.reason || '' });
            ui.onRequestsChanged?.(Array.from(pendingRequests.values()));
        }
    }

    function resolveRequest(id, allow) {
        if (!pendingRequests.has(id)) return;
        if (allow) {
            grantControl(id);
        } else {
            pendingRequests.delete(id);
            sendTo(id, MSG.CONTROL_DENY, { reason: 'The host denied your request.' });
            ui.onRequestsChanged?.(Array.from(pendingRequests.values()));
        }
    }

    function canCommand(id) {
        if (!roster.has(id)) return false;
        if (nowMs() - lastHostActionAt < HOST_PRIORITY_WINDOW_MS) return false; // host wins races
        return session.policy === 'anyone' || session.controllerId === id;
    }

    async function handleCommand(id, msg) {
        if (msg.type === MSG.CMD_SONG_OPEN) {
            if (!canCommand(id)) return;
            const name = String(msg.fileName || '');
            if (!isGpFileName(name)) {
                sendTo(id, MSG.CONTROL_DENY, { reason: `Only ${JAM_GP_EXTENSIONS.join(', ')} files can be shared.` });
                return;
            }
            let bytes = null;
            try { bytes = base64ToArrayBuffer(msg.b64 || ''); } catch (_) { bytes = null; }
            if (!bytes || bytes.byteLength === 0 || bytes.byteLength > JAM_MAX_UPLOAD_BYTES) {
                sendTo(id, MSG.CONTROL_DENY, { reason: 'That file is too large to share.' });
                return;
            }
            const file = new File([bytes], name, { type: 'application/octet-stream' });
            await loadFile(file);
            return;
        }
        if (!canCommand(id)) return;
        switch (msg.type) {
            case MSG.CMD_PLAY:
                if (!session.playing) startPlayback(Number.isFinite(msg.timeMs) ? msg.timeMs : undefined);
                break;
            case MSG.CMD_PAUSE:
                pausePlayback();
                break;
            case MSG.CMD_SEEK:
                if (Number.isFinite(msg.timeMs)) seekTo(msg.timeMs);
                // Beat clicks arrive as MIDI ticks; the position-jump detector broadcasts the result.
                else if (Number.isFinite(msg.tick)) jamPlayerControl.seekTick(msg.tick);
                break;
            case MSG.CMD_SPEED:
                if (Number.isFinite(msg.speed)) jamPlayerControl.setSpeed(Math.min(2, Math.max(0.1, msg.speed)));
                break;
            case MSG.CMD_LOOP:
                if (msg.loop) jamPlayerControl.setLoop(msg.loop);
                break;
            default:
        }
    }

    // ---- Incoming events ---------------------------------------------------

    function handleMessage(from, msg) {
        const peer = roster.get(from);
        switch (msg.type) {
            case MSG.SONG_REQUEST: sendSongData(from, msg); break;
            case MSG.SONG_READY:
                if (peer && session.song && msg.songId === session.song.id) { peer.ready = true; emitRoster(); }
                break;
            case MSG.STATUS:
                if (peer) {
                    peer.rttMs = msg.rttMs ?? peer.rttMs;
                    peer.driftMs = msg.driftMs ?? peer.driftMs;
                    peer.status = msg.state || peer.status;
                    emitRoster();
                }
                break;
            case MSG.STATE_REQUEST: sendTo(from, MSG.STATE, { state: sessionState() }); break;
            case MSG.CONTROL_REQUEST: handleControlRequest(from, msg); break;
            case MSG.CONTROL_RELEASE:
                if (session.controllerId === from) revokeControl();
                break;
            default:
                if (msg.type.startsWith('cmd.')) handleCommand(from, msg);
        }
    }

    function handlePeers(info) {
        if (info.event === 'joined') {
            roster.set(info.id, { id: info.id, name: info.name, ready: !session.song, rttMs: 0, driftMs: null, status: 'joined' });
            sendTo(info.id, MSG.STATE, { state: sessionState() });
        } else if (info.event === 'left') {
            roster.delete(info.id);
            pendingRequests.delete(info.id);
            ui.onRequestsChanged?.(Array.from(pendingRequests.values()));
            if (session.controllerId === info.id) {
                clearTimeout(controllerGraceTimer);
                controllerGraceTimer = setTimeout(() => {
                    if (!roster.has(session.controllerId)) revokeControl();
                }, CONTROLLER_GRACE_MS);
            }
        }
        emitRoster();
    }

    function onFileLoaded(e) {
        publishFile(e.detail?.file);
    }

    return {
        start(initialFile) {
            active = true;
            session.policy = getSettings().policy || 'ask';
            unsubscribe = onTransportEvent(onPlayerEvent);
            setTransportInterceptor(interceptor);
            window.addEventListener('majestictab:file-loaded', onFileLoaded);
            heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
            if (initialFile) publishFile(initialFile);
        },
        stop() {
            active = false;
            unsubscribe?.();
            unsubscribe = null;
            setTransportInterceptor(null);
            window.removeEventListener('majestictab:file-loaded', onFileLoaded);
            clearInterval(heartbeatTimer);
            clearTimeout(startTimer);
            clearTimeout(lagTimer);
            clearTimeout(controllerGraceTimer);
            clearTimeout(seekDebounce);
            setStartingUI(false);
            roster.clear();
            pendingRequests.clear();
            session.song = null;
            session.songBytes = null;
            session.playing = false;
            session.controllerId = null;
            ui.onRequestsChanged?.([]);
        },
        handleMessage,
        handlePeers,
        resolveRequest,
        grantControl,
        revokeControl,
        setPolicy,
        kick: (id) => jam.hostKick(id),
        getRoster: () => Array.from(roster.values()),
        getSession: () => session,
        getPendingRequests: () => Array.from(pendingRequests.values())
    };
}
