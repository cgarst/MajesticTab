// gpPlayer.js
// In-app artificial instrument (SoundFont synthesizer) player for Guitar Pro files
import { pauseYouTube, toggleYouTubePanel } from '../youtubePlayer.js';
import { gpState } from './gpHandler.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
import { updateGlobalRewindButton, setActiveAudioMode } from '../utils/navigationUtils.js';

let currentApi = null;
let currentScore = null;
let isSeeking = false;

export const synthPlayerState = {
    isOpen: false,
    isPlaying: false,
    isReady: false,
    hasPlayed: false,
    soundFontLoaded: false,
    currentTime: 0,
    endTime: 0,
    playbackSpeed: 1.0,
    metronomeEnabled: false,
    countInEnabled: false,
    masterVolume: 1.0
};

/**
 * Format milliseconds into M:SS or MM:SS string
 */
function formatTime(ms) {
    if (!ms || isNaN(ms) || ms < 0) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Update the Top Bar and Panel UI elements
 */
export function updateSynthUI() {
    const metronomeQuickBtn = document.getElementById('synthMetronomeQuickBtn');
    const metronomeSwitch = document.getElementById('synthMetronomeSwitch');
    const countInSwitch = document.getElementById('synthCountInSwitch');
    const timeDisplay = document.getElementById('synthTimeDisplay');
    const currentTimeText = document.getElementById('synthCurrentTimeText');
    const totalTimeText = document.getElementById('synthTotalTimeText');
    const seekSlider = document.getElementById('synthSeekSlider');
    const positionPercent = document.getElementById('synthPositionPercent');
    const speedBadge = document.getElementById('synthSpeedBadge');
    const hasScore = Boolean(currentApi);
    const canPlay = Boolean(currentApi && (synthPlayerState.isReady || synthPlayerState.soundFontLoaded || currentApi?.isReadyForPlayback || currentApi?.isSoundFontLoaded));

    updateGlobalRewindButton();

    if (metronomeQuickBtn) {
        metronomeQuickBtn.disabled = !canPlay;
        if (synthPlayerState.metronomeEnabled) {
            metronomeQuickBtn.classList.add('active');
        } else {
            metronomeQuickBtn.classList.remove('active');
        }
    }

    if (metronomeSwitch) {
        metronomeSwitch.checked = synthPlayerState.metronomeEnabled;
    }

    if (countInSwitch) {
        countInSwitch.checked = synthPlayerState.countInEnabled;
    }

    if (timeDisplay) {
        timeDisplay.textContent = `${formatTime(synthPlayerState.currentTime)} / ${formatTime(synthPlayerState.endTime)}`;
    }

    if (currentTimeText) {
        currentTimeText.textContent = formatTime(synthPlayerState.currentTime);
    }

    if (totalTimeText) {
        totalTimeText.textContent = formatTime(synthPlayerState.endTime);
    }

    const pct = synthPlayerState.endTime > 0 
        ? Math.min(100, Math.max(0, (synthPlayerState.currentTime / synthPlayerState.endTime) * 100))
        : 0;

    if (positionPercent) {
        positionPercent.textContent = `${Math.round(pct)}%`;
    }

    if (seekSlider && !isSeeking) {
        seekSlider.value = pct * 10; // 0 to 1000 range
        seekSlider.disabled = !canPlay || synthPlayerState.endTime <= 0;
    }

    if (speedBadge) {
        speedBadge.textContent = `${Math.round(synthPlayerState.playbackSpeed * 100)}%`;
    }

    // Update speed button active classes
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');
    speedButtons.forEach(btn => {
        const speedVal = parseFloat(btn.dataset.speed);
        if (Math.abs(speedVal - synthPlayerState.playbackSpeed) < 0.005) {
            btn.classList.add('active', 'btn-success');
            btn.classList.remove('btn-outline-secondary');
        } else {
            btn.classList.remove('active', 'btn-success');
            btn.classList.add('btn-outline-secondary');
        }
    });
}

/**
 * Render visual playback position cursor and handle auto-page navigation in Page Mode
 */
function updatePageModeCursor(currentTick) {
    if (!currentApi || !currentScore || !synthPlayerState.hasPlayed) {
        document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        return;
    }

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : true;
    if (!isPageMode) {
        // In continuous mode, AlphaTab handles its own cursor
        document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        return;
    }

    const boundsLookup = currentApi.renderer?.boundsLookup;
    if (!boundsLookup || !boundsLookup.staffSystems || !boundsLookup.staffSystems.length) return;

    // 1. Find master bar for currentTick
    const masterBars = currentScore.masterBars;
    if (!masterBars || !masterBars.length) return;

    let activeMasterBarIndex = -1;
    for (let i = 0; i < masterBars.length; i++) {
        const mb = masterBars[i];
        const barStart = mb.start;
        const barEnd = barStart + mb.calculateDuration();
        if (currentTick >= barStart && currentTick < barEnd) {
            activeMasterBarIndex = i;
            break;
        }
    }
    if (activeMasterBarIndex === -1 && masterBars.length > 0) {
        if (currentTick >= masterBars[masterBars.length - 1].start) {
            activeMasterBarIndex = masterBars.length - 1;
        }
    }
    if (activeMasterBarIndex < 0) return;

    // 2. Find which staffSystem contains activeMasterBarIndex
    let targetStaffSystem = null;
    let targetStaffSystemIndex = -1;
    let targetBarBounds = null;

    for (let s = 0; s < boundsLookup.staffSystems.length; s++) {
        const sys = boundsLookup.staffSystems[s];
        if (sys.bars) {
            const foundBar = sys.bars.find(b => b.index === activeMasterBarIndex);
            if (foundBar) {
                targetStaffSystem = sys;
                targetStaffSystemIndex = s;
                targetBarBounds = foundBar;
                break;
            }
        }
    }

    if (!targetStaffSystem || targetStaffSystemIndex < 0 || !targetBarBounds) return;

    // 3. Find beat bounds within the bar
    let targetBeatBounds = null;
    if (targetBarBounds.bars && targetBarBounds.bars.length > 0) {
        const trackBar = targetBarBounds.bars[0];
        if (trackBar.beats && trackBar.beats.length > 0) {
            for (const beat of trackBar.beats) {
                const bStart = beat.beat?.absolutePlaybackStart ?? ((targetMasterBar.start || 0) + (beat.beat?.playbackStart ?? beat.playbackStart ?? 0));
                const bDur = beat.beat?.playbackDuration ?? beat.playbackDuration ?? 0;
                if (bStart !== undefined && currentTick >= bStart && currentTick < (bStart + bDur)) {
                    targetBeatBounds = beat;
                    break;
                }
            }
            if (!targetBeatBounds && trackBar.beats.length > 0) {
                // If not found inside any specific beat range, pick the closest beat
                let minDiff = Infinity;
                for (const beat of trackBar.beats) {
                    const bStart = beat.beat?.absolutePlaybackStart ?? ((targetMasterBar.start || 0) + (beat.beat?.playbackStart ?? beat.playbackStart ?? 0));
                    const diff = Math.abs(currentTick - bStart);
                    if (diff < minDiff) {
                        minDiff = diff;
                        targetBeatBounds = beat;
                    }
                }
            }
        }
    }

    // 4. Find the matching block in page mode:
    // Staff systems in AlphaTab map to score blocks. We match the staffSystem's Y position to the original block.
    const originalBlocks = gpState.canvases[0]?.container ? Array.from(gpState.canvases[0].container.querySelectorAll('div.at-surface.at > div')) : [];
    let matchedBlockIndex = targetStaffSystemIndex;
    if (originalBlocks.length > 0) {
        const sysY = targetStaffSystem.realBounds?.y ?? targetStaffSystem.visualBounds?.y ?? 0;
        let minDiff = Infinity;
        originalBlocks.forEach((b, bIdx) => {
            const bTop = parseFloat(b.style.top || '0');
            const diff = Math.abs(bTop - sysY);
            if (diff < minDiff) {
                minDiff = diff;
                matchedBlockIndex = bIdx;
            }
        });
    }

    // Auto-advance page if necessary
    if (gpState.pages && gpState.pages.length) {
        let accumulatedBlocks = 0;
        for (let p = 0; p < gpState.pages.length; p++) {
            const pageBlocks = gpState.pages[p];
            const pageStart = accumulatedBlocks;
            const pageEnd = accumulatedBlocks + pageBlocks.length;
            if (matchedBlockIndex >= pageStart && matchedBlockIndex < pageEnd) {
                const pagesPerView = getPagesPerView(true);
                if (p < gpState.currentPageIndex || p >= gpState.currentPageIndex + pagesPerView) {
                    gpState.currentPageIndex = p;
                    const output = document.getElementById('output');
                    const continuousModeRadio = document.getElementById('continuousModeRadio');
                    import('./gpHandler.js').then(m => {
                        m.renderGPPage(output, true, continuousModeRadio);
                    });
                }
                break;
            }
            accumulatedBlocks += pageBlocks.length;
        }
    }

    // 5. Draw / update cursor elements on the visible cloned block in page mode
    const visibleBlock = document.querySelector(`.alphaTab-gp-content div[data-block-index="${matchedBlockIndex}"]`);
    
    // Remove stale page cursors on other blocks
    document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => {
        if (!visibleBlock || !visibleBlock.contains(el)) {
            el.remove();
        }
    });

    if (!visibleBlock) return;

    // Ensure cursor elements exist inside visibleBlock
    let cursorBar = visibleBlock.querySelector('.gp-page-cursor-bar');
    let cursorBeat = visibleBlock.querySelector('.gp-page-cursor-beat');

    if (!cursorBar) {
        cursorBar = document.createElement('div');
        cursorBar.className = 'gp-page-cursor-bar';
        visibleBlock.appendChild(cursorBar);
    }
    if (!cursorBeat) {
        cursorBeat = document.createElement('div');
        cursorBeat.className = 'gp-page-cursor-beat';
        visibleBlock.appendChild(cursorBeat);
    }

    const svg = visibleBlock.querySelector('svg');
    const blockRect = visibleBlock.getBoundingClientRect();
    const svgRect = svg ? svg.getBoundingClientRect() : null;

    const svgLeftOffset = (svgRect && blockRect.width > 0) ? (svgRect.left - blockRect.left) : 0;
    const svgTopOffset = (svgRect && blockRect.height > 0) ? (svgRect.top - blockRect.top) : parseFloat(visibleBlock.style.paddingTop || '0');

    // Measure exact physical staff lines inside the rendered SVG
    let staffTopY = null;
    let staffHeight = null;

    if (svg) {
        // Staff lines inside AlphaTab blocks are rect/line/path elements with w > 50 and h < 5
        const staffElements = [];
        svg.querySelectorAll('rect, line, path').forEach(el => {
            try {
                const b = el.getBBox ? el.getBBox() : null;
                if (b && b.width > 50 && b.height <= 5) {
                    staffElements.push(b);
                }
            } catch (e) {}
        });

        if (staffElements.length >= 2) {
            const minSvgY = Math.min(...staffElements.map(b => b.y));
            const maxSvgY = Math.max(...staffElements.map(b => b.y + b.height));
            staffTopY = svgTopOffset + minSvgY - 4;
            staffHeight = (maxSvgY - minSvgY) + 8;
        }
    }

    const trackBar = targetBarBounds.bars?.[0];
    const trackStave = trackBar?.staves?.[0];
    const staffBounds = trackStave?.visualBounds || trackBar?.visualBounds || targetBarBounds.visualBounds;
    const sysRealY = targetStaffSystem.realBounds?.y ?? targetStaffSystem.visualBounds?.y ?? 0;

    if (staffBounds) {
        const staveTabBounds = trackStave?.tabStaffBounds || trackStave?.standardStaffBounds;
        const barX = svgLeftOffset + staffBounds.x;
        const defaultBarY = svgTopOffset + ((staveTabBounds?.y ?? staffBounds.y) - sysRealY);
        const barY = staffTopY !== null ? staffTopY : defaultBarY;
        const barW = staffBounds.w;
        const barH = staffHeight !== null ? staffHeight : (staveTabBounds?.h ?? staffBounds.h);

        cursorBar.style.left = `${barX}px`;
        cursorBar.style.top = `${barY}px`;
        cursorBar.style.width = `${barW}px`;
        cursorBar.style.height = `${barH}px`;
        cursorBar.style.display = 'block';

        // Beat cursor spans the exact same vertical staff line bounds
        if (targetBeatBounds) {
            const beatVisual = targetBeatBounds.visualBounds || targetBeatBounds.realBounds;
            const rawBeatX = targetBeatBounds.onNotesX ?? (beatVisual ? beatVisual.x : staffBounds.x);
            const beatX = svgLeftOffset + rawBeatX;
            const beatW = beatVisual ? Math.max(6, Math.min(14, beatVisual.w)) : 8;

            cursorBeat.style.left = `${beatX}px`;
            cursorBeat.style.top = `${barY}px`;
            cursorBeat.style.width = `${beatW}px`;
            cursorBeat.style.height = `${barH}px`;
            cursorBeat.style.display = 'block';
        } else {
            cursorBeat.style.display = 'none';
        }
    }
}

/**
 * Handle auto-scrolling with quick snap and read-ahead in Continuous Mode
 */
export function updateContinuousPlaybackScroll(currentTick) {
    if (!currentApi || !currentScore || !synthPlayerState.isPlaying) return;

    const pageModeRadio = document.getElementById('pageModeRadio');
    const isPageMode = pageModeRadio ? pageModeRadio.checked : false;
    if (isPageMode) return;

    const output = document.getElementById('output');
    if (!output) return;

    const viewportHeight = output.clientHeight;
    if (viewportHeight <= 0) return;

    const TOP_PADDING = 12;
    const outputRect = output.getBoundingClientRect();

    // Prefer measuring the actual highlighted cursor DOM element placed by AlphaTab
    const cursorEl = document.querySelector('.at-cursor-bar') || document.querySelector('.at-cursor-beat');
    if (cursorEl) {
        const cursorRect = cursorEl.getBoundingClientRect();
        const cursorVisualTop = cursorRect.top - outputRect.top;
        const cursorDocY = cursorVisualTop + output.scrollTop;

        // Read-ahead threshold: snap when cursor is above viewport (e.g. repeat jump / rewind)
        // or past 68% of viewport height (advancing after ~3 of 4 on-screen stave groups)
        const isAboveTop = cursorVisualTop < 0;
        const isBelowThreshold = cursorVisualTop > (viewportHeight * 0.68);

        if (isAboveTop || isBelowThreshold) {
            const maxScroll = output.scrollHeight - output.clientHeight;
            const targetScrollTop = (cursorDocY < 160)
                ? 0
                : Math.max(0, Math.min(maxScroll, cursorDocY - TOP_PADDING));
            if (Math.abs(output.scrollTop - targetScrollTop) > 5) {
                output.scrollTop = targetScrollTop;
            }
        }
        return;
    }

    // Fallback using renderer boundsLookup if DOM cursor element is not yet found
    const boundsLookup = currentApi.renderer?.boundsLookup;
    if (!boundsLookup || !boundsLookup.staffSystems || !boundsLookup.staffSystems.length) return;

    // 1. Find master bar for currentTick
    const masterBars = currentScore.masterBars;
    if (!masterBars || !masterBars.length) return;

    let activeMasterBarIndex = -1;
    for (let i = 0; i < masterBars.length; i++) {
        const mb = masterBars[i];
        const barStart = mb.start;
        const barEnd = barStart + mb.calculateDuration();
        if (currentTick >= barStart && currentTick < barEnd) {
            activeMasterBarIndex = i;
            break;
        }
    }
    if (activeMasterBarIndex === -1 && masterBars.length > 0) {
        if (currentTick >= masterBars[masterBars.length - 1].start) {
            activeMasterBarIndex = masterBars.length - 1;
        }
    }
    if (activeMasterBarIndex < 0) return;

    // 2. Find staffSystem containing activeMasterBarIndex
    let targetStaffSystem = null;
    for (let s = 0; s < boundsLookup.staffSystems.length; s++) {
        const sys = boundsLookup.staffSystems[s];
        if (sys.bars && sys.bars.some(b => b.index === activeMasterBarIndex)) {
            targetStaffSystem = sys;
            break;
        }
    }
    if (!targetStaffSystem) return;

    // 3. Compute system vertical coordinates
    const container = gpState.canvases[0]?.container;
    const containerTop = container ? container.offsetTop : 0;
    const sysY = containerTop + (targetStaffSystem.realBounds?.y ?? targetStaffSystem.visualBounds?.y ?? 0);

    const visualTop = sysY - output.scrollTop;

    const isAboveTop = visualTop < 0;
    const isBelowThreshold = visualTop > (viewportHeight * 0.68);

    if (isAboveTop || isBelowThreshold) {
        const maxScroll = output.scrollHeight - output.clientHeight;
        const targetScrollTop = (targetStaffSystem === boundsLookup.staffSystems[0])
            ? 0
            : Math.max(0, Math.min(maxScroll, sysY - TOP_PADDING));
        if (Math.abs(output.scrollTop - targetScrollTop) > 5) {
            output.scrollTop = targetScrollTop;
        }
    }
}

/**
 * Attach AlphaTab API to the synth player
 */
export function attachAlphaTabApi(api) {
    currentApi = api;
    currentScore = api.score;

    synthPlayerState.isPlaying = false;
    synthPlayerState.hasPlayed = false;
    synthPlayerState.currentTime = 0;
    synthPlayerState.endTime = 0;
    synthPlayerState.isReady = false;
    synthPlayerState.soundFontLoaded = false;
    document.body.classList.remove('synth-playback-started');

    // Update song title in panel
    const titleEl = document.getElementById('synthPanelTitle');
    if (titleEl && api.score) {
        const title = api.score.title || 'Instrument Playback';
        const artist = api.score.artist ? ` - ${api.score.artist}` : '';
        titleEl.textContent = `${title}${artist}`;
    }

    // Check if player or soundfont is already loaded
    if (api.isSoundFontLoaded || api.player?.isSoundFontLoaded) {
        synthPlayerState.soundFontLoaded = true;
    }
    if (api.isReadyForPlayback || api.isReady || api.player?.isReadyForPlayback) {
        synthPlayerState.isReady = true;
    }

    // SoundFont Loaded Event
    api.soundFontLoaded.on(() => {
        console.log('[Synth Player] SoundFont loaded successfully');
        synthPlayerState.soundFontLoaded = true;
        updateSynthUI();
    });

    // SoundFont Load Failed Event
    api.soundFontLoadFailed?.on((err) => {
        console.error('[Synth Player] SoundFont load failed:', err);
        synthPlayerState.soundFontLoaded = false;
        synthPlayerState.isReady = false;
        updateSynthUI();
    });

    // Player Ready Event
    api.playerReady.on(() => {
        console.log('[Synth Player] Audio player is ready');
        synthPlayerState.isReady = true;
        // Apply existing preferences
        api.playbackSpeed = synthPlayerState.playbackSpeed;
        api.metronomeVolume = synthPlayerState.metronomeEnabled ? 1.0 : 0.0;
        api.countInVolume = synthPlayerState.countInEnabled ? 1.0 : 0.0;
        updateSynthUI();
    });

    if (api.playerReadyForPlayback) {
        api.playerReadyForPlayback.on(() => {
            synthPlayerState.isReady = true;
            synthPlayerState.soundFontLoaded = true;
            updateSynthUI();
        });
    }

    // Player State Changed (0: Stopped, 1: Playing, 2: Paused)
    api.playerStateChanged.on((args) => {
        const state = args.state;
        synthPlayerState.isPlaying = (state === 1);
        if (state === 1) {
            synthPlayerState.hasPlayed = true;
            document.body.classList.add('synth-playback-started');
            pauseYouTube();
            setActiveAudioMode('synth');
        }
        updateSynthUI();
    });

    // Player Position Changed
    api.playerPositionChanged.on((args) => {
        synthPlayerState.currentTime = args.currentTime;
        synthPlayerState.endTime = args.endTime;

        updateSynthUI();
        updatePageModeCursor(args.currentTick);
        updateContinuousPlaybackScroll(args.currentTick);
    });

    // Show Synth Player UI
    showSynthPlayer();
    updateSynthUI();
}

/**
 * Clear visual playback highlight and reset hasPlayed state
 */
export function clearSynthHighlights() {
    synthPlayerState.hasPlayed = false;
    document.body.classList.remove('synth-playback-started');
    document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
}

/**
 * Detach AlphaTab API and hide player
 */
export function detachAlphaTabApi() {
    if (currentApi) {
        try {
            currentApi.stop();
        } catch (e) {
            // ignore
        }
    }
    currentApi = null;
    currentScore = null;
    synthPlayerState.isPlaying = false;
    synthPlayerState.isReady = false;
    synthPlayerState.soundFontLoaded = false;
    synthPlayerState.currentTime = 0;
    synthPlayerState.endTime = 0;

    clearSynthHighlights();
    toggleSynthPanel(false);
    hideSynthPlayer();
    updateSynthUI();
}

/**
 * Toggle play / pause
 */
export function playPauseSynth() {
    if (!currentApi) return;
    try {
        pauseYouTube();
        currentApi.playPause();
    } catch (e) {
        console.error('[Synth Player] Play/Pause error:', e);
    }
}

export function isSynthAvailable() {
    const synthBtn = document.getElementById('synthToggleBtn');
    return Boolean(synthBtn && synthBtn.style.display !== 'none' && currentApi);
}

export function isSynthPlaying() {
    return Boolean(synthPlayerState.isPlaying);
}

/**
 * Pause Synth playback
 */
export function pauseSynthPlayer() {
    if (!currentApi) return;
    try {
        currentApi.pause();
    } catch (e) {
        console.error('[Synth Player] Pause error:', e);
    }
    if (synthPlayerState.isPlaying) {
        synthPlayerState.isPlaying = false;
        updateSynthUI();
    }
}

/**
 * Rewind to start
 */
export function rewindSynth() {
    if (!currentApi) return;
    try {
        currentApi.timePosition = 0;
        synthPlayerState.currentTime = 0;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Rewind error:', e);
    }
}

/**
 * Seek back 10 seconds (or to 0 if within first 10s)
 */
export function rewindSynth10Seconds() {
    if (!currentApi) return;
    try {
        const currentMs = (synthPlayerState.currentTime !== undefined && synthPlayerState.currentTime !== null)
            ? synthPlayerState.currentTime
            : (currentApi.timePosition || 0);
        const targetMs = Math.max(0, currentMs - 10000);
        currentApi.timePosition = targetMs;
        synthPlayerState.currentTime = targetMs;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Back 10s error:', e);
    }
}

/**
 * Seek to a percentage position (0 to 1)
 */
export function seekSynthPercent(percent) {
    if (!currentApi || synthPlayerState.endTime <= 0) return;
    const targetMs = Math.floor(percent * synthPlayerState.endTime);
    try {
        currentApi.timePosition = targetMs;
        synthPlayerState.currentTime = targetMs;
        updateSynthUI();
    } catch (e) {
        console.error('[Synth Player] Seek error:', e);
    }
}

/**
 * Set playback speed
 */
export function setPlaybackSpeed(speed) {
    synthPlayerState.playbackSpeed = speed;
    if (currentApi) {
        try {
            currentApi.playbackSpeed = speed;
        } catch (e) {
            console.error('[Synth Player] Set speed error:', e);
        }
    }
    updateSynthUI();
}

/**
 * Toggle metronome
 */
export function toggleMetronome(force = null) {
    const newState = force !== null ? force : !synthPlayerState.metronomeEnabled;
    synthPlayerState.metronomeEnabled = newState;
    if (currentApi) {
        try {
            currentApi.metronomeVolume = newState ? 1.0 : 0.0;
        } catch (e) {
            console.error('[Synth Player] Metronome error:', e);
        }
    }
    updateSynthUI();
}

/**
 * Toggle count-in
 */
export function toggleCountIn(force = null) {
    const newState = force !== null ? force : !synthPlayerState.countInEnabled;
    synthPlayerState.countInEnabled = newState;
    if (currentApi) {
        try {
            currentApi.countInVolume = newState ? 1.0 : 0.0;
        } catch (e) {
            console.error('[Synth Player] Count-in error:', e);
        }
    }
    updateSynthUI();
}

/**
 * Show / Hide top bar Synth container
 */
export function showSynthPlayer() {
    const btn = document.getElementById('synthToggleBtn');
    if (btn) btn.style.display = 'inline-flex';
    updateGlobalRewindButton();
}

export function hideSynthPlayer() {
    const btn = document.getElementById('synthToggleBtn');
    if (btn) btn.style.display = 'none';
    updateGlobalRewindButton();
}

/**
 * Toggle collapsible synth settings panel
 */
export function toggleSynthPanel(forceState = null) {
    const panel = document.getElementById('synthDropdownPanel');
    const toggleBtn = document.getElementById('synthToggleBtn');

    if (!panel) return;

    const newState = forceState !== null ? forceState : !synthPlayerState.isOpen;
    synthPlayerState.isOpen = newState;

    if (newState) {
        setActiveAudioMode('synth');
        // Ensure YouTube panel is closed and YouTube playback paused when opening synth panel
        toggleYouTubePanel(false);
        pauseYouTube();

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
        toggleBtn?.classList.add('active');
    } else {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
    }
}

/**
 * Initialize all DOM event listeners for the Synth Player
 */
export function initSynthPlayer() {
    hideSynthPlayer();
    const toggleBtn = document.getElementById('synthToggleBtn');
    const closeBtn = document.getElementById('synthPanelCloseBtn');
    const metronomeQuickBtn = document.getElementById('synthMetronomeQuickBtn');
    const metronomeSwitch = document.getElementById('synthMetronomeSwitch');
    const countInSwitch = document.getElementById('synthCountInSwitch');
    const seekSlider = document.getElementById('synthSeekSlider');
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        pauseYouTube();
        toggleSynthPanel();
    });

    closeBtn?.addEventListener('click', () => {
        toggleSynthPanel(false);
    });

    metronomeQuickBtn?.addEventListener('click', () => {
        toggleMetronome();
    });

    metronomeSwitch?.addEventListener('change', (e) => {
        toggleMetronome(e.target.checked);
    });

    countInSwitch?.addEventListener('change', (e) => {
        toggleCountIn(e.target.checked);
    });

    const speedMinusBtn = document.getElementById('synthSpeedMinusBtn');
    const speedPlusBtn = document.getElementById('synthSpeedPlusBtn');

    speedMinusBtn?.addEventListener('click', () => {
        const currentPct = Math.round(synthPlayerState.playbackSpeed * 100);
        const newPct = Math.max(10, currentPct - 1);
        setPlaybackSpeed(newPct / 100);
    });

    speedPlusBtn?.addEventListener('click', () => {
        const currentPct = Math.round(synthPlayerState.playbackSpeed * 100);
        const newPct = Math.min(200, currentPct + 1);
        setPlaybackSpeed(newPct / 100);
    });

    // Speed button handlers
    speedButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const speed = parseFloat(btn.dataset.speed);
            if (!isNaN(speed)) {
                setPlaybackSpeed(speed);
            }
        });
    });

    // Seek slider handlers
    seekSlider?.addEventListener('input', (e) => {
        isSeeking = true;
        const val = parseFloat(e.target.value);
        const pct = val / 1000;
        const tempMs = Math.floor(pct * synthPlayerState.endTime);
        const currentTimeText = document.getElementById('synthCurrentTimeText');
        const positionPercent = document.getElementById('synthPositionPercent');
        if (currentTimeText) currentTimeText.textContent = formatTime(tempMs);
        if (positionPercent) positionPercent.textContent = `${Math.round(pct * 100)}%`;
    });

    seekSlider?.addEventListener('change', (e) => {
        isSeeking = false;
        const val = parseFloat(e.target.value);
        seekSynthPercent(val / 1000);
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('synthDropdownPanel');
        const sourcePill = document.getElementById('audioSourcePill');

        if (synthPlayerState.isOpen && panel && !panel.contains(e.target) && !sourcePill?.contains(e.target)) {
            toggleSynthPanel(false);
        }
    });

    updateSynthUI();
}
