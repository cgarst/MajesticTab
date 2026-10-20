// fretboardController.js
// Controller coordinating AlphaTab events, user interaction, layout, and virtual fretboard rendering
import { FretboardView } from './fretboardView.js';
import { formatTuningFromMidi, getActiveInstrumentTracks } from '../utils/tuningUtils.js';

const STORAGE_KEY_OPEN = 'majestictab_fretboard_open';
const STORAGE_KEY_MODE = 'majestictab_fretboard_display_mode';
const STORAGE_KEY_LH = 'majestictab_fretboard_left_handed';
const STORAGE_KEY_FLIP = 'majestictab_fretboard_flip_strings';

class FretboardController {
    constructor() {
        this.view = null;
        this.isOpen = false;
        this.isScoreAvailable = false;
        this.displayMode = 'notes';
        this.isLeftHanded = false;
        this.isFlipped = false; // false = Tab View (high on top), true = Player View (low on top)

        this.currentApi = null;
        this.activeTrack = null;
        this.activeScore = null;
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
            this.displayMode = localStorage.getItem(STORAGE_KEY_MODE) || 'notes';
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

        // Display mode pill buttons
        const modeButtons = document.querySelectorAll('[data-fretboard-mode]');
        modeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.fretboardMode;
                if (mode) this.setDisplayMode(mode);
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
     * Update display mode (notes, frets, fingers, dots)
     * @param {string} mode
     */
    setDisplayMode(mode) {
        if (!['notes', 'frets', 'fingers', 'dots'].includes(mode)) return;
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
            this.onScoreLoaded(api);
        }
    }

    /**
     * Called when a score is loaded into AlphaTab
     * @param {Object} api
     */
    onScoreLoaded(api) {
        this.currentApi = api;
        this.activeScore = api.score;
        this.setScoreAvailable(true);

        const renderedTracks = api.tracks || [];
        const primaryTrack = renderedTracks[0] || api.score?.tracks?.[0] || null;

        this.updateTrack(primaryTrack, api.score);
    }

    /**
     * Called when visible tracks selection changes in gpHandler
     * @param {Object} activeTrack
     */
    onTrackSelectionChanged(activeTrack) {
        this.updateTrack(activeTrack, this.activeScore);
    }

    /**
     * Update active instrument track, tuning, string count, and capo
     */
    updateTrack(track, score = this.activeScore) {
        this.activeTrack = track || null;
        this.activeScore = score || null;

        if (!track) return;

        // Parse open string tunings
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
            // Tuning array from AlphaTab: index 0 is high string, index N-1 is low string
            this.tuning = [...rawTunings];
        } else {
            this.stringCount = 6;
            this.tuning = [64, 59, 55, 50, 45, 40];
        }

        // Capo
        this.capo = track.capo || track.staves?.[0]?.capo || 0;

        // Update Header Badges
        const trackNameEl = document.getElementById('fretboardTrackName');
        const tuningBadgeEl = document.getElementById('fretboardTuningBadge');
        const capoBadgeEl = document.getElementById('fretboardCapoBadge');

        if (trackNameEl) {
            trackNameEl.textContent = track.name || `Track ${track.index + 1}`;
            trackNameEl.parentElement?.setAttribute('title', `${track.name || 'Instrument'} (${this.stringCount}-String)`);
        }

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
     * Beat transition handler hooked into api.playedBeatChanged
     * @param {Object} beat AlphaTab Beat
     */
    onBeatChanged(beat) {
        if (!this.isOpen || !this.isScoreAvailable || !beat) {
            return;
        }

        // Filter by active instrument track
        const beatTrack = beat.voice?.bar?.staff?.track;
        if (beatTrack && this.activeTrack && beatTrack.index !== this.activeTrack.index) {
            return;
        }

        const notes = [];
        let fretSum = 0;
        let fretCount = 0;

        if (Array.isArray(beat.notes)) {
            for (const n of beat.notes) {
                const s = n.string; // AlphaTab: 1 = lowest string, stringCount = highest string
                const f = n.fret;

                if (s >= 1 && s <= this.stringCount) {
                    // In tuning array: index 0 is high string, index stringCount - 1 is low string
                    const openMidi = this.tuning[this.stringCount - s] ?? 60;
                    const midiVal = (typeof n.realValue === 'number' && !isNaN(n.realValue))
                        ? n.realValue
                        : (openMidi + f);

                    notes.push({
                        string: s,
                        fret: f,
                        midiPitch: midiVal,
                        isDead: Boolean(n.isDead),
                        isGhost: Boolean(n.isGhost),
                        isTieDestination: Boolean(n.isTieDestination),
                        finger: n.leftHandFinger
                    });

                    if (f > 0) {
                        fretSum += f;
                        fretCount++;
                    }
                }
            }
        }

        this.lastBeatNotes = notes;
        this.view?.updateActiveNotes(notes, this.displayMode);

        // Auto-center scroll container on active frets if scrollable
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
        this.lastBeatNotes = [];
        this.view?.clearActiveNotes();
    }

    /**
     * Score closed or detached
     */
    onScoreClosed() {
        this.clearActiveNotes();
        this.setScoreAvailable(false);
    }

    /**
     * Trigger relayout of score so bars do not sit under the dock
     */
    triggerLayoutRefresh() {
        const pageModeRadio = document.getElementById('pageModeRadio');
        const output = document.getElementById('output');

        if (pageModeRadio?.checked && window.gpState?.canvases?.[0]?.container && output) {
            // Give CSS padding transition 50ms to register clientHeight
            setTimeout(() => {
                if (typeof window.gpState?.layoutGPPages === 'function') {
                    const pageHeight = output.clientHeight - 20;
                    window.gpState.pages = window.gpState.layoutGPPages(window.gpState.canvases[0].container, pageHeight);
                    if (typeof window.gpState.renderGPPage === 'function') {
                        window.gpState.renderGPPage(output, true);
                    }
                } else {
                    // Trigger window resize event to let layout listeners adjust
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
