// audioSyncUi.js
// The sync row in the YouTube panel: a "Sync Points" button that opens the editor, and, when the loaded song has
// sync points for the loaded video, a "Follow recording" switch that starts or stops the follower. The synth and the video are never the clock
// at the same time: the follower stands down while the synth plays and resumes when the video does.

import { getSongKey, onYouTubeEvent, jamYouTubeControl } from '../youtubePlayer.js';
import { onTransportEvent, isSynthPlaying } from '../gpProcessor/gpPlayer.js';
import { loadRecord } from './syncStore.js';
import { createYouTubeSource } from './mediaSource.js';
import { startAudioSync, stopAudioSync, getAudioSyncSession } from './audioSyncController.js';
import { initAudioSyncEditor, SYNC_CHANGED_EVENT } from './audioSyncEditor.js';

const FOLLOW_PREF_KEY = 'audio_sync_follow';

function readFollowPref() {
    try { return localStorage.getItem(FOLLOW_PREF_KEY) !== '0'; } catch { return true; }
}

function writeFollowPref(on) {
    try { localStorage.setItem(FOLLOW_PREF_KEY, on ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

export function initAudioSyncUi() {
    const row = document.getElementById('ytSyncRow');
    const toggle = document.getElementById('ytSyncFollow');
    const info = document.getElementById('ytSyncInfo');
    if (!row || !toggle) return;

    const source = createYouTubeSource(jamYouTubeControl, onYouTubeEvent);
    const switchWrap = toggle.closest('.form-check');
    const editor = initAudioSyncEditor({ source, getMedia: () => ({ kind: 'youtube', videoId: source.id }) });
    let record = null;

    /** `mayStart` false only stops: pausing the synth must not pull the cursor back to the video's position. */
    function refresh(mayStart = true) {
        const videoId = source.id;
        record = videoId ? loadRecord(getSongKey(), { kind: 'youtube', videoId }) : null;
        const has = Boolean(record?.points.length);
        row.hidden = !videoId;
        switchWrap.hidden = !has;
        info.textContent = has ? `${record.points.length} sync point${record.points.length === 1 ? '' : 's'}` : 'No sync points';
        toggle.checked = has && readFollowPref();

        const following = Boolean(getAudioSyncSession());
        const want = has && toggle.checked && !isSynthPlaying();
        if (!want) {
            if (following) stopAudioSync();
            return;
        }
        if (!following && !mayStart) return;
        // Re-read the points on every refresh so edits made elsewhere apply; start fails until a score is ready
        if (following) getAudioSyncSession().setPoints(record.points);
        else startAudioSync({ source, points: record.points });
    }

    document.getElementById('ytSyncEditBtn')?.addEventListener('click', () => editor.open());
    window.addEventListener(SYNC_CHANGED_EVENT, () => refresh());

    toggle.addEventListener('change', () => {
        writeFollowPref(toggle.checked);
        refresh();
    });

    onYouTubeEvent((e) => {
        if (e.type === 'video') refresh();
        else if (e.type === 'state') refresh(e.playing);
    });
    onTransportEvent((e) => {
        if (e.type === 'state') refresh(false);
        else if (e.type === 'ready' || e.type === 'attached') refresh();
        else if (e.type === 'detached') {
            stopAudioSync();
            row.hidden = true;
        }
    });
}
