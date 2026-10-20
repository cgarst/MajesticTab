// gpPlayer.js
// In-app artificial instrument (SoundFont synthesizer) player for Guitar Pro files
import { pauseYouTube, toggleYouTubePanel } from '../youtubePlayer.js';
import { gpState, renderGPPage } from './gpHandler.js';
import { getPagesPerView } from '../utils/viewModeUtils.js';
import { updateGlobalRewindButton, setActiveAudioMode } from '../utils/navigationUtils.js';
import { getInstrumentMode, isTrackGuitar, isTrackBass } from '../utils/tuningUtils.js';
import { enableIOSAudioPlayback, pauseIOSAudioPlayback, configureAudioSession, registerAudioContext } from '../utils/iosAudioUnlock.js';
import { fretboardController } from '../fretboard/fretboardController.js';

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
    masterVolume: 1.0,
    trackMode: 'fullBand',
    audioSyncAvailable: false,
    audioSyncEnabled: false,
    loopEnabled: false,
    loopStartMeasure: 1,
    loopEndMeasure: 1
};

export function syncSynthTrackModeLabels() {
    const isBass = getInstrumentMode() === 'bass';
    const soloLabel = document.getElementById('synthTrackGuitarsOnlyLabel') || document.querySelector('label[for="synthTrackGuitarsOnly"]');
    const muteLabel = document.getElementById('synthTrackNoGuitarsLabel') || document.querySelector('label[for="synthTrackNoGuitars"]');
    if (soloLabel) soloLabel.textContent = isBass ? 'Bass Only' : 'Guitars Only';
    if (muteLabel) muteLabel.textContent = isBass ? 'No Bass' : 'No Guitars';
}

function applySynthTrackMode() {
    if (!currentApi || !currentScore?.tracks) return;

    syncSynthTrackModeLabels();

    const trackModeRadios = document.querySelectorAll('input[name="synthTrackMode"]');
    trackModeRadios.forEach(radio => {
        radio.checked = radio.value === synthPlayerState.trackMode;
    });

    const isBassMode = getInstrumentMode() === 'bass';
    const targetTracks = [];
    const otherTracks = [];
    currentScore.tracks.forEach((track, index) => {
        const isTarget = isBassMode ? isTrackBass(track) : isTrackGuitar(track);
        (isTarget ? targetTracks : otherTracks).push(index);
    });

    const muteTarget = synthPlayerState.trackMode === 'noGuitars';
    const muteOtherTracks = synthPlayerState.trackMode === 'guitarsOnly';
    if (targetTracks.length) currentApi.changeTrackMute(targetTracks, muteTarget);
    if (otherTracks.length) currentApi.changeTrackMute(otherTracks, muteOtherTracks);
}

function isWithinLoopRange() {
    if (!currentApi || !currentScore?.masterBars?.length) return false;
    const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
    const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
    if (!firstBar || !lastBar) return false;
    const startTick = firstBar.start;
    const endTick = lastBar.start + lastBar.calculateDuration();
    const currentTick = currentApi.tickPosition ?? 0;
    return currentTick >= startTick && currentTick < endTick;
}

function seekToLoopStart() {
    const firstBar = currentScore?.masterBars?.[synthPlayerState.loopStartMeasure - 1];
    if (currentApi && firstBar) {
        currentApi.tickPosition = firstBar.start;
    }
}

export function applyLoopSettings() {
    if (!currentApi) return;
    if (synthPlayerState.loopEnabled && currentScore?.masterBars?.length) {
        const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
        const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
        if (firstBar && lastBar) {
            const startTick = firstBar.start;
            const endTick = lastBar.start + lastBar.calculateDuration();
            currentApi.playbackRange = { startTick, endTick };
            currentApi.isLooping = true;
            return;
        }
    }
    currentApi.isLooping = false;
    currentApi.playbackRange = null;
}

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
    const loopSwitch = document.getElementById('synthLoopSwitch');
    const loopStartInput = document.getElementById('synthLoopStartMeasure');
    const loopEndInput = document.getElementById('synthLoopEndMeasure');
    const hasScore = Boolean(currentApi);
    const canPlay = Boolean(currentApi && (synthPlayerState.isReady || synthPlayerState.soundFontLoaded || currentApi?.isReadyForPlayback || currentApi?.isSoundFontLoaded));
    const measureCount = currentScore?.masterBars?.length || 1;

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

    if (loopSwitch) {
        loopSwitch.checked = synthPlayerState.loopEnabled;
        loopSwitch.disabled = !hasScore;
    }

    if (loopStartInput && loopEndInput) {
        synthPlayerState.loopStartMeasure = Math.min(measureCount, Math.max(1, synthPlayerState.loopStartMeasure));
        synthPlayerState.loopEndMeasure = Math.min(measureCount, Math.max(1, synthPlayerState.loopEndMeasure));
        loopStartInput.min = '1';
        loopStartInput.max = String(measureCount);
        loopStartInput.value = String(synthPlayerState.loopStartMeasure);
        loopStartInput.disabled = !hasScore;
        loopEndInput.min = '1';
        loopEndInput.max = String(measureCount);
        loopEndInput.value = String(synthPlayerState.loopEndMeasure);
        loopEndInput.disabled = !hasScore;
    }

    // Update speed button active classes
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');
    speedButtons.forEach(btn => {
        const speedVal = parseFloat(btn.dataset.speed);
        if (Math.abs(speedVal - synthPlayerState.playbackSpeed) < 0.005) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Update Embedded Audio Sync switch and description
    const audioSyncSection = document.getElementById('synthAudioSyncSection');
    const audioSyncSwitch = document.getElementById('synthAudioSyncSwitch');
    const audioSyncDesc = document.getElementById('synthAudioSyncDesc');
    const trackModeContainer = document.getElementById('synthTrackModeContainer');
    const trackModeRadios = document.querySelectorAll('input[name="synthTrackMode"]');

    if (audioSyncSwitch) {
        audioSyncSwitch.disabled = !synthPlayerState.audioSyncAvailable || !hasScore;
        audioSyncSwitch.checked = synthPlayerState.audioSyncAvailable && synthPlayerState.audioSyncEnabled;
    }
    if (audioSyncSection) {
        if (synthPlayerState.audioSyncAvailable && hasScore) {
            audioSyncSection.classList.remove('opacity-50');
            if (audioSyncDesc) {
                audioSyncDesc.textContent = synthPlayerState.audioSyncEnabled
                    ? 'Guitar Pro 8 synced audio track active'
                    : 'SoundFont MIDI synthesizer active';
            }
        } else {
            audioSyncSection.classList.add('opacity-50');
            if (audioSyncDesc) {
                audioSyncDesc.textContent = 'Not provided in this tab';
            }
        }
    }
    if (trackModeContainer) {
        if (synthPlayerState.audioSyncAvailable && synthPlayerState.audioSyncEnabled) {
            trackModeContainer.classList.add('opacity-50');
            trackModeRadios.forEach(r => r.disabled = true);
        } else {
            trackModeContainer.classList.remove('opacity-50');
            trackModeRadios.forEach(r => r.disabled = !canPlay);
        }
    }
}

const playedBeatState = { beat: null, shownBeat: null };

export const READER_CURSOR_WIDTH = 20;

/**
 * Build SVG path for a vertically oriented pill/stadium with a pointed V-shaped bottom
 */
export function buildPillVPath(w, h) {
    const r = w / 2;
    const v = Math.min(12, Math.max(8, h * 0.12));
    return `M ${r} 1 A ${r - 1} ${r - 1} 0 0 1 ${w - 1} ${r} L ${w - 1} ${h - v} L ${r + 2} ${h - 3} Q ${r} ${h - 1} ${r - 2} ${h - 3} L 1 ${h - v} L 1 ${r} A ${r - 1} ${r - 1} 0 0 1 ${r} 1 Z`;
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

    // Prefer measuring the actual line reader cursor DOM element placed by AlphaTab
    const cursorEl = document.querySelector('.gp-reader-cursor') || document.querySelector('.at-cursor-beat') || document.querySelector('.at-cursor-bar');
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
 * Create a custom cursor handler for AlphaTab in Scroll and Page Modes
 * - Suppresses the whole-measure highlight box
 * - Replaces the beat line with a Line Reader tool shape
 *   (vertically oriented stadium / pill outline with pointed V-shaped bottom)
 * - Restricts bounds to physical staff lines to prevent bleeding into adjacent systems
 * - Handles smooth transitions between measures and across multi-track scores in Page Mode
 */
export function createCustomCursorHandler(api) {
    let readerEl = null;
    let svgPathEl = null;
    let lastH = 0;

    function getOrCreateReader() {
        const wrapper = api?._cursorWrapper?.element || document.querySelector('.at-cursors');
        if (!wrapper) return null;
        if (!readerEl || !wrapper.contains(readerEl)) {
            readerEl = wrapper.querySelector('.gp-reader-cursor');
            if (!readerEl) {
                readerEl = document.createElement('div');
                readerEl.className = 'gp-reader-cursor';
                readerEl.innerHTML = `<svg class="gp-reader-svg" width="${READER_CURSOR_WIDTH}" height="100" viewBox="0 0 ${READER_CURSOR_WIDTH} 100"><path class="gp-reader-path" d="" /></svg>`;
                wrapper.appendChild(readerEl);
            }
            svgPathEl = readerEl.querySelector('.gp-reader-path');
        }
        return readerEl;
    }

    function updateReaderDimensions(h) {
        if (!readerEl || Math.abs(h - lastH) < 1) return;
        lastH = h;
        const svg = readerEl.querySelector('svg');
        if (svg) {
            svg.setAttribute('width', `${READER_CURSOR_WIDTH}`);
            svg.setAttribute('height', `${h}`);
            svg.setAttribute('viewBox', `0 0 ${READER_CURSOR_WIDTH} ${h}`);
        }
        if (!svgPathEl) svgPathEl = readerEl.querySelector('.gp-reader-path');
        if (svgPathEl) {
            svgPathEl.setAttribute('d', buildPillVPath(READER_CURSOR_WIDTH, h));
        }
    }

    function getPageCursorContext(beatBounds) {
        const masterBounds = beatBounds?.barBounds?.masterBarBounds;
        if (!masterBounds) return null;

        const sysBounds = masterBounds.staffSystemBounds?.realBounds 
                       || masterBounds.staffSystemBounds?.visualBounds;
        const sysY = sysBounds?.y ?? 0;

        const originalBlocks = gpState.canvases[0]?.container 
            ? Array.from(gpState.canvases[0].container.querySelectorAll('div.at-surface.at > div')) 
            : [];
        let matchedBlockIndex = -1;
        if (originalBlocks.length > 0) {
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
        if (matchedBlockIndex < 0) return null;

        // Auto-advance page if necessary
        if (gpState.pages && gpState.pages.length) {
            let targetPage = -1;
            for (let p = 0; p < gpState.pages.length; p++) {
                if (gpState.pages[p].some(b => b.dataset.blockIndex === String(matchedBlockIndex))) {
                    targetPage = p;
                    break;
                }
            }
            if (targetPage >= 0) {
                const pagesPerView = getPagesPerView(true);
                if (targetPage < gpState.currentPageIndex || targetPage >= gpState.currentPageIndex + pagesPerView) {
                    gpState.currentPageIndex = targetPage;
                    const output = document.getElementById('output');
                    const continuousModeRadio = document.getElementById('continuousModeRadio');
                    renderGPPage(output, true, continuousModeRadio);
                }
            }
        }

        const visibleBlock = document.querySelector(`.alphaTab-gp-content div[data-block-index="${matchedBlockIndex}"]`);
        if (!visibleBlock) return null;

        // Remove stale page cursors on other blocks
        document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => {
            if (!visibleBlock.contains(el)) el.remove();
        });

        let cursorBeat = visibleBlock.querySelector('.gp-page-cursor-beat');
        let isNew = false;
        if (!cursorBeat) {
            cursorBeat = document.createElement('div');
            cursorBeat.className = 'gp-page-cursor-beat gp-reader-cursor';
            visibleBlock.appendChild(cursorBeat);
            isNew = true;
        }

        const svg = visibleBlock.querySelector('svg');
        const blockRect = visibleBlock.getBoundingClientRect();
        const svgRect = svg ? svg.getBoundingClientRect() : null;
        const svgLeftOffset = (svgRect && blockRect.width > 0) ? (svgRect.left - blockRect.left) : 0;
        const svgTopOffset = (svgRect && blockRect.height > 0) ? (svgRect.top - blockRect.top) : parseFloat(visibleBlock.style.paddingTop || '0');

        let staffTopY = visibleBlock._cachedStaffTopY;
        let staffHeight = visibleBlock._cachedStaffHeight;
        if (staffTopY === undefined && svg) {
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
            } else {
                staffTopY = null;
                staffHeight = null;
            }
            visibleBlock._cachedStaffTopY = staffTopY;
            visibleBlock._cachedStaffHeight = staffHeight;
        }

        const lineBounds = masterBounds.lineAlignedBounds || masterBounds.visualBounds;
        const sysRealY = sysBounds?.y ?? 0;
        const defaultBarY = svgTopOffset + ((lineBounds?.y ?? 0) - sysRealY);
        const barY = (staffTopY !== null && staffTopY !== undefined) ? staffTopY : defaultBarY;
        const barH = (staffHeight !== null && staffHeight !== undefined) ? staffHeight : (lineBounds?.h ?? 100);

        const topPadding = 15;
        const bottomPadding = 12;
        const cursorY = barY - topPadding;
        const cursorH = barH + topPadding + bottomPadding;

        let cursorSvg = cursorBeat.querySelector('svg');
        if (!cursorSvg) {
            cursorBeat.innerHTML = `<svg class="gp-reader-svg" width="${READER_CURSOR_WIDTH}" height="${cursorH}" viewBox="0 0 ${READER_CURSOR_WIDTH} ${cursorH}"><path class="gp-reader-path" d="" /></svg>`;
            cursorSvg = cursorBeat.querySelector('svg');
        }
        const path = cursorBeat.querySelector('.gp-reader-path');
        if (path && (!cursorBeat._lastH || Math.abs(cursorBeat._lastH - cursorH) >= 1)) {
            cursorBeat._lastH = cursorH;
            cursorSvg.setAttribute('width', `${READER_CURSOR_WIDTH}`);
            cursorSvg.setAttribute('height', `${cursorH}`);
            cursorSvg.setAttribute('viewBox', `0 0 ${READER_CURSOR_WIDTH} ${cursorH}`);
            path.setAttribute('d', buildPillVPath(READER_CURSOR_WIDTH, cursorH));
        }

        cursorBeat.style.top = `${cursorY}px`;
        cursorBeat.style.width = `${READER_CURSOR_WIDTH}px`;
        cursorBeat.style.height = `${cursorH}px`;
        cursorBeat.style.display = 'block';

        const scaleX = (svgRect && svg?.viewBox?.baseVal?.width > 0)
            ? (svgRect.width / svg.viewBox.baseVal.width)
            : 1;

        return { cursorBeat, svgLeftOffset, scaleX, isNew };
    }

    return {
        onAttach(cursors) {
            getOrCreateReader();
        },
        onDetach(cursors) {
            if (readerEl) {
                readerEl.remove();
                readerEl = null;
            }
            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        },
        reset() {
            if (readerEl) {
                readerEl.style.display = 'none';
            }
            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
        },
        placeBarCursor(barCursor, beatBounds) {
            // Measure highlight box is removed in favor of the line reader tool
            if (barCursor) {
                barCursor.setBounds(0, 0, 0, 0);
            }
        },
        placeBeatCursor(beatCursor, beatBounds, startBeatX) {
            if (beatBounds?.beat && !synthPlayerState.isPlaying) {
                fretboardController.showBeatsAtCursor(beatBounds.beat);
            }

            const pageModeRadio = document.getElementById('pageModeRadio');
            const isPageMode = pageModeRadio ? pageModeRadio.checked : false;

            if (isPageMode) {
                if (readerEl) readerEl.style.display = 'none';
                const ctx = getPageCursorContext(beatBounds);
                if (ctx) {
                    const posX = ctx.svgLeftOffset + (startBeatX * ctx.scaleX);
                    ctx.cursorBeat.style.transition = 'none';
                    ctx.cursorBeat.style.left = `${posX}px`;
                    void ctx.cursorBeat.offsetWidth; // Force reflow
                    ctx.cursorBeat._placed = true;
                }
                return;
            }

            document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());

            const masterBounds = beatBounds?.barBounds?.masterBarBounds;
            // Use lineAlignedBounds to strictly bound to physical staff lines
            const lineBounds = masterBounds?.lineAlignedBounds 
                || masterBounds?.visualBounds 
                || beatBounds?.barBounds?.visualBounds;

            if (lineBounds) {
                const topPadding = 15;
                const bottomPadding = 12;
                let cursorY = lineBounds.y - topPadding;
                let cursorH = lineBounds.h + topPadding + bottomPadding;

                // Safety guard: clamp to staff system bounds to prevent bleeding into next system
                const sysBounds = masterBounds?.staffSystemBounds?.visualBounds 
                               || masterBounds?.staffSystemBounds?.realBounds;
                if (sysBounds && sysBounds.h > 0) {
                    const maxBottom = sysBounds.y + sysBounds.h;
                    if (cursorY + cursorH > maxBottom) {
                        cursorH = Math.max(30, maxBottom - cursorY);
                    }
                }

                const reader = getOrCreateReader();
                if (reader) {
                    updateReaderDimensions(cursorH);
                    reader.style.transition = 'none';
                    reader.style.left = `${startBeatX}px`;
                    reader.style.top = `${cursorY}px`;
                    reader.style.height = `${cursorH}px`;
                    reader.style.display = 'block';
                    void reader.offsetWidth; // Force reflow so transition starts cleanly
                }

                if (beatCursor) {
                    beatCursor.transitionToX(0, startBeatX);
                    beatCursor.setBounds(startBeatX, cursorY, 1, cursorH);
                }
            }
        },
        transitionBeatCursor(beatCursor, beatBounds, startBeatX, nextBeatX, duration, cursorMode) {
            const pageModeRadio = document.getElementById('pageModeRadio');
            const isPageMode = pageModeRadio ? pageModeRadio.checked : false;

            const factor = (cursorMode === alphaTab.midi?.MidiTickLookupFindBeatResultCursorMode?.ToNextBext) ? 2 : 1;
            const targetX = startBeatX + (nextBeatX - startBeatX) * factor;
            const animDuration = duration * factor;

            if (isPageMode) {
                if (readerEl) readerEl.style.display = 'none';
                const ctx = getPageCursorContext(beatBounds);
                if (ctx) {
                    const posX = ctx.svgLeftOffset + (targetX * ctx.scaleX);
                    if (!ctx.cursorBeat._placed || ctx.isNew) {
                        const startX = ctx.svgLeftOffset + (startBeatX * ctx.scaleX);
                        ctx.cursorBeat.style.transition = 'none';
                        ctx.cursorBeat.style.left = `${startX}px`;
                        void ctx.cursorBeat.offsetWidth;
                        ctx.cursorBeat._placed = true;
                    }
                    ctx.cursorBeat.style.transition = `left ${animDuration}ms linear`;
                    ctx.cursorBeat.style.left = `${posX}px`;
                }
                return;
            }

            const reader = getOrCreateReader();
            if (reader) {
                reader.style.transition = `left ${animDuration}ms linear`;
                reader.style.left = `${targetX}px`;
            }

            if (beatCursor) {
                beatCursor.transitionToX(animDuration, targetX);
            }
        }
    };
}

/**
 * Attach AlphaTab API to the synth player
 */
export function attachAlphaTabApi(api) {
    currentApi = api;
    currentScore = api.score;

    if (!api.customCursorHandler) {
        api.customCursorHandler = createCustomCursorHandler(api);
    }

    if (api?.player) {
        if (api.player.context) registerAudioContext(api.player.context);
        if (api.player._audioContext) registerAudioContext(api.player._audioContext);
        if (api.player.synth?.context) registerAudioContext(api.player.synth.context);
    }

    synthPlayerState.loopEnabled = false;
    synthPlayerState.loopStartMeasure = 1;
    synthPlayerState.loopEndMeasure = Math.max(1, currentScore?.masterBars?.length || 1);
    applyLoopSettings();

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

    const hasAudioSync = Boolean(currentScore?.backingTrack?.rawAudioFile);
    synthPlayerState.audioSyncAvailable = hasAudioSync;
    synthPlayerState.audioSyncEnabled = hasAudioSync && (
        api.settings?.player?.playerMode === alphaTab.PlayerMode.EnabledBackingTrack ||
        api.settings?.player?.playerMode === alphaTab.PlayerMode.EnabledAutomatic
    );

    if (!synthPlayerState.audioSyncEnabled) {
        applySynthTrackMode();
    }

    fretboardController.attachAlphaTabApi(api);

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
        if (!synthPlayerState.audioSyncEnabled) {
            applySynthTrackMode();
        }
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
            enableIOSAudioPlayback();
        } else {
            pauseIOSAudioPlayback();
        }
        updateSynthUI();
    });

    // Multi-track active beats synchronization for fretboard visualizer
    if (api.activeBeatsChanged) {
        api.activeBeatsChanged.on((args) => {
            if (args?.activeBeats) {
                fretboardController.onActiveBeatsChanged(args.activeBeats);
            }
        });
    }

    api.playedBeatChanged.on((beat) => {
        playedBeatState.beat = beat;
        if (!api.activeBeatsChanged) {
            fretboardController.onBeatChanged(beat);
        }
    });

    if (api.beatMouseDown) {
        api.beatMouseDown.on((beat) => {
            if (!synthPlayerState.isPlaying && beat) {
                fretboardController.showBeatsAtCursor(beat);
            }
        });
    }

    // Player Position Changed
    api.playerPositionChanged.on((args) => {
        synthPlayerState.currentTime = args.currentTime;
        synthPlayerState.endTime = args.endTime;

        if (synthPlayerState.loopEnabled && synthPlayerState.isPlaying && currentScore?.masterBars?.length) {
            const firstBar = currentScore.masterBars[synthPlayerState.loopStartMeasure - 1];
            const lastBar = currentScore.masterBars[synthPlayerState.loopEndMeasure - 1];
            const loopEndTick = lastBar.start + lastBar.calculateDuration();
            if (firstBar && args.currentTick >= loopEndTick) {
                currentApi.tickPosition = firstBar.start;
            }
        }

        updateSynthUI();
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
    playedBeatState.beat = null;
    playedBeatState.shownBeat = null;
    document.body.classList.remove('synth-playback-started');
    document.querySelectorAll('.gp-page-cursor-bar, .gp-page-cursor-beat').forEach(el => el.remove());
    if (currentApi?.customCursorHandler?.reset) {
        currentApi.customCursorHandler.reset();
    } else {
        document.querySelectorAll('.gp-reader-cursor').forEach(el => { el.style.display = 'none'; });
    }
    fretboardController.clearActiveNotes();
}

/**
 * Detach AlphaTab API and hide player
 */
export function detachAlphaTabApi() {
    pauseIOSAudioPlayback();
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
    synthPlayerState.audioSyncAvailable = false;
    synthPlayerState.audioSyncEnabled = false;
    synthPlayerState.currentTime = 0;
    synthPlayerState.endTime = 0;

    clearSynthHighlights();
    fretboardController.onScoreClosed();
    toggleSynthPanel(false);
    hideSynthPlayer();
    updateSynthUI();
}

/**
 * Enable or disable embedded audio sync backing track for Guitar Pro 8 files
 * @param {boolean} enabled
 */
export function setAudioSyncEnabled(enabled) {
    if (!currentApi || !synthPlayerState.audioSyncAvailable) return;
    synthPlayerState.audioSyncEnabled = enabled;

    const wasPlaying = synthPlayerState.isPlaying;
    if (wasPlaying) {
        pauseSynthPlayer();
    }

    currentApi.settings.player.playerMode = enabled
        ? alphaTab.PlayerMode.EnabledBackingTrack
        : alphaTab.PlayerMode.EnabledSynthesizer;

    currentApi.updateSettings();
    if (typeof currentApi.loadMidiForScore === 'function') {
        currentApi.loadMidiForScore();
    }

    currentApi.playbackSpeed = synthPlayerState.playbackSpeed;
    if (!enabled) {
        applySynthTrackMode();
    }
    updateSynthUI();
}

/**
 * Toggle play / pause
 */
export function playPauseSynth() {
    if (!currentApi) return;
    try {
        pauseYouTube();
        applyLoopSettings();
        if (!synthPlayerState.isPlaying) {
            enableIOSAudioPlayback();
        }
        if (!synthPlayerState.isPlaying && synthPlayerState.loopEnabled) {
            if (!isWithinLoopRange()) {
                seekToLoopStart();
            }
        }
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
    pauseIOSAudioPlayback();
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

export const scoreOptionsState = {
    isOpen: false,
    isAvailable: false
};

/**
 * Show / Enable top bar Score Options button (when notation options are available)
 */
export function showScoreOptions(fileType = 'gp') {
    scoreOptionsState.isAvailable = true;
    const btn = document.getElementById('topBarSongTitleBtn');
    const chevron = btn?.querySelector('.song-title-chevron');
    const notationSection = document.getElementById('scoreOptionsNotationStyleSection');
    const stringCountSection = document.getElementById('scoreOptionsStringCountSection');
    const tracksSection = document.getElementById('synthTrackVisibilitySection');
    const pdfSection = document.getElementById('scoreOptionsPdfSection');
    const fretboardSection = document.getElementById('scoreOptionsFretboardSection');
    const exportPdfBtn = document.getElementById('exportPDFBtn');
    const exportSourceBtn = document.getElementById('exportSourceTabBtn');

    if (btn) {
        btn.classList.remove('disabled', 'is-static');
        btn.removeAttribute('disabled');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-disabled', 'false');
        const songTitleEl = document.getElementById('topBarSongTitle');
        const displayName = songTitleEl?.textContent || '';
        btn.title = displayName ? `${displayName} - Notation Options` : 'Notation Options';
    }
    if (chevron) {
        chevron.style.display = '';
    }

    if (fileType === 'gp') {
        if (notationSection) notationSection.style.display = '';
        if (stringCountSection) stringCountSection.style.display = '';
        if (fretboardSection) fretboardSection.style.display = '';
        if (pdfSection) pdfSection.style.display = 'none';
        if (exportPdfBtn) exportPdfBtn.style.display = '';
        fretboardController.setScoreAvailable(true);
    } else if (fileType === 'pdf') {
        if (notationSection) notationSection.style.display = 'none';
        if (stringCountSection) stringCountSection.style.display = 'none';
        if (fretboardSection) fretboardSection.style.display = 'none';
        if (tracksSection) tracksSection.style.display = 'none';
        if (pdfSection) pdfSection.style.display = '';
        const condensePdfCheckbox = document.getElementById('condensePdfMode');
        if (exportPdfBtn) exportPdfBtn.style.display = (condensePdfCheckbox && condensePdfCheckbox.checked) ? '' : 'none';
        fretboardController.setScoreAvailable(false);
    } else {
        // txt or other
        if (notationSection) notationSection.style.display = 'none';
        if (stringCountSection) stringCountSection.style.display = 'none';
        if (fretboardSection) fretboardSection.style.display = 'none';
        if (tracksSection) tracksSection.style.display = 'none';
        if (pdfSection) pdfSection.style.display = 'none';
        if (exportPdfBtn) exportPdfBtn.style.display = 'none';
        fretboardController.setScoreAvailable(false);
    }
    if (exportSourceBtn) {
        exportSourceBtn.style.display = '';
    }
}

/**
 * Hide / Disable top bar Score Options (when no file is loaded)
 */
export function hideScoreOptions() {
    scoreOptionsState.isAvailable = false;
    toggleScoreOptionsPanel(false);
    const btn = document.getElementById('topBarSongTitleBtn');
    const chevron = btn?.querySelector('.song-title-chevron');
    const notationSection = document.getElementById('scoreOptionsNotationStyleSection');
    const stringCountSection = document.getElementById('scoreOptionsStringCountSection');
    const tracksSection = document.getElementById('synthTrackVisibilitySection');
    const pdfSection = document.getElementById('scoreOptionsPdfSection');
    const fretboardSection = document.getElementById('scoreOptionsFretboardSection');
    const exportPdfBtn = document.getElementById('exportPDFBtn');
    const exportSourceBtn = document.getElementById('exportSourceTabBtn');

    if (btn) {
        btn.classList.add('disabled', 'is-static');
        btn.removeAttribute('aria-expanded');
        btn.setAttribute('aria-disabled', 'true');
        const songTitleEl = document.getElementById('topBarSongTitle');
        const displayName = songTitleEl?.textContent || '';
        btn.title = displayName || '';
    }
    if (chevron) {
        chevron.style.display = 'none';
    }
    if (notationSection) {
        notationSection.style.display = 'none';
    }
    if (stringCountSection) {
        stringCountSection.style.display = 'none';
    }
    if (fretboardSection) {
        fretboardSection.style.display = 'none';
    }
    fretboardController.setScoreAvailable(false);
    if (tracksSection) {
        tracksSection.style.display = 'none';
    }
    if (pdfSection) {
        pdfSection.style.display = 'none';
    }
    if (exportPdfBtn) {
        exportPdfBtn.style.display = 'none';
    }
    if (exportSourceBtn) {
        exportSourceBtn.style.display = 'none';
    }
}

export function updateScoreOptionsPanelPosition() {
    const panel = document.getElementById('scoreOptionsDropdownPanel');
    const toggleBtn = document.getElementById('topBarSongTitleBtn');
    if (!panel || !toggleBtn || !scoreOptionsState.isOpen) return;

    const rect = toggleBtn.getBoundingClientRect();
    if (window.innerWidth <= 576) {
        panel.style.position = 'fixed';
        panel.style.top = `${rect.bottom + 8}px`;
        panel.style.left = '0.5rem';
        panel.style.right = '0.5rem';
        panel.style.width = 'auto';
        panel.style.transform = 'none';
        return;
    }

    panel.style.position = 'fixed';
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.right = 'auto';
    panel.style.width = '';
    const centerX = rect.left + rect.width / 2;
    const halfPanelWidth = Math.min(185, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Toggle collapsible score & notation options panel
 */
export function toggleScoreOptionsPanel(forceState = null) {
    const panel = document.getElementById('scoreOptionsDropdownPanel');
    const toggleBtn = document.getElementById('topBarSongTitleBtn');

    if (!panel) return;

    if (!scoreOptionsState.isAvailable && forceState !== false) {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
        toggleBtn?.setAttribute('aria-expanded', 'false');
        scoreOptionsState.isOpen = false;
        return;
    }

    const newState = forceState !== null ? forceState : !scoreOptionsState.isOpen;
    scoreOptionsState.isOpen = newState;

    if (newState) {
        // Close other panels if open, without interrupting audio playback
        toggleSynthPanel(false);
        toggleYouTubePanel(false);
        document.getElementById('pdfBookmarksPanelCloseBtn')?.click();

        updateScoreOptionsPanelPosition();
        panel.style.display = 'block';
        toggleBtn?.classList.add('active');
        toggleBtn?.setAttribute('aria-expanded', 'true');
    } else {
        panel.style.display = 'none';
        toggleBtn?.classList.remove('active');
        toggleBtn?.setAttribute('aria-expanded', 'false');
    }
}

/**
 * Initialize all DOM event listeners for the Score Options Panel
 */
export function initScoreOptionsPanel() {
    hideScoreOptions();
    const toggleBtn = document.getElementById('topBarSongTitleBtn');
    const closeBtn = document.getElementById('scoreOptionsPanelCloseBtn');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!scoreOptionsState.isAvailable) return;
        toggleScoreOptionsPanel();
    });

    closeBtn?.addEventListener('click', () => {
        toggleScoreOptionsPanel(false);
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('scoreOptionsDropdownPanel');
        const toggleBtn = document.getElementById('topBarSongTitleBtn');

        if (scoreOptionsState.isOpen && panel && !panel.contains(e.target) && !toggleBtn?.contains(e.target)) {
            toggleScoreOptionsPanel(false);
        }
    });

    window.addEventListener('resize', updateScoreOptionsPanelPosition);
    document.addEventListener('fullscreenchange', updateScoreOptionsPanelPosition);
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

export function updateSynthPanelPosition() {
    const panel = document.getElementById('synthDropdownPanel');
    const toggleBtn = document.getElementById('synthToggleBtn');
    if (!panel || !synthPlayerState.isOpen) return;

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
    const halfPanelWidth = Math.min(185, (window.innerWidth - 24) / 2);
    const clampedLeft = Math.max(halfPanelWidth + 12, Math.min(window.innerWidth - halfPanelWidth - 12, centerX));
    panel.style.left = `${clampedLeft}px`;
    panel.style.transform = 'translateX(-50%)';
}

/**
 * Toggle collapsible synth settings panel
 */
export function toggleSynthPanel(forceState = null) {
    const panel = document.getElementById('synthDropdownPanel');
    const toggleBtn = document.getElementById('synthToggleBtn');
    const mobileBtn = document.getElementById('mobileSynthToggleBtn');

    if (!panel) return;

    const newState = forceState !== null ? forceState : !synthPlayerState.isOpen;
    synthPlayerState.isOpen = newState;

    if (newState) {
        setActiveAudioMode('synth');
        // Ensure YouTube panel and Score Options panel are closed and YouTube playback paused when opening synth panel
        toggleYouTubePanel(false);
        toggleScoreOptionsPanel(false);
        document.getElementById('pdfBookmarksPanelCloseBtn')?.click();
        pauseYouTube();

        updateSynthPanelPosition();
        panel.style.display = 'block';
        toggleBtn?.classList.add('active');
        mobileBtn?.classList.add('active');
    } else {
        panel.style.display = 'none';
        panel.classList.remove('popup-from-bottom');
        toggleBtn?.classList.remove('active');
        mobileBtn?.classList.remove('active');
    }
}

/**
 * Initialize all DOM event listeners for the Synth Player
 */
export function initSynthPlayer() {
    hideSynthPlayer();
    syncSynthTrackModeLabels();
    const toggleBtn = document.getElementById('synthToggleBtn');
    const closeBtn = document.getElementById('synthPanelCloseBtn');
    const metronomeQuickBtn = document.getElementById('synthMetronomeQuickBtn');
    const metronomeSwitch = document.getElementById('synthMetronomeSwitch');
    const countInSwitch = document.getElementById('synthCountInSwitch');
    const seekSlider = document.getElementById('synthSeekSlider');
    const speedButtons = document.querySelectorAll('#synthSpeedButtons button');
    const trackModeRadios = document.querySelectorAll('input[name="synthTrackMode"]');
    const loopSwitch = document.getElementById('synthLoopSwitch');
    const loopStartInput = document.getElementById('synthLoopStartMeasure');
    const loopEndInput = document.getElementById('synthLoopEndMeasure');

    toggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        pauseYouTube();
        toggleSynthPanel();
    });

    window.addEventListener('resize', () => {
        if (!synthPlayerState.isOpen) return;
        updateSynthPanelPosition();
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

    const audioSyncSwitch = document.getElementById('synthAudioSyncSwitch');
    audioSyncSwitch?.addEventListener('change', (e) => {
        setAudioSyncEnabled(e.target.checked);
    });

    trackModeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            synthPlayerState.trackMode = radio.value;
            applySynthTrackMode();
        });
    });

    loopSwitch?.addEventListener('change', () => {
        synthPlayerState.loopEnabled = loopSwitch.checked;
        applyLoopSettings();
        if (synthPlayerState.loopEnabled && !isWithinLoopRange()) {
            seekToLoopStart();
        }
        updateSynthUI();
    });

    const handleLoopStartChange = () => {
        const measureCount = currentScore?.masterBars?.length || 1;
        const value = Number.parseInt(loopStartInput.value, 10);
        if (Number.isFinite(value) && value >= 1) {
            const clampedStart = Math.min(measureCount, Math.max(1, value));
            synthPlayerState.loopStartMeasure = clampedStart;
            if (synthPlayerState.loopEndMeasure < clampedStart) {
                synthPlayerState.loopEndMeasure = clampedStart;
            }
            synthPlayerState.loopEnabled = true;
            applyLoopSettings();
            updateSynthUI();
        }
    };

    loopStartInput?.addEventListener('input', handleLoopStartChange);
    loopStartInput?.addEventListener('change', handleLoopStartChange);

    const handleLoopEndChange = () => {
        const measureCount = currentScore?.masterBars?.length || 1;
        const value = Number.parseInt(loopEndInput.value, 10);
        if (Number.isFinite(value) && value >= 1) {
            const clampedEnd = Math.min(measureCount, Math.max(1, value));
            synthPlayerState.loopEndMeasure = clampedEnd;
            if (synthPlayerState.loopStartMeasure > clampedEnd) {
                synthPlayerState.loopStartMeasure = clampedEnd;
            }
            synthPlayerState.loopEnabled = true;
            applyLoopSettings();
            updateSynthUI();
        }
    };

    loopEndInput?.addEventListener('input', handleLoopEndChange);
    loopEndInput?.addEventListener('change', handleLoopEndChange);

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
    const handleOutsideSynthClick = (e) => {
        const panel = document.getElementById('synthDropdownPanel');
        const sourcePill = document.getElementById('audioSourcePill');
        const mobileDock = document.getElementById('mobilePlaybackDock');

        if (synthPlayerState.isOpen && panel && !panel.contains(e.target) && !sourcePill?.contains(e.target) && !mobileDock?.contains(e.target)) {
            toggleSynthPanel(false);
        }
    };
    document.addEventListener('click', handleOutsideSynthClick);
    document.addEventListener('pointerdown', handleOutsideSynthClick);

    window.addEventListener('resize', updateSynthPanelPosition);
    document.addEventListener('fullscreenchange', updateSynthPanelPosition);

    updateSynthUI();
}
