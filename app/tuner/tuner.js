// tuner.js
// Vanilla JavaScript port of PitchCraft by Niki Indjov (MIT License)
// Integrated into MajesticTab with dynamic track tuning detection from loaded Guitar Pro tabs.

import { formatTuningFromMidi } from '../utils/tuningUtils.js';
import { fretboardController } from '../fretboard/fretboardController.js';
import { updateUrl, clearUrl } from '../utils/urlRouter.js';

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const BASE_INSTRUMENTS = [
    {
        id: "guitar",
        name: "Guitar",
        tuning: ["E2", "A2", "D3", "G3", "B3", "E4"],
        color: "#FF6B35",
        description: "Standard 6-string tuning (E A D G B E)",
        strings: 6,
        type: "guitar"
    },
    {
        id: "bass",
        name: "Bass",
        tuning: ["E1", "A1", "D2", "G2"],
        color: "#7B2FF7",
        description: "Standard 4-string bass tuning (E A D G)",
        strings: 4,
        type: "bass"
    },
    {
        id: "ukulele",
        name: "Ukulele",
        tuning: ["G4", "C4", "E4", "A4"],
        color: "#00C9A7",
        description: "Standard GCEA tuning",
        strings: 4,
        type: "ukulele"
    },
    {
        id: "banjo",
        name: "Banjo",
        tuning: ["G4", "D3", "G3", "B3", "D4"],
        color: "#2D9CDB",
        description: "Open G tuning",
        strings: 5,
        type: "banjo"
    },
    {
        id: "mandolin",
        name: "Mandolin",
        tuning: ["G3", "D4", "A4", "E5"],
        color: "#F2C94C",
        description: "Standard G D A E tuning",
        strings: 4,
        type: "mandolin"
    },
    {
        id: "violin",
        name: "Violin",
        tuning: ["G3", "D4", "A4", "E5"],
        color: "#C4375B",
        description: "Standard G D A E tuning",
        strings: 4,
        type: "violin"
    },
    {
        id: "viola",
        name: "Viola",
        tuning: ["C3", "G3", "D4", "A4"],
        color: "#9B51E0",
        description: "Standard C G D A tuning",
        strings: 4,
        type: "viola"
    },
    {
        id: "cello",
        name: "Cello",
        tuning: ["C2", "G2", "D3", "A3"],
        color: "#E8871E",
        description: "Standard C G D A tuning",
        strings: 4,
        type: "cello"
    },
    {
        id: "chromatic",
        name: "Chromatic",
        tuning: [],
        color: "#56CCF2",
        description: "All pitches & octaves, any instrument",
        strings: 0,
        type: "chromatic"
    }
];

// SVG Instrument Icons
function getInstrumentSvg(type, color = "currentColor", size = 48) {
    switch (type) {
        case "guitar":
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-guit-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="${color}" stop-opacity="0.5" />
                </linearGradient>
              </defs>
              <rect x="54" y="5" width="12" height="55" rx="3" fill="${color}" opacity="0.7" />
              <line x1="57" y1="5" x2="57" y2="60" stroke="#fff" stroke-width="0.5" opacity="0.3" />
              <line x1="60" y1="5" x2="60" y2="60" stroke="#fff" stroke-width="0.5" opacity="0.3" />
              <line x1="63" y1="5" x2="63" y2="60" stroke="#fff" stroke-width="0.5" opacity="0.3" />
              <line x1="54" y1="18" x2="66" y2="18" stroke="#fff" stroke-width="1" opacity="0.4" />
              <line x1="54" y1="30" x2="66" y2="30" stroke="#fff" stroke-width="1" opacity="0.4" />
              <line x1="54" y1="42" x2="66" y2="42" stroke="#fff" stroke-width="1" opacity="0.4" />
              <rect x="50" y="2" width="20" height="8" rx="3" fill="${color}" opacity="0.8" />
              <circle cx="53" cy="5" r="1.5" fill="#fff" opacity="0.6" />
              <circle cx="67" cy="5" r="1.5" fill="#fff" opacity="0.6" />
              <ellipse cx="60" cy="78" rx="28" ry="22" fill="url(#pt-guit-grad)" />
              <ellipse cx="60" cy="98" rx="32" ry="20" fill="url(#pt-guit-grad)" />
              <circle cx="60" cy="82" r="10" fill="rgba(0,0,0,0.4)" />
              <circle cx="60" cy="82" r="11" stroke="${color}" stroke-width="1.5" fill="none" opacity="0.6" />
              <rect x="52" y="100" width="16" height="3" rx="1" fill="${color}" opacity="0.8" />
            </svg>`;
        case "bass":
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-bass-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="${color}" stop-opacity="0.5" />
                </linearGradient>
              </defs>
              <rect x="55" y="3" width="10" height="60" rx="2" fill="${color}" opacity="0.7" />
              <rect x="51" y="0" width="18" height="8" rx="3" fill="${color}" opacity="0.8" />
              <circle cx="54" cy="4" r="2" fill="#fff" opacity="0.5" />
              <circle cx="66" cy="4" r="2" fill="#fff" opacity="0.5" />
              <line x1="55" y1="20" x2="65" y2="20" stroke="#fff" stroke-width="1" opacity="0.4" />
              <line x1="55" y1="36" x2="65" y2="36" stroke="#fff" stroke-width="1" opacity="0.4" />
              <path d="M35 70 Q30 85 38 100 Q48 115 60 115 Q72 115 82 100 Q90 85 85 70 Q82 62 60 62 Q38 62 35 70Z" fill="url(#pt-bass-grad)" />
              <ellipse cx="50" cy="82" rx="6" ry="8" fill="rgba(0,0,0,0.3)" />
              <ellipse cx="70" cy="82" rx="6" ry="8" fill="rgba(0,0,0,0.3)" />
              <rect x="54" y="98" width="12" height="3" rx="1" fill="${color}" opacity="0.8" />
            </svg>`;
        case "ukulele":
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-uke-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="${color}" stop-opacity="0.5" />
                </linearGradient>
              </defs>
              <rect x="55" y="8" width="10" height="42" rx="3" fill="${color}" opacity="0.7" />
              <rect x="52" y="4" width="16" height="9" rx="4" fill="${color}" opacity="0.8" />
              <ellipse cx="60" cy="72" rx="30" ry="28" fill="url(#pt-uke-grad)" />
              <circle cx="60" cy="72" r="12" fill="rgba(0,0,0,0.35)" />
              <rect x="54" y="94" width="12" height="2.5" rx="1" fill="${color}" opacity="0.8" />
            </svg>`;
        case "banjo":
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-banjo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="${color}" stop-opacity="0.5" />
                </linearGradient>
              </defs>
              <rect x="55" y="5" width="10" height="50" rx="2" fill="${color}" opacity="0.7" />
              <circle cx="60" cy="82" r="30" fill="url(#pt-banjo-grad)" />
              <circle cx="60" cy="82" r="26" stroke="${color}" stroke-width="1" fill="none" opacity="0.4" />
              <rect x="54" y="82" width="12" height="3" rx="1" fill="${color}" opacity="0.9" />
            </svg>`;
        case "mandolin":
        case "violin":
        case "viola":
        case "cello":
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-orch-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="${color}" stop-opacity="0.5" />
                </linearGradient>
              </defs>
              <rect x="57" y="3" width="6" height="38" rx="2" fill="${color}" opacity="0.7" />
              <ellipse cx="60" cy="52" rx="22" ry="16" fill="url(#pt-orch-grad)" />
              <ellipse cx="60" cy="68" rx="16" ry="9" fill="url(#pt-orch-grad)" />
              <ellipse cx="60" cy="85" rx="26" ry="20" fill="url(#pt-orch-grad)" />
              <rect x="56" y="96" width="8" height="10" rx="2" fill="${color}" opacity="0.8" />
            </svg>`;
        case "chromatic":
        default:
            return `
            <svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="pt-chrom-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${color}" stop-opacity="0.85" />
                  <stop offset="100%" stop-color="#a855f7" stop-opacity="0.6" />
                </linearGradient>
              </defs>
              <rect x="58" y="55" width="4" height="45" rx="2" fill="${color}" opacity="0.7" />
              <path d="M50 15 Q50 55 58 55" stroke="${color}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.85" />
              <path d="M70 15 Q70 55 62 55" stroke="${color}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.85" />
              <path d="M38 25 Q32 35 38 45" stroke="${color}" stroke-width="1.5" fill="none" opacity="0.4" />
              <path d="M82 25 Q88 35 82 45" stroke="${color}" stroke-width="1.5" fill="none" opacity="0.4" />
              <circle cx="60" cy="105" r="6" fill="url(#pt-chrom-grad)" />
            </svg>`;
    }
}

class PitchCraftTunerController {
    constructor() {
        this.referenceA = 440;
        this.instruments = [...BASE_INSTRUMENTS];
        this.selectedInstrument = BASE_INSTRUMENTS[0];
        this.selectedStringIndex = null;

        this.isListening = false;
        this.audioContext = null;
        this.analyser = null;
        this.mediaStream = null;
        this.animFrameId = null;
        this.detectedNote = null;
        this.volume = 0;

        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        this.initialized = true;

        this.bindGlobalEvents();
    }

    bindGlobalEvents() {
        // Tuner button in top bar
        document.getElementById('tunerToggleBtn')?.addEventListener('click', () => {
            this.open();
        });

        // Close button inside modal
        document.getElementById('tunerModalCloseBtn')?.addEventListener('click', () => {
            this.close();
        });

        // Close on backdrop click
        const backdrop = document.getElementById('tunerModal');
        backdrop?.addEventListener('click', (e) => {
            if (e.target === backdrop) {
                this.close();
            }
        });

        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const modal = document.getElementById('tunerModal');
                if (modal && modal.style.display !== 'none') {
                    this.close();
                }
            }
        });
    }

    /**
     * Inspect active score & fretboard controller to build dynamic Track Tuning instruments
     * for ALL non-percussion tracks in the opened score.
     */
    buildTrackInstruments() {
        const score = fretboardController?.activeScore || window.gpState?.api?.score;
        const visibleTracks = fretboardController?.visibleTracks || [];
        const allTracks = score?.tracks || window.gpState?.api?.tracks || visibleTracks;

        if (!allTracks || allTracks.length === 0 || !fretboardController?.isScoreAvailable) {
            return [];
        }

        const instruments = [];
        const seenTunings = new Set();

        const processTrack = (track, trackIdx) => {
            if (!track || track.isPercussion) return;

            let rawTuningsList = [];
            for (const staff of (track.staves || [])) {
                if (staff.isPercussion) continue;
                if (staff.stringTuning?.tunings && staff.stringTuning.tunings.length > 0) {
                    rawTuningsList.push(staff.stringTuning.tunings);
                } else if (Array.isArray(staff.tuning) && staff.tuning.length > 0) {
                    rawTuningsList.push(staff.tuning);
                }
            }

            if (rawTuningsList.length === 0 && Array.isArray(track.tuning) && track.tuning.length > 0) {
                rawTuningsList.push(track.tuning);
            }

            // Fallback to fretboardController.tuning if this is the primary visible track and no staff tuning found
            if (rawTuningsList.length === 0 && track === visibleTracks[0] && Array.isArray(fretboardController?.tuning)) {
                rawTuningsList.push(fretboardController.tuning);
            }

            for (let sIdx = 0; sIdx < rawTuningsList.length; sIdx++) {
                const rawTunings = rawTuningsList[sIdx];
                if (!Array.isArray(rawTunings) || rawTunings.length === 0) continue;

                // Normalize order from lowest string to highest string for tuner string layout
                let midiOrder = [...rawTunings];
                if (midiOrder[0] > midiOrder[midiOrder.length - 1]) {
                    midiOrder.reverse();
                }

                const tuningKey = midiOrder.join(',');
                const trackName = (track.name || `Track ${trackIdx + 1}`).trim();
                const dedupKey = `${trackName}:${tuningKey}`;
                if (seenTunings.has(dedupKey)) continue;
                seenTunings.add(dedupKey);

                // Convert MIDI pitches to note names e.g. E2, A2, D3, etc.
                const stringNotes = midiOrder.map(m => {
                    const noteName = NOTES[((m % 12) + 12) % 12];
                    const octave = Math.floor(m / 12) - 1;
                    return `${noteName}${octave}`;
                });

                const formattedTuningName = formatTuningFromMidi(rawTunings) || 'Custom';
                const isBass = midiOrder.length <= 5 && (midiOrder[0] < 36 || trackName.toLowerCase().includes('bass'));

                instruments.push({
                    id: `track-tuning-${track.index ?? trackIdx}-${sIdx}`,
                    name: allTracks.length > 1 ? `${trackName}: ${formattedTuningName}` : `Track: ${formattedTuningName}`,
                    tuning: stringNotes,
                    color: isBass ? '#7B2FF7' : '#10b981',
                    description: `${trackName} tuning (${stringNotes.join(' ')})`,
                    strings: stringNotes.length,
                    type: isBass ? 'bass' : 'guitar',
                    isTrackTuning: true,
                    trackName,
                    trackIndex: track.index ?? trackIdx
                });
            }
        };

        // First process visible tracks (so primary visible track appears first)
        visibleTracks.forEach((t, i) => processTrack(t, t.index ?? i));

        // Then process any other tracks in the score
        allTracks.forEach((t, i) => processTrack(t, t.index ?? i));

        return instruments;
    }

    /**
     * Open Tuner Modal and refresh instrument list
     */
    open() {
        const modal = document.getElementById('tunerModal');
        if (!modal) return;

        // Build track instruments for all tracks in opened score
        const trackInstruments = this.buildTrackInstruments();
        if (trackInstruments.length > 0) {
            this.instruments = [...trackInstruments, ...BASE_INSTRUMENTS];
            this.selectedInstrument = trackInstruments[0];
        } else {
            this.instruments = [...BASE_INSTRUMENTS];
            if (this.selectedInstrument?.isTrackTuning) {
                this.selectedInstrument = BASE_INSTRUMENTS[0];
            }
        }

        this.selectedStringIndex = null;
        this.renderModalContent();

        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
        document.getElementById('tunerToggleBtn')?.classList.add('active');
        updateUrl('tuner');

        // Accessibility focus
        const firstBtn = modal.querySelector('.tuner-mic-btn');
        firstBtn?.focus();
    }

    /**
     * Close Tuner Modal and terminate microphone
     */
    close() {
        this.stopListening();

        const modal = document.getElementById('tunerModal');
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
        document.getElementById('tunerToggleBtn')?.classList.remove('active');

        const libPage = document.getElementById('libraryPage');
        if (libPage && libPage.style.display !== 'none') {
            import('../libraryModal.js').then(m => {
                updateUrl(m.getActiveLibraryView?.() || 'library');
            });
        } else {
            clearUrl();
        }
    }

    selectInstrument(inst) {
        this.selectedInstrument = inst;
        this.selectedStringIndex = null;
        this.renderModalContent();
    }

    /**
     * Calculate target frequency for a scientific pitch string e.g. "E2"
     */
    getNoteFrequency(noteStr) {
        const match = noteStr.match(/^([A-G]#?)([0-9])$/);
        if (!match) return 440;
        const note = match[1];
        const octave = parseInt(match[2], 10);
        const noteIndex = NOTES.indexOf(note);
        if (noteIndex === -1) return 440;
        const semitonesFromA4 = (octave - 4) * 12 + (noteIndex - 9);
        return this.referenceA * Math.pow(2, semitonesFromA4 / 12);
    }

    /**
     * Identify closest musical pitch from detected frequency
     */
    getClosestNote(freq) {
        if (!freq || freq < 20 || freq > 5000) return null;
        const noteNum = 12 * Math.log2(freq / this.referenceA) + 49;
        const rounded = Math.round(noteNum);
        const cents = Math.round((noteNum - rounded) * 100);
        const octave = Math.floor((rounded + 8) / 12);
        const noteIndex = ((rounded + 8) % 12 + 12) % 12;
        return {
            note: NOTES[noteIndex],
            octave,
            cents,
            frequency: freq,
            fullNote: `${NOTES[noteIndex]}${octave}`
        };
    }

    /**
     * Play synthetic reference tone for selected string
     */
    playTone(freq) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(0.25, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.25);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 1.25);

            setTimeout(() => {
                try { ctx.close(); } catch (_) {}
            }, 1350);
        } catch (err) {
            console.warn('Tone playback failed:', err);
        }
    }

    /**
     * PitchCraft Autocorrelation Pitch Detection Algorithm
     */
    autoCorrelate(buf, sampleRate) {
        let size = buf.length;
        let rms = 0;
        for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / size);
        if (rms < 0.01) return { freq: -1, rms };

        let r1 = 0, r2 = size - 1;
        const thresh = 0.2;
        for (let i = 0; i < size / 2; i++) {
            if (Math.abs(buf[i]) < thresh) { r1 = i; break; }
        }
        for (let i = 1; i < size / 2; i++) {
            if (Math.abs(buf[size - i]) < thresh) { r2 = size - i; break; }
        }

        buf = buf.slice(r1, r2);
        size = buf.length;
        if (size <= 0) return { freq: -1, rms };

        const c = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size - i; j++) {
                c[i] += buf[j] * buf[j + i];
            }
        }

        let d = 0;
        while (d < size - 1 && c[d] > c[d + 1]) d++;

        let maxVal = -1, maxPos = -1;
        for (let i = d; i < size; i++) {
            if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
        }

        let t0 = maxPos;
        if (t0 > 0 && t0 < size - 1) {
            const x1 = c[t0 - 1], x2 = c[t0], x3 = c[t0 + 1];
            const a = (x1 + x3 - 2 * x2) / 2;
            const b = (x3 - x1) / 2;
            if (a !== 0) t0 = t0 - b / (2 * a);
        }

        return { freq: sampleRate / t0, rms };
    }

    /**
     * Start microphone pitch detection
     */
    async startListening() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaStream = stream;

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext = audioContext;

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 4096;
            this.analyser = analyser;

            const source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser);

            this.isListening = true;
            this.updateListeningUI(true);

            const buf = new Float32Array(analyser.fftSize);

            const detect = () => {
                if (!this.isListening) return;

                analyser.getFloatTimeDomainData(buf);
                const { freq, rms } = this.autoCorrelate(buf, audioContext.sampleRate);

                this.volume = Math.min(rms * 5, 1);
                this.updateVolumeUI(this.volume);

                if (freq > 0) {
                    const noteInfo = this.getClosestNote(freq);
                    if (noteInfo) {
                        this.detectedNote = noteInfo;
                        this.updatePitchUI(noteInfo);
                    }
                }

                this.animFrameId = requestAnimationFrame(detect);
            };

            detect();
        } catch (err) {
            console.error("Microphone access failed:", err);
            alert("Microphone access is required for real-time instrument tuning.");
            this.stopListening();
        }
    }

    /**
     * Stop microphone listening
     */
    stopListening() {
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (_) {}
            this.audioContext = null;
        }

        this.isListening = false;
        this.detectedNote = null;
        this.volume = 0;

        this.updateListeningUI(false);
        this.resetPitchUI();
        this.updateVolumeUI(0);
    }

    updateListeningUI(isListening) {
        const btn = document.getElementById('tunerMicBtn');
        if (!btn) return;

        if (isListening) {
            btn.classList.add('is-listening');
            btn.innerHTML = `
                <i class="bi-stop-fill"></i>
                <span>Stop Tuner</span>
            `;
        } else {
            btn.classList.remove('is-listening');
            btn.innerHTML = `
                <i class="bi-mic-fill"></i>
                <span>Start Tuner</span>
            `;
        }
    }

    updateVolumeUI(volume) {
        const bars = document.querySelectorAll('.tuner-vol-bar');
        const activeCount = Math.round(volume * bars.length);
        bars.forEach((bar, idx) => {
            const isActive = idx < activeCount;
            bar.classList.toggle('is-active', isActive);
            const height = Math.max(4, (isActive ? (idx + 1) / bars.length : 0.15) * 20);
            bar.style.height = `${height}px`;
        });
    }

    updatePitchUI(noteInfo) {
        const needle = document.getElementById('tunerNeedle');
        const noteEl = document.getElementById('tunerBigNote');
        const octaveEl = document.getElementById('tunerBigOctave');
        const freqEl = document.getElementById('tunerFreqReadout');
        const statusEl = document.getElementById('tunerStatusReadout');
        const centsEl = document.getElementById('tunerCentsReadout');

        if (!needle || !noteEl) return;

        // Needle position (-50 to +50 cents mapped to 0% to 100%)
        const clampedCents = Math.max(-50, Math.min(50, noteInfo.cents));
        needle.style.left = `${50 + clampedCents}%`;

        // Note and Octave
        noteEl.textContent = noteInfo.note;
        if (octaveEl) octaveEl.textContent = noteInfo.octave;
        if (freqEl) freqEl.textContent = `${noteInfo.frequency.toFixed(1)} Hz`;

        const absCents = Math.abs(noteInfo.cents);
        let statusText = '';
        let statusClass = '';
        let needleColor = '';

        if (absCents <= 5) {
            statusText = 'In Tune!';
            statusClass = 'tuner-status-in-tune';
            needleColor = '#22c55e';
        } else if (absCents <= 15) {
            statusText = noteInfo.cents > 0 ? 'Slightly Sharp' : 'Slightly Flat';
            statusClass = 'tuner-status-almost';
            needleColor = '#eab308';
        } else {
            statusText = noteInfo.cents > 0 ? 'Too Sharp' : 'Too Flat';
            statusClass = 'tuner-status-off';
            needleColor = '#ef4444';
        }

        needle.style.background = needleColor;
        needle.style.boxShadow = `0 0 10px ${needleColor}`;

        if (statusEl) {
            statusEl.textContent = statusText;
            statusEl.className = `tuner-status-readout ${statusClass}`;
        }

        if (centsEl) {
            centsEl.textContent = `${noteInfo.cents > 0 ? '+' : ''}${noteInfo.cents} cents`;
        }
    }

    resetPitchUI() {
        const needle = document.getElementById('tunerNeedle');
        const noteEl = document.getElementById('tunerBigNote');
        const octaveEl = document.getElementById('tunerBigOctave');
        const freqEl = document.getElementById('tunerFreqReadout');
        const statusEl = document.getElementById('tunerStatusReadout');
        const centsEl = document.getElementById('tunerCentsReadout');

        if (needle) {
            needle.style.left = '50%';
            needle.style.background = 'var(--accent-primary, #6366f1)';
            needle.style.boxShadow = '0 0 10px var(--accent-primary, #6366f1)';
        }
        if (noteEl) noteEl.textContent = '—';
        if (octaveEl) octaveEl.textContent = '';
        if (freqEl) freqEl.textContent = 'Play a note...';
        if (statusEl) {
            statusEl.textContent = 'Waiting for audio...';
            statusEl.className = 'tuner-status-readout';
        }
        if (centsEl) centsEl.textContent = '';
    }

    renderModalContent() {
        const container = document.getElementById('tunerModalBody');
        if (!container) return;

        const inst = this.selectedInstrument;
        const instColor = inst.color || '#6366f1';

        // 1. Instrument chips row
        const chipsHtml = this.instruments.map(item => {
            const isActive = item.id === inst.id;
            const isTrack = Boolean(item.isTrackTuning);
            return `
            <button type="button" class="tuner-inst-chip ${isActive ? 'active' : ''} ${isTrack ? 'is-track-chip' : ''}" data-tuner-inst="${item.id}" title="${item.description}">
              <span class="tuner-inst-icon-wrap">${getInstrumentSvg(item.type, isActive ? '#fff' : item.color, 18)}</span>
              <span>${item.name}</span>
            </button>
            `;
        }).join('');

        // 2. String buttons for reference tone playback
        const stringsHtml = (inst.tuning && inst.tuning.length > 0)
            ? inst.tuning.map((noteStr, idx) => {
                const isSelected = this.selectedStringIndex === idx;
                const freq = this.getNoteFrequency(noteStr);
                return `
                <button type="button" class="tuner-string-btn ${isSelected ? 'active' : ''}" data-tuner-string="${idx}" title="Play ${noteStr} reference tone (${Math.round(freq)} Hz)">
                  <span class="tuner-string-note">${noteStr}</span>
                  <span class="tuner-string-hz">${Math.round(freq)} Hz</span>
                </button>
                `;
            }).join('')
            : '<span class="small text-muted">Chromatic mode detects all notes across any pitch range.</span>';

        container.innerHTML = `
          <!-- Instrument Carousel / Grid -->
          <div class="tuner-instrument-grid" role="tablist" aria-label="Tuning Instruments">
            ${chipsHtml}
          </div>

          <!-- Active Instrument Details & String Reference Row -->
          <div class="tuner-instrument-banner">
            <div class="tuner-banner-svg">
              ${getInstrumentSvg(inst.type, instColor, 52)}
            </div>
            <div class="tuner-banner-meta">
              <div class="tuner-banner-title">
                ${inst.name}
                ${inst.isTrackTuning ? '<span class="badge bg-success-subtle text-success border border-success-subtle small ms-1" style="font-size: 0.65rem;">Active Track</span>' : ''}
              </div>
              <div class="tuner-banner-subtitle">${inst.description}</div>
              <div class="tuner-strings-row">
                ${stringsHtml}
              </div>
            </div>
          </div>

          <!-- Real-Time Chromatic Pitch & Cents Display -->
          <div class="tuner-display-card">
            <!-- Cents Meter Bar -->
            <div class="tuner-cents-meter" id="tunerCentsMeter" role="meter" aria-label="Tuning Cents Meter">
              <div class="tuner-center-target"></div>
              <div class="tuner-green-zone"></div>
              <div class="tuner-needle" id="tunerNeedle"></div>
              <div class="tuner-tick-marks">
                ${[-40, -30, -20, -10, 0, 10, 20, 30, 40].map(tick => `
                  <div class="tuner-tick ${tick === 0 ? 'is-major' : ''}" style="left: ${50 + tick}%;"></div>
                `).join('')}
              </div>
            </div>

            <!-- Pitch Readout -->
            <div class="tuner-pitch-display">
              <span class="tuner-big-note" id="tunerBigNote">—</span>
              <span class="tuner-big-octave" id="tunerBigOctave"></span>
            </div>

            <div class="tuner-freq-readout" id="tunerFreqReadout">Play a note...</div>
            <div class="tuner-status-readout" id="tunerStatusReadout">Ready</div>
            <div class="tuner-cents-readout" id="tunerCentsReadout"></div>

            <!-- Volume Audio Input Meter -->
            <div class="tuner-volume-meter" aria-hidden="true">
              ${Array.from({ length: 14 }).map(() => '<div class="tuner-vol-bar"></div>').join('')}
            </div>

            <!-- Start / Stop Listening Button -->
            <div class="tuner-action-row">
              <button type="button" class="btn btn-theme-primary tuner-mic-btn" id="tunerMicBtn">
                <i class="bi-mic-fill"></i>
                <span>Start Tuner</span>
              </button>
            </div>
          </div>
        `;

        // Bind interactive events within freshly rendered body
        container.querySelectorAll('[data-tuner-inst]').forEach(btn => {
            btn.addEventListener('click', () => {
                const instId = btn.dataset.tunerInst;
                const found = this.instruments.find(i => i.id === instId);
                if (found) this.selectInstrument(found);
            });
        });

        container.querySelectorAll('[data-tuner-string]').forEach(btn => {
            btn.addEventListener('click', () => {
                const strIdx = parseInt(btn.dataset.tunerString, 10);
                this.selectedStringIndex = strIdx;
                container.querySelectorAll('.tuner-string-btn').forEach((b, i) => {
                    b.classList.toggle('active', i === strIdx);
                });
                const noteStr = inst.tuning[strIdx];
                if (noteStr) {
                    const freq = this.getNoteFrequency(noteStr);
                    this.playTone(freq);
                }
            });
        });

        const micBtn = container.querySelector('#tunerMicBtn');
        micBtn?.addEventListener('click', () => {
            if (this.isListening) {
                this.stopListening();
            } else {
                this.startListening();
            }
        });

        // Calibration selector in header
        const calibSelect = document.getElementById('tunerCalibSelect');
        if (calibSelect) {
            calibSelect.value = String(this.referenceA);
            calibSelect.onchange = (e) => {
                this.referenceA = Number(e.target.value) || 440;
                this.renderModalContent();
            };
        }
    }
}

export const pitchCraftTuner = new PitchCraftTunerController();

export function initTuner() {
    pitchCraftTuner.init();
}

export function openTunerModal() {
    pitchCraftTuner.open();
}

export function closeTunerModal() {
    pitchCraftTuner.close();
}
