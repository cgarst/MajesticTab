// jamBridge.js
// Where audio sync meets Jam Mode. The host publishes the sync points of the video it is playing; a guest keeps them
// for the session only (never saved) and follows the host's video with them, so its cursor moves with the music
// like the host's does. While a guest follows the host, sync authoring is off on that device: the host controls
// the video, so a guest's tap mode would fight it. A guest that detaches goes back to its own points.
// Local audio files are never shared (the host's file cannot be sent to guests); the host is told so.
// The data helpers are pure (unit tested in tests/audioSync/jamBridge.test.mjs).

import { normalizeRecord } from './syncStore.js';

/** Most points a guest accepts, so one message cannot fill its memory. */
export const JAM_SYNC_MAX_POINTS = 2000;
export const JAM_BRIDGE_EVENT = 'audiosync:jam';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const FOLLOW_CLASS = 'jam-guest-following';

/**
 * What the host sends for its video: the video id and the points of its record, or null when it has none.
 * @param {string|null} videoId
 * @param {{ points: Array }|null} record the host's own record for this song and video
 */
export function buildSyncPayload(videoId, record) {
    if (!VIDEO_ID_RE.test(String(videoId || '')) || !record?.points?.length) return null;
    return {
        videoId,
        points: record.points.slice(0, JAM_SYNC_MAX_POINTS).map(p => ({
            id: p.id, barIndex: p.barIndex, occurrence: p.occurrence, pos: p.pos, timeMs: p.timeMs, source: p.source
        }))
    };
}

/** Checks a payload received from the network. Returns clean `{ videoId, points }`, or null for anything else. */
export function readSyncPayload(raw) {
    if (!raw || typeof raw !== 'object' || !VIDEO_ID_RE.test(String(raw.videoId || '')) || !Array.isArray(raw.points)) return null;
    if (raw.points.length > JAM_SYNC_MAX_POINTS) return null;
    const record = normalizeRecord({ version: 1, media: { kind: 'youtube', videoId: raw.videoId }, points: raw.points, updatedAt: 0 });
    return record?.points.length ? { videoId: raw.videoId, points: record.points } : null;
}

// --- This device's part in a session -------------------------------------------------------------------------------

let hosting = false;
let guest = false;
let following = false;
let session = null; // { videoId, points } the host last sent

function changed() {
    if (typeof document !== 'undefined') document.body?.classList.toggle(FOLLOW_CLASS, isJamGuestFollowing());
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(JAM_BRIDGE_EVENT));
}

export function setJamHosting(on) {
    if (hosting === Boolean(on)) return;
    hosting = Boolean(on);
    changed();
}

/** This device joined (or left) a session as a guest. Leaving forgets the host's points. */
export function setJamGuest(on) {
    guest = Boolean(on);
    if (!guest) {
        following = false;
        session = null;
    }
    changed();
}

/** A guest following the host (true) or detached to practise alone (false). */
export function setJamFollowing(on) {
    if (following === Boolean(on)) return;
    following = Boolean(on);
    changed();
}

/** Keeps the points the host sent (already checked with readSyncPayload), or forgets them with null. */
export function setSessionSync(payload) {
    session = payload || null;
    changed();
}

export const isJamHosting = () => hosting;
export const isJamGuestFollowing = () => guest && following;

/** The host's points for `media`, when this device is a guest following the host's video. */
export function sessionPointsFor(media) {
    if (!isJamGuestFollowing() || !session || media?.kind !== 'youtube' || media.videoId !== session.videoId) return null;
    return session.points;
}
