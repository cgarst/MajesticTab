// youtubePlayer.js
// Collapsible YouTube / Backing Track player integrated into top bar
import { pauseSynthPlayer, clearSynthHighlights, toggleSynthPanel, toggleScoreOptionsPanel, isSynthPlaying } from './gpProcessor/gpPlayer.js';
import { showPanel, hidePanel } from './utils/readerPanels.js';
import { getMasterVolume, onMasterVolume } from './utils/masterVolume.js';
import { songHasSyncPoints, listRecords, saveRecord, deleteRecord, mediaKey, SYNC_CHANGED_EVENT } from './audioSync/syncStore.js';
import { listHistory, rememberVideo, forgetVideo } from './audioSync/videoHistory.js';
import { showToast } from './utils/toast.js';
import { updateGlobalRewindButton, setActiveAudioMode } from './utils/navigationUtils.js';
import { showSheet, closeSheet, resetPeek, isVideoShown, visibleVideoRect, onSheetChange, onSheetMove, onSheetTransition, initYtSheet } from './ytSheet.js';

let activeSearchController = null;

export let playerState = {
    isOpen: false,
    trackMode: 'original', // Default to 'original' (left button)
    artist: '',
    title: '',
    filename: '',
    customQueries: { original: '', backing: '' },
    customQuery: '',
    currentVideoId: null,
    currentTime: 0,
    duration: 0, // seconds, as the embed reports it
    isPlaying: false,
    hasStarted: false,
    isSearching: false,
    playbackRate: 1
};

// --- Jam Mode hooks ---------------------------------------------------------
// Jam code follows what the iframe actually reports (playerState.isPlaying is set
// optimistically before the video starts) and drives the player via jamYouTubeControl.
const youTubeListeners = new Set();
let reportedState = -1; // last YouTube player state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
let reportedPlaying = false;
let iframePlayed = false; // the current embed has reported playing (autoplay is no longer gated)
// Title and channel of each video, as the player itself reports them (infoDelivery's videoData), for the panel
const videoInfo = new Map();
export const getVideoInfo = (videoId) => videoInfo.get(videoId) || null;
function captureVideoData(info) {
    const vd = info?.videoData;
    if (!vd || !(vd.title || vd.author)) return;
    const id = vd.video_id || playerState.currentVideoId;
    const prev = id ? videoInfo.get(id) : null;
    const next = { title: vd.title || prev?.title || '', author: vd.author || prev?.author || '' };
    if (!id || (prev && prev.title === next.title && prev.author === next.author)) return;
    videoInfo.set(id, next);
    updateFoundVideo();
    emitYouTubeEvent('info', { videoId: id, ...next });
}
// The title and channel come from YouTube's oEmbed page (works before the player has loaded, and on every platform; the
// player's own report, above, fills in or corrects it). Remembered, so the panel can name the video offline.
const infoLookups = new Set();
export async function lookupVideoInfo(videoId) {
    if (!videoId || videoInfo.has(videoId) || infoLookups.has(videoId)) return;
    try {
        const cached = JSON.parse(localStorage.getItem(`yt_info_${videoId}`) || 'null');
        if (cached && (cached.title || cached.author)) { videoInfo.set(videoId, cached); updateFoundVideo(); emitYouTubeEvent('info', { videoId, ...cached }); return; }
    } catch { /* optional */ }
    infoLookups.add(videoId);
    try {
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
        if (!res.ok) return;
        const j = await res.json();
        const info = { title: j.title || '', author: j.author_name || '' };
        if (!info.title && !info.author) return;
        videoInfo.set(videoId, info);
        try { localStorage.setItem(`yt_info_${videoId}`, JSON.stringify(info)); } catch { /* optional */ }
        updateFoundVideo();
        emitYouTubeEvent('info', { videoId, ...info });
    } catch { /* offline or blocked: the player's own report may still fill it in */ } finally {
        infoLookups.delete(videoId);
    }
}

// The list of remembered videos names each one by its title and channel as they arrive (it also shows the current video)
function updateFoundVideo() {
    const section = document.getElementById('ytVideoSection');
    if (section && !section.hidden) renderSyncedVideos();
}

let sheetClosedAt = 0; // when the person last closed the video sheet
let timeReportedAt = 0; // performance.now() at which playerState.currentTime was sampled

/** Subscribe to 'video' | 'state' | 'time' | 'rate' events. Returns an unsubscribe function. */
export function onYouTubeEvent(cb) {
    youTubeListeners.add(cb);
    return () => youTubeListeners.delete(cb);
}

function emitYouTubeEvent(type, detail = {}) {
    youTubeListeners.forEach((cb) => {
        try { cb({ type, ...detail }); } catch (e) { console.error('[YouTube] listener error:', e); }
    });
}

/** `source`: 'user' (picked in the panel), 'auto' (saved or searched), 'song' (reset on file load) or 'jam'. */
function setVideoId(videoId, source) {
    if (playerState.currentVideoId === videoId) return;
    playerState.currentVideoId = videoId;
    playerState.videoSource = source;
    playerState.duration = 0;
    updateFoundVideo();
    lookupVideoInfo(videoId);
    // A video the person picked or pasted is remembered at once; one that was only found by search, when it plays
    if (videoId && source === 'user') rememberCurrentVideo();
    // A new video opens the sheet fully again; lowering it was a choice about the one before.
    resetPeek();
    // A new (or no) embed: the old iframe won't report that it stopped.
    iframePlayed = false;
    reportedPlaying = false;
    reportedState = -1;
    emitYouTubeEvent('video', { videoId, source });
}

function reportYouTubeState(state) {
    const wasBuffering = reportedState === 3;
    reportedState = state;
    if (state === 3) {
        // buffering: keep the previous playing / paused state, but tell audio sync, which holds the cursor until
        // the clock is real again (a seek buffers)
        emitYouTubeEvent('state', { playing: reportedPlaying, buffering: true, timeSec: currentYouTubeTime() });
        return;
    }
    const playing = state === 1;
    if (playing) iframePlayed = true;
    if (playing) rememberCurrentVideo();
    // Playing means on the screen. Anything that started the video without opening the sheet (a Jam host, sync) opens
    // it here. A late report right after the person closed it is ignored, since closing paused the video.
    if (playing && !isVideoShown() && performance.now() - sheetClosedAt > 2500) {
        if (playerState.isOpen) toggleYouTubePanel(false); // playing takes the screen: the panel and the video are never shown together
        showSheet();
    }
    if (playing !== reportedPlaying) {
        reportedPlaying = playing;
        emitYouTubeEvent('state', { playing, timeSec: playerState.currentTime });
    } else if (wasBuffering) {
        // Buffering ended with no change of state: the cursor was held while it lasted, so let it go on
        emitYouTubeEvent('state', { playing, timeSec: playerState.currentTime });
    }
}

function currentYouTubeTime() {
    if (reportedState !== 1 || !timeReportedAt) return playerState.currentTime || 0;
    const elapsed = Math.min(2000, Math.max(0, performance.now() - timeReportedAt));
    return (playerState.currentTime || 0) + elapsed / 1000 * (playerState.playbackRate || 1);
}

// macOS and iOS native shells play YouTube in a native webview overlaid on the iframe slot,
// because the shell origin (tauri://localhost) is rejected by embeds (error 153).
function isNativeOverlayPlayer() {
    return Boolean(window.__TAURI__) && /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent);
}

// The Linux and other desktop shells run the app at tauri://localhost, which YouTube also rejects with error 153 (it
// needs an http(s) referrer). They embed the player through a relay page on the website, which frames YouTube under
// its own https origin and passes the player's messages both ways (docs/youtube-player.html).
const YOUTUBE_RELAY_URL = 'https://majestictab.zathu.net/youtube-player.html';
function needsYouTubeRelay() {
    return window.location.protocol === 'tauri:' && !isNativeOverlayPlayer();
}

function sendYouTubeMessage(iframe, message) {
    if (isNativeOverlayPlayer()) {
        window.__TAURI__.core.invoke('youtube_player_command', { message }).catch(() => {});
        return;
    }
    iframe?.contentWindow?.postMessage(JSON.stringify(message), '*');
}

function applyYouTubeVolume() {
    const iframe = document.getElementById('ytIframe');
    if (iframe?.dataset.loaded !== 'true') return;
    sendYouTubeMessage(iframe, { event: 'command', func: 'setVolume', args: [Math.round(getMasterVolume() * 100)] });
}
onMasterVolume(applyYouTubeVolume);

// The native player ignores an update while its slot is hidden or still zero-sized (the panel is opening), so a
// request to autoplay is kept until an update that is actually shown has carried it.
let nativeAutoplayPending = false;

function syncNativeMacPlayerBounds(autoplay = false) {
    if (!isNativeOverlayPlayer()) return;
    if (autoplay) nativeAutoplayPending = true;

    const iframe = document.getElementById('ytIframe');
    // The native view covers the visible part of the video sheet: all of it, or the slice that is left when the
    // person has lowered the sheet (the player keeps its full height inside that view). Never off-screen or tiny.
    const rect = visibleVideoRect();
    const visible = Boolean(
        isVideoShown() &&
        playerState.currentVideoId &&
        iframe?.dataset.loaded === 'true' &&
        rect?.width &&
        rect?.height
    );

    window.__TAURI__.core.invoke('youtube_player_update', {
        videoId: playerState.currentVideoId || '',
        autoplay: nativeAutoplayPending && visible,
        start: Math.floor(playerState.currentTime || 0),
        left: rect?.left || 0,
        top: rect?.top || 0,
        width: rect?.width || 0,
        height: rect?.height || 0,
        visible,
        fullHeight: rect?.fullHeight || 0
    }).catch(() => {});
    if (visible) nativeAutoplayPending = false;
}

function animateNativeMacPlayerBounds() {
    const stopAt = performance.now() + 320;
    let lastUpdate = 0;
    const update = (time) => {
        if (time - lastUpdate >= 16 || time >= stopAt) {
            syncNativeMacPlayerBounds();
            lastUpdate = time;
        }
        if (time < stopAt) {
            requestAnimationFrame(update);
        }
    };
    requestAnimationFrame(update);
}

/**
 * Pause YouTube player if active
 */
export function pauseYouTube() {
    const iframe = document.getElementById('ytIframe');
    sendYouTubeMessage(iframe, { event: 'command', func: 'pauseVideo', args: [] });
    if (playerState.isPlaying) {
        playerState.isPlaying = false;
        nativeAutoplayPending = false;
        updatePlaybackControls();
    }
}

/**
 * Rewind YouTube to start (0s)
 */
export function rewindYouTubeToBeginning() {
    const iframe = document.getElementById('ytIframe');
    if (!iframe || !iframe.contentWindow) return;

    playerState.currentTime = 0;
    sendYouTubeMessage(iframe, { event: 'command', func: 'seekTo', args: [0, true] });
}

/**
 * Rewind YouTube by 10 seconds
 */
export function rewindYouTube10Seconds() {
    const iframe = document.getElementById('ytIframe');
    if (!iframe || !iframe.contentWindow) return;

    const targetTime = Math.max(0, (playerState.currentTime || 0) - 10);
    playerState.currentTime = targetTime;
    sendYouTubeMessage(iframe, { event: 'command', func: 'seekTo', args: [targetTime, true] });
}

/**
 * Toggle YouTube play / pause
 */
export function playPauseYouTube() {
    const iframe = document.getElementById('ytIframe');
    if (!iframe || !iframe.contentWindow) return false;

    // The saved video has not been loaded yet (first play after opening the song, or on a fresh install):
    // load it now, and show the panel until it plays, since YouTube only allows an embed that is visible
    if (iframe.dataset.loaded !== 'true' && !playerState.isPlaying && hasSavedVideo()) {
        loadCurrentTrack(true, { source: 'user' });
        updatePlaybackControls();
        return true;
    }

    if (playerState.isPlaying) {
        sendYouTubeMessage(iframe, { event: 'command', func: 'pauseVideo', args: [] });
        playerState.isPlaying = false;
        nativeAutoplayPending = false;
    } else {
        pauseSynthPlayer();
        clearSynthHighlights();
        showSheet(); // the video is on the screen before it plays
        sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
        playerState.isPlaying = true;
        playerState.hasStarted = true;
        setActiveAudioMode('youtube');
    }
    updatePlaybackControls();
    return true;
}

/**
 * Original is selected (for example when a song with a recording opens): its video is on the screen without waiting
 * for play. Only when a video is already known; the Original panel being open, or the video already shown, leaves it.
 */
export function showOriginalVideo() {
    if (playerState.isOpen || isVideoShown() || !hasSavedVideo()) return;
    loadCurrentTrack(false);
    showSheet();
}

/**
 * Whether the video should be on the screen because of the selected sound (not because of playback). Opening a tab
 * changes the sound several times in a row (the reader, the player's reset, the synth's load), so the changes settle
 * first and the sheet follows the last one: it pops in once instead of in, out and in again.
 */
let settleTimer = 0;
export function scheduleOriginalVideo(want) {
    clearTimeout(settleTimer);
    if (!want && isYouTubePlaying()) { closeSheet(); return; } // a playing video that is no longer the sound leaves at once
    settleTimer = setTimeout(() => (want ? showOriginalVideo() : closeSheet()), 250);
}

/** Whether a video is saved for the current song and track mode, even if its player has not been loaded yet. */
function hasSavedVideo() {
    try { return Boolean(getSongKey() && localStorage.getItem(getStorageKey())); } catch { return false; }
}

export function isYouTubeAvailable() {
    return Boolean(playerState.currentVideoId || playerState.hasStarted || hasSavedVideo());
}

export function isYouTubePlaying() {
    return Boolean(playerState.isPlaying);
}

/**
 * Clean up a raw string (e.g. filename) to extract probable artist and song title
 */
export function parseSongInfo(filename = '', scoreTitle = '', scoreArtist = '') {
    let title = (scoreTitle || '').trim();
    let artist = (scoreArtist || '').trim();

    if (!title && filename) {
        // Strip extension (.gp, .gp5, .pdf, .txt, etc.)
        let cleanName = filename.replace(/\.(gp\d?|gpx|pdf|txt|cap)$/i, '').trim();
        // Replace underscores with spaces
        cleanName = cleanName.replace(/_/g, ' ');

        // Check for "Artist - Title" format
        if (cleanName.includes(' - ')) {
            const parts = cleanName.split(' - ');
            artist = parts[0].trim();
            title = parts.slice(1).join(' - ').trim();
        } else {
            title = cleanName;
        }
    }

    return { artist, title };
}

/**
 * Extract YouTube Video ID from various URL formats
 */
export function extractVideoId(urlOrText) {
    if (!urlOrText) return null;
    const text = urlOrText.trim();
    
    // Direct 11-char ID (e.g. yW8nBlZZvxM)
    if (/^[a-zA-Z0-9_-]{11}$/.test(text)) {
        return text;
    }
    
    // Standard watch URL: youtube.com/watch?v=ID, youtu.be/ID, embed/ID, music.youtube.com/watch?v=ID
    const watchMatch = text.match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?.*v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (watchMatch) {
        return watchMatch[1];
    }
    
    return null;
}

/**
 * Key for localStorage caching of video IDs per song and mode
 */
function getStorageKey(mode = playerState.trackMode) {
    return `yt_track_${encodeURIComponent(getSongKey().toLowerCase())}_${mode}`;
}

/** Identity of the loaded song (artist and title, or the file name); also keys the song's audio sync data. */
export function getSongKey() {
    return [playerState.artist, playerState.title].filter(Boolean).join(' - ') || playerState.filename;
}

/**
 * Get default automated query string for the current song and mode
 */
export function getDefaultQuery(mode = playerState.trackMode) {
    const { artist, title } = playerState;
    const base = [artist, title].filter(Boolean).join(' ');

    if (!base) {
        return mode === 'backing' ? 'guitar backing track' : 'official audio';
    }

    if (mode === 'backing') {
        return `${base} guitar backing track`;
    } else {
        return `${base}`;
    }
}

/**
 * Build the query string for YouTube based on current song info, overrides, and mode
 */
export function buildQuery(mode = playerState.trackMode) {
    if (playerState.customQueries && playerState.customQueries[mode]) {
        return playerState.customQueries[mode];
    }
    if (playerState.customQuery) {
        return playerState.customQuery;
    }

    return getDefaultQuery(mode);
}

/**
 * Synchronize the query input field and reset button with current query state
 */
export function updateQueryInputUI() {
    const input = document.getElementById('ytSearchQueryInput');
    const resetBtn = document.getElementById('ytResetQueryBtn');
    if (!input) return;

    const mode = playerState.trackMode;
    const currentQuery = buildQuery(mode);
    const defaultQuery = getDefaultQuery(mode);
    const isOverridden = Boolean(playerState.customQueries?.[mode] && playerState.customQueries[mode] !== defaultQuery);

    input.value = currentQuery;
    if (resetBtn) {
        resetBtn.style.display = isOverridden ? 'inline-flex' : 'none';
    }
}

/**
 * Switch between the original recording and the backing track: updates the search string
 * (adds "guitar backing track" for backing) and searches again unless a video is saved for that mode.
 * The recording panel's slot rows and the track radios both come through here.
 */
export function setYouTubeTrackMode(mode) {
    if (mode !== 'original' && mode !== 'backing') return;
    if (playerState.trackMode === mode) { applySyncedDefaults(); renderSyncedVideos(); return; }
    if (playerState.isSearching) {
        cancelYouTubeSearch();
    }
    playerState.trackMode = mode;
    setVideoId(null, 'user');
    updateQueryInputUI();
    loadCurrentTrack(true, { source: 'user' });
}

/**
 * Redo YouTube search with an optional query override
 */
export function redoSearchWithQuery(override = null) {
    const input = document.getElementById('ytSearchQueryInput');
    const mode = playerState.trackMode;
    const query = (override !== null ? override : (input?.value || '')).trim();
    const defaultQuery = getDefaultQuery(mode);

    if (playerState.isSearching) {
        cancelYouTubeSearch();
    }

    if (!playerState.customQueries) {
        playerState.customQueries = { original: '', backing: '' };
    }

    if (!query || query === defaultQuery) {
        playerState.customQueries[mode] = '';
        playerState.customQuery = '';
    } else {
        playerState.customQueries[mode] = query;
        playerState.customQuery = query;
    }

    // Clear saved video ID so the search runs fresh
    localStorage.removeItem(getStorageKey());
    markUserPick(mode); // an explicit search wins over the synced default
    clearVideoRemoved(mode);
    setVideoId(null, 'user');

    updateQueryInputUI();
    loadCurrentTrack(true, { source: 'user' });
}

/**
 * Public Invidious and Piped mirrors for client-side multi-mirror search
 */
const PUBLIC_MIRRORS = [
    { type: 'piped', url: 'https://pipedapi.ducks.party' },
    { type: 'piped', url: 'https://api.piped.private.coffee' }
];

/**
 * Search YouTube using Tauri native backend if available
 */
async function fetchYouTubeNativeSearch(query) {
    if (typeof window !== 'undefined' && window.__TAURI__?.core?.invoke) {
        try {
            const vid = await window.__TAURI__.core.invoke('youtube_search', { query });
            if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) {
                return vid;
            }
        } catch (e) {
            console.warn('[YouTube Native Search Error]', e);
        }
    }
    return null;
}

/**
 * Attempt to search public mirrors concurrently for a matching video ID
 */
async function fetchMultiMirrorSearch(query, parentSignal = null) {
    const fetchFromMirror = async (mirror) => {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), 3500);

        if (parentSignal) {
            parentSignal.addEventListener('abort', () => timeoutController.abort(), { once: true });
        }

        try {
            const endpoint = mirror.type === 'invidious'
                ? `${mirror.url}/api/v1/search?q=${encodeURIComponent(query)}&type=video`
                : `${mirror.url}/search?q=${encodeURIComponent(query)}&filter=videos`;

            const res = await fetch(endpoint, {
                signal: timeoutController.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (mirror.type === 'invidious' && Array.isArray(data) && data.length > 0) {
                const vid = data[0].videoId;
                if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) return vid;
            } else if (mirror.type === 'piped' && data?.items?.length > 0) {
                const vid = data.items[0].url?.replace('/watch?v=', '');
                if (vid && /^[a-zA-Z0-9_-]{11}$/.test(vid)) return vid;
            }
            throw new Error('No video found in response');
        } catch (e) {
            clearTimeout(timeoutId);
            throw e;
        }
    };

    try {
        return await Promise.any(PUBLIC_MIRRORS.map(m => fetchFromMirror(m)));
    } catch {
        return null;
    }
}

/**
 * Search YouTube Data API v3 if API key is configured in settings
 */
async function fetchYouTubeApiKeySearch(query, parentSignal = null) {
    const apiKey = localStorage.getItem('youtubeApiKey');
    if (!apiKey) return null;

    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, { signal: parentSignal });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].id?.videoId || null;
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.warn('[YouTube API Search Error]', e);
        }
    }
    return null;
}

/**
 * Cancel an ongoing automated search
 */
export function cancelYouTubeSearch() {
    if (activeSearchController) {
        activeSearchController.abort();
        activeSearchController = null;
    }
    playerState.isSearching = false;

    const iframe = document.getElementById('ytIframe');
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const loadingIndicator = document.getElementById('ytLoadingIndicator');

    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');
    if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
        delete iframe.dataset.loaded;
    }
    if (prompt) {
        prompt.style.setProperty('display', 'flex', 'important');
    }
    updatePanelTitle();
}

const SEARCH_TIMEOUT_MS = 15000;

/**
 * Replace the spinner with an error and a "Try again" action after a search timeout
 */
/** Panel state for a recording slot with no video: no embed, no search running, the paste-a-link prompt. */
function showNoVideoPrompt() {
    const iframe = document.getElementById('ytIframe');
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    const title = document.getElementById('ytPromptTitle');
    const retry = document.getElementById('ytRetrySearchBtn');
    if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
        delete iframe.dataset.loaded;
    }
    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');
    updatePanelTitle();
    if (title) title.textContent = 'No video attached.';
    if (retry) retry.hidden = true;
    if (prompt) prompt.style.setProperty('display', 'flex', 'important');
}

const removedKey = (mode = playerState.trackMode) => `yt_none_${encodeURIComponent(getSongKey().toLowerCase())}_${mode}`;
function isVideoRemoved(mode = playerState.trackMode) {
    try { return Boolean(getSongKey() && localStorage.getItem(removedKey(mode))); } catch { return false; }
}
function clearVideoRemoved(mode = playerState.trackMode) {
    try { localStorage.removeItem(removedKey(mode)); } catch { /* optional */ }
}

/** Detach the video from this song's recording slot and go back to having none (its sync points are kept). */
export function removeYouTubeVideo() {
    if (!getSongKey()) return;
    if (playerState.isSearching) cancelYouTubeSearch();
    pauseYouTube();
    try {
        localStorage.removeItem(getStorageKey());
        localStorage.setItem(removedKey(), '1');
    } catch { /* optional */ }
    markUserPick(); // do not fall back to a synced video by itself
    setVideoId(null, 'user');
    playerState.isPlaying = false;
    playerState.hasStarted = false;
    showNoVideoPrompt();
    updatePlaybackControls();
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
}

function showSearchTimeout() {
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    const title = document.getElementById('ytPromptTitle');
    const retry = document.getElementById('ytRetrySearchBtn');
    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');
    updatePanelTitle();
    if (title) title.textContent = 'The YouTube search timed out. Check your connection, then try again or paste a link under Add a video.';
    if (retry) retry.hidden = false;
    if (prompt) prompt.style.setProperty('display', 'flex', 'important');
}

/**
 * Update the YouTube iframe or prompt UI based on current video ID.
 * `videoId` forces a video without saving it for this song (Jam Mode).
 */
async function loadCurrentTrack(autoplay = false, { videoId: forcedVideoId = null, source = 'auto' } = {}) {
    const iframe = document.getElementById('ytIframe');
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    const loadingQueryText = document.getElementById('ytLoadingQueryText');

    // 1. Check if user already saved a video ID for this song & mode
    const storedId = localStorage.getItem(getStorageKey());
    let videoId = forcedVideoId || storedId || playerState.currentVideoId;
    // A recording defaults to a video the song already has sync points for, before any search
    if (!videoId && !localStorage.getItem(pickMarkerKey(playerState.trackMode))) {
        videoId = pickSyncedVideo(playerState.trackMode)?.videoId || null;
        if (videoId) localStorage.setItem(getStorageKey(), videoId);
    }

    // No automatic search when it would only be a guess: a tab with no artist (a plain file name is a poor query and
    // finds unrelated videos), or one whose video the player removed. The panel then asks for a search or a link.
    if (!videoId && source === 'auto' && (!playerState.artist || isVideoRemoved())) {
        showNoVideoPrompt();
        return;
    }

    // The Original panel and the video are never shown together. A video picked or pasted while the panel is open only
    // loads; pressing play closes the panel and opens the sheet. (A Jam host's play takes the screen from the panel.)
    if (autoplay && playerState.isOpen) {
        if (source === 'jam') toggleYouTubePanel(false);
        else autoplay = false;
    }
    // The video has to be on the screen while it plays, so playing opens the video sheet first (it also holds the
    // searching and not-found states of the player). Loading without playing leaves it closed.
    if (autoplay) showSheet();

    // 2. If no ID, attempt search with visible loading indicator and cancel capability
    if (!videoId) {
        if (activeSearchController) {
            activeSearchController.abort();
            activeSearchController = null;
        }

        const query = buildQuery();
        playerState.isSearching = true;

        if (iframe) {
            iframe.src = '';
            iframe.style.display = 'none';
            delete iframe.dataset.loaded;
        }
        if (prompt) prompt.style.setProperty('display', 'none', 'important');
        if (loadingIndicator) {
            loadingIndicator.style.setProperty('display', 'flex', 'important');
            if (loadingQueryText) {
                loadingQueryText.textContent = `"${query}"`;
            }
        }

        activeSearchController = new AbortController();
        const signal = activeSearchController.signal;

        let timedOut = false;
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; resolve(null); }, SEARCH_TIMEOUT_MS);
        });
        const runSearch = async () => {
            // Check native search if on Tauri (desktop & mobile native)
            let found = await fetchYouTubeNativeSearch(query);

            // Check YouTube Data API if key provided
            if (!found && !signal.aborted && !timedOut) {
                found = await fetchYouTubeApiKeySearch(query, signal);
            }

            // If still no ID, attempt public mirrors search
            if (!found && !signal.aborted && !timedOut) {
                found = await fetchMultiMirrorSearch(query, signal);
            }
            return found;
        };

        try {
            // A search that never settles (stalled native call or network) must not spin forever
            videoId = await Promise.race([runSearch(), timeout]);
        } catch (e) {
            // Handled
        }
        clearTimeout(timer);

        if (timedOut && !videoId && !signal.aborted) {
            activeSearchController?.abort();
            activeSearchController = null;
            playerState.isSearching = false;
            showSearchTimeout();
            return;
        }

        if (signal.aborted) {
            return;
        }

        activeSearchController = null;
        playerState.isSearching = false;

        if (videoId) {
            localStorage.setItem(getStorageKey(), videoId);
        }
    }

    setVideoId(videoId, source);
    updatePanelTitle();
    updateQueryInputUI();

    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');

    if (videoId) {
        // We have a valid video ID -> show iframe
        if (prompt) prompt.style.setProperty('display', 'none', 'important');
        if (iframe) {
            iframe.style.display = 'block';
            const autoplayParam = autoplay ? '1' : '0';
            const relay = needsYouTubeRelay();
            const embedUrl = relay ? new URL(YOUTUBE_RELAY_URL) : new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
            if (relay) {
                embedUrl.searchParams.set('v', videoId);
            } else {
                embedUrl.searchParams.set('enablejsapi', '1');
                embedUrl.searchParams.set('playsinline', '1');
            }
            embedUrl.searchParams.set('autoplay', autoplayParam);

            const origin = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') ? window.location.origin : '';
            const hostname = (typeof window !== 'undefined' && window.location?.hostname) ? window.location.hostname : '';
            const isLocalOrInternalHost = !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
            const isValidHttpOrigin = origin && origin.startsWith('http') && !isLocalOrInternalHost && !origin.includes('tauri');
            if (isValidHttpOrigin && !relay) {
                embedUrl.searchParams.set('origin', origin);
                embedUrl.searchParams.set('widget_referrer', origin);
            }

            if (playerState.currentTime > 0) {
                embedUrl.searchParams.set('start', String(Math.floor(playerState.currentTime)));
            }
            if (autoplay) {
                pauseSynthPlayer();
                clearSynthHighlights();
                playerState.isPlaying = true;
                playerState.hasStarted = true;
                setActiveAudioMode('youtube');
                updatePlaybackControls();
            }
            const targetSrc = embedUrl.toString();
            if (isNativeOverlayPlayer()) {
                iframe.src = '';
                iframe.style.visibility = 'hidden';
            } else if (iframe.src !== targetSrc) {
                iframe.style.visibility = 'visible';
                iframe.src = targetSrc;
            } else if (autoplay && iframe.contentWindow) {
                iframe.style.visibility = 'visible';
                sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
            }
            iframe.dataset.loaded = 'true';
            syncNativeMacPlayerBounds(autoplay);
        }
    } else {
        // No video ID yet -> show search & prompt screen
        if (iframe) {
            iframe.src = '';
            iframe.style.display = 'none';
            iframe.style.visibility = 'visible';
            delete iframe.dataset.loaded;
        }
        syncNativeMacPlayerBounds();
        if (prompt) {
            prompt.style.setProperty('display', 'flex', 'important');
        }
    }
}

/**
 * Update titles, labels, and external links
 */
// Tabs of one library song can carry different score titles, so their sync points sit under different song keys.
// The keys seen for a library song are remembered, so a tab can offer the synced videos of its sibling tabs.
const songKeysStore = (id) => `yt_song_keys_${id}`;
function rememberSongKey(librarySongId, key, meta = {}) {
    if (!librarySongId || !key) return;
    try {
        const raw = JSON.parse(localStorage.getItem(songKeysStore(librarySongId)) || '[]');
        const list = raw.map(item => (typeof item === 'string' ? { key: item } : item));
        const entry = {
            key,
            filename: meta.filename || playerState.filename || '',
            tabName: meta.tabName || playerState.tabName || '',
            sourceWebsite: meta.sourceWebsite || playerState.sourceWebsite || null,
            sourceUrl: meta.sourceUrl || playerState.sourceUrl || null
        };
        const existingIdx = list.findIndex(e => e.key && e.key.toLowerCase() === key.toLowerCase());
        if (existingIdx >= 0) {
            list[existingIdx] = { ...list[existingIdx], ...entry };
        } else {
            list.push(entry);
        }
        localStorage.setItem(songKeysStore(librarySongId), JSON.stringify(list.slice(-20)));
    } catch { /* optional */ }
}

function siblingSongKeys() {
    const own = getSongKey() || '';
    if (!playerState.librarySongId) return [];
    try {
        const raw = JSON.parse(localStorage.getItem(songKeysStore(playerState.librarySongId)) || '[]');
        return raw
            .map(item => (typeof item === 'string' ? { key: item } : item))
            .filter(e => e.key && e.key.toLowerCase() !== own.toLowerCase());
    } catch { return []; }
}

/**
 * YouTube videos this specific tab has sync points for (newest first).
 */
export function getSyncedVideos() {
    try {
        return listRecords(getSongKey() || '')
            .filter(r => r.media.kind === 'youtube' && r.points.length)
            .map(r => ({
                videoId: r.media.videoId,
                // The source tags a video with a feature (backing, solo, alternative); no tag means the original recording
                kind: /feature (\w+)/.exec(r.media.label || '')?.[1] || 'original',
                label: r.media.label || '',
                count: r.points.length,
                updatedAt: r.updatedAt || 0,
                own: true,
                key: getSongKey(),
                media: r.media,
                points: r.points,
                origin: r.media.origin || null
            }));
    } catch { return []; }
}

/**
 * Available synced videos on sibling tabs of the same library song.
 */
export async function getSiblingSyncedVideos() {
    const own = getSongKey() || '';
    if (!playerState.librarySongId) return [];
    const ownRecords = listRecords(own);
    const siblingEntries = [];

    // From remembered score keys
    siblingSongKeys().forEach(e => siblingEntries.push(e));

    // Also look up tabs from libraryStore
    try {
        const { getSongById } = await import('./libraryStore.js');
        const song = await getSongById(playerState.librarySongId);
        if (song && Array.isArray(song.tabOptions)) {
            song.tabOptions.forEach(tab => {
                const tabKey = tab.name || '';
                if (tabKey && tabKey.toLowerCase() !== (playerState.tabName || '').toLowerCase() && tabKey.toLowerCase() !== own.toLowerCase()) {
                    siblingEntries.push({
                        key: tabKey,
                        tabName: tab.name,
                        sourceWebsite: tab.sourceWebsite || null,
                        sourceUrl: tab.sourceUrl || null
                    });
                }
            });
        }
    } catch { /* optional */ }

    const seenKeys = new Set();
    const out = [];

    for (const sib of siblingEntries) {
        const k = (sib.key || '').toLowerCase();
        if (!k || k === own.toLowerCase() || seenKeys.has(k)) continue;
        seenKeys.add(k);

        const records = listRecords(sib.key);
        for (const r of records) {
            const rKey = mediaKey(r.media);
            if (rKey && r.points?.length) {
                if (ownRecords.some(o => mediaKey(o.media) === rKey)) continue;
                if (out.some(o => o.mediaKey === rKey)) continue;
                const isLocal = r.media.kind === 'local';

                out.push({
                    mediaKey: rKey,
                    isLocal,
                    name: isLocal ? (r.media.name || 'Audio file') : '',
                    videoId: isLocal ? null : r.media.videoId,
                    kind: isLocal ? 'original' : (/feature (\w+)/.exec(r.media.label || '')?.[1] || 'original'),
                    label: r.media.label || '',
                    count: r.points.length,
                    media: r.media,
                    points: r.points,
                    originSongKey: sib.key,
                    originTabName: sib.tabName || sib.filename || sib.key,
                    originSourceWebsite: sib.sourceWebsite || null,
                    originSourceUrl: sib.sourceUrl || null
                });
            }
        }
    }

    return out;
}

/**
 * Copy one synced video + sync points from a sibling tab to this tab file, recording origin.
 */
export function copySyncedVideoFromSibling(siblingVideo) {
    if (!siblingVideo || !getSongKey()) return false;
    const origin = {
        fromSongKey: siblingVideo.originSongKey,
        fromTabName: siblingVideo.originTabName,
        fromSourceWebsite: siblingVideo.originSourceWebsite || null,
        copiedAt: Date.now()
    };
    const media = {
        ...siblingVideo.media,
        origin
    };
    const record = saveRecord(getSongKey(), media, siblingVideo.points);
    if (record) {
        if (siblingVideo.isLocal) {
            // The file itself is shared: link it to this song so it plays here when it is on this device
            import('./audioSync/audioFileStore.js')
                .then(({ linkAudioFile }) => linkAudioFile(media.audioId, getSongKey()))
                .catch(() => { /* not on this device: it shows as a file to relink */ })
                .finally(() => {
                    window.dispatchEvent(new CustomEvent('audiofiles:changed'));
                    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
                });
        } else {
            window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
            bindSyncedVideo(siblingVideo.videoId);
        }
        return true;
    }
    return false;
}

/**
 * Delete synced videos & associated sync points from this tab, supporting multi-select deletion.
 */
export function deleteSyncedVideos(videoIds) {
    if (!Array.isArray(videoIds) || !videoIds.length || !getSongKey()) return 0;
    const records = listRecords(getSongKey());
    let deletedCount = 0;
    let deletedActive = false;

    for (const r of records) {
        if (r.media?.kind === 'youtube' && videoIds.includes(r.media.videoId)) {
            deleteRecord(getSongKey(), r.media);
            deletedCount++;
            if (playerState.currentVideoId === r.media.videoId) {
                deletedActive = true;
            }
            for (const mode of ['original', 'backing']) {
                if (localStorage.getItem(getStorageKey(mode)) === r.media.videoId) {
                    localStorage.removeItem(getStorageKey(mode));
                }
            }
        }
    }

    if (deletedCount > 0) {
        if (deletedActive) {
            playerState.currentVideoId = null;
            applySyncedDefaults({ reload: true });
        }
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        renderSyncedVideos();
    }

    return deletedCount;
}

/** The synced video to use for a track mode: backing for Backing, the untagged original for Original. */
function pickSyncedVideo(mode) {
    const videos = getSyncedVideos();
    return videos.find(v => v.kind === (mode === 'backing' ? 'backing' : 'original')) || null;
}

const pickMarkerKey = (mode) => `yt_pick_${encodeURIComponent(getSongKey().toLowerCase())}_${mode}`;
function markUserPick(mode = playerState.trackMode) {
    try { localStorage.setItem(pickMarkerKey(mode), '1'); } catch { /* optional */ }
}

/**
 * When a song gets sync points (a tab download), a video found by search is replaced by the matching synced
 * one. A video the user chose is kept.
 */
export function applySyncedDefaults({ reload = true } = {}) {
    if (!getSongKey()) return;
    const synced = new Set(getSyncedVideos().map(v => v.videoId));
    let changedCurrent = false;
    for (const mode of ['original', 'backing']) {
        const pick = pickSyncedVideo(mode);
        if (!pick) continue;
        const saved = localStorage.getItem(getStorageKey(mode));
        const userPicked = !!localStorage.getItem(pickMarkerKey(mode));
        if (saved && (synced.has(saved) || userPicked)) {
            // Another listener may have stored the synced pick already (reload: false) while the panel is still
            // searching or showing something else, so the pick still has to reach the screen.
            const pending = !userPicked && saved === pick.videoId && mode === playerState.trackMode
                && (playerState.isSearching || playerState.currentVideoId !== pick.videoId);
            if (!pending) continue;
        } else {
            localStorage.setItem(getStorageKey(mode), pick.videoId);
        }
        if (mode === playerState.trackMode) changedCurrent = true;
    }
    if (changedCurrent && reload && playerState.isOpen && !playerState.isPlaying) {
        // A search for this song is still running: drop it, the synced video replaces its result
        if (playerState.isSearching) cancelYouTubeSearch();
        if (playerState.currentVideoId !== localStorage.getItem(getStorageKey())) setVideoId(null, 'auto');
        loadCurrentTrack(false);
    }
}

// --- The videos remembered for this recording -------------------------------------------------------------------

const slotOfKind = (kind) => (kind === 'backing' ? 'backing' : 'original');
let lastRememberedId = null;
let removeMode = false;
let armedRemoval = null;
let armedCopy = null;
let armTimer = 0;

/** Remembers the video that is loaded as a choice for the current slot (not a Jam video, which belongs to the host). */
function rememberCurrentVideo() {
    const id = playerState.currentVideoId;
    const songKey = getSongKey();
    if (!id || !songKey || playerState.videoSource === 'jam') return;
    if (lastRememberedId === `${songKey}|${playerState.trackMode}|${id}`) return;
    lastRememberedId = `${songKey}|${playerState.trackMode}|${id}`;
    const synced = new Set(getSyncedVideos().map((v) => v.videoId));
    // Added by the person (a link or a search): say so, since the list below is where it now is
    const isNew = playerState.videoSource === 'user' && !getVideoChoices().some((c) => c.videoId === id && c.lastUsedAt > 1);
    rememberVideo(songKey, playerState.trackMode, id, (vid) => synced.has(vid));
    if (isNew) showToast('Added to the list of videos');
    if (document.getElementById('ytVideoSection') && !document.getElementById('ytVideoSection').hidden) renderSyncedVideos();
}

/**
 * The videos to offer for a slot, most recently used first: the ones remembered, the saved one, and the ones with sync
 * points for this tab. Each carries its own sync points (count).
 */
export function getVideoChoices(slot = playerState.trackMode) {
    const songKey = getSongKey();
    if (!songKey) return [];
    const byId = new Map();
    const add = (videoId, at, extra = {}) => {
        const prev = byId.get(videoId) || { videoId, lastUsedAt: 0, count: 0 };
        byId.set(videoId, { ...prev, ...extra, lastUsedAt: Math.max(prev.lastUsedAt, at || 0) });
    };
    listHistory(songKey, slot).forEach((e) => add(e.videoId, e.lastUsedAt));
    const saved = localStorage.getItem(getStorageKey(slot));
    if (saved) add(saved, 1);
    getSyncedVideos().filter((v) => slotOfKind(v.kind) === slot).forEach((v) => add(v.videoId, v.updatedAt, { count: v.count, origin: v.origin }));
    return [...byId.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

const videoTitle = (id) => getVideoInfo(id)?.title || 'Loading…';
const videoSubline = (id, count) => [getVideoInfo(id)?.author, count ? `Synced · ${count} ${count === 1 ? 'point' : 'points'}` : 'Not synced'].filter(Boolean).join(' · ');

const songKeyNow = () => getSongKey();
function disarm() { clearTimeout(armTimer); armedRemoval = null; armedCopy = null; }
function arm(kind, id) {
    disarm();
    if (kind === 'remove') armedRemoval = id; else armedCopy = id;
    armTimer = setTimeout(() => { disarm(); renderSyncedVideos(); }, 4000);
}

function videoRow({ videoId, count }, current, { remove = false } = {}) {
    const row = document.createElement('div');
    row.className = 'vrow';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', videoId === current ? 'true' : 'false');
    btn.dataset.videoId = videoId;
    const rd = document.createElement('span'); rd.className = 'rd'; rd.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span'); t.className = 't';
    const b = document.createElement('b'); b.textContent = videoTitle(videoId);
    const sub = document.createElement('span'); sub.textContent = videoSubline(videoId, count);
    t.append(b, sub);
    btn.append(rd, t);
    row.append(btn);
    if (remove) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn rec-text-btn vrow-remove';
        rm.dataset.removeVideoId = videoId;
        rm.textContent = armedRemoval === videoId ? `Delete ${count} sync points too?` : 'Remove';
        if (armedRemoval === videoId) rm.classList.add('is-armed');
        row.append(rm);
    }
    return row;
}

/** The list of remembered videos in the Original panel (and the copy picker). Not async work for the caller to wait on. */
export async function renderSyncedVideos() {
    const wrap = document.getElementById('ytVideoSection');
    const list = document.getElementById('ytVideoList');
    if (!wrap || !list) return;

    const choices = getVideoChoices();
    let siblingVideos = [];
    try { siblingVideos = await getSiblingSyncedVideos(); } catch { /* optional */ }
    wrap.hidden = choices.length === 0 && siblingVideos.length === 0;
    const editBtn = document.getElementById('ytEditVideosBtn');
    if (editBtn) { editBtn.hidden = choices.length === 0; editBtn.textContent = removeMode ? 'Done' : 'Remove videos…'; editBtn.setAttribute('aria-pressed', removeMode ? 'true' : 'false'); }
    if (choices.length === 0) removeMode = false;
    const copyTabBtn = document.getElementById('ytCopyFromOtherTabBtn');
    if (copyTabBtn) copyTabBtn.hidden = siblingVideos.length === 0;
    if (wrap.hidden) return;

    const current = localStorage.getItem(getStorageKey()) || playerState.currentVideoId;
    list.textContent = '';
    choices.forEach((c) => {
        list.appendChild(videoRow(c, current, { remove: removeMode }));
        if (!getVideoInfo(c.videoId)) lookupVideoInfo(c.videoId);
    });

    const activeVideo = getSyncedVideos().find((v) => v.videoId === current);
    const originInfo = document.getElementById('ytSyncedOriginInfo');
    if (originInfo) {
        const o = activeVideo?.origin;
        originInfo.hidden = !o;
        originInfo.textContent = o ? (o.fromAudioId ? `Sync points copied from ${o.fromAudioName || 'an audio file'}` : o.fromVideoId ? `Sync points copied from ${getVideoInfo(o.fromVideoId)?.title || 'another video'}` : `Copied from tab: ${o.fromTabName || o.fromSongKey || ''}`) : '';
    }

    // Copy sync points between this tab's videos: into the current video, from another one that has points
    // (from any recording of the song with points: another video or an audio file)
    const sources = listRecords(songKeyNow()).filter((r) => r.points.length && mediaKey(r.media) !== `yt_${current}`);
    const copyBtn = document.getElementById('ytCopyBetweenBtn');
    const picker = document.getElementById('ytCopyPicker');
    const showCopy = Boolean(current) && sources.length > 0;
    if (copyBtn) copyBtn.hidden = !showCopy;
    if (picker && !showCopy) picker.hidden = true;
    const pickerList = document.getElementById('ytCopyPickerList');
    if (pickerList && picker && !picker.hidden) {
        pickerList.textContent = '';
        const mine = getSyncedVideos().find((v) => v.videoId === current);
        sources.forEach((r) => {
            const key = mediaKey(r.media);
            const isLocal = r.media.kind === 'local';
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'slot vrow-copy';
            row.dataset.copyFrom = key;
            const t = document.createElement('span'); t.className = 't';
            const b = document.createElement('b');
            b.textContent = armedCopy === key ? `Replace ${mine?.count || 0} sync points?` : (isLocal ? (r.media.name || 'Audio file') : videoTitle(r.media.videoId));
            const sub = document.createElement('span');
            sub.textContent = isLocal ? `Audio file · ${r.points.length} ${r.points.length === 1 ? 'point' : 'points'}` : videoSubline(r.media.videoId, r.points.length);
            t.append(b, sub);
            row.append(t);
            if (armedCopy === key) row.classList.add('is-armed');
            pickerList.appendChild(row);
            if (!isLocal && !getVideoInfo(r.media.videoId)) lookupVideoInfo(r.media.videoId);
        });
    }
}

/** Copies the sync points of one of this tab's videos onto the current one (the times are copied as they are). */
function copyPointsBetweenVideos(fromKey) {
    const songKey = getSongKey();
    const toVideoId = localStorage.getItem(getStorageKey()) || playerState.currentVideoId;
    const from = listRecords(songKey).find((r) => mediaKey(r.media) === fromKey);
    if (!songKey || !toVideoId || !from) return;
    const origin = from.media.kind === 'local'
        ? { fromAudioId: from.media.audioId, fromAudioName: from.media.name, fromSongKey: songKey, copiedAt: Date.now() }
        : { fromVideoId: from.media.videoId, fromSongKey: songKey, copiedAt: Date.now() };
    const media = { kind: 'youtube', videoId: toVideoId, origin };
    if (saveRecord(songKey, media, from.points)) {
        window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        const picker = document.getElementById('ytCopyPicker');
        if (picker) picker.hidden = true;
        document.getElementById('ytCopyBetweenBtn')?.setAttribute('aria-expanded', 'false');
        renderSyncedVideos();
    }
}

/** Removes a video from the list, and its sync points with it; if it was the current one, the next most recent takes over. */
function removeVideoChoice(videoId) {
    const songKey = getSongKey();
    if (!songKey || !videoId) return;
    const wasCurrent = playerState.currentVideoId === videoId || localStorage.getItem(getStorageKey()) === videoId;
    for (const slot of ['original', 'backing']) {
        forgetVideo(songKey, slot, videoId);
        if (localStorage.getItem(getStorageKey(slot)) === videoId) localStorage.removeItem(getStorageKey(slot));
    }
    deleteRecord(songKey, { kind: 'youtube', videoId });
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
    disarm();
    if (wasCurrent) {
        const next = getVideoChoices().find((c) => c.videoId !== videoId);
        if (next) bindSyncedVideo(next.videoId); else removeYouTubeVideo();
    }
    renderSyncedVideos();
}

function initVideoList() {
    document.getElementById('ytVideoList')?.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-remove-video-id]');
        if (rm) {
            e.stopPropagation();
            const id = rm.dataset.removeVideoId;
            const count = getVideoChoices().find((c) => c.videoId === id)?.count || 0;
            // A video with sync points takes a second press: it would delete them
            if (count > 0 && armedRemoval !== id) { arm('remove', id); renderSyncedVideos(); return; }
            removeVideoChoice(id);
            return;
        }
        const row = e.target.closest('[data-video-id]');
        if (row && !removeMode) bindSyncedVideo(row.dataset.videoId);
    });
    document.getElementById('ytEditVideosBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeMode = !removeMode;
        disarm();
        renderSyncedVideos();
    });
    document.getElementById('ytCopyBetweenBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const picker = document.getElementById('ytCopyPicker');
        if (!picker) return;
        picker.hidden = !picker.hidden;
        e.currentTarget.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
        disarm();
        renderSyncedVideos();
    });
    document.getElementById('ytCopyPickerList')?.addEventListener('click', (e) => {
        const row = e.target.closest('[data-copy-from]');
        if (!row) return;
        e.stopPropagation();
        const id = row.dataset.copyFrom;
        const current = localStorage.getItem(getStorageKey()) || playerState.currentVideoId;
        const mine = getSyncedVideos().find((v) => v.videoId === current);
        if (mine?.count > 0 && armedCopy !== id) { arm('copy', id); renderSyncedVideos(); return; }
        disarm();
        copyPointsBetweenVideos(id);
    });
    window.addEventListener(SYNC_CHANGED_EVENT, () => renderSyncedVideos());
}

export function bindSyncedVideo(videoId) {
    if (!videoId) return;
    if (playerState.isSearching) cancelYouTubeSearch();
    localStorage.setItem(getStorageKey(), videoId);
    clearVideoRemoved();
    markUserPick();
    loadCurrentTrack(playerState.isPlaying || playerState.hasStarted, { videoId, source: 'user' });
    renderSyncedVideos();
    emitYouTubeEvent('info', { videoId });
}

function updatePanelTitle() {
    renderSyncedVideos();
    const titleEl = document.getElementById('ytPanelTitle');
    const promptTitle = document.getElementById('ytPromptTitle');
    const searchExternalBtn = document.getElementById('ytSearchExternalBtn');
    const externalLink = document.getElementById('ytExternalLink');

    const songLabel = [playerState.artist, playerState.title].filter(Boolean).join(' - ') + ' song';
    const modeLabel = playerState.trackMode === 'backing' ? 'Backing Track' : 'Original';
    const sheetName = document.getElementById('ytSheetName');
    if (sheetName) sheetName.textContent = `${playerState.trackMode === 'backing' ? 'Backing track' : 'Original recording'} · ${getSongKey() || 'No song'}`;
    const query = buildQuery();
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    if (titleEl) {
        titleEl.textContent = `${songLabel} (${modeLabel})`;
    }

    if (promptTitle) {
        promptTitle.textContent = `${songLabel} (${modeLabel})`;
    }

    if (searchExternalBtn) {
        searchExternalBtn.href = searchUrl;
    }

    if (externalLink) {
        if (playerState.currentVideoId) {
            externalLink.href = `https://www.youtube.com/watch?v=${playerState.currentVideoId}`;
        } else {
            externalLink.href = searchUrl;
        }
    }
}

export function updateYouTubePanelPosition() {
    const panel = document.getElementById('ytDropdownPanel');
    const toggleBtn = document.getElementById('ytToggleBtn');
    if (!panel || !playerState.isOpen) return;

    const mobileDock = document.getElementById('mobilePlaybackDock');
    const isMobileDockActive = window.innerWidth <= 576 || (mobileDock && window.getComputedStyle(mobileDock).display !== 'none');

    if (isMobileDockActive && mobileDock) {
        panel.classList.add('popup-from-bottom');
        const dockRect = mobileDock.getBoundingClientRect();
        const bottomOffset = dockRect.top > 0 ? Math.max(12, Math.round(window.innerHeight - dockRect.top + 8)) : 76;
        panel.style.position = 'fixed';
        panel.style.top = 'auto';
        panel.style.bottom = `${bottomOffset}px`;
        panel.style.left = '50%';
        panel.style.transform = 'translateX(-50%)';
        return;
    }

    panel.classList.remove('popup-from-bottom');
    panel.style.bottom = 'auto';
    if (!toggleBtn) return;
    const rect = toggleBtn.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 8}px`;
    const centerX = rect.left + rect.width / 2;
    const halfPanelWidth = Math.min(190, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Toggle the dropdown panel open/closed
 */
export function toggleYouTubePanel(forceState = null) {
    const panel = document.getElementById('ytDropdownPanel');
    const toggleBtn = document.getElementById('ytToggleBtn');
    const mobileBtn = document.getElementById('mobileYtToggleBtn');
    const chevron = document.getElementById('ytPillChevron');

    if (!panel) return;

    const newState = forceState !== null ? forceState : !playerState.isOpen;
    playerState.isOpen = newState;

    if (newState) {
        setActiveAudioMode('youtube');
        // Ensure Synth / SoundFont panel and Score Options panel are closed and synth playback paused when opening YouTube panel
        toggleSynthPanel(false);
        toggleScoreOptionsPanel(false);
        document.getElementById('pdfBookmarksPanelCloseBtn')?.click();
        pauseSynthPlayer();
        clearSynthHighlights();
        // The Original panel and the video are never on the screen together: opening the panel pauses the audio and
        // closes the video sheet. Pressing play closes the panel and, for YouTube, brings the sheet back.
        sheetClosedAt = performance.now();
        pauseYouTube();
        closeSheet();
        window.dispatchEvent(new Event('original-panel-open'));

        updateYouTubePanelPosition();
        showPanel(panel, 'block');
        if (chevron) {
            chevron.className = 'bi-chevron-up ms-1';
        }
        toggleBtn?.classList.add('active');
        mobileBtn?.classList.add('active');
        updateQueryInputUI();

        // Load the saved or searched video in the background so the panel can say what it found (the source line
        // and its sync state). It is not shown and does not play: the video sheet opens when playback starts.
        const iframe = document.getElementById('ytIframe');
        if (!iframe?.dataset.loaded && !playerState.currentVideoId && !playerState.isSearching) {
            loadCurrentTrack(false);
        }
    } else {
        hidePanel(panel);
        panel.classList.remove('popup-from-bottom');
        if (chevron) {
            chevron.className = 'bi-chevron-down ms-1';
        }
        toggleBtn?.classList.remove('active');
        mobileBtn?.classList.remove('active');
    }
    syncNativeMacPlayerBounds();
}

/**
 * Update visibility and state of playback buttons in top bar
 */
function updatePlaybackControls() {
    updateGlobalRewindButton();
}

/**
 * Called when a new file or score metadata is loaded in the app
 */
export function updateSongForYouTube({
    filename = '',
    scoreTitle = '',
    scoreArtist = '',
    librarySongId = null,
    tabName = '',
    sourceWebsite = null,
    sourceUrl = null
} = {}) {
    if (activeSearchController) {
        activeSearchController.abort();
        activeSearchController = null;
    }
    const { artist, title } = parseSongInfo(filename, scoreTitle, scoreArtist);

    playerState.artist = artist;
    playerState.title = title;
    playerState.filename = filename;
    playerState.librarySongId = librarySongId || null;
    playerState.tabName = tabName || filename || '';
    playerState.sourceWebsite = sourceWebsite || null;
    playerState.sourceUrl = sourceUrl || null;
    rememberSongKey(playerState.librarySongId, getSongKey(), {
        filename: playerState.filename,
        tabName: playerState.tabName,
        sourceWebsite: playerState.sourceWebsite,
        sourceUrl: playerState.sourceUrl
    });
    playerState.customQueries = { original: '', backing: '' };
    playerState.customQuery = '';
    setVideoId(null, 'song');
    playerState.currentTime = 0;
    playerState.isPlaying = false;
    playerState.hasStarted = false;
    playerState.isSearching = false;

    // A new song closes the video sheet (which pauses) and forgets that it was lowered
    closeSheet();
    resetPeek();

    // Show YouTube toggle button in audio source pill
    const ytBtn = document.getElementById('ytToggleBtn');
    if (ytBtn) {
        ytBtn.style.display = 'inline-flex';
    }

    // Synced videos become the saved Original and Backing videos (no search)
    applySyncedDefaults({ reload: false });

    // A song with sync points opens on its recording; otherwise the synth is selected
    setActiveAudioMode(songHasSyncPoints(getSongKey()) ? 'real' : 'synth');

    updatePlaybackControls();

    // Default to Original Song radio (checked)
    const originalRadio = document.getElementById('ytTrackOriginal');
    if (originalRadio) {
        originalRadio.checked = true;
    }
    playerState.trackMode = 'original';

    // Reset iframe dataset.loaded and loading indicator
    const iframe = document.getElementById('ytIframe');
    if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
        iframe.style.visibility = 'visible';
        delete iframe.dataset.loaded;
    }
    syncNativeMacPlayerBounds();
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    if (loadingIndicator) {
        loadingIndicator.style.setProperty('display', 'none', 'important');
    }

    updatePanelTitle();
    updateQueryInputUI();

    // If panel is already open, reload with new song
    if (playerState.isOpen) {
        loadCurrentTrack(false);
    }
}

/**
 * Initialize YouTube Player controls and event listeners
 */
export function initYouTubePlayer() {
    const toggleBtn = document.getElementById('ytToggleBtn');
    const closeBtn = document.getElementById('ytPanelCloseBtn');
    const cancelSearchBtn = document.getElementById('ytCancelSearchBtn');
    const originalRadio = document.getElementById('ytTrackOriginal');
    const backingRadio = document.getElementById('ytTrackBacking');
    const ytApiKeyInput = document.getElementById('ytApiKeyInput');

    // Load saved API Key if any
    if (ytApiKeyInput) {
        ytApiKeyInput.value = localStorage.getItem('youtubeApiKey') || '';
        ytApiKeyInput.addEventListener('change', () => {
            const key = ytApiKeyInput.value.trim();
            if (key) {
                localStorage.setItem('youtubeApiKey', key);
            } else {
                localStorage.removeItem('youtubeApiKey');
            }
        });
    }

    // Toggle button in top bar
    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        pauseSynthPlayer();
        clearSynthHighlights();
        toggleYouTubePanel();
    });

    window.addEventListener('resize', () => {
        if (playerState.isOpen) updateYouTubePanelPosition();
        syncNativeMacPlayerBounds();
    });

    // The video sheet: closing it pauses (a player that is not shown must not play), and the native player follows it.
    initYtSheet({
        onClose: () => { sheetClosedAt = performance.now(); pauseYouTube(); },
        // Back in the reader with Original (YouTube) selected: its video is on the screen again
        onReaderShown: () => {
            const original = document.getElementById('mobileYtToggleBtn')?.classList.contains('active-audio-mode');
            const youtube = document.getElementById('realAudioSourceYt')?.classList.contains('active');
            if (original && youtube) scheduleOriginalVideo(true);
        }
    });
    onSheetChange(() => { if (isNativeOverlayPlayer()) animateNativeMacPlayerBounds(); else syncNativeMacPlayerBounds(); });
    // The fretboard (and the panels' space) moving the sheet: the native player, which draws above the page, moves with it
    if (isNativeOverlayPlayer()) {
        new MutationObserver(() => { if (isVideoShown()) animateNativeMacPlayerBounds(); })
            .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    // A tap on the grabber, or the sheet fading in or out: the native player follows from the first frame of the CSS transition
    onSheetTransition(() => { if (isNativeOverlayPlayer()) animateNativeMacPlayerBounds(); });
    // While the sheet is dragged the native player follows every frame, not just when the drag ends
    let moveQueued = false;
    onSheetMove(() => {
        if (!isNativeOverlayPlayer() || moveQueued) return;
        moveQueued = true;
        requestAnimationFrame(() => { moveQueued = false; syncNativeMacPlayerBounds(); });
    });

    // Close button in panel
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleYouTubePanel(false);
    });

    document.getElementById('ytRetrySearchBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.currentTarget.hidden = true;
        loadCurrentTrack(false);
    });

    // Cancel search button in loading state
    cancelSearchBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelYouTubeSearch();
    });

    initVideoList();

    // Initialize synced videos management and copy modals
    import('./audioSync/syncedVideosModal.js').then(({ initSyncedVideosModals }) => {
        initSyncedVideosModals();
    }).catch(() => {});

    // Track Mode Selector (Original vs Backing)
    originalRadio?.addEventListener('change', () => {
        if (originalRadio.checked) setYouTubeTrackMode('original');
    });

    backingRadio?.addEventListener('change', () => {
        if (backingRadio.checked) setYouTubeTrackMode('backing');
    });

    // Query Override and Redo Search controls
    const queryInput = document.getElementById('ytSearchQueryInput');
    const redoSearchBtn = document.getElementById('ytRedoSearchBtn');
    const resetQueryBtn = document.getElementById('ytResetQueryBtn');

    resetQueryBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        redoSearchWithQuery(getDefaultQuery(playerState.trackMode));
    });

    // One field for adding a video: a YouTube link or video ID is added as it is, anything else is a search whose first
    // match is added. Either way the video goes onto the list of videos for this recording.
    const handleInput = () => {
        const text = (queryInput?.value || '').trim();
        if (!text) return;

        if (playerState.isSearching) {
            cancelYouTubeSearch();
        }

        const videoId = extractVideoId(text);
        if (videoId) {
            setVideoId(videoId, 'user');
            localStorage.setItem(getStorageKey(), videoId);
            clearVideoRemoved();
            markUserPick();
            loadCurrentTrack(true, { source: 'user' });
            updateQueryInputUI(); // the field goes back to the search text; the video is on the list
            emitYouTubeEvent('info', { videoId }); // the Original recording row names the new video
        } else {
            redoSearchWithQuery(text);
        }
    };

    redoSearchBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleInput();
    });
    queryInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleInput();
        }
    });
    // A pasted link is added at once; pasted words are left for the person to edit and search
    queryInput?.addEventListener('paste', () => {
        setTimeout(() => { if (extractVideoId((queryInput.value || '').trim())) handleInput(); }, 50);
    });

    // Listen for YouTube iframe postMessage events (currentTime and player state)
    window.addEventListener('message', (event) => {
        try {
            let data = event.data;
            if (typeof data === 'string') {
                data = JSON.parse(data);
            }
            if (!data || typeof data !== 'object') return;

            let stateChanged = false;
            let timeChanged = false;

            // The first message after the handshake (initialDelivery) carries the video's title and channel
            if (data.event === 'initialDelivery' && data.info) captureVideoData(data.info);

            // YouTube iframe API sends infoDelivery messages with currentTime & playerState
            if (data.event === 'infoDelivery' && data.info) {
                captureVideoData(data.info);
                // The player resets to full volume on each load; push the master level when it differs
                if (typeof data.info.volume === 'number' && Math.abs(data.info.volume - getMasterVolume() * 100) > 1) applyYouTubeVolume();
                if (typeof data.info.duration === 'number' && data.info.duration > 0) playerState.duration = data.info.duration;
                if (typeof data.info.currentTime === 'number') {
                    playerState.currentTime = data.info.currentTime;
                    // currentTimeLastUpdated_ is the wall clock (s) at which currentTime was sampled.
                    const sampledAgoMs = Date.now() - Number(data.info.currentTimeLastUpdated_) * 1000;
                    timeReportedAt = performance.now() - (sampledAgoMs >= 0 && sampledAgoMs < 5000 ? sampledAgoMs : 0);
                    timeChanged = true;
                }
                if (typeof data.info.playbackRate === 'number' && data.info.playbackRate !== playerState.playbackRate) {
                    playerState.playbackRate = data.info.playbackRate;
                    emitYouTubeEvent('rate', { rate: data.info.playbackRate });
                }
                if (typeof data.info.playerState === 'number') {
                    reportYouTubeState(data.info.playerState);
                    const playing = (data.info.playerState === 1);
                    if (playing) {
                        playerState.hasStarted = true;
                        pauseSynthPlayer();
                        clearSynthHighlights();
                        setActiveAudioMode('youtube');
                    }
                    if (playerState.isPlaying !== playing) {
                        playerState.isPlaying = playing;
                        stateChanged = true;
                    }
                }
            } else if (data.event === 'onStateChange' && typeof data.info === 'number') {
                reportYouTubeState(data.info);
                const playing = (data.info === 1);
                if (playing) {
                    playerState.hasStarted = true;
                    pauseSynthPlayer();
                    clearSynthHighlights();
                    setActiveAudioMode('youtube');
                }
                if (playerState.isPlaying !== playing) {
                    playerState.isPlaying = playing;
                    stateChanged = true;
                }
            }

            if (stateChanged) {
                updatePlaybackControls();
            }
            if (timeChanged) {
                emitYouTubeEvent('time', { timeSec: playerState.currentTime, playing: reportedPlaying });
            }
        } catch (e) {
            // Ignore non-JSON messages from other sources
        }
    });

    if (isNativeOverlayPlayer()) {
        window.__TAURI__.event.listen('youtube-player-state', ({ payload }) => {
            window.dispatchEvent(new MessageEvent('message', { data: payload }));
        });
    }

    if (window.__TAURI__) {
        window.__TAURI__.event.listen('youtube-auth-completed', () => {
            const iframe = document.getElementById('ytIframe');
            if (iframe && iframe.src) {
                iframe.src = iframe.src;
            }
            if (playerState.currentVideoId) {
                loadCurrentTrack(playerState.isPlaying || playerState.hasStarted);
            }
        });
    }

    const iframe = document.getElementById('ytIframe');
    if (iframe) {
        iframe.addEventListener('load', () => {
            if (isNativeOverlayPlayer()) return;
            try {
                sendYouTubeMessage(iframe, { event: 'listening', id: 1 });
                sendYouTubeMessage(iframe, {
                    event: 'command',
                    func: 'addEventListener',
                    args: ['onStateChange']
                });
                if (playerState.isPlaying || playerState.hasStarted) {
                    sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
                }
            } catch (e) {
                // Ignore cross-origin error if any
            }
        });
    }

    // Guard: a playing video is always on the screen, at least 200 x 200, and not covered. Anything that left it
    // hidden (a bug, a path that did not open the sheet) is put right here instead of playing out of sight.
    setInterval(() => {
        if (!(reportedPlaying || playerState.isPlaying)) return;
        if (performance.now() - sheetClosedAt < 2500) return;
        if (!isVideoShown()) { showSheet(); return; }
        const wrap = document.getElementById('ytPlayerWrapper');
        const r = wrap?.getBoundingClientRect();
        if (r && (r.width < 200 || r.height < 200)) console.warn('[YouTube] the player is smaller than 200 x 200:', Math.round(r.width), 'x', Math.round(r.height));
        if (r && r.width && r.height) {
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (top && !wrap.contains(top)) console.warn('[YouTube] something covers the player:', top.id || top.className);
        }
    }, 1000);

    // Periodically send listening event to iframe to ensure continuous time & state updates
    setInterval(() => {
        if (playerState.isOpen || playerState.hasStarted) {
            const currentIframe = document.getElementById('ytIframe');
            if (currentIframe && currentIframe.contentWindow) {
                try {
                    sendYouTubeMessage(currentIframe, { event: 'listening', id: 1 });
                } catch (e) {
                    // Ignore cross-origin error if any
                }
            }
        }
    }, 1000);

    if (isNativeOverlayPlayer()) {
        const syncBounds = () => syncNativeMacPlayerBounds();
        if (typeof ResizeObserver !== 'undefined' && iframe) {
            new ResizeObserver(syncBounds).observe(iframe);
        }
        window.addEventListener('resize', syncBounds);
        window.addEventListener('scroll', syncBounds, true);
    }

    // The panel stays open until the Synth or Original button (or its close control) is pressed; clicks on the score do not close it.

    // Sync points can arrive after the song opened (a tab fetched with its sync data attaches them once the score is
    // ready). Until something has played, the sound the transport will use follows them: the Original recording.
    window.addEventListener(SYNC_CHANGED_EVENT, () => {
        if (!getSongKey() || playerState.hasStarted || playerState.isPlaying || isSynthPlaying()) return;
        applySyncedDefaults({ reload: false });
        if (songHasSyncPoints(getSongKey())) setActiveAudioMode('real');
        updatePlaybackControls();
    });

    updatePlaybackControls();
}


// --- Jam Mode remote control -----------------------------------------------

/** A new embed needs to be on the screen to play, so a Jam load or play opens the video sheet. */
function revealUntilPlaying() {
    showSheet();
}

let jamYouTubeMuted = false;
function applyJamYouTubeMute() {
    const iframe = document.getElementById('ytIframe');
    if (iframe?.dataset.loaded === 'true') {
        sendYouTubeMessage(iframe, { event: 'command', func: jamYouTubeMuted ? 'mute' : 'unMute', args: [] });
    }
}

export const jamYouTubeControl = {
    /** Jam host's "mute guests" option; re-applied on play since a reloaded embed resets it. */
    setMuted(on) {
        jamYouTubeMuted = Boolean(on);
        applyJamYouTubeMute();
    },
    snapshot() {
        return {
            videoId: playerState.currentVideoId,
            playing: reportedPlaying,
            buffering: reportedState === 3,
            timeSec: currentYouTubeTime(),
            rate: playerState.playbackRate || 1
        };
    },
    /** Whether this embed has started playing at least once (later starts aren't autoplay-gated). */
    hasPlayed: () => iframePlayed,
    /** Load `videoId` at `timeSec` without saving it as this song's choice. */
    load(videoId, { playing = false, timeSec = 0 } = {}) {
        if (activeSearchController) {
            activeSearchController.abort();
            activeSearchController = null;
        }
        playerState.isSearching = false;
        playerState.currentTime = Math.max(0, timeSec || 0);
        timeReportedAt = performance.now();
        loadCurrentTrack(playing, { videoId, source: 'jam' });
        if (videoId && playing) revealUntilPlaying();
    },
    play() {
        if (!playerState.currentVideoId) return;
        const iframe = document.getElementById('ytIframe');
        pauseSynthPlayer();
        clearSynthHighlights();
        setActiveAudioMode('youtube');
        if (iframe?.dataset.loaded === 'true') {
            if (jamYouTubeMuted) applyJamYouTubeMute();
            sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
            playerState.isPlaying = true;
            playerState.hasStarted = true;
            updatePlaybackControls();
        } else {
            loadCurrentTrack(true, { videoId: playerState.currentVideoId, source: 'jam' });
            if (jamYouTubeMuted) setTimeout(applyJamYouTubeMute, 800);
        }
        revealUntilPlaying();
    },
    pause() {
        pauseYouTube();
    },
    seek(timeSec) {
        const t = Math.max(0, timeSec || 0);
        playerState.currentTime = t;
        timeReportedAt = performance.now();
        const iframe = document.getElementById('ytIframe');
        if (iframe?.dataset.loaded === 'true') {
            sendYouTubeMessage(iframe, { event: 'command', func: 'seekTo', args: [t, true] });
        }
    },
    setRate(rate) {
        setYouTubePlaybackRate(rate);
    }
};

export function setYouTubePlaybackRate(rate) {
    if (!Number.isFinite(rate)) return;
    playerState.playbackRate = rate;
    const iframe = document.getElementById('ytIframe');
    if (iframe?.dataset.loaded === 'true') {
        sendYouTubeMessage(iframe, { event: 'command', func: 'setPlaybackRate', args: [rate] });
    }
}
