// jamProtocol.js
// Message schemas and constants for Jam Mode (host / client playback sync).
// Every message is JSON: { v, type, seq, ...payload }. Host messages may carry `hostTs`
// (host monotonic ms at send). Positions are always MIDI-timeline times (`timeMs`), never
// pixels, pages or notation-timeline ticks, because those depend on each client's layout.

export const JAM_PROTOCOL_VERSION = 1;
export const JAM_MAX_CLIENTS = 8;
export const JAM_GP_EXTENSIONS = ['gp', 'gp3', 'gp4', 'gp5', 'gpx'];
export const JAM_MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

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
    // client commands (controller -> host)
    CMD_SONG_OPEN: 'cmd.song.open',
    CMD_PLAY: 'cmd.transport.play',
    CMD_PAUSE: 'cmd.transport.pause',
    CMD_SEEK: 'cmd.transport.seek',
    CMD_SPEED: 'cmd.transport.speed',
    CMD_LOOP: 'cmd.transport.loop'
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

export function isGpFileName(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return JAM_GP_EXTENSIONS.includes(ext);
}
