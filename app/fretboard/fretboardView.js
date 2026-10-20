// fretboardView.js
// High-DPI Responsive SVG Neck & Fretboard Visualizer for MajesticTab
import { NOTE_NAMES, midiToNoteName } from '../utils/tuningUtils.js';

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
        this.displayMode = 'notes';

        // Precalculated geometry cache
        this.fretWiresX = [];
        this.fretMidsX = [];
        this.stringYs = [];
        this.openBadgeX = 28;
        this.nutX = 72;
        this.bridgeX = 1126;
        this.neckHeight = 90;
        this.totalHeight = 140;

        // Pooled note marker SVG nodes
        this.poolSize = 32;
        this.markerPool = [];
        this.openBadges = {};

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
        this.displayMode = displayMode;

        // Compute geometry
        const stringGap = this.stringCount <= 5 ? 20 : (this.stringCount === 6 ? 17 : 14);
        this.neckHeight = (this.stringCount - 1) * stringGap;
        const topMargin = 16;
        this.totalHeight = topMargin + this.neckHeight + 32;

        this.svg.setAttribute('viewBox', `0 0 ${SVG_WIDTH} ${this.totalHeight}`);

        // Compute horizontal coordinates
        // Right-handed: Nut at left (72), Bridge at right (1126)
        // Left-handed: Nut at right (1078), Bridge at left (24)
        const scaleLength = 1054;
        this.fretWiresX = new Array(TOTAL_FRETS + 1);
        this.fretMidsX = new Array(TOTAL_FRETS + 1);

        if (!this.isLeftHanded) {
            this.openBadgeX = 28;
            this.nutX = 72;
            this.bridgeX = 1126;
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
            this.openBadgeX = SVG_WIDTH - 28;
            this.nutX = SVG_WIDTH - 72;
            this.bridgeX = SVG_WIDTH - 1126;
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
        this.buildOpenStringBadges();
        this.buildFretNumbers(topMargin);
        this.buildMarkerPool();
    }

    buildDefs() {
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <linearGradient id="fretboardMarkerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="var(--accent-primary, #a855f7)" />
                <stop offset="100%" stop-color="var(--accent-secondary, #10b981)" />
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

    buildOpenStringBadges() {
        const badgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        badgesGroup.setAttribute('class', 'fretboard-open-badges');
        this.openBadges = {};

        for (let v = 1; v <= this.stringCount; v++) {
            const atString = this.getAtString(v);
            const pitch = this.getVisualLinePitch(v);
            const pitchName = midiToNoteName(pitch);

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'fretboard-open-string');
            g.setAttribute('data-string', `${atString}`);
            g.setAttribute('data-visual', `${v}`);
            g.setAttribute('data-pitch', `${pitch}`);
            g.setAttribute('transform', `translate(${this.openBadgeX}, ${this.stringYs[v]})`);

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('class', 'open-badge-bg');
            circle.setAttribute('r', '12');

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'open-badge-text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'central');
            text.textContent = pitchName;

            g.appendChild(circle);
            g.appendChild(text);
            badgesGroup.appendChild(g);

            this.openBadges[atString] = g;
        }

        this.svg.appendChild(badgesGroup);
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

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('class', 'marker-circle');
            circle.setAttribute('r', '11');

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
            g.appendChild(text);
            g.appendChild(dead);

            poolGroup.appendChild(g);
            this.markerPool.push({ element: g, glow, circle, text, dead });
        }

        this.svg.appendChild(poolGroup);
    }

    /**
     * Update active note markers synchronized with AlphaTab beat playback
     * @param {Array<Object>} notes
     * @param {string} displayMode
     */
    updateActiveNotes(notes = [], displayMode = this.displayMode) {
        this.displayMode = displayMode;

        // Reset open string badges active pulse
        for (let s = 1; s <= this.stringCount; s++) {
            this.openBadges[s]?.classList.remove('fretboard-open-active');
        }

        let poolIdx = 0;

        for (const note of notes) {
            const atString = note.string;
            const fret = note.fret;

            if (atString < 1 || atString > this.stringCount) continue;

            // Open string (fret 0) lights up the corresponding open tuning badge
            if (fret === 0) {
                this.openBadges[atString]?.classList.add('fretboard-open-active');
                continue;
            }

            if (fret < 0 || fret > TOTAL_FRETS) continue;
            if (poolIdx >= this.markerPool.length) break;

            const visualLine = this.getVisualString(atString);
            const marker = this.markerPool[poolIdx++];
            const posX = this.fretMidsX[fret];
            const posY = this.stringYs[visualLine];

            marker.element.setAttribute('transform', `translate(${posX}, ${posY})`);
            marker.element.setAttribute('class', `fretboard-note-marker${note.isGhost ? ' is-ghost' : ''}${note.isTieDestination ? ' is-tie' : ''}`);

            // Dead notes display '✕'
            if (note.isDead) {
                marker.dead.style.display = 'inline';
                marker.text.textContent = '';
            } else {
                marker.dead.style.display = 'none';
                marker.text.textContent = this.formatNoteLabel(note, displayMode);
            }

            marker.element.style.display = 'inline';
        }

        // Hide unused pooled markers
        for (let i = poolIdx; i < this.markerPool.length; i++) {
            this.markerPool[i].element.style.display = 'none';
        }
    }

    /**
     * Format note badge label text according to display mode
     */
    formatNoteLabel(note, mode) {
        if (mode === 'dots') return '';
        if (mode === 'frets') return `${note.fret}`;
        if (mode === 'fingers') {
            const f = note.finger;
            if (f === 1 || f === '1' || f === 'IndexFinger') return '1';
            if (f === 2 || f === '2' || f === 'MiddleFinger') return '2';
            if (f === 3 || f === '3' || f === 'RingFinger') return '3';
            if (f === 4 || f === '4' || f === 'LittleFinger') return '4';
            if (f === 0 || f === '0' || f === 'Thumb') return 'T';
            return `${note.fret}`;
        }
        // mode === 'notes': pitch class name without octave (e.g. C, F#, Bb)
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
            this.openBadges[s]?.classList.remove('fretboard-open-active');
        }
    }

    /**
     * Interactive SVG Click Handler: maps click position to string & fret, then auditions note
     */
    handleSvgClick(event) {
        if (!this.onFretClick) return;

        // Check if an open string badge was directly clicked
        const badgeTarget = event.target.closest('.fretboard-open-string');
        if (badgeTarget) {
            const atString = parseInt(badgeTarget.getAttribute('data-string'), 10);
            const pitch = parseInt(badgeTarget.getAttribute('data-pitch'), 10);
            if (atString && !isNaN(pitch)) {
                this.flashOpenBadge(atString);
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
            if (clickedFret === 0) {
                this.flashOpenBadge(atString);
            } else {
                this.flashNote(atString, clickedFret, pitch);
            }
            this.onFretClick(atString, clickedFret, pitch);
        }
    }

    flashOpenBadge(atString) {
        const badge = this.openBadges[atString];
        if (!badge) return;
        badge.classList.add('fretboard-open-active');
        setTimeout(() => badge.classList.remove('fretboard-open-active'), 350);
    }

    flashNote(atString, fret, midiPitch) {
        this.updateActiveNotes([{
            string: atString,
            fret: fret,
            midiPitch: midiPitch,
            isDead: false,
            isGhost: false,
            isTieDestination: false
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
