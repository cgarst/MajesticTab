// jamHostAdapter.js
// Host side of Jam Mode: observes the local player and file loads, and broadcasts the
// authoritative session state. Also validates and applies client control commands.
// Any song type is shared (GP, PDF, text); synth transport sync applies to GP songs only,
// YouTube sync (jamYouTubeSync.js) to all of them.

import { MSG, makeMessage, songTypeForName, isGpSong, chunkBase64, JAM_MAX_UPLOAD_BYTES, JAM_SONG_EXTENSIONS } from './jamProtocol.js';
import { nowMs, jam } from './jamTransport.js';
import { computeLeadMs } from './jamClock.js';
import { jamSongId, songTitleFromName, startLag, measureStartLag, waitForPlayerReady, estimateOutputLatencyMs, trackPolicyFor } from './jamCommon.js';
import { normAudioMode, normListening } from './jamTrackPolicy.js';
import { resolveNames, cleanAlias } from './jamRoster.js';
import { createYouTubeHost } from './jamYouTubeSync.js';
import { jamPlayerControl, onTransportEvent, setTransportInterceptor, getMixerSnapshot, onMixerChange } from '../gpProcessor/gpPlayer.js';
import { describeActiveSoundFonts, getSoundFontData, onSoundFontSelectionChange } from '../soundFontStore.js';
import { arrayBufferToBase64Async, base64ToArrayBuffer } from '../fileStore.js';

const HEARTBEAT_MS = 500;
const JUMP_THRESHOLD_MS = 400;
const HOST_PRIORITY_WINDOW_MS = 200;
const CONTROLLER_GRACE_MS = 5000;
const MIXER_BROADCAST_MS = 150;
const SOUNDFONT_BROADCAST_MS = 700;
// Raw bytes per SoundFont part: a multiple of 3 so each part's base64 is exactly JAM_CHUNK_B64_CHARS.
const SOUNDFONT_PART_BYTES = 384 * 1024;


export function createHostAdapter({ loadFile, ui, getSettings }) {
    const roster = new Map(); // id -> { id, name, ready, rttMs, driftMs, status }
    const aliases = new Map(); // peer id -> name the host gave them
    const departedAliases = new Map(); // client's own name -> alias, so a reconnecting device keeps it
    const session = {
        song: null,
        songBytes: null,
        playing: false,
        controllerId: null, // null = host
        policy: 'ask',
        muteGuests: false,
        trackAssignments: {}, // peer id or 'host' -> track indices
        assignedAudioMode: 'all', // 'all' | 'assigned' (own tracks only) | 'backing' (everything but own tracks)
        assignedViewOnly: false,
        listeners: [], // people the host marked Listening (no tracks, on purpose); everyone else without tracks is unrestricted
        listeningHears: 'all', // 'all' | 'backing' (not the tracks assigned to others)
    };
    let unsubscribe = null;
    let unsubscribeMixer = null;
    let unsubscribeSoundFonts = null;
    let mixerTimer = null;
    let soundFontTimer = null;
    let soundFonts = null; // { fonts, strict } this host plays, as last described
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
    const uploads = new Map(); // client id -> { fileName, parts: [] } (controller song upload in progress)
    let active = false;

    const namedRoster = () => resolveNames(Array.from(roster.values()), aliases);
    const emitRoster = () => ui.onRosterChange?.(namedRoster(), session);
    // The host's own position runs ahead of what its speaker plays by its output latency;
    // every message carries it so clients align with what the host actually sounds like.
    const hostOutputLatency = () => Math.round((estimateOutputLatencyMs() + (getSettings().trimMs || 0)) * 10) / 10;
    const stamp = (payload) => ({ hostTs: nowMs(), outLatencyMs: hostOutputLatency(), ...payload });
    const broadcast = (type, payload = {}) => jam.hostSend(makeMessage(type, stamp(payload))).catch(() => {});
    const sendTo = (id, type, payload = {}) => jam.hostSend(makeMessage(type, stamp(payload)), id).catch(() => {});
    const youtube = createYouTubeHost({ broadcast });

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
        youtube: youtube.state(),
        controllerId: session.controllerId,
        policy: session.policy,
        muteGuests: session.muteGuests,
        mixer: getMixerSnapshot(),
        soundFonts,
        ...trackState()
    });

    // ---- Mixer and SoundFonts ----------------------------------------------

    const broadcastMixer = () => broadcast(MSG.MIXER, { songId: session.song?.id ?? null, mixer: getMixerSnapshot() });

    function scheduleMixerBroadcast() {
        clearTimeout(mixerTimer);
        mixerTimer = setTimeout(() => { if (active) broadcastMixer(); }, MIXER_BROADCAST_MS);
    }

    async function refreshSoundFonts() {
        try {
            const next = await describeActiveSoundFonts();
            if (!active) return;
            if (JSON.stringify(next) === JSON.stringify(soundFonts)) return;
            soundFonts = next;
            broadcast(MSG.SOUNDFONTS, { soundFonts });
        } catch (e) {
            console.error('[Jam] SoundFont description failed:', e);
        }
    }

    function scheduleSoundFontBroadcast() {
        clearTimeout(soundFontTimer);
        soundFontTimer = setTimeout(refreshSoundFonts, SOUNDFONT_BROADCAST_MS);
    }

    /** Stream one enabled SoundFont to a client in protocol-sized parts, encoding a slice at a time. */
    async function sendSoundFont(clientId, requestedId) {
        const font = soundFonts?.fonts.find((f) => f.id === requestedId && !f.builtin);
        if (!font) return;
        const data = await getSoundFontData(font.id);
        if (!data) return;
        const parts = Math.max(1, Math.ceil(data.byteLength / SOUNDFONT_PART_BYTES));
        for (let part = 0; part < parts; part++) {
            if (!active || !roster.has(clientId)) return;
            const slice = data.slice(part * SOUNDFONT_PART_BYTES, (part + 1) * SOUNDFONT_PART_BYTES);
            await sendTo(clientId, MSG.SOUNDFONT_DATA, { id: font.id, size: font.size, part, parts, b64: await arrayBufferToBase64Async(slice) });
        }
    }

    // ---- Track assignments -------------------------------------------------

    const trackState = () => ({
        trackAssignments: session.trackAssignments,
        assignedAudioMode: session.assignedAudioMode,
        assignedViewOnly: session.assignedViewOnly,
        listeners: session.listeners,
        listeningHears: session.listeningHears,
    });

    const applyOwnTracks = () => jamPlayerControl.setTrackPolicy(trackPolicyFor(session, 'host'));

    function updateTracks(patch) {
        if (patch.trackAssignments) session.trackAssignments = patch.trackAssignments;
        if (patch.assignedAudioMode !== undefined) session.assignedAudioMode = normAudioMode(patch.assignedAudioMode);
        if (patch.assignedViewOnly !== undefined) session.assignedViewOnly = Boolean(patch.assignedViewOnly);
        if (patch.listeningHears !== undefined) session.listeningHears = normListening(patch.listeningHears);
        applyOwnTracks();
        broadcast(MSG.TRACK_ASSIGN, trackState());
        emitRoster();
    }

    function setTrackAssignment(key, indices) {
        const next = { ...session.trackAssignments };
        if (indices.length) next[key] = indices; else delete next[key];
        // Taking a track makes someone a player; clearing the last one leaves them Not set.
        session.listeners = session.listeners.filter((k) => k !== key);
        updateTracks({ trackAssignments: next });
    }

    /** Marks a person Listening (clearing their tracks), or back to Not set. */
    function setListening(key, on) {
        const next = { ...session.trackAssignments };
        delete next[key];
        session.listeners = session.listeners.filter((k) => k !== key);
        if (on) session.listeners.push(key);
        updateTracks({ trackAssignments: next });
    }

    function clearTrackAssignments() {
        session.trackAssignments = {};
        applyOwnTracks();
        broadcast(MSG.TRACK_ASSIGN, trackState());
    }

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
        if (!active || !isGpSong(session.song)) return false;
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
        if (!active || !isGpSong(session.song)) return;
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
        if (!active || !isGpSong(session.song) || !session.playing || startingLocal) return;
        const snap = jamPlayerControl.snapshot();
        if (!snap.playing) return;
        broadcast(MSG.HEARTBEAT, { timeMs: snap.timeMs, playing: true, speed: snap.speed });
    }

    // ---- Song publishing ---------------------------------------------------

    // `converted` is the file after the host's extensions ran, which is what followers receive.
    async function publishFile(file, converted = file) {
        if (!active || !file) return;
        if (file.jamTransient) return; // came from the host's own jam download (never the case on a host)
        const type = songTypeForName(file.name);
        if (!type) {
            session.song = null;
            session.songBytes = null;
            session.playing = false;
            clearTrackAssignments();
            broadcast(MSG.SONG_CLOSE);
            roster.forEach((p) => { p.ready = false; });
            emitRoster();
            return;
        }
        try {
            const bytes = await converted.arrayBuffer();
            const id = await jamSongId(bytes, file);
            session.songBytes = bytes;
            session.song = {
                id,
                title: file.songTitle || file.librarySongTitle || songTitleFromName(file.name),
                fileName: file.name,
                size: bytes.byteLength,
                type,
                // A PDF library tab is a page range of a larger file.
                startPage: file.startPage || null,
                endPage: file.endPage || null
            };
            session.playing = false;
            clearTrackAssignments();
            roster.forEach((p) => { p.ready = false; });
            emitRoster();
            broadcast(MSG.SONG_OPEN, { song: session.song });
            broadcastMixer();
            if (type !== 'gp') return;
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
        const song = session.song;
        if (!song || !session.songBytes || requested.id !== song.id) return;
        const parts = chunkBase64(await arrayBufferToBase64Async(session.songBytes));
        for (let part = 0; part < parts.length; part++) {
            if (session.song !== song || !roster.has(id)) return;
            await sendTo(id, MSG.SONG_DATA, { songId: song.id, fileName: song.fileName, part, parts: parts.length, b64: parts[part] });
        }
    }

    /** Collect a controller's song upload; returns the full base64 once every part is in. */
    function collectUpload(id, msg) {
        const parts = Number(msg.parts) || 1;
        const part = Number(msg.part) || 0;
        if (parts === 1) return msg.b64 || '';
        let upload = uploads.get(id);
        if (!upload || upload.fileName !== msg.fileName || upload.parts.length !== parts) {
            upload = { fileName: msg.fileName, parts: new Array(parts).fill(null) };
            uploads.set(id, upload);
        }
        if (part < 0 || part >= parts) return null;
        upload.parts[part] = msg.b64 || '';
        if (upload.parts.reduce((n, p) => n + (p ? p.length : 0), 0) > JAM_MAX_UPLOAD_BYTES * 4 / 3 + 4) {
            uploads.delete(id);
            return '';
        }
        if (upload.parts.some((p) => p === null)) return null;
        uploads.delete(id);
        return upload.parts.join('');
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

    function setMuteGuests(on) {
        session.muteGuests = Boolean(on);
        broadcast(MSG.GUEST_MUTE, { muteGuests: session.muteGuests });
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
            pendingRequests.set(id, { id, name: namedRoster().find((p) => p.id === id)?.name || peer.name, reason: msg.reason || '' });
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
            if (!songTypeForName(name)) {
                sendTo(id, MSG.CONTROL_DENY, { reason: `Only ${JAM_SONG_EXTENSIONS.join(', ')} files can be shared.` });
                return;
            }
            const b64 = collectUpload(id, msg);
            if (b64 === null) return; // more parts to come
            let bytes = null;
            try { bytes = base64ToArrayBuffer(b64); } catch (_) { bytes = null; }
            if (!bytes || bytes.byteLength === 0 || bytes.byteLength > JAM_MAX_UPLOAD_BYTES) {
                sendTo(id, MSG.CONTROL_DENY, { reason: 'That file is too large to share.' });
                return;
            }
            const file = new File([bytes], name, { type: 'application/octet-stream' });
            await loadFile(file);
            return;
        }
        if (!canCommand(id)) return;
        if (msg.type === MSG.CMD_YT) {
            youtube.handleCommand(msg);
            return;
        }
        if (!isGpSong(session.song)) return;
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
            case MSG.SOUNDFONT_REQUEST: sendSoundFont(from, msg.id); break;
            case MSG.SONG_READY:
                if (peer && session.song && msg.songId === session.song.id) { peer.ready = true; emitRoster(); }
                break;
            case MSG.STATUS:
                if (peer) {
                    peer.rttMs = msg.rttMs ?? peer.rttMs;
                    peer.driftMs = msg.driftMs ?? peer.driftMs;
                    peer.ytDriftMs = msg.ytDriftMs ?? null;
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
            if (departedAliases.has(info.name)) {
                aliases.set(info.id, departedAliases.get(info.name));
                departedAliases.delete(info.name);
                sendTo(info.id, MSG.RENAME, { name: aliases.get(info.id) });
            }
            session.listeners.push(info.id); // new people listen until the host gives them tracks
            sendTo(info.id, MSG.STATE, { state: sessionState() });
            if (session.listeners.includes(info.id)) broadcast(MSG.TRACK_ASSIGN, trackState());
        } else if (info.event === 'left') {
            const left = roster.get(info.id);
            if (left && aliases.has(info.id)) departedAliases.set(left.name, aliases.get(info.id));
            aliases.delete(info.id);
            roster.delete(info.id);
            if (session.trackAssignments[info.id] || session.listeners.includes(info.id)) setTrackAssignment(info.id, []);
            uploads.delete(info.id);
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
        publishFile(e.detail?.file, e.detail?.converted);
    }

    return {
        start(initialFile) {
            active = true;
            session.policy = getSettings().policy || 'ask';
            session.muteGuests = Boolean(getSettings().muteGuests);
            session.assignedAudioMode = normAudioMode(getSettings().assignedAudioMode);
            session.assignedViewOnly = Boolean(getSettings().assignedViewOnly);
            session.listeningHears = normListening(getSettings().listeningHears);
            session.listeners = [];
            unsubscribe = onTransportEvent(onPlayerEvent);
            unsubscribeMixer = onMixerChange(scheduleMixerBroadcast);
            unsubscribeSoundFonts = onSoundFontSelectionChange(scheduleSoundFontBroadcast);
            refreshSoundFonts();
            setTransportInterceptor(interceptor);
            window.addEventListener('majestictab:file-loaded', onFileLoaded);
            heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
            youtube.start();
            if (initialFile) publishFile(initialFile);
        },
        stop() {
            active = false;
            unsubscribe?.();
            unsubscribe = null;
            unsubscribeMixer?.();
            unsubscribeSoundFonts?.();
            unsubscribeMixer = unsubscribeSoundFonts = null;
            clearTimeout(mixerTimer);
            clearTimeout(soundFontTimer);
            soundFonts = null;
            setTransportInterceptor(null);
            window.removeEventListener('majestictab:file-loaded', onFileLoaded);
            clearInterval(heartbeatTimer);
            clearTimeout(startTimer);
            clearTimeout(lagTimer);
            clearTimeout(controllerGraceTimer);
            clearTimeout(seekDebounce);
            youtube.stop();
            setStartingUI(false);
            roster.clear();
            uploads.clear();
            pendingRequests.clear();
            session.song = null;
            session.songBytes = null;
            session.playing = false;
            session.controllerId = null;
            session.trackAssignments = {};
            session.listeners = [];
            aliases.clear();
            departedAliases.clear();
            applyOwnTracks();
            ui.onRequestsChanged?.([]);
        },
        handleMessage,
        handlePeers,
        resolveRequest,
        grantControl,
        revokeControl,
        setPolicy,
        setMuteGuests,
        setTrackAssignment,
        setListening,
        updateTracks,
        // Tell the client first so it leaves for good; a bare close looks like a dropped connection and it would reconnect.
        async kick(id) {
            await sendTo(id, MSG.KICKED);
            await jam.hostKick(id);
        },
        getRoster: namedRoster,
        /** Names a peer on the host only; an empty name goes back to what the client sent. */
        renamePeer(id, name) {
            if (!roster.has(id)) return;
            const alias = cleanAlias(name);
            if (alias) {
                aliases.set(id, alias);
                sendTo(id, MSG.RENAME, { name: alias });
            } else {
                aliases.delete(id);
            }
            emitRoster();
        },
        identify: (id) => sendTo(id, MSG.IDENTIFY),
        getSession: () => session,
        getPendingRequests: () => Array.from(pendingRequests.values())
    };
}
