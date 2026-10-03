// youtubePlayer.js
// Collapsible YouTube / Backing Track player integrated into top bar

let playerState = {
    isOpen: false,
    trackMode: 'original', // Default to 'original' (left button)
    artist: '',
    title: '',
    filename: '',
    customQuery: '',
    currentVideoId: null,
    isPlaying: false
};

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
 * Search YouTube Data API v3 if API key is configured in settings
 */
async function fetchYouTubeApiKeySearch(query) {
    const apiKey = localStorage.getItem('youtubeApiKey');
    if (!apiKey) return null;

    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].id?.videoId || null;
        }
    } catch (e) {
        console.warn('[YouTube API Search Error]', e);
    }
    return null;
}

/**
 * Update the YouTube iframe or prompt UI based on current video ID
 */
async function loadCurrentTrack(autoplay = false) {
    const iframe = document.getElementById('ytIframe');
    const prompt = document.getElementById('ytPlaceholderPrompt');
    const searchInput = document.getElementById('ytSearchInput');

    // 1. Check if user already saved a video ID for this song & mode
    const storedId = localStorage.getItem(getStorageKey());
    let videoId = storedId || playerState.currentVideoId;

    // 2. If no ID, attempt YouTube Data API search if key is provided
    if (!videoId) {
        const query = buildQuery();
        videoId = await fetchYouTubeApiKeySearch(query);
        if (videoId) {
            localStorage.setItem(getStorageKey(), videoId);
        }
    }

    playerState.currentVideoId = videoId;
    updatePanelTitle();

    if (videoId) {
        // We have a valid video ID -> show iframe
        if (prompt) prompt.style.setProperty('display', 'none', 'important');
        if (iframe) {
            iframe.style.display = 'block';
            const autoplayParam = autoplay ? '1' : '0';
            iframe.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplayParam}&enablejsapi=1`;
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
    const pillLabel = document.getElementById('ytPillLabel');
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

    if (pillLabel) {
        pillLabel.textContent = modeLabel;
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
        if (toggleBtn) {
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.position = 'fixed';
            panel.style.top = `${rect.bottom + 8}px`;
            const centerX = rect.left + rect.width / 2;
            const halfPanelWidth = Math.min(180, (window.innerWidth - 24) / 2);
            const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
            panel.style.left = `${clampedLeft}px`;
            panel.style.transform = 'translateX(-50%)';
        }
        panel.style.display = 'block';
        if (chevron) {
            chevron.className = 'bi-chevron-up ms-1';
        }
        toggleBtn?.classList.add('active');

        // Load track if not yet loaded
        const iframe = document.getElementById('ytIframe');
        if (!iframe?.dataset.loaded && !playerState.currentVideoId) {
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
 * Called when a new file or score metadata is loaded in the app
 */
export function updateSongForYouTube({ filename = '', scoreTitle = '', scoreArtist = '' } = {}) {
    const { artist, title } = parseSongInfo(filename, scoreTitle, scoreArtist);

    playerState.artist = artist;
    playerState.title = title;
    playerState.filename = filename;
    playerState.customQuery = '';
    playerState.currentVideoId = null;

    // Show container in top bar
    const container = document.getElementById('ytContainer');
    if (container) {
        container.style.display = 'flex';
    }

    // Default to Original Song radio (checked)
    const originalRadio = document.getElementById('ytTrackOriginal');
    if (originalRadio) {
        originalRadio.checked = true;
    }
    playerState.trackMode = 'original';

    // Reset iframe dataset.loaded
    const iframe = document.getElementById('ytIframe');
    if (iframe) {
        delete iframe.dataset.loaded;
    }

    updatePanelTitle();

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
        toggleYouTubePanel();
    });

    // Close button in panel
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleYouTubePanel(false);
    });

    // Track Mode Selector (Original vs Backing)
    originalRadio?.addEventListener('change', () => {
        if (originalRadio.checked) {
            playerState.trackMode = 'original';
            playerState.currentVideoId = null;
            loadCurrentTrack(true);
        }
    });

    backingRadio?.addEventListener('change', () => {
        if (backingRadio.checked) {
            playerState.trackMode = 'backing';
            playerState.currentVideoId = null;
            loadCurrentTrack(true);
        }
    });

    // Handle Search / Link Paste
    const handleInput = () => {
        const text = (searchInput?.value || '').trim();
        if (!text) return;

        const videoId = extractVideoId(text);
        if (videoId) {
            playerState.currentVideoId = videoId;
            localStorage.setItem(getStorageKey(), videoId);
            loadCurrentTrack(true);
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

    // Close panel when clicking outside of panel and top bar toggle
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('ytDropdownPanel');
        const container = document.getElementById('ytContainer');

        if (playerState.isOpen && panel && !panel.contains(e.target) && !container?.contains(e.target)) {
            toggleYouTubePanel(false);
        }
    });
}
