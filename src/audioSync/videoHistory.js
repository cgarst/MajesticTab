// audioSync/videoHistory.js
// The YouTube videos a person has picked or played for a tab, one list per slot (Original or Backing), newest first.
// Sync points are not stored here: they already belong to each video (see syncStore.js), so every remembered video keeps
// its own. This list is what lets the Original panel offer past choices that have no sync points yet.
//
// Entry: { videoId, lastUsedAt }. Titles and channels are looked up from the video id (youtubePlayer.js), not stored.
// At most MAX_VIDEOS per slot: the oldest without sync points go first, and a video with sync points is never dropped.

export const VIDEO_HISTORY_PREFIX = 'yt_videos_';
export const MAX_VIDEOS = 10;

const key = (songKey, slot) => `${VIDEO_HISTORY_PREFIX}${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

export function listHistory(songKey, slot, storage = localStorage) {
    try {
        const raw = JSON.parse(storage.getItem(key(songKey, slot)) || '[]');
        return Array.isArray(raw)
            ? raw.filter((e) => e && /^[A-Za-z0-9_-]{11}$/.test(e.videoId)).map((e) => ({ videoId: e.videoId, lastUsedAt: Number(e.lastUsedAt) || 0 }))
            : [];
    } catch { return []; }
}

function save(songKey, slot, list, storage) {
    try { storage.setItem(key(songKey, slot), JSON.stringify(list)); } catch { /* optional */ }
}

/** Notes that a video was picked or played: it moves to the top. `hasSync(videoId)` says which ones may not be dropped. */
export function rememberVideo(songKey, slot, videoId, hasSync = () => false, storage = localStorage, now = Date.now()) {
    if (!songKey || !videoId) return;
    const list = listHistory(songKey, slot, storage).filter((e) => e.videoId !== videoId);
    list.unshift({ videoId, lastUsedAt: now });
    while (list.length > MAX_VIDEOS) {
        // Oldest first, skipping any with sync points; if all have them, the cap yields to keeping them
        let drop = -1;
        for (let i = list.length - 1; i > 0; i--) { if (!hasSync(list[i].videoId)) { drop = i; break; } }
        if (drop < 0) break;
        list.splice(drop, 1);
    }
    save(songKey, slot, list, storage);
}

export function forgetVideo(songKey, slot, videoId, storage = localStorage) {
    if (!songKey || !videoId) return;
    save(songKey, slot, listHistory(songKey, slot, storage).filter((e) => e.videoId !== videoId), storage);
}
