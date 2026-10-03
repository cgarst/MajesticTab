// youtubePlayer.js
// Collapsible YouTube / Backing Track player integrated into top bar
import { pauseSynthPlayer, clearSynthHighlights, toggleSynthPanel } from './gpProcessor/gpPlayer.js';
import { updateGlobalRewindButton, setActiveAudioMode } from './utils/navigationUtils.js';

let activeSearchController = null;

let playerState = {
    isOpen: false,
    trackMode: 'original', // Default to 'original' (left button)
    artist: '',
    title: '',
    filename: '',
    customQuery: '',
    currentVideoId: null,
    currentTime: 0,
    isPlaying: false,
    hasStarted: false,
    isSearching: false
};

/**
 * Pause YouTube player if active
 */
export function pauseYouTube() {
    const iframe = document.getElementById('ytIframe');
    if (iframe?.contentWindow) {
        try {
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: 'pauseVideo',
                args: []
            }), '*');
        } catch (e) {}
    }
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
    iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: 'seekTo',
        args: [0, true]
    }), '*');
}

/**
 * Rewind YouTube by 10 seconds
 */
export function rewindYouTube10Seconds() {
    const iframe = document.getElementById('ytIframe');
    if (!iframe || !iframe.contentWindow) return;

    const targetTime = Math.max(0, (playerState.currentTime || 0) - 10);
    playerState.currentTime = targetTime;
    iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: 'seekTo',
        args: [targetTime, true]
    }), '*');
}

/**
 * Toggle YouTube play / pause
 */
export function playPauseYouTube() {
    const iframe = document.getElementById('ytIframe');
    if (!iframe || !iframe.contentWindow) return false;

    if (playerState.isPlaying) {
        iframe.contentWindow.postMessage(JSON.stringify({
            event: 'command',
            func: 'pauseVideo',
            args: []
        }), '*');
        playerState.isPlaying = false;
    } else {
        pauseSynthPlayer();
        clearSynthHighlights();
        iframe.contentWindow.postMessage(JSON.stringify({
            event: 'command',
            func: 'playVideo',
            args: []
        }), '*');
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
 * Build the query string for YouTube based on current song info and mode
 */
export function buildQuery(mode = playerState.trackMode) {
    if (playerState.customQuery) {
        return playerState.customQuery;
    }

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
 * Public Invidious and Piped mirrors for client-side multi-mirror search
 */
const PUBLIC_MIRRORS = [
    { type: 'invidious', url: 'https://invidious.f5.si' },
    { type: 'invidious', url: 'https://yt.artemislena.eu' },
    { type: 'invidious', url: 'https://iv.ggtyler.dev' },
    { type: 'invidious', url: 'https://invidious.private.coffee' },
    { type: 'invidious', url: 'https://invidious.drgns.space' },
    { type: 'invidious', url: 'https://inv.vern.cc' },
    { type: 'piped', url: 'https://pa.il.ax' },
    { type: 'piped', url: 'https://pipedapi.tokhmi.xyz' },
    { type: 'piped', url: 'https://pipedapi.r4fo.com' }
];

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
 * Update the YouTube iframe or prompt UI based on current video ID
 */
async function loadCurrentTrack(autoplay = false) {
    const iframe = document.getElementById('ytIframe');
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    const loadingQueryText = document.getElementById('ytLoadingQueryText');
    const searchInput = document.getElementById('ytSearchInput');

    // 1. Check if user already saved a video ID for this song & mode
    const storedId = localStorage.getItem(getStorageKey());
    let videoId = storedId || playerState.currentVideoId;

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
            // Check YouTube Data API if key provided
            videoId = await fetchYouTubeApiKeySearch(query, signal);

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

    playerState.currentVideoId = videoId;
    updatePanelTitle();

    if (loadingIndicator) loadingIndicator.style.setProperty('display', 'none', 'important');

    if (videoId) {
        // We have a valid video ID -> show iframe
        if (prompt) prompt.style.setProperty('display', 'none', 'important');
        if (iframe) {
            iframe.style.display = 'block';
            const autoplayParam = autoplay ? '1' : '0';
            const startParam = playerState.currentTime > 0 ? `&start=${Math.floor(playerState.currentTime)}` : '';
            const targetSrc = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplayParam}&enablejsapi=1${startParam}`;
            if (iframe.src !== targetSrc) {
                iframe.src = targetSrc;
            } else if (autoplay && iframe.contentWindow) {
                pauseSynthPlayer();
                clearSynthHighlights();
                iframe.contentWindow.postMessage(JSON.stringify({
                    event: 'command',
                    func: 'playVideo',
                    args: []
                }), '*');
                playerState.isPlaying = true;
                playerState.hasStarted = true;
                setActiveAudioMode('youtube');
                updatePlaybackControls();
            }
            iframe.dataset.loaded = 'true';
        }
        if (searchInput) {
            searchInput.value = `https://www.youtube.com/watch?v=${videoId}`;
        }
    } else {
        // No video ID yet -> show search & prompt screen
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

    const songLabel = [playerState.artist, playerState.title].filter(Boolean).join(' - ') || 'YouTube Audio';
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

/**
 * Toggle the dropdown panel open/closed
 */
export function toggleYouTubePanel(forceState = null) {
    const panel = document.getElementById('ytDropdownPanel');
    const toggleBtn = document.getElementById('ytToggleBtn');
    const chevron = document.getElementById('ytPillChevron');

    if (!panel) return;

    const newState = forceState !== null ? forceState : !playerState.isOpen;
    playerState.isOpen = newState;

    if (newState) {
        setActiveAudioMode('youtube');
        // Ensure Synth / SoundFont panel is closed and synth playback paused when opening YouTube panel
        toggleSynthPanel(false);
        pauseSynthPlayer();
        clearSynthHighlights();

        if (toggleBtn) {
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.position = 'fixed';
            panel.style.top = `${rect.bottom + 8}px`;
            const centerX = rect.left + rect.width / 2;
            const halfPanelWidth = Math.min(190, (window.innerWidth - 24) / 2);
            const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
            panel.style.left = `${clampedLeft}px`;
            panel.style.transform = 'translateX(-50%)';
        }
        panel.style.display = 'block';
        if (chevron) {
            chevron.className = 'bi-chevron-up ms-1';
        }
        toggleBtn?.classList.add('active');

        // Load track if not yet loaded or searching
        const iframe = document.getElementById('ytIframe');
        if (!iframe?.dataset.loaded && !playerState.currentVideoId && !playerState.isSearching) {
            loadCurrentTrack(false);
        }
    } else {
        panel.style.display = 'none';
        if (chevron) {
            chevron.className = 'bi-chevron-down ms-1';
        }
        toggleBtn?.classList.remove('active');
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
    playerState.customQuery = '';
    playerState.currentVideoId = null;
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
        delete iframe.dataset.loaded;
    }
    const loadingIndicator = document.getElementById('ytLoadingIndicator');
    if (loadingIndicator) {
        loadingIndicator.style.setProperty('display', 'none', 'important');
    }

    updatePanelTitle();

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
            playerState.currentVideoId = null;
            loadCurrentTrack(true);
        }
    });

    backingRadio?.addEventListener('change', () => {
        if (backingRadio.checked) {
            if (playerState.isSearching) {
                cancelYouTubeSearch();
            }
            playerState.trackMode = 'backing';
            playerState.currentVideoId = null;
            loadCurrentTrack(true);
        }
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
            playerState.currentVideoId = videoId;
            localStorage.setItem(getStorageKey(), videoId);

            const iframe = document.getElementById('ytIframe');
            if (iframe?.dataset.loaded === 'true' && iframe.contentWindow && iframe.src.includes(videoId)) {
                pauseSynthPlayer();
                clearSynthHighlights();
                iframe.contentWindow.postMessage(JSON.stringify({
                    event: 'command',
                    func: 'playVideo',
                    args: []
                }), '*');
                playerState.isPlaying = true;
                playerState.hasStarted = true;
                setActiveAudioMode('youtube');
                updatePlaybackControls();
            } else {
                loadCurrentTrack(true);
            }
            closePanelWhenPlaying();
        } else {
            // Text search fallback via search query
            const query = text;
            playerState.customQuery = query;
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            window.open(searchUrl, '_blank');
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

            // YouTube iframe API sends infoDelivery messages with currentTime & playerState
            if (data.event === 'infoDelivery' && data.info) {
                if (typeof data.info.currentTime === 'number') {
                    playerState.currentTime = data.info.currentTime;
                }
                if (typeof data.info.playerState === 'number') {
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
        } catch (e) {
            // Ignore non-JSON messages from other sources
        }
    });

    const iframe = document.getElementById('ytIframe');
    if (iframe) {
        iframe.addEventListener('load', () => {
            try {
                iframe.contentWindow?.postMessage(JSON.stringify({
                    event: 'listening',
                    id: 1
                }), '*');
                iframe.contentWindow?.postMessage(JSON.stringify({
                    event: 'command',
                    func: 'addEventListener',
                    args: ['onStateChange']
                }), '*');
                if (playerState.isPlaying || playerState.hasStarted) {
                    iframe.contentWindow?.postMessage(JSON.stringify({
                        event: 'command',
                        func: 'playVideo',
                        args: []
                    }), '*');
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
                    currentIframe.contentWindow.postMessage(JSON.stringify({
                        event: 'listening',
                        id: 1
                    }), '*');
                } catch (e) {
                    // Ignore cross-origin error if any
                }
            }
        }
    }, 1000);

    // Close panel when clicking outside of panel and top bar toggle
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('ytDropdownPanel');
        const sourcePill = document.getElementById('audioSourcePill');

        if (playerState.isOpen && panel && !panel.contains(e.target) && !sourcePill?.contains(e.target)) {
            toggleYouTubePanel(false);
        }
    });

    updatePlaybackControls();
}
