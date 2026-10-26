// youtubePlayer.js
// Collapsible YouTube / Backing Track player integrated into top bar
import { pauseSynthPlayer, clearSynthHighlights, toggleSynthPanel, toggleScoreOptionsPanel } from './gpProcessor/gpPlayer.js';
import { updateGlobalRewindButton, setActiveAudioMode } from './utils/navigationUtils.js';

let activeSearchController = null;

let playerState = {
    isOpen: false,
    trackMode: 'original', // Default to 'original' (left button)
    artist: '',
    title: '',
    filename: '',
    customQueries: { original: '', backing: '' },
    customQuery: '',
    currentVideoId: null,
    currentTime: 0,
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
    // A new (or no) embed: the old iframe won't report that it stopped.
    iframePlayed = false;
    reportedPlaying = false;
    reportedState = -1;
    emitYouTubeEvent('video', { videoId, source });
}

function reportYouTubeState(state) {
    reportedState = state;
    if (state === 3) return; // buffering: keep the previous playing / paused state
    const playing = state === 1;
    if (playing) iframePlayed = true;
    if (playing !== reportedPlaying) {
        reportedPlaying = playing;
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

function sendYouTubeMessage(iframe, message) {
    if (isNativeOverlayPlayer()) {
        window.__TAURI__.core.invoke('youtube_player_command', { message }).catch(() => {});
        return;
    }
    iframe?.contentWindow?.postMessage(JSON.stringify(message), '*');
}

function syncNativeMacPlayerBounds(autoplay = false) {
    if (!isNativeOverlayPlayer()) return;

    const iframe = document.getElementById('ytIframe');
    const rect = iframe?.getBoundingClientRect();
    const visible = Boolean(
        playerState.isOpen &&
        playerState.currentVideoId &&
        iframe?.dataset.loaded === 'true' &&
        rect?.width &&
        rect?.height
    );

    window.__TAURI__.core.invoke('youtube_player_update', {
        videoId: playerState.currentVideoId || '',
        autoplay,
        start: Math.floor(playerState.currentTime || 0),
        left: rect?.left || 0,
        top: rect?.top || 0,
        width: rect?.width || 0,
        height: rect?.height || 0,
        visible,
        keepAlive: playerState.isPlaying || playerState.hasStarted
    }).catch(() => {});
}

function animateNativeMacPlayerBounds() {
    const stopAt = performance.now() + 320;
    let lastUpdate = 0;
    const update = (time) => {
        if (time - lastUpdate >= 32 || time >= stopAt) {
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

    if (playerState.isPlaying) {
        sendYouTubeMessage(iframe, { event: 'command', func: 'pauseVideo', args: [] });
        playerState.isPlaying = false;
    } else {
        pauseSynthPlayer();
        clearSynthHighlights();
        sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
        playerState.isPlaying = true;
        playerState.hasStarted = true;
        setActiveAudioMode('youtube');
    }
    updatePlaybackControls();
    return true;
}

export function isYouTubeAvailable() {
    return Boolean(playerState.currentVideoId || playerState.hasStarted);
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
    const base = [playerState.artist, playerState.title].filter(Boolean).join(' - ') || playerState.filename;
    return `yt_track_${encodeURIComponent(base.toLowerCase())}_${mode}`;
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
    const searchInput = document.getElementById('ytSearchInput');

    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');
    if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
        delete iframe.dataset.loaded;
    }
    if (prompt) {
        prompt.style.setProperty('display', 'flex', 'important');
    }
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = 'Paste YouTube link or video ID...';
    }

    updatePanelTitle();
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
    const searchInput = document.getElementById('ytSearchInput');

    // 1. Check if user already saved a video ID for this song & mode
    const storedId = localStorage.getItem(getStorageKey());
    let videoId = forcedVideoId || storedId || playerState.currentVideoId;

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

        try {
            // Check native search if on Tauri (desktop & mobile native)
            videoId = await fetchYouTubeNativeSearch(query);

            // Check YouTube Data API if key provided
            if (!videoId && !signal.aborted) {
                videoId = await fetchYouTubeApiKeySearch(query, signal);
            }

            // If still no ID, attempt public mirrors search
            if (!videoId && !signal.aborted) {
                videoId = await fetchMultiMirrorSearch(query, signal);
            }
        } catch (e) {
            // Handled
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
            const embedUrl = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
            embedUrl.searchParams.set('autoplay', autoplayParam);
            embedUrl.searchParams.set('enablejsapi', '1');
            embedUrl.searchParams.set('playsinline', '1');

            const origin = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') ? window.location.origin : '';
            const isValidHttpOrigin = origin && origin.startsWith('http') && !origin.includes('localhost') && !origin.includes('tauri');
            if (isValidHttpOrigin) {
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
        if (searchInput) {
            searchInput.value = `https://www.youtube.com/watch?v=${videoId}`;
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
        if (searchInput) {
            searchInput.value = '';
            searchInput.placeholder = 'Paste YouTube link or video ID...';
        }
    }
}

/**
 * Update titles, labels, and external links
 */
function updatePanelTitle() {
    const titleEl = document.getElementById('ytPanelTitle');
    const promptTitle = document.getElementById('ytPromptTitle');
    const searchExternalBtn = document.getElementById('ytSearchExternalBtn');
    const externalLink = document.getElementById('ytExternalLink');

    const songLabel = [playerState.artist, playerState.title].filter(Boolean).join(' - ') + ' song';
    const modeLabel = playerState.trackMode === 'backing' ? 'Backing Track' : 'Original';
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

        updateYouTubePanelPosition();
        panel.style.display = 'block';
        if (chevron) {
            chevron.className = 'bi-chevron-up ms-1';
        }
        toggleBtn?.classList.add('active');
        mobileBtn?.classList.add('active');
        updateQueryInputUI();

        // Load track if not yet loaded or searching
        const iframe = document.getElementById('ytIframe');
        if (!iframe?.dataset.loaded && !playerState.currentVideoId && !playerState.isSearching) {
            loadCurrentTrack(false);
        }
    } else {
        panel.style.display = 'none';
        panel.classList.remove('popup-from-bottom');
        if (chevron) {
            chevron.className = 'bi-chevron-down ms-1';
        }
        toggleBtn?.classList.remove('active');
        mobileBtn?.classList.remove('active');
    }
    if (newState && isNativeOverlayPlayer()) {
        animateNativeMacPlayerBounds();
    } else {
        syncNativeMacPlayerBounds();
    }
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
export function updateSongForYouTube({ filename = '', scoreTitle = '', scoreArtist = '' } = {}) {
    if (activeSearchController) {
        activeSearchController.abort();
        activeSearchController = null;
    }
    const { artist, title } = parseSongInfo(filename, scoreTitle, scoreArtist);

    playerState.artist = artist;
    playerState.title = title;
    playerState.filename = filename;
    playerState.customQueries = { original: '', backing: '' };
    playerState.customQuery = '';
    setVideoId(null, 'song');
    playerState.currentTime = 0;
    playerState.isPlaying = false;
    playerState.hasStarted = false;
    playerState.isSearching = false;

    // Show YouTube toggle button in audio source pill
    const ytBtn = document.getElementById('ytToggleBtn');
    if (ytBtn) {
        ytBtn.style.display = 'inline-flex';
    }

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
 * Close the panel only once the iframe is actually playing. Hiding the iframe
 * (display:none) before playback starts can cause YouTube to block/abort
 * autoplay. If playback never starts (e.g. autoplay blocked), the panel stays
 * open so the user can press play inside the iframe.
 */
function closePanelWhenPlaying(timeoutMs = 8000) {
    const start = Date.now();
    const check = setInterval(() => {
        if (!playerState.isOpen) {
            clearInterval(check);
        } else if (playerState.isPlaying) {
            clearInterval(check);
            // Brief delay so playback is stable before hiding
            setTimeout(() => toggleYouTubePanel(false), 400);
        } else if (Date.now() - start > timeoutMs) {
            clearInterval(check);
        }
    }, 150);
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
    const searchBtn = document.getElementById('ytSearchBtn');
    const searchInput = document.getElementById('ytSearchInput');
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
        if (!playerState.isOpen) return;
        updateYouTubePanelPosition();
        syncNativeMacPlayerBounds();
    });

    // Close button in panel
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleYouTubePanel(false);
    });

    // Cancel search button in loading state
    cancelSearchBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelYouTubeSearch();
    });

    // Track Mode Selector (Original vs Backing)
    originalRadio?.addEventListener('change', () => {
        if (originalRadio.checked) {
            if (playerState.isSearching) {
                cancelYouTubeSearch();
            }
            playerState.trackMode = 'original';
            setVideoId(null, 'user');
            updateQueryInputUI();
            loadCurrentTrack(true, { source: 'user' });
        }
    });

    backingRadio?.addEventListener('change', () => {
        if (backingRadio.checked) {
            if (playerState.isSearching) {
                cancelYouTubeSearch();
            }
            playerState.trackMode = 'backing';
            setVideoId(null, 'user');
            updateQueryInputUI();
            loadCurrentTrack(true, { source: 'user' });
        }
    });

    // Query Override and Redo Search controls
    const queryInput = document.getElementById('ytSearchQueryInput');
    const redoSearchBtn = document.getElementById('ytRedoSearchBtn');
    const resetQueryBtn = document.getElementById('ytResetQueryBtn');

    redoSearchBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        redoSearchWithQuery();
    });

    queryInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            redoSearchWithQuery();
        }
    });

    resetQueryBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        redoSearchWithQuery(getDefaultQuery(playerState.trackMode));
    });

    // Handle Search / Link Paste
    const handleInput = () => {
        let text = (searchInput?.value || '').trim();
        if (!text && playerState.currentVideoId) {
            text = playerState.currentVideoId;
        }
        if (!text) return;

        if (playerState.isSearching) {
            cancelYouTubeSearch();
        }

        const videoId = extractVideoId(text);
        if (videoId) {
            setVideoId(videoId, 'user');
            localStorage.setItem(getStorageKey(), videoId);

            const iframe = document.getElementById('ytIframe');
            if (iframe?.dataset.loaded === 'true' && iframe.contentWindow && iframe.src.includes(videoId)) {
                pauseSynthPlayer();
                clearSynthHighlights();
                sendYouTubeMessage(iframe, { event: 'command', func: 'playVideo', args: [] });
                playerState.isPlaying = true;
                playerState.hasStarted = true;
                setActiveAudioMode('youtube');
                updatePlaybackControls();
            } else {
                loadCurrentTrack(true, { source: 'user' });
            }
            closePanelWhenPlaying();
        } else {
            // Text search fallback via search query override
            redoSearchWithQuery(text);
        }
    };

    searchBtn?.addEventListener('click', handleInput);
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleInput();
        }
    });

    // Auto-load on paste
    searchInput?.addEventListener('paste', () => {
        setTimeout(handleInput, 50);
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

            // YouTube iframe API sends infoDelivery messages with currentTime & playerState
            if (data.event === 'infoDelivery' && data.info) {
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

    // Close panel when clicking outside of panel and top bar toggle
    const handleOutsideYtClick = (e) => {
        const panel = document.getElementById('ytDropdownPanel');
        const sourcePill = document.getElementById('audioSourcePill');
        const mobileDock = document.getElementById('mobilePlaybackDock');

        if (playerState.isOpen && panel && !panel.contains(e.target) && !sourcePill?.contains(e.target) && !mobileDock?.contains(e.target)) {
            toggleYouTubePanel(false);
        }
    };
    document.addEventListener('click', handleOutsideYtClick);
    document.addEventListener('pointerdown', handleOutsideYtClick);

    updatePlaybackControls();
}


// --- Jam Mode remote control -----------------------------------------------

/**
 * A new embed may refuse to autoplay while hidden, so show the panel until the video
 * actually plays, then tuck it away again. A panel the user opened stays open.
 */
function revealUntilPlaying(timeoutMs = 10000) {
    if (playerState.isOpen) return;
    toggleYouTubePanel(true);
    const start = Date.now();
    const check = setInterval(() => {
        if (!playerState.isOpen) {
            clearInterval(check);
        } else if (reportedPlaying) {
            clearInterval(check);
            setTimeout(() => toggleYouTubePanel(false), 400);
        } else if (Date.now() - start > timeoutMs) {
            clearInterval(check);
        }
    }, 150);
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
        if (!iframePlayed) revealUntilPlaying();
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
        const iframe = document.getElementById('ytIframe');
        if (iframe?.dataset.loaded === 'true' && Number.isFinite(rate)) {
            sendYouTubeMessage(iframe, { event: 'command', func: 'setPlaybackRate', args: [rate] });
        }
    }
};
