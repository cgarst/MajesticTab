// audioSyncUi.js
// The sync row that sits in a recording's panel (YouTube, audio file): a "Sync Points" button that opens the editor
// and, when the song has sync points for that recording, a "Follow recording" switch that starts or stops the
// follower. Only one recording drives the cursor at a time. The synth and a recording are never the clock together:
// the follower stands down while the synth plays and resumes when the recording does.

import { getSongKey, onYouTubeEvent, jamYouTubeControl, toggleYouTubePanel } from '../youtubePlayer.js';
import { onTransportEvent, isSynthPlaying } from '../gpProcessor/gpPlayer.js';
import { loadRecord } from './syncStore.js';
import { createYouTubeSource } from './mediaSource.js';
import { startAudioSync, stopAudioSync, getAudioSyncSession } from './audioSyncController.js';
import { initAudioSyncEditor, SYNC_CHANGED_EVENT } from './audioSyncEditor.js';
import { enterSyncMode } from './syncMode.js';
import { isTvMode } from '../tvMode.js';
import { sessionPointsFor, isJamGuestFollowing, JAM_BRIDGE_EVENT } from './jamBridge.js';

const FOLLOW_PREF_KEY = 'audio_sync_follow';

function readFollowPref() {
    try { return localStorage.getItem(FOLLOW_PREF_KEY) !== '0'; } catch { return true; }
}

function writeFollowPref(on) {
    try { localStorage.setItem(FOLLOW_PREF_KEY, on ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

let editor = null;
const $tap = (prefix) => document.getElementById(`${prefix}SyncTapBtn`);

/**
 * Wires the row whose elements are `<prefix>SyncRow`, `<prefix>SyncFollow`, `<prefix>SyncInfo` and
 * `<prefix>SyncEditBtn` and `<prefix>SyncTapBtn`.
 *
 * @param {object} opts
 * @param {string} opts.prefix element id prefix
 * @param {() => object|null} opts.getSource the recording's MediaSource, or null while none is loaded
 * @param {() => object|null} opts.getMedia the recording's media descriptor, or null when no recording is chosen
 * @param {(cb:(kind:string)=>void) => void} opts.subscribe calls `cb('idle' | 'play' | 'stop')` when the recording
 *   changes: 'play' when it starts playing (it may take the cursor over), 'stop' when it pauses, 'idle' otherwise
 * @param {() => (Uint8Array|null)} [opts.getPeaks] the waveform, for a local file
 * @param {() => Promise<ArrayBuffer|null>} [opts.getAudioData] the audio of a local file, for snapping taps to sounds
 * @param {() => void} [opts.prepareSync] called before tap mode starts, to get this recording's panel out of the way
 * @returns {{ refresh: Function }}
 */
export function mountSyncRow({ prefix, getSource, getMedia, subscribe, prepareSync, getPeaks, getAudioData }) {
    const row = document.getElementById(`${prefix}SyncRow`);
    const toggle = document.getElementById(`${prefix}SyncFollow`);
    const info = document.getElementById(`${prefix}SyncInfo`);
    const editBtn = document.getElementById(`${prefix}SyncEditBtn`);
    if (!row || !toggle) return { refresh() {} };
    const switchWrap = toggle.closest('.form-check');
    editor ||= initAudioSyncEditor();

    // A Jam guest follows the host's video with the host's points (kept for the session), and cannot author them
    const guestOnVideo = (media) => media?.kind === 'youtube' && isJamGuestFollowing();
    const recordFor = (media) => {
        const fromHost = sessionPointsFor(media);
        return fromHost ? { points: fromHost, fromHost: true } : loadRecord(getSongKey(), media);
    };

    /**
     * `kind` says what may happen: 'idle' starts following only when nothing else is, 'play' also takes the cursor
     * from another recording, 'stop' never starts (pausing the synth must not pull the cursor back).
     */
    function refresh(kind = 'idle') {
        const media = getMedia();
        const source = getSource();
        const record = media ? recordFor(media) : null;
        const has = Boolean(record?.points.length);
        // A TV, or a guest following the host, only follows existing points, so with none the row has nothing to offer
        row.hidden = !media || ((isTvMode() || guestOnVideo(media)) && !has);
        switchWrap.hidden = !has;
        info.textContent = has
            ? `${record.points.length} sync point${record.points.length === 1 ? '' : 's'}${record.fromHost ? ' from the host' : ''}`
            : 'No sync points';
        toggle.checked = has && readFollowPref();

        const session = getAudioSyncSession();
        const mine = Boolean(session && source && session.source === source);
        const want = has && toggle.checked && Boolean(source) && !isSynthPlaying();
        if (!want) {
            if (mine) stopAudioSync();
            return;
        }
        // Re-read the points on every refresh so edits made elsewhere apply
        if (mine) {
            session.setPoints(record.points);
            return;
        }
        if (kind === 'stop' || (session && kind !== 'play')) return;
        startAudioSync({ source, points: record.points, alignToCursor: !guestOnVideo(media) });
    }

    toggle.addEventListener('change', () => {
        writeFollowPref(toggle.checked);
        refresh('play');
    });
    editBtn?.addEventListener('click', () => {
        const media = getMedia();
        const source = getSource();
        if (media && source && !isTvMode() && !guestOnVideo(media)) {
            toggleYouTubePanel(false);
            editor.open({ source, media, peaks: getPeaks?.() || null });
        }
    });
    $tap(prefix)?.addEventListener('click', () => {
        const media = getMedia();
        const source = getSource();
        if (!media || !source || isTvMode() || guestOnVideo(media)) return;
        prepareSync?.();
        enterSyncMode({ source, media, peaks: getPeaks?.() || null, getAudioData });
    });
    window.addEventListener(SYNC_CHANGED_EVENT, () => refresh('idle'));
    window.addEventListener(JAM_BRIDGE_EVENT, () => refresh('idle'));
    subscribe(refresh);
    onTransportEvent((e) => {
        if (e.type === 'state') refresh('stop');
        else if (e.type === 'ready' || e.type === 'attached') refresh('idle');
        else if (e.type === 'detached') {
            stopAudioSync();
            row.hidden = true;
        }
    });
    return { refresh };
}

/** The YouTube panel's row. */
export function initAudioSyncUi() {
    const source = createYouTubeSource(jamYouTubeControl, onYouTubeEvent);
    mountSyncRow({
        prefix: 'yt',
        getSource: () => (source.id ? source : null),
        getMedia: () => (source.id ? { kind: 'youtube', videoId: source.id } : null),
        // The video must have played once to be allowed to keep playing with its panel closed
        prepareSync: () => { if (jamYouTubeControl.hasPlayed()) toggleYouTubePanel(false); },
        subscribe(cb) {
            onYouTubeEvent((e) => {
                if (e.type === 'video') cb('idle');
                else if (e.type === 'state') cb(e.playing ? 'play' : 'stop');
            });
        }
    });
}
