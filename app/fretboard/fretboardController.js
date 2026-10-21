// fretboardController.js
// Controller coordinating AlphaTab events, multi-track note aggregation, layout, and virtual fretboard rendering
import { FretboardView } from './fretboardView.js';
import { formatTuningFromMidi } from '../utils/tuningUtils.js';

const STORAGE_KEY_OPEN = 'majestictab_fretboard_open';
const STORAGE_KEY_MODE = 'majestictab_fretboard_display_mode';
const STORAGE_KEY_LH = 'majestictab_fretboard_left_handed';
const STORAGE_KEY_FLIP = 'majestictab_fretboard_flip_strings';

export const TRACK_PALETTE = ['var(--accent-primary, #6366f1)', '#ec4899', '#f59e0b', '#06b6d4'];

class FretboardController {
    constructor() {
        this.view = null;
        this.isOpen = false;
        this.isScoreAvailable = false;
        this.displayMode = 'notes'; // 'notes' | 'frets'
        this.isLeftHanded = false;
        this.isFlipped = false; // false = Tab View (high on top), true = Player View (low on top)

        this.currentApi = null;
        this.activeScore = null;
        this.visibleTracks = []; // All currently rendered tracks in score
        this.trackNotesMap = new Map(); // trackIndex -> Array of active notes

        this.tuning = [64, 59, 55, 50, 45, 40];
        this.stringCount = 6;
        this.capo = 0;

        this.lastBeatNotes = [];
        this.activeBeatIds = new Set();
        this.lastTickPosition = null;
        this.audioCtx = null;
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        // Restore saved preferences
        try {
            this.isOpen = localStorage.getItem(STORAGE_KEY_OPEN) === 'true';
            const savedMode = localStorage.getItem(STORAGE_KEY_MODE);
            this.displayMode = savedMode === 'frets' ? 'frets' : 'notes';
            this.isLeftHanded = localStorage.getItem(STORAGE_KEY_LH) === 'true';
            this.isFlipped = localStorage.getItem(STORAGE_KEY_FLIP) === 'true';
        } catch (_) {
            this.isOpen = false;
            this.displayMode = 'notes';
            this.isLeftHanded = false;
            this.isFlipped = false;
        }

        const container = document.getElementById('fretboardSvgContainer');
        if (container) {
            this.view = new FretboardView(container, {
                onFretClick: (stringIdx, fret, midiPitch) => {
                    this.playPluckSound(midiPitch);
                }
            });
        }

        this.bindEvents();
        this.updateModeUI();
        this.updateLeftHandedUI();
        this.updateFlippedUI();

        // Render initial view
        this.view?.renderNeck({
            stringCount: this.stringCount,
            tuning: this.tuning,
            capo: this.capo,
            isLeftHanded: this.isLeftHanded,
            isFlipped: this.isFlipped,
            displayMode: this.displayMode
        });
    }

    bindEvents() {
        // Top bar toggle button
        const topBarToggle = document.getElementById('fretboardToggleBtn');
        topBarToggle?.addEventListener('click', () => {
            this.toggle();
        });

        // Dock close button
        const closeBtn = document.getElementById('fretboardCloseBtn');
        closeBtn?.addEventListener('click', () => {
            this.toggle(false);
        });

        // Display mode pill buttons (Notes | Frets)
        const modeButtons = document.querySelectorAll('[data-fretboard-mode]');
        modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.fretboardMode;
                if (mode === 'notes' || mode === 'frets') {
                    this.setDisplayMode(mode);
                }
            });
        });

        // Left-handed toggle button
        const lhBtn = document.getElementById('fretboardLhBtn');
        lhBtn?.addEventListener('click', () => {
            this.setLeftHanded(!this.isLeftHanded);
        });

        // Invert strings (flip) toggle button
        const flipBtn = document.getElementById('fretboardFlipBtn');
        flipBtn?.addEventListener('click', () => {
            this.setFlipped(!this.isFlipped);
        });

        // Keyboard shortcut: F key (when not focused in an input)
        window.addEventListener('keydown', (e) => {
            if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const activeEl = document.activeElement;
                const isInput = activeEl && (
                    (activeEl.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit'].includes(activeEl.type)) ||
                    activeEl.tagName === 'TEXTAREA' ||
                    activeEl.isContentEditable
                );
                if (!isInput && this.isScoreAvailable) {
                    e.preventDefault();
                    this.toggle();
                }
            }
        });
    }

    /**
     * Toggle fretboard dock open/closed
     * @param {boolean} [forceState]
     */
    toggle(forceState) {
        if (!this.isScoreAvailable && (forceState === true || (forceState === undefined && !this.isOpen))) {
            return;
        }

        this.isOpen = (forceState !== undefined) ? Boolean(forceState) : !this.isOpen;

        try {
            localStorage.setItem(STORAGE_KEY_OPEN, String(this.isOpen));
        } catch (_) {}

        this.syncUIState();
        this.triggerLayoutRefresh();
    }

    /**
     * Publish the dock's real height so the score and playback dock clear it
     */
    trackDockHeight(dock) {
        if (!dock || this.dockResizeObserver || typeof ResizeObserver === 'undefined') return;
        const root = document.documentElement;
        this.dockResizeObserver = new ResizeObserver(() => {
            const height = Math.ceil(dock.getBoundingClientRect().height);
            if (height > 0) root.style.setProperty('--fretboard-dock-height', `${height}px`);
        });
        this.dockResizeObserver.observe(dock);
    }

    syncUIState() {
        const dock = document.getElementById('fretboardDock');
        this.trackDockHeight(dock);
        const topBarToggle = document.getElementById('fretboardToggleBtn');

        if (this.isOpen && this.isScoreAvailable) {
            dock?.style.setProperty('display', 'block');
            dock?.classList.remove('is-hidden');
            document.body.classList.add('fretboard-open');
            topBarToggle?.classList.add('active');
            if (this.lastBeatNotes?.length) {
                this.view?.updateActiveNotes(this.lastBeatNotes, this.displayMode);
            } else {
                this.refreshCursorNotes();
            }
        } else {
            dock?.classList.add('is-hidden');
            setTimeout(() => {
                if (!this.isOpen || !this.isScoreAvailable) {
                    dock?.style.setProperty('display', 'none');
                }
            }, 250);
            document.body.classList.remove('fretboard-open');
            topBarToggle?.classList.remove('active');
            this.view?.clearActiveNotes();
        }
    }

    /**
     * Update display mode ('notes' | 'frets')
     * @param {string} mode
     */
    setDisplayMode(mode) {
        if (mode !== 'notes' && mode !== 'frets') return;
        this.displayMode = mode;

        try {
            localStorage.setItem(STORAGE_KEY_MODE, mode);
        } catch (_) {}

        this.updateModeUI();

        if (this.lastBeatNotes?.length) {
            this.view?.updateActiveNotes(this.lastBeatNotes, this.displayMode);
        }
    }

    updateModeUI() {
        const modeButtons = document.querySelectorAll('[data-fretboard-mode]');
        modeButtons.forEach(btn => {
            const isMatch = btn.dataset.fretboardMode === this.displayMode;
            btn.classList.toggle('active', isMatch);
        });
    }

    /**
     * Set left-handed orientation
     * @param {boolean} isLeftHanded
     */
    setLeftHanded(isLeftHanded) {
        this.isLeftHanded = Boolean(isLeftHanded);

        try {
            localStorage.setItem(STORAGE_KEY_LH, String(this.isLeftHanded));
        } catch (_) {}

        this.updateLeftHandedUI();

        this.view?.renderNeck({
            stringCount: this.stringCount,
            tuning: this.tuning,
            capo: this.capo,
            isLeftHanded: this.isLeftHanded,
            isFlipped: this.isFlipped,
            displayMode: this.displayMode
        });

        if (this.lastBeatNotes?.length) {
            this.view?.updateActiveNotes(this.lastBeatNotes, this.displayMode);
        }
    }

    updateLeftHandedUI() {
        const lhBtn = document.getElementById('fretboardLhBtn');
        lhBtn?.classList.toggle('active', this.isLeftHanded);
    }

    /**
     * Invert string order (Tab View vs Player View)
     * @param {boolean} isFlipped
     */
    setFlipped(isFlipped) {
        this.isFlipped = Boolean(isFlipped);

        try {
            localStorage.setItem(STORAGE_KEY_FLIP, String(this.isFlipped));
        } catch (_) {}

        this.updateFlippedUI();

        this.view?.renderNeck({
            stringCount: this.stringCount,
            tuning: this.tuning,
            capo: this.capo,
            isLeftHanded: this.isLeftHanded,
            isFlipped: this.isFlipped,
            displayMode: this.displayMode
        });

        if (this.lastBeatNotes?.length) {
            this.view?.updateActiveNotes(this.lastBeatNotes, this.displayMode);
        }
    }

    updateFlippedUI() {
        const flipBtn = document.getElementById('fretboardFlipBtn');
        flipBtn?.classList.toggle('active', this.isFlipped);
    }

    /**
     * Mark whether a Guitar Pro score is actively loaded
     * @param {boolean} isAvailable
     */
    setScoreAvailable(isAvailable) {
        this.isScoreAvailable = Boolean(isAvailable);

        const pill = document.getElementById('fretboardPill');
        if (pill) pill.style.display = this.isScoreAvailable ? '' : 'none';

        if (this.isScoreAvailable) {
            if (this.isOpen) {
                this.syncUIState();
            }
        } else {
            this.clearActiveNotes();
            this.syncUIState();
        }
    }

    /**
     * Called when AlphaTab API is attached
     * @param {Object} api
     */
    attachAlphaTabApi(api) {
        this.currentApi = api;
        this.setScoreAvailable(Boolean(api?.score));

        if (api?.score) {
            this.onScoreLoaded(api, api.tracks);
        }
    }

    /**
     * Called when a score is loaded into AlphaTab
     * @param {Object} api
     * @param {Array<Object>} [renderedTracks]
     */
    onScoreLoaded(api, renderedTracks = null) {
        this.currentApi = api;
        this.activeScore = api.score;
        this.setScoreAvailable(true);

        const tracks = renderedTracks || api.tracks || api.score?.tracks || [];
        this.onTrackSelectionChanged(tracks);
        this.refreshCursorNotes();
    }

    /**
     * Called when visible tracks selection changes in gpHandler
     * @param {Array<Object>|Object} visibleTracksInput
     */
    onTrackSelectionChanged(visibleTracksInput) {
        const tracks = Array.isArray(visibleTracksInput)
            ? visibleTracksInput
            : (visibleTracksInput ? [visibleTracksInput] : []);

        this.visibleTracks = tracks.length > 0
            ? tracks
            : (this.currentApi?.tracks || this.activeScore?.tracks?.slice(0, 1) || []);

        this.trackNotesMap.clear();

        // Primary track determines neck geometry and tunings
        const primaryTrack = this.visibleTracks[0] || null;
        this.updateNeckInstrument(primaryTrack);
        this.updateTrackLegend();
    }

    /**
     * Raw string tunings (MIDI) for a track, or null when it has none
     */
    getTrackTunings(track) {
        if (!track) return null;
        for (const staff of (track.staves || [])) {
            if (staff.isPercussion) continue;
            if (staff.stringTuning?.tunings && staff.stringTuning.tunings.length > 0) {
                return staff.stringTuning.tunings;
            }
        }
        if (Array.isArray(track.tuning) && track.tuning.length > 0) return track.tuning;
        return null;
    }

    /**
     * Update active instrument tuning, string count, and capo from primary track
     */
    updateNeckInstrument(track) {
        if (!track) return;

        const rawTunings = this.getTrackTunings(track);

        if (Array.isArray(rawTunings) && rawTunings.length > 0) {
            this.stringCount = rawTunings.length;
            this.tuning = [...rawTunings];
        } else {
            this.stringCount = 6;
            this.tuning = [64, 59, 55, 50, 45, 40];
        }

        this.capo = track.capo || track.staves?.[0]?.capo || 0;

        const tuningBadgeEl = document.getElementById('fretboardTuningBadge');
        const capoBadgeEl = document.getElementById('fretboardCapoBadge');

        if (tuningBadgeEl) {
            // List every distinct tuning among visible pitched tracks, primary first
            const labels = [];
            for (const t of this.visibleTracks) {
                const raw = this.getTrackTunings(t);
                if (!raw) continue;
                const label = formatTuningFromMidi(raw) || `${raw.length}-String`;
                if (!labels.includes(label)) labels.push(label);
            }
            const formatted = labels.length > 0 ? labels.join(' · ') : formatTuningFromMidi(this.tuning);
            tuningBadgeEl.textContent = formatted || `${this.stringCount}-String`;
            tuningBadgeEl.setAttribute('title', `Tuning: ${formatted || 'Custom'}`);
        }

        if (capoBadgeEl) {
            if (this.capo > 0) {
                capoBadgeEl.textContent = `Capo ${this.capo}`;
                capoBadgeEl.style.display = 'inline-flex';
            } else {
                capoBadgeEl.style.display = 'none';
            }
        }

        // Render Neck
        this.view?.renderNeck({
            stringCount: this.stringCount,
            tuning: this.tuning,
            capo: this.capo,
            isLeftHanded: this.isLeftHanded,
            isFlipped: this.isFlipped,
            displayMode: this.displayMode
        });
    }

    /**
     * Render track chips in the dock header legend
     */
    updateTrackLegend() {
        const legendContainer = document.getElementById('fretboardTracksLegend');
        if (!legendContainer) return;

        if (this.visibleTracks.length <= 1) {
            const track = this.visibleTracks[0];
            const name = track?.name || 'Guitar';
            legendContainer.style.display = 'inline-flex';
            legendContainer.innerHTML = `
                <div class="fretboard-track-badge" id="fretboardTrackBadge" title="${name}">
                    <i class="bi-music-note-beamed text-info"></i>
                    <span class="fretboard-track-name text-truncate" id="fretboardTrackName">${name}</span>
                </div>
            `;
            return;
        }

        // Multiple tracks rendered simultaneously: show colors only, names in a popup
        legendContainer.style.display = 'inline-flex';
        const dotsHtml = this.visibleTracks.map((t, idx) => {
            const color = TRACK_PALETTE[idx % TRACK_PALETTE.length];
            return `<span class="track-chip-dot" style="--track-color: ${color};"></span>`;
        }).join('');

        legendContainer.innerHTML = `
            <button type="button" class="fretboard-track-colors-btn" id="fretboardTrackColorsBtn" title="Show track colors" aria-label="Show track colors">
                ${dotsHtml}
            </button>
        `;
        legendContainer.querySelector('#fretboardTrackColorsBtn')
            ?.addEventListener('click', () => this.showTrackColorsPopup());
    }

    /**
     * Show a popup listing every visible track with its fretboard color
     */
    showTrackColorsPopup() {
        const existing = document.getElementById('fretboardTrackColorsPopover');
        if (existing) { existing._close?.(); return; }
        const btn = document.getElementById('fretboardTrackColorsBtn');
        if (!btn) return;
        const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

        const pop = document.createElement('div');
        pop.id = 'fretboardTrackColorsPopover';
        pop.className = 'fretboard-track-popover';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Track colors');
        pop.innerHTML = this.visibleTracks.map((t, idx) => {
            const color = TRACK_PALETTE[idx % TRACK_PALETTE.length];
            const name = t.name || `Track ${t.index + 1}`;
            return `
                <div class="fretboard-track-color-row">
                    <span class="track-chip-dot" style="--track-color: ${color};"></span>
                    <span class="fretboard-track-color-name">${esc(name)}</span>
                </div>
            `;
        }).join('');
        document.body.appendChild(pop);

        // Anchor above the button (dock sits at the bottom), clamped to viewport
        const r = btn.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        const left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
        const top = r.top - pr.height - 8 >= 8 ? r.top - pr.height - 8 : r.bottom + 8;
        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;

        const onDocDown = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        function close() {
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey);
            pop.remove();
        }
        pop._close = close;
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey);
    }

    /**
     * Map track index to color palette index
     */
    getTrackColorIndex(trackIndex) {
        const idx = this.visibleTracks.findIndex(t => t.index === trackIndex);
        return idx >= 0 ? (idx % TRACK_PALETTE.length) : 0;
    }

    /**
     * Multi-track active beats handler hooked into api.activeBeatsChanged
     * Composites notes from all currently visible score tracks simultaneously.
     * @param {Array<Object>} activeBeats Array of AlphaTab Beats sounding at this tick
     */
    onActiveBeatsChanged(activeBeats) {
        if (!this.isScoreAvailable || !Array.isArray(activeBeats)) {
            return;
        }

        const prevBeatIds = this.activeBeatIds || new Set();
        const currentBeatIds = new Set();
        const newlyStruckBeatIds = new Set();

        const currentTick = this.currentApi?.tickPosition ?? 0;
        const isJumpOrSeek = this.lastTickPosition !== undefined && this.lastTickPosition !== null && currentTick < this.lastTickPosition;
        this.lastTickPosition = currentTick;

        for (const beat of activeBeats) {
            if (!beat) continue;
            currentBeatIds.add(beat.id);
            if (isJumpOrSeek || !prevBeatIds.has(beat.id) || prevBeatIds.size === 0) {
                newlyStruckBeatIds.add(beat.id);
            }
        }
        this.activeBeatIds = currentBeatIds;

        this.trackNotesMap.clear();

        for (const beat of activeBeats) {
            if (!beat) continue;
            const beatTrack = beat.voice?.bar?.staff?.track;
            if (!beatTrack) continue;

            const isVisible = this.visibleTracks.some(t => t.index === beatTrack.index);
            if (!isVisible) continue;

            const isBeatNewlyStruck = newlyStruckBeatIds.has(beat.id);
            const trackColorIdx = this.getTrackColorIndex(beatTrack.index);
            let trackNotes = this.trackNotesMap.get(beatTrack.index);
            if (!trackNotes) {
                trackNotes = [];
                this.trackNotesMap.set(beatTrack.index, trackNotes);
            }

            if (Array.isArray(beat.notes)) {
                for (const n of beat.notes) {
                    const s = n.string; // AlphaTab: 1 = lowest string, stringCount = highest string
                    const f = n.fret;

                    if (s >= 1 && s <= this.stringCount) {
                        const openMidi = this.tuning[this.stringCount - s] ?? 60;
                        const midiVal = (typeof n.realValue === 'number' && !isNaN(n.realValue))
                            ? n.realValue
                            : (openMidi + f);

                        const isTie = Boolean(n.isTieDestination);
                        trackNotes.push({
                            string: s,
                            fret: f,
                            midiPitch: midiVal,
                            isDead: Boolean(n.isDead),
                            isGhost: Boolean(n.isGhost),
                            isTieDestination: isTie,
                            isPicked: isBeatNewlyStruck && !isTie,
                            trackIndex: beatTrack.index,
                            trackColorIndex: trackColorIdx
                        });
                    }
                }
            }
        }

        // Composite notes across all active visible tracks
        // Groups notes on the exact same string & fret into unison collision entries
        const compositeMap = new Map();
        let fretSum = 0;
        let fretCount = 0;

        for (const [, tNotes] of this.trackNotesMap.entries()) {
            for (const n of tNotes) {
                const key = `${n.string}:${n.fret}`;
                if (!compositeMap.has(key)) {
                    compositeMap.set(key, {
                        string: n.string,
                        fret: n.fret,
                        midiPitch: n.midiPitch,
                        isDead: n.isDead,
                        isGhost: n.isGhost,
                        isTieDestination: n.isTieDestination,
                        isPicked: n.isPicked,
                        trackIndices: [n.trackIndex],
                        trackColorIndices: [n.trackColorIndex]
                    });
                } else {
                    const existing = compositeMap.get(key);
                    if (!existing.trackColorIndices.includes(n.trackColorIndex)) {
                        existing.trackColorIndices.push(n.trackColorIndex);
                        existing.trackIndices.push(n.trackIndex);
                    }
                    if (n.isPicked) {
                        existing.isPicked = true;
                    }
                }

                if (n.fret > 0) {
                    fretSum += n.fret;
                    fretCount++;
                }
            }
        }

        const compositeNotes = Array.from(compositeMap.values());
        this.lastBeatNotes = compositeNotes;

        if (this.isOpen) {
            this.view?.updateActiveNotes(compositeNotes, this.displayMode);

            if (fretCount > 0) {
                this.autoCenterFret(Math.round(fretSum / fretCount));
            }
        }
    }

    /**
     * Show notes at the current cursor position across all visible tracks (still / paused / seeked)
     * @param {Object} primaryBeat
     */
    showBeatsAtCursor(primaryBeat) {
        if (!this.isScoreAvailable || !primaryBeat) {
            return;
        }

        // Explicit cursor placement (seek/pause/click) marks notes as newly struck
        this.activeBeatIds.clear();
        this.lastTickPosition = null;

        const barIndex = primaryBeat.voice?.bar?.index;
        if (barIndex === undefined || barIndex === null) {
            this.onActiveBeatsChanged([primaryBeat]);
            return;
        }

        const targetStart = primaryBeat.playbackStart ?? primaryBeat.start ?? 0;
        const activeBeats = [];

        for (const track of this.visibleTracks) {
            const bar = track.staves?.[0]?.bars?.[barIndex];
            if (!bar) continue;

            let matchedBeat = null;
            for (const v of (bar.voices || [])) {
                for (const b of (v.beats || [])) {
                    const bStart = b.playbackStart ?? b.start ?? 0;
                    const bDuration = b.playbackDuration ?? b.duration ?? 0;
                    if (targetStart >= bStart && (bDuration === 0 || targetStart < bStart + bDuration)) {
                        matchedBeat = b;
                        break;
                    }
                }
                if (matchedBeat) break;
            }

            if (matchedBeat) {
                activeBeats.push(matchedBeat);
            } else if (track.index === primaryBeat.voice?.bar?.staff?.track?.index) {
                activeBeats.push(primaryBeat);
            }
        }

        const beatsToRender = activeBeats.length > 0 ? activeBeats : [primaryBeat];
        this.onActiveBeatsChanged(beatsToRender);
    }

    /**
     * Determine and display notes at the current score cursor / tick position
     */
    refreshCursorNotes() {
        if (!this.isScoreAvailable) return;

        const primaryTrack = this.visibleTracks[0] || this.activeScore?.tracks?.[0];
        if (!primaryTrack) return;

        const currentTick = this.currentApi?.tickPosition ?? 0;
        let targetMasterBar = this.activeScore?.masterBars?.[0];
        if (this.activeScore?.masterBars?.length) {
            for (let i = this.activeScore.masterBars.length - 1; i >= 0; i--) {
                const mb = this.activeScore.masterBars[i];
                if (currentTick >= mb.start) {
                    targetMasterBar = mb;
                    break;
                }
            }
        }

        const barIdx = targetMasterBar?.index ?? 0;
        const bar = primaryTrack.staves?.[0]?.bars?.[barIdx];
        const firstBeat = bar?.voices?.[0]?.beats?.[0];
        if (firstBeat) {
            this.showBeatsAtCursor(firstBeat);
        }
    }

    /**
     * Beat transition handler hooked into api.playedBeatChanged
     * Delegates to onActiveBeatsChanged for multi-track composition.
     * @param {Object} beat AlphaTab Beat
     */
    onBeatChanged(beat) {
        if (!beat) return;
        this.showBeatsAtCursor(beat);
    }

    /**
     * Smoothly auto-scroll neck viewport to center active fret
     * @param {number} fret
     */
    autoCenterFret(fret) {
        const scrollEl = document.getElementById('fretboardNeckScroll');
        if (!scrollEl || scrollEl.scrollWidth <= scrollEl.clientWidth) return;

        const midX = this.view?.fretMidsX[fret];
        if (midX == null) return;

        const ratio = midX / 1150;
        const targetX = (ratio * scrollEl.scrollWidth) - (scrollEl.clientWidth / 2);
        const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
        const safeTargetX = Math.max(0, Math.min(maxScroll, targetX));

        // Skip scrolling if the target fret is already comfortably visible
        const currentScroll = scrollEl.scrollLeft;
        const visibleMinX = (currentScroll / scrollEl.scrollWidth) * 1150;
        const visibleMaxX = ((currentScroll + scrollEl.clientWidth) / scrollEl.scrollWidth) * 1150;
        const padding = (visibleMaxX - visibleMinX) * 0.18;

        if (midX >= (visibleMinX + padding) && midX <= (visibleMaxX - padding)) {
            return;
        }

        // Throttle scrolling to avoid interrupting rapid notes (e.g. 16th notes)
        const now = performance.now();
        if (this._lastScrollTime && (now - this._lastScrollTime < 350)) {
            return;
        }
        this._lastScrollTime = now;

        scrollEl.scrollTo({
            left: safeTargetX,
            behavior: 'smooth'
        });
    }

    /**
     * Clear all note markers
     */
    clearActiveNotes() {
        this.trackNotesMap.clear();
        this.lastBeatNotes = [];
        this.activeBeatIds.clear();
        this.lastTickPosition = null;
        this.view?.clearActiveNotes();
    }

    /**
     * Score closed or detached
     */
    onScoreClosed() {
        this.clearActiveNotes();
        this.visibleTracks = [];
        this.setScoreAvailable(false);
    }

    /**
     * Trigger relayout of score so bars do not sit under the dock
     */
    triggerLayoutRefresh() {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const output = document.getElementById('output');

        if (pageModeRadio?.checked && window.gpState?.canvases?.[0]?.container && output) {
            setTimeout(() => {
                if (window.gpState) {
                    window.gpState.lastLayoutDimensions = null;
                }
                if (typeof window.gpState?.renderGPPage === 'function') {
                    window.gpState.renderGPPage(output, true);
                } else {
                    window.dispatchEvent(new Event('resize'));
                }
            }, 60);
        } else if (output) {
            setTimeout(() => {
                if (typeof window.__majesticUpdateContinuousPlaybackScroll === 'function' && this.currentApi?.tickPosition !== undefined) {
                    window.__majesticUpdateContinuousPlaybackScroll(this.currentApi.tickPosition, true);
                }
            }, 60);
        }
    }

    /**
     * Lightweight Web Audio Plucked String Synthesizer for Interactive Audition
     * @param {number} midiPitch
     */
    playPluckSound(midiPitch) {
        if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return;

        try {
            if (!this.audioCtx) {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                this.audioCtx = new AudioCtxClass();
            }

            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }

            const now = this.audioCtx.currentTime;
            const freq = 440 * Math.pow(2, (midiPitch - 69) / 12);

            const osc = this.audioCtx.createOscillator();
            const filter = this.audioCtx.createBiquadFilter();
            const gain = this.audioCtx.createGain();

            // Pluck waveform blend
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now);

            // Low-pass filter simulating string dampening sweep
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(Math.min(3200, freq * 5), now);
            filter.frequency.exponentialRampToValueAtTime(Math.max(200, freq * 1.2), now + 0.6);

            // Exponential decay envelope
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.linearRampToValueAtTime(0.35, now + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.audioCtx.destination);

            osc.start(now);
            osc.stop(now + 0.9);
        } catch (_) {}
    }
}

export const fretboardController = new FretboardController();

export function initFretboard() {
    fretboardController.init();
}
