// fretboardView.js
// High-DPI Responsive SVG Neck & Fretboard Visualizer for MajesticTab
import { NOTE_NAMES, midiToNoteName } from '../utils/tuningUtils.js';
import { TRACK_PALETTE } from './fretboardController.js';

const TOTAL_FRETS = 24;
const SVG_WIDTH = 1150;
const SINGLE_INLAY_FRETS = [3, 5, 7, 9, 15, 17, 19, 21];
const DOUBLE_INLAY_FRETS = [12, 24];
const FRET_NUMBERS = [1, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24];

export class FretboardView {
    /**
     * @param {HTMLElement} container
     * @param {Object} options
     * @param {Function} [options.onFretClick] (stringIndex, fret, midiPitch) => void
     */
    constructor(container, options = {}) {
        this.container = container;
        this.onFretClick = options.onFretClick || null;

        this.stringCount = 6;
        this.tuning = [64, 59, 55, 50, 45, 40]; // Standard guitar high to low
        this.capo = 0;
        this.isLeftHanded = false;
        this.isFlipped = false; // false = Tab View (high on top), true = Player View (low on top)
        this.displayMode = 'notes'; // 'notes' | 'frets'

        // Precalculated geometry cache
        this.fretWiresX = [];
        this.fretMidsX = [];
        this.stringYs = [];
        this.openBadgeX = 36;
        this.nutX = 72;
        this.bridgeX = 1128;
        this.pickX = 1088;
        this.neckHeight = 90;
        this.totalHeight = 140;

        // Pooled note marker SVG nodes (expanded to 48 for dense multi-track passages)
        this.poolSize = 48;
        this.markerPool = [];
        this.stringLabels = {};
        this.pickIndicators = {};

        this.initDOM();
    }

    initDOM() {
        this.container.innerHTML = '';
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('class', 'fretboard-svg');
        this.svg.setAttribute('viewBox', `0 0 ${SVG_WIDTH} 140`);
        this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        this.container.appendChild(this.svg);

        // Click handler for audition
        this.svg.addEventListener('click', (e) => this.handleSvgClick(e));
    }

    /**
     * Map AlphaTab string index (1 = lowest string, N = highest string)
     * to visual string line index (1 = top line, N = bottom line)
     */
    getVisualString(atString) {
        if (!this.isFlipped) {
            // Standard Tab View: top line is high string, bottom line is low string
            return this.stringCount - atString + 1;
        } else {
            // Inverted Player View: top line is low string, bottom line is high string
            return atString;
        }
    }

    /**
     * Map visual line index (1 = top, N = bottom)
     * to AlphaTab string index (1 = lowest, N = highest)
     */
    getAtString(visualString) {
        if (!this.isFlipped) {
            return this.stringCount - visualString + 1;
        } else {
            return visualString;
        }
    }

    /**
     * Get open MIDI pitch for visual line index (1 to N)
     */
    getVisualLinePitch(visualString) {
        if (!this.isFlipped) {
            // Visual line 1 (top) is highest string -> tuning[0]
            // Visual line N (bottom) is lowest string -> tuning[N - 1]
            return this.tuning[visualString - 1] ?? 60;
        } else {
            // Visual line 1 (top) is lowest string -> tuning[N - 1]
            // Visual line N (bottom) is highest string -> tuning[0]
            return this.tuning[this.stringCount - visualString] ?? 60;
        }
    }

    /**
     * Get stroke width gauge for visual line index (1 to N)
     */
    getVisualLineGauge(visualString) {
        if (!this.isFlipped) {
            // Visual line 1 is thin (1.0px), visual line N is thick (2.8px)
            return 1.0 + ((visualString - 1) / Math.max(1, this.stringCount - 1)) * 1.8;
        } else {
            // Visual line 1 is thick (2.8px), visual line N is thin (1.0px)
            return 2.8 - ((visualString - 1) / Math.max(1, this.stringCount - 1)) * 1.8;
        }
    }

    /**
     * Render or re-render the physical fretboard neck
     */
    renderNeck({ stringCount = 6, tuning = null, capo = 0, isLeftHanded = false, isFlipped = false, displayMode = 'notes' } = {}) {
        this.stringCount = Math.max(4, Math.min(10, stringCount));
        if (Array.isArray(tuning) && tuning.length === this.stringCount) {
            this.tuning = [...tuning];
        } else if (!this.tuning || this.tuning.length !== this.stringCount) {
            this.tuning = this.getDefaultTuning(this.stringCount);
        }
        this.capo = Math.max(0, parseInt(capo, 10) || 0);
        this.isLeftHanded = Boolean(isLeftHanded);
        this.isFlipped = Boolean(isFlipped);
        this.displayMode = displayMode === 'frets' ? 'frets' : 'notes';

        // Compute geometry
        const stringGap = this.stringCount <= 5 ? 20 : (this.stringCount === 6 ? 17 : 14);
        this.neckHeight = (this.stringCount - 1) * stringGap;
        const topMargin = 16;
        this.totalHeight = topMargin + this.neckHeight + 32;

        this.svg.setAttribute('viewBox', `0 0 ${SVG_WIDTH} ${this.totalHeight}`);

        // Compute horizontal coordinates (980 scale length leaves 76px pickup/picking zone at bridge)
        const scaleLength = 980;
        this.fretWiresX = new Array(TOTAL_FRETS + 1);
        this.fretMidsX = new Array(TOTAL_FRETS + 1);

        if (!this.isLeftHanded) {
            this.openBadgeX = 36;
            this.nutX = 72;
            this.bridgeX = 1128;
            this.pickX = 1088;
            this.fretWiresX[0] = this.nutX;

            for (let n = 1; n <= TOTAL_FRETS; n++) {
                // Compensated logarithmic curve: 70% log + 30% linear
                const rLog = (1 - Math.pow(2, -n / 12)) / (1 - Math.pow(2, -TOTAL_FRETS / 12));
                const rLin = n / TOTAL_FRETS;
                const ratio = 0.70 * rLog + 0.30 * rLin;
                this.fretWiresX[n] = this.nutX + ratio * scaleLength;
                this.fretMidsX[n] = (this.fretWiresX[n - 1] + this.fretWiresX[n]) / 2;
            }
            this.fretMidsX[0] = this.openBadgeX;
        } else {
            this.openBadgeX = SVG_WIDTH - 36;
            this.nutX = SVG_WIDTH - 72;
            this.bridgeX = SVG_WIDTH - 1128;
            this.pickX = SVG_WIDTH - 1088;
            this.fretWiresX[0] = this.nutX;

            for (let n = 1; n <= TOTAL_FRETS; n++) {
                const rLog = (1 - Math.pow(2, -n / 12)) / (1 - Math.pow(2, -TOTAL_FRETS / 12));
                const rLin = n / TOTAL_FRETS;
                const ratio = 0.70 * rLog + 0.30 * rLin;
                this.fretWiresX[n] = this.nutX - ratio * scaleLength;
                this.fretMidsX[n] = (this.fretWiresX[n - 1] + this.fretWiresX[n]) / 2;
            }
            this.fretMidsX[0] = this.openBadgeX;
        }

        // Compute visual string Y coordinates (visual line 1 at topMargin)
        this.stringYs = new Array(this.stringCount + 1);
        for (let v = 1; v <= this.stringCount; v++) {
            this.stringYs[v] = topMargin + (v - 1) * stringGap;
        }

        // Build SVG Elements
        this.svg.innerHTML = '';
        this.buildDefs();
        this.buildNeck(topMargin);
        this.buildInlays(topMargin);
        this.buildNutAndFrets(topMargin);
        this.buildCapo(topMargin);
        this.buildStrings();
        this.buildStringLabels();
        this.buildPickIndicators();
        this.buildFretNumbers(topMargin);
        this.buildMarkerPool();
    }

    buildDefs() {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <!-- Track 0: Primary Theme Gradient -->
            <linearGradient id="trackGrad0" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="var(--accent-primary, #a855f7)" />
                <stop offset="100%" stop-color="var(--accent-secondary, #10b981)" />
            </linearGradient>
            <!-- Track 1: Magenta / Violet -->
            <linearGradient id="trackGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ec4899" />
                <stop offset="100%" stop-color="#8b5cf6" />
            </linearGradient>
            <!-- Track 2: Amber / Coral -->
            <linearGradient id="trackGrad2" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f59e0b" />
                <stop offset="100%" stop-color="#ef4444" />
            </linearGradient>
            <!-- Track 3: Cyan / Sky Blue -->
            <linearGradient id="trackGrad3" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#06b6d4" />
                <stop offset="100%" stop-color="#3b82f6" />
            </linearGradient>

            <linearGradient id="fretboardNutGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="var(--text-muted, #94a3b8)" stop-opacity="0.8" />
                <stop offset="50%" stop-color="#ffffff" stop-opacity="0.95" />
                <stop offset="100%" stop-color="var(--text-dim, #64748b)" stop-opacity="0.75" />
            </linearGradient>
            <filter id="fretboardGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
        `;
        this.svg.appendChild(defs);
    }

    buildNeck(topMargin) {
        const neckBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const minX = Math.min(this.nutX, this.bridgeX);
        const maxX = Math.max(this.nutX, this.bridgeX);
        neckBg.setAttribute('class', 'fretboard-neck-bg');
        neckBg.setAttribute('x', `${minX}`);
        neckBg.setAttribute('y', `${topMargin - 6}`);
        neckBg.setAttribute('width', `${maxX - minX}`);
        neckBg.setAttribute('height', `${this.neckHeight + 12}`);
        neckBg.setAttribute('rx', '4');
        this.svg.appendChild(neckBg);
    }

    buildInlays(topMargin) {
        const inlaysGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        inlaysGroup.setAttribute('class', 'fretboard-inlays');

        const centerY = topMargin + this.neckHeight / 2;
        const doubleOffset = Math.max(12, this.neckHeight * 0.24);

        // Single dot inlays
        for (const f of SINGLE_INLAY_FRETS) {
            if (f <= TOTAL_FRETS) {
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('class', 'fretboard-inlay');
                circle.setAttribute('cx', `${this.fretMidsX[f]}`);
                circle.setAttribute('cy', `${centerY}`);
                circle.setAttribute('r', '5.5');
                inlaysGroup.appendChild(circle);
            }
        }

        // Double dot inlays (12th and 24th frets)
        for (const f of DOUBLE_INLAY_FRETS) {
            if (f <= TOTAL_FRETS) {
                const topDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                topDot.setAttribute('class', 'fretboard-inlay');
                topDot.setAttribute('cx', `${this.fretMidsX[f]}`);
                topDot.setAttribute('cy', `${centerY - doubleOffset}`);
                topDot.setAttribute('r', '4.8');
                inlaysGroup.appendChild(topDot);

                const btmDot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                btmDot.setAttribute('class', 'fretboard-inlay');
                btmDot.setAttribute('cx', `${this.fretMidsX[f]}`);
                btmDot.setAttribute('cy', `${centerY + doubleOffset}`);
                btmDot.setAttribute('r', '4.8');
                inlaysGroup.appendChild(btmDot);
            }
        }

        this.svg.appendChild(inlaysGroup);
    }

    buildNutAndFrets(topMargin) {
        const fretsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        fretsGroup.setAttribute('class', 'fretboard-wires');

        // Fret wires (1 to 24)
        for (let n = 1; n <= TOTAL_FRETS; n++) {
            const wire = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            wire.setAttribute('class', 'fretboard-wire');
            wire.setAttribute('x1', `${this.fretWiresX[n]}`);
            wire.setAttribute('y1', `${topMargin - 5}`);
            wire.setAttribute('x2', `${this.fretWiresX[n]}`);
            wire.setAttribute('y2', `${topMargin + this.neckHeight + 5}`);
            fretsGroup.appendChild(wire);
        }

        // Nut (fret 0 divider)
        const nut = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        nut.setAttribute('class', 'fretboard-nut');
        nut.setAttribute('x', `${this.nutX - 3}`);
        nut.setAttribute('y', `${topMargin - 6}`);
        nut.setAttribute('width', '6');
        nut.setAttribute('height', `${this.neckHeight + 12}`);
        nut.setAttribute('rx', '2');
        fretsGroup.appendChild(nut);

        this.svg.appendChild(fretsGroup);
    }

    buildCapo(topMargin) {
        if (this.capo <= 0 || this.capo > TOTAL_FRETS) return;

        const capoGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        capoGroup.setAttribute('class', 'fretboard-capo');

        const capoX = this.fretWiresX[this.capo];
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar.setAttribute('class', 'fretboard-capo-bar');
        bar.setAttribute('x', `${capoX - 3}`);
        bar.setAttribute('y', `${topMargin - 8}`);
        bar.setAttribute('width', '6');
        bar.setAttribute('height', `${this.neckHeight + 16}`);
        bar.setAttribute('rx', '2');
        capoGroup.appendChild(bar);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('class', 'fretboard-capo-label');
        label.setAttribute('x', `${capoX}`);
        label.setAttribute('y', `${topMargin - 12}`);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = `Capo ${this.capo}`;
        capoGroup.appendChild(label);

        this.svg.appendChild(capoGroup);
    }

    buildStrings() {
        const stringsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        stringsGroup.setAttribute('class', 'fretboard-strings');

        const xStart = Math.min(this.nutX, this.bridgeX);
        const xEnd = Math.max(this.nutX, this.bridgeX);

        for (let v = 1; v <= this.stringCount; v++) {
            const gauge = this.getVisualLineGauge(v);
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('class', 'fretboard-string');
            line.setAttribute('x1', `${xStart}`);
            line.setAttribute('y1', `${this.stringYs[v]}`);
            line.setAttribute('x2', `${xEnd}`);
            line.setAttribute('y2', `${this.stringYs[v]}`);
            line.setAttribute('stroke-width', `${gauge.toFixed(2)}`);
            stringsGroup.appendChild(line);
        }

        this.svg.appendChild(stringsGroup);
    }

    buildStringLabels() {
        const labelsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelsGroup.setAttribute('class', 'fretboard-string-labels');
        this.stringLabels = {};

        for (let v = 1; v <= this.stringCount; v++) {
            const atString = this.getAtString(v);
            const pitch = this.getVisualLinePitch(v);
            const pitchName = midiToNoteName(pitch);

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'fretboard-string-label');
            text.setAttribute('x', `${this.openBadgeX}`);
            text.setAttribute('y', `${this.stringYs[v]}`);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.setAttribute('data-string', `${atString}`);
            text.setAttribute('data-visual', `${v}`);
            text.setAttribute('data-pitch', `${pitch}`);
            text.textContent = pitchName;

            labelsGroup.appendChild(text);
            this.stringLabels[atString] = text;
        }

        this.svg.appendChild(labelsGroup);
    }

    buildPickIndicators() {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('class', 'fretboard-pick-indicators');
        this.pickIndicators = {};

        // Bridge anchor plate / saddles visual on picking side
        const bridgeXPos = !this.isLeftHanded ? this.bridgeX : (this.bridgeX - 6);
        const bridgePlate = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bridgePlate.setAttribute('class', 'fretboard-bridge-saddle');
        bridgePlate.setAttribute('x', `${bridgeXPos - 2}`);
        bridgePlate.setAttribute('y', `${this.stringYs[1] - 8}`);
        bridgePlate.setAttribute('width', '8');
        bridgePlate.setAttribute('height', `${this.neckHeight + 16}`);
        bridgePlate.setAttribute('rx', '3');
        group.appendChild(bridgePlate);

        for (let v = 1; v <= this.stringCount; v++) {
            const atString = this.getAtString(v);
            const posY = this.stringYs[v];

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'fretboard-pick-marker');
            g.setAttribute('transform', `translate(${this.pickX}, ${posY})`);
            g.style.display = 'none';

            // Inner container isolates CSS transform animations from outer SVG translation
            const inner = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            inner.setAttribute('class', 'pick-marker-inner');

            // Pluck spark glow
            const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            glow.setAttribute('class', 'pick-strike-glow');
            glow.setAttribute('r', '11');

            // Plectrum shape pointing into string
            const pick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            pick.setAttribute('class', 'pick-strike-shape');
            pick.setAttribute('d', 'M -4 -7 L 4 -7 L 0 5 Z');

            // Pluck acoustic ripple wave arcs radiating towards the neck
            const wave1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            wave1.setAttribute('class', 'pick-strike-wave wave-inner');
            const wave1D = !this.isLeftHanded ? 'M -5 -7 Q -11 0 -5 7' : 'M 5 -7 Q 11 0 5 7';
            wave1.setAttribute('d', wave1D);

            const wave2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            wave2.setAttribute('class', 'pick-strike-wave wave-outer');
            const wave2D = !this.isLeftHanded ? 'M -9 -10 Q -17 0 -9 10' : 'M 9 -10 Q 17 0 9 10';
            wave2.setAttribute('d', wave2D);

            inner.appendChild(glow);
            inner.appendChild(pick);
            inner.appendChild(wave1);
            inner.appendChild(wave2);
            g.appendChild(inner);
            group.appendChild(g);

            this.pickIndicators[atString] = {
                group: g,
                inner,
                glow,
                pick,
                wave1,
                wave2,
                visualLine: v,
                struckToggle: false
            };
        }

        this.svg.appendChild(group);
    }

    buildFretNumbers(topMargin) {
        const numsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        numsGroup.setAttribute('class', 'fretboard-fret-numbers');
        const numY = topMargin + this.neckHeight + 20;

        for (const f of FRET_NUMBERS) {
            if (f <= TOTAL_FRETS) {
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('class', 'fretboard-num');
                text.setAttribute('x', `${this.fretMidsX[f]}`);
                text.setAttribute('y', `${numY}`);
                text.setAttribute('text-anchor', 'middle');
                text.textContent = `${f}`;
                numsGroup.appendChild(text);
            }
        }

        this.svg.appendChild(numsGroup);
    }

    buildMarkerPool() {
        const poolGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        poolGroup.setAttribute('id', 'fretboardNotePool');
        poolGroup.setAttribute('class', 'fretboard-note-pool');
        this.markerPool = [];

        for (let i = 0; i < this.poolSize; i++) {
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'fretboard-note-marker');
            g.style.display = 'none';

            const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            glow.setAttribute('class', 'marker-glow');
            glow.setAttribute('r', '15');

            // Standard single-track full circle
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('class', 'marker-circle');
            circle.setAttribute('r', '11');

            // Unison collision split badge elements
            const splitLeft = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            splitLeft.setAttribute('class', 'marker-split-left');
            splitLeft.setAttribute('d', 'M 0 -11 A 11 11 0 0 0 0 11 Z');
            splitLeft.style.display = 'none';

            const splitRight = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            splitRight.setAttribute('class', 'marker-split-right');
            splitRight.setAttribute('d', 'M 0 -11 A 11 11 0 0 1 0 11 Z');
            splitRight.style.display = 'none';

            const splitDivider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            splitDivider.setAttribute('class', 'marker-split-divider');
            splitDivider.setAttribute('x1', '0');
            splitDivider.setAttribute('y1', '-11');
            splitDivider.setAttribute('x2', '0');
            splitDivider.setAttribute('y2', '11');
            splitDivider.style.display = 'none';

            const outline = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            outline.setAttribute('class', 'marker-outline');
            outline.setAttribute('r', '11');
            outline.style.display = 'none';

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'marker-text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');

            const dead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            dead.setAttribute('class', 'marker-dead');
            dead.setAttribute('d', 'M -4 -4 L 4 4 M 4 -4 L -4 4');
            dead.style.display = 'none';

            g.appendChild(glow);
            g.appendChild(circle);
            g.appendChild(splitLeft);
            g.appendChild(splitRight);
            g.appendChild(splitDivider);
            g.appendChild(outline);
            g.appendChild(text);
            g.appendChild(dead);

            poolGroup.appendChild(g);
            this.markerPool.push({
                element: g,
                glow,
                circle,
                splitLeft,
                splitRight,
                splitDivider,
                outline,
                text,
                dead
            });
        }

        this.svg.appendChild(poolGroup);
    }

    /**
     * Update active note markers synchronized with AlphaTab beat playback
     * Picking hand strike indicator animates on the picking side.
     * @param {Array<Object>} notes
     * @param {string} displayMode 'notes' | 'frets'
     */
    updateActiveNotes(notes = [], displayMode = this.displayMode) {
        this.displayMode = displayMode === 'frets' ? 'frets' : 'notes';

        // Reset all pick indicators
        for (let s = 1; s <= this.stringCount; s++) {
            if (this.pickIndicators?.[s]) {
                this.pickIndicators[s].group.style.display = 'none';
            }
        }

        let poolIdx = 0;

        for (const note of notes) {
            const atString = note.string;
            const fret = note.fret;

            if (atString < 1 || atString > this.stringCount) continue;
            if (fret < 0 || fret > TOTAL_FRETS) continue;

            const colorIndices = Array.isArray(note.trackColorIndices) && note.trackColorIndices.length > 0
                ? note.trackColorIndices
                : [note.trackColorIndex ?? 0];
            const primaryTrackColorIdx = colorIndices[0] % 4;
            const trackColor = TRACK_PALETTE[primaryTrackColorIdx] || 'var(--accent-primary)';
            const trackGrad = `url(#trackGrad${primaryTrackColorIdx})`;

            const visualLine = this.getVisualString(atString);
            const posY = this.stringYs[visualLine];

            // 1. Activate Picking Hand Strike Indicator on picking side
            const pick = this.pickIndicators?.[atString];
            if (pick) {
                pick.group.style.display = '';
                pick.struckToggle = !pick.struckToggle;
                pick.group.setAttribute('class', `fretboard-pick-marker ${pick.struckToggle ? 'is-struck' : 'is-struck-alt'}`);

                pick.glow.style.fill = trackColor;
                pick.pick.style.fill = trackGrad;
                pick.wave1.style.stroke = trackColor;
                pick.wave2.style.stroke = trackColor;
            }

            // 2. For Fretted Notes (fret > 0), place Finger Dot Marker on the fret
            if (fret > 0) {
                if (poolIdx >= this.markerPool.length) continue;

                const marker = this.markerPool[poolIdx++];
                const posX = this.fretMidsX[fret];

                marker.struckToggle = !marker.struckToggle;
                const struckClass = marker.struckToggle ? 'is-struck' : 'is-struck-alt';
                marker.element.setAttribute('transform', `translate(${posX}, ${posY})`);
                marker.element.setAttribute('class', `fretboard-note-marker ${struckClass}${note.isGhost ? ' is-ghost' : ''}${note.isTieDestination ? ' is-tie' : ''}`);

                const glowFill = colorIndices[0] === 0 ? 'var(--accent-glow)' : (TRACK_PALETTE[primaryTrackColorIdx] || 'var(--accent-glow)');
                marker.glow.style.fill = glowFill;

                if (colorIndices.length >= 2) {
                    marker.circle.style.display = 'none';
                    marker.splitLeft.style.display = 'inline';
                    marker.splitRight.style.display = 'inline';
                    marker.splitDivider.style.display = 'inline';
                    marker.outline.style.display = 'inline';

                    marker.splitLeft.style.fill = `url(#trackGrad${colorIndices[0] % 4})`;
                    marker.splitRight.style.fill = `url(#trackGrad${colorIndices[1] % 4})`;
                } else {
                    marker.circle.style.display = 'inline';
                    marker.circle.style.fill = trackGrad;
                    marker.splitLeft.style.display = 'none';
                    marker.splitRight.style.display = 'none';
                    marker.splitDivider.style.display = 'none';
                    marker.outline.style.display = 'none';
                }

                if (note.isDead) {
                    marker.dead.style.display = 'inline';
                    marker.text.textContent = '';
                } else {
                    marker.dead.style.display = 'none';
                    marker.text.textContent = this.formatNoteLabel(note, displayMode);
                }

                marker.element.style.display = 'inline';
            }
        }

        // Hide unused pooled markers
        for (let i = poolIdx; i < this.markerPool.length; i++) {
            this.markerPool[i].element.style.display = 'none';
        }
    }

    /**
     * Format note badge label text according to display mode ('notes' | 'frets')
     */
    formatNoteLabel(note, mode) {
        if (mode === 'frets') return `${note.fret}`;
        // mode === 'notes' (default): pitch class name without octave (e.g. C, F#, Bb)
        const openPitch = this.tuning[this.stringCount - note.string] ?? 60;
        const midi = note.midiPitch ?? (openPitch + note.fret);
        return NOTE_NAMES[((midi % 12) + 12) % 12] || '';
    }

    /**
     * Clear all active markers from the neck
     */
    clearActiveNotes() {
        for (const marker of this.markerPool) {
            marker.element.style.display = 'none';
        }
        for (let s = 1; s <= this.stringCount; s++) {
            if (this.pickIndicators?.[s]) {
                this.pickIndicators[s].group.style.display = 'none';
            }
        }
    }

    /**
     * Interactive SVG Click Handler: maps click position to string & fret, then auditions note
     */
    handleSvgClick(event) {
        if (!this.onFretClick) return;

        // Check if a static string label was directly clicked
        const labelTarget = event.target.closest('.fretboard-string-label');
        if (labelTarget) {
            const atString = parseInt(labelTarget.getAttribute('data-string'), 10);
            const pitch = parseInt(labelTarget.getAttribute('data-pitch'), 10);
            if (atString && !isNaN(pitch)) {
                this.flashNote(atString, 0, pitch);
                this.onFretClick(atString, 0, pitch);
                return;
            }
        }

        // Convert client click coordinates to SVG coordinates
        const ctm = this.svg.getScreenCTM();
        if (!ctm) return;
        const pt = this.svg.createSVGPoint();
        pt.x = event.clientX;
        pt.y = event.clientY;
        const svgPt = pt.matrixTransform(ctm.inverse());

        // Find closest visual line
        let closestLine = 1;
        let minDy = Infinity;
        for (let v = 1; v <= this.stringCount; v++) {
            const dy = Math.abs(svgPt.y - this.stringYs[v]);
            if (dy < minDy) {
                minDy = dy;
                closestLine = v;
            }
        }

        const atString = this.getAtString(closestLine);

        // Determine fret from X position
        let clickedFret = -1;
        if (!this.isLeftHanded) {
            if (svgPt.x < this.nutX) {
                clickedFret = 0;
            } else {
                for (let n = 1; n <= TOTAL_FRETS; n++) {
                    const xLeft = n === 1 ? this.nutX : this.fretWiresX[n - 1];
                    const xRight = this.fretWiresX[n];
                    if (svgPt.x >= xLeft && svgPt.x <= xRight) {
                        clickedFret = n;
                        break;
                    }
                }
            }
        } else {
            if (svgPt.x > this.nutX) {
                clickedFret = 0;
            } else {
                for (let n = 1; n <= TOTAL_FRETS; n++) {
                    const xRight = n === 1 ? this.nutX : this.fretWiresX[n - 1];
                    const xLeft = this.fretWiresX[n];
                    if (svgPt.x >= xLeft && svgPt.x <= xRight) {
                        clickedFret = n;
                        break;
                    }
                }
            }
        }

        if (clickedFret >= 0 && clickedFret <= TOTAL_FRETS) {
            const openPitch = this.getVisualLinePitch(closestLine);
            const pitch = openPitch + clickedFret;
            this.flashNote(atString, clickedFret, pitch);
            this.onFretClick(atString, clickedFret, pitch);
        }
    }

    flashNote(atString, fret, midiPitch) {
        this.updateActiveNotes([{
            string: atString,
            fret: fret,
            midiPitch: midiPitch,
            isDead: false,
            isGhost: false,
            isTieDestination: false,
            trackColorIndex: 0
        }]);
        setTimeout(() => this.clearActiveNotes(), 450);
    }

    getDefaultTuning(stringCount) {
        if (stringCount === 4) return [43, 38, 33, 28]; // Bass EADG
        if (stringCount === 5) return [43, 38, 33, 28, 23]; // Bass BEADG
        if (stringCount === 7) return [64, 59, 55, 50, 45, 40, 35]; // 7-String
        if (stringCount === 8) return [64, 59, 55, 50, 45, 40, 35, 30]; // 8-String
        return [64, 59, 55, 50, 45, 40]; // Standard 6-string
    }
}
