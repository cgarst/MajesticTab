// jamProtocol.js
// Message schemas and constants for Jam Mode (host / client playback sync).
// Every message is JSON: { v, type, seq, ...payload }. Host messages may carry `hostTs`
// (host monotonic ms at send). Positions are always MIDI-timeline times (`timeMs`), never
// pixels, pages or notation-timeline ticks, because those depend on each client's layout.
// YouTube positions are video seconds (`timeSec`).

export const JAM_PROTOCOL_VERSION = 1;
export const JAM_MAX_CLIENTS = 8;
export const JAM_GP_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx'];
export const JAM_SONG_EXTENSIONS = [...JAM_GP_EXTENSIONS, 'pdf', 'txt'];
export const JAM_MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
// Song files travel as base64 in parts, so a large PDF neither exceeds the WebSocket frame
// limit nor holds up clock-sync pings behind one huge frame. Multiple of 4: parts decode alone.
export const JAM_CHUNK_B64_CHARS = 512 * 1024;

export const CONTROL_POLICIES = ['host', 'ask', 'anyone'];

export const MSG = Object.freeze({
    // handshake (Rust handles hello / welcome / reject)
    WELCOME: 'welcome',
    REJECT: 'reject',
    STATE: 'session.state',
    STATE_REQUEST: 'session.state.request',
    // song
    SONG_OPEN: 'song.open',
    SONG_CLOSE: 'song.close',
    SONG_REQUEST: 'song.request',
    SONG_DATA: 'song.data',
    SONG_READY: 'song.ready',
    // YouTube (host -> clients), any song type
    YT_STATE: 'yt.state',
    // transport (host -> clients)
    SEEK: 'transport.seek',
    PLAY: 'transport.play',
    PAUSE: 'transport.pause',
    SPEED: 'transport.speed',
    LOOP: 'transport.loop',
    HEARTBEAT: 'transport.heartbeat',
    // clock sync (answered in Rust)
    PING: 'ping',
    PONG: 'pong',
    STATUS: 'status',
    // control requests
    CONTROL_REQUEST: 'control.request',
    CONTROL_GRANT: 'control.grant',
    CONTROL_DENY: 'control.deny',
    CONTROL_REVOKE: 'control.revoke',
    CONTROL_RELEASE: 'control.release',
    CONTROL_POLICY: 'control.policy',
    GUEST_MUTE: 'guest.mute',
    // client commands (controller -> host)
    CMD_SONG_OPEN: 'cmd.song.open',
    CMD_PLAY: 'cmd.transport.play',
    CMD_PAUSE: 'cmd.transport.pause',
    CMD_SEEK: 'cmd.transport.seek',
    CMD_SPEED: 'cmd.transport.speed',
    CMD_LOOP: 'cmd.transport.loop',
    CMD_YT: 'cmd.yt'
});

let seqCounter = 0;

export function makeMessage(type, payload = {}) {
    seqCounter += 1;
    return { v: JAM_PROTOCOL_VERSION, type, seq: seqCounter, ...payload };
}

/** Parse a raw message string. Returns null for malformed or wrong-version messages. */
export function parseMessage(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
        try { msg = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
    if (msg.v !== undefined && msg.v !== JAM_PROTOCOL_VERSION) return null;
    return msg;
}

/** 'gp' | 'pdf' | 'txt', or null for files Jam Mode can't share. */
export function songTypeForName(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (JAM_GP_EXTENSIONS.includes(ext)) return 'gp';
    return JAM_SONG_EXTENSIONS.includes(ext) ? ext : null;
}

/** Songs from older hosts carry no type; they were always Guitar Pro. */
export const isGpSong = (song) => Boolean(song) && (song.type || 'gp') === 'gp';

/** Split base64 into protocol-sized parts. */
export function chunkBase64(b64) {
    const parts = [];
    for (let i = 0; i < b64.length; i += JAM_CHUNK_B64_CHARS) parts.push(b64.slice(i, i + JAM_CHUNK_B64_CHARS));
    return parts.length ? parts : [''];
}
