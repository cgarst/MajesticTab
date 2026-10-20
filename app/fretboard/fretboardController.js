// fretboardController.js
// Controller coordinating AlphaTab events, multi-track note aggregation, layout, and virtual fretboard rendering
import { FretboardView } from './fretboardView.js';
import { formatTuningFromMidi } from '../utils/tuningUtils.js';

const STORAGE_KEY_OPEN = 'majestictab_fretboard_open';
const STORAGE_KEY_MODE = 'majestictab_fretboard_display_mode';
const STORAGE_KEY_LH = 'majestictab_fretboard_left_handed';
const STORAGE_KEY_FLIP = 'majestictab_fretboard_flip_strings';

const TRACK_PALETTE = ['#10b981', '#ec4899', '#f59e0b', '#06b6d4'];

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

        // Notation options panel switch
        const scoreOptionsSwitch = document.getElementById('scoreOptionsFretboardSwitch');
        scoreOptionsSwitch?.addEventListener('change', (e) => {
            this.toggle(e.target.checked);
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

    syncUIState() {
        const dock = document.getElementById('fretboardDock');
        const topBarToggle = document.getElementById('fretboardToggleBtn');
        const scoreOptionsSwitch = document.getElementById('scoreOptionsFretboardSwitch');

        if (this.isOpen && this.isScoreAvailable) {
            dock?.style.setProperty('display', 'block');
            dock?.classList.remove('is-hidden');
            document.body.classList.add('fretboard-open');
            topBarToggle?.classList.add('active');
            if (scoreOptionsSwitch) scoreOptionsSwitch.checked = true;
        } else {
            dock?.classList.add('is-hidden');
            setTimeout(() => {
                if (!this.isOpen || !this.isScoreAvailable) {
                    dock?.style.setProperty('display', 'none');
                }
            }, 250);
            document.body.classList.remove('fretboard-open');
            topBarToggle?.classList.remove('active');
            if (scoreOptionsSwitch) scoreOptionsSwitch.checked = false;
            this.clearActiveNotes();
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
        const scoreSection = document.getElementById('scoreOptionsFretboardSection');

        if (pill) pill.style.display = this.isScoreAvailable ? '' : 'none';
        if (scoreSection) scoreSection.style.display = this.isScoreAvailable ? '' : 'none';

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
     * Update active instrument tuning, string count, and capo from primary track
     */
    updateNeckInstrument(track) {
        if (!track) return;

        let rawTunings = null;
        for (const staff of (track.staves || [])) {
            if (staff.isPercussion) continue;
            if (staff.stringTuning?.tunings && staff.stringTuning.tunings.length > 0) {
                rawTunings = staff.stringTuning.tunings;
                break;
            }
        }
        if (!rawTunings && Array.isArray(track.tuning) && track.tuning.length > 0) {
            rawTunings = track.tuning;
        }

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
            const formatted = formatTuningFromMidi(this.tuning);
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
            legendContainer.innerHTML = `
                <div class="fretboard-track-badge" id="fretboardTrackBadge" title="${name}">
                    <i class="bi-music-note-beamed text-info"></i>
                    <span class="fretboard-track-name text-truncate" id="fretboardTrackName">${name}</span>
                </div>
            `;
            return;
        }

        // Multiple tracks rendered simultaneously
        const chipsHtml = this.visibleTracks.map((t, idx) => {
            const color = TRACK_PALETTE[idx % TRACK_PALETTE.length];
            const name = t.name || `Track ${t.index + 1}`;
            return `
                <span class="fretboard-track-chip" style="--track-color: ${color};" title="${name}">
                    <span class="track-chip-dot"></span>
                    <span class="track-chip-name">${name}</span>
                </span>
            `;
        }).join('');

        legendContainer.innerHTML = chipsHtml;
    }

    /**
     * Map track index to color palette index
     */
    getTrackColorIndex(trackIndex) {
        const idx = this.visibleTracks.findIndex(t => t.index === trackIndex);
        return idx >= 0 ? (idx % TRACK_PALETTE.length) : 0;
    }

    /**
     * Beat transition handler hooked into api.playedBeatChanged
     * Composites notes from all currently visible score tracks.
     * @param {Object} beat AlphaTab Beat
     */
    onBeatChanged(beat) {
        if (!this.isOpen || !this.isScoreAvailable || !beat) {
            return;
        }

        const beatTrack = beat.voice?.bar?.staff?.track;
        if (!beatTrack) return;

        const isVisible = this.visibleTracks.some(t => t.index === beatTrack.index);
        if (!isVisible) return;

        const trackColorIdx = this.getTrackColorIndex(beatTrack.index);
        const trackNotes = [];

        if (Array.isArray(beat.notes)) {
            for (const n of beat.notes) {
                const s = n.string; // AlphaTab: 1 = lowest string, stringCount = highest string
                const f = n.fret;

                if (s >= 1 && s <= this.stringCount) {
                    const openMidi = this.tuning[this.stringCount - s] ?? 60;
                    const midiVal = (typeof n.realValue === 'number' && !isNaN(n.realValue))
                        ? n.realValue
                        : (openMidi + f);

                    trackNotes.push({
                        string: s,
                        fret: f,
                        midiPitch: midiVal,
                        isDead: Boolean(n.isDead),
                        isGhost: Boolean(n.isGhost),
                        isTieDestination: Boolean(n.isTieDestination),
                        trackIndex: beatTrack.index,
                        trackColorIndex: trackColorIdx
                    });
                }
            }
        }

        this.trackNotesMap.set(beatTrack.index, trackNotes);

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
                        trackIndices: [n.trackIndex],
                        trackColorIndices: [n.trackColorIndex]
                    });
                } else {
                    const existing = compositeMap.get(key);
                    if (!existing.trackColorIndices.includes(n.trackColorIndex)) {
                        existing.trackColorIndices.push(n.trackColorIndex);
                        existing.trackIndices.push(n.trackIndex);
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
        this.view?.updateActiveNotes(compositeNotes, this.displayMode);

        if (fretCount > 0) {
            this.autoCenterFret(Math.round(fretSum / fretCount));
        }
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
        scrollEl.scrollTo({
            left: Math.max(0, targetX),
            behavior: 'smooth'
        });
    }

    /**
     * Clear all note markers
     */
    clearActiveNotes() {
        this.trackNotesMap.clear();
        this.lastBeatNotes = [];
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
                if (typeof window.gpState?.layoutGPPages === 'function') {
                    const pageHeight = output.clientHeight - 20;
                    window.gpState.pages = window.gpState.layoutGPPages(window.gpState.canvases[0].container, pageHeight);
                    if (typeof window.gpState.renderGPPage === 'function') {
                        window.gpState.renderGPPage(output, true);
                    }
                } else {
                    window.dispatchEvent(new Event('resize'));
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
