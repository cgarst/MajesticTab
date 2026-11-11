// chordDiagram.js
// SVG Chord Box Diagram generator supporting both Horizontal (fretboard style)
// and Vertical (traditional chord chart) orientations for 6, 7, and 8-string guitars.

export const STORAGE_KEY_CHORD_ORIENTATION = 'majestictab_chord_orientation';
export const STORAGE_KEY_CHORD_VIEW_MODE = 'majestictab_chord_view_mode';
export const STORAGE_KEY_LH = 'majestictab_fretboard_left_handed';
export const STORAGE_KEY_FLIP = 'majestictab_fretboard_flip_strings';

export function getChordOrientation() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_CHORD_ORIENTATION);
        if (stored === 'vertical' || stored === 'horizontal') return stored;
    } catch (_) {}
    return 'vertical'; // Vertical by default
}

export function setChordOrientation(val) {
    const orientation = val === 'horizontal' ? 'horizontal' : 'vertical';
    try {
        localStorage.setItem(STORAGE_KEY_CHORD_ORIENTATION, orientation);
    } catch (_) {}
    return orientation;
}

export function getChordViewMode() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_CHORD_VIEW_MODE);
        if (stored === 'moveable' || stored === 'note') return stored;
    } catch (_) {}
    return 'moveable'; // Movable Shapes by default
}

export function setChordViewMode(val) {
    const mode = val === 'moveable' ? 'moveable' : 'note';
    try {
        localStorage.setItem(STORAGE_KEY_CHORD_VIEW_MODE, mode);
    } catch (_) {}
    return mode;
}

export function getIsLeftHanded() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_LH);
        if (stored !== null) return stored === 'true';
    } catch (_) {}
    return false;
}

export function getIsFlipped() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_FLIP);
        if (stored !== null) return stored === 'true';
    } catch (_) {}
    return false;
}

const DEFAULT_STRING_NAMES = {
    6: ['e', 'B', 'G', 'D', 'A', 'E'],
    7: ['e', 'B', 'G', 'D', 'A', 'E', 'B'],
    8: ['e', 'B', 'G', 'D', 'A', 'E', 'B', 'F♯']
};

/**
 * Identify which fingers must bar multiple strings.
 * Returns [{ fret, strings: [indices into frets array] }].
 */
export function findFingerBars(frets) {
    const fretNumbers = frets.map(f => parseInt(f, 10));
    const groups = new Map();
    fretNumbers.forEach((fret, i) => {
        if (fret > 0) groups.set(fret, [...(groups.get(fret) || []), i]);
    });
    const totalNotes = [...groups.values()].reduce((sum, strings) => sum + strings.length, 0);
    const sortedFrets = [...groups.keys()].sort((a, b) => a - b);
    let fingersNeeded = totalNotes;
    const bars = [];
    for (const fret of sortedFrets) {
        const strings = groups.get(fret);
        if (strings.length < 2) continue;
        const minStr = Math.min(...strings);
        const maxStr = Math.max(...strings);

        const currentBar = [];
        for (let s = minStr; s <= maxStr; s++) {
            const f = fretNumbers[s];
            if (f === 0 || (f > 0 && f < fret)) {
                if (currentBar.length >= 2) bars.push({ fret, strings: [...currentBar] });
                currentBar.length = 0;
            } else if (f === fret) {
                currentBar.push(s);
            }
        }
        if (currentBar.length >= 2) bars.push({ fret, strings: currentBar });

        const savings = strings.length - 1;
        const bridgedGap = strings.some((s, idx) => idx > 0 && s > strings[idx - 1] + 1);
        if (bridgedGap || fingersNeeded > 4) {
            fingersNeeded -= savings;
        }
    }
    return bars;
}

/**
 * Generate Chord Box Diagram SVG
 * Supports both Horizontal (nut on side) and Vertical (nut on top) orientations.
 */
export function buildChordDiagramSvg(chordOrFrets, explicitStartFret, explicitOrientation, customStringNames, explicitCapo) {
    const isFlipped = getIsFlipped();
    const isLeftHanded = getIsLeftHanded();
    const orientation = explicitOrientation || getChordOrientation();

    let fretsStr = '';
    let startFret = explicitStartFret || 1;
    let isMoveable = false;
    let shapeLabels = null;
    let rootString = null;
    let capoFret = 0;
    if (Number.isInteger(explicitCapo) && explicitCapo > 0) {
        capoFret = explicitCapo;
    } else if (chordOrFrets && typeof chordOrFrets === 'object' && Number.isInteger(chordOrFrets.capo) && chordOrFrets.capo > 0) {
        capoFret = chordOrFrets.capo;
    }
    if (typeof chordOrFrets === 'string') {
        fretsStr = chordOrFrets;
    } else if (chordOrFrets && typeof chordOrFrets === 'object') {
        fretsStr = chordOrFrets.frets || '';
        startFret = chordOrFrets.startFret || explicitStartFret || 1;
        isMoveable = Boolean(chordOrFrets.isMoveable);
        shapeLabels = chordOrFrets.labels || null;
        rootString = chordOrFrets.rootString ?? null;
    }

    const frets = fretsStr.trim().split(/\s+/);
    const numStrings = Math.max(6, frets.length);
    const lastString = numStrings - 1;

    // Check base fret
    const numericFrets = frets.map(f => parseInt(f, 10)).filter(f => !isNaN(f) && f > 0);
    const minFret = numericFrets.length > 0 ? Math.min(...numericFrets) : 1;
    const maxFret = numericFrets.length > 0 ? Math.max(...numericFrets) : 1;

    let baseFret = startFret || 1;
    if (minFret < baseFret) {
        baseFret = minFret;
    }
    const numFrets = Math.max(4, maxFret - baseFret + 1);

    const defaultNames = DEFAULT_STRING_NAMES[numStrings] || DEFAULT_STRING_NAMES[6];
    const stringNamesNormal = (customStringNames || defaultNames).slice(0, numStrings);
    const stringNamesFlipped = [...stringNamesNormal].reverse();

    if (orientation === 'vertical') {
        // Vertical layout: Nut on top, strings vertical, frets horizontal
        const startX = (capoFret > 0 && !isLeftHanded) ? 42 : 22;
        const stringGap = numStrings > 6 ? 12 : 14;
        const boardWidth = lastString * stringGap;
        const width = startX + boardWidth + (capoFret > 0 && isLeftHanded ? 42 : 22);
        const startY = 22;
        const fretGap = numFrets > 4 ? 16 : 18;
        const boardHeight = numFrets * fretGap;
        const height = startY + boardHeight + 20;

        // In vertical view: column 0 is low string, column lastString is high string
        const vertStringNamesNormal = [...stringNamesNormal].reverse();
        const vertStringNames = isFlipped ? [...vertStringNamesNormal].reverse() : vertStringNamesNormal;

        const getOrigStringIndex = col => {
            if (isLeftHanded) {
                return isFlipped ? col : (lastString - col);
            }
            return isFlipped ? (lastString - col) : col;
        };

        const fingerBars = findFingerBars(frets);
        const buildVerticalBarsSvg = () => fingerBars.map(bar => {
            const relativeFret = bar.fret - baseFret + 1;
            if (relativeFret < 1 || relativeFret > numFrets) return '';
            const cols = bar.strings.map(origIdx => {
                for (let c = 0; c <= lastString; c++) {
                    if (getOrigStringIndex(c) === origIdx) return c;
                }
                return 0;
            });
            const x1 = startX + Math.min(...cols) * stringGap;
            const x2 = startX + Math.max(...cols) * stringGap;
            const y = startY + (relativeFret - 0.5) * fretGap;
            return `<rect class="ref-chord-barre" x="${x1 - 4.5}" y="${y - 4.5}" width="${x2 - x1 + 9}" height="9" rx="4.5" fill="var(--ink)" fill-opacity="0.22" />`;
        }).join('');

        let svg = `<svg viewBox="0 0 ${width} ${height}" class="ref-chord-diagram-svg ref-chord-diagram-vertical" style="aspect-ratio: ${width} / ${height}" aria-hidden="true">`;

        const capoTextX = isLeftHanded ? (startX + boardWidth + 7) : (startX - 7);
        const capoAnchor = isLeftHanded ? 'start' : 'end';
        const fretBadgeX = capoFret > 0 ? capoTextX : (isLeftHanded ? (startX + boardWidth + 11) : (startX - 11));
        const fretBadgeAnchor = capoFret > 0 ? capoAnchor : 'middle';

        // Nut / Capo (horizontal top line)
        if (baseFret === 1) {
            if (capoFret > 0) {
                svg += `<rect class="ref-chord-capo-bar" x="${startX - 2.5}" y="${startY - 3}" width="${boardWidth + 5}" height="6" rx="3" fill="var(--ink)" fill-opacity="0.85" />`;
                svg += `<text class="ref-chord-capo-text" x="${capoTextX}" y="${startY + 2.8}" fill="var(--ink2)" font-size="7.5" font-weight="700" text-anchor="${capoAnchor}">Capo ${capoFret}</text>`;
            } else {
                svg += `<line x1="${startX}" y1="${startY}" x2="${startX + boardWidth}" y2="${startY}" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round"/>`;
            }
        } else {
            svg += `<line x1="${startX}" y1="${startY}" x2="${startX + boardWidth}" y2="${startY}" stroke="var(--border-prominent)" stroke-width="1.8" stroke-linecap="round"/>`;
            if (capoFret > 0) {
                svg += `<text class="ref-chord-capo-text" x="${capoTextX}" y="${startY - 5}" fill="var(--ink2)" font-size="7.5" font-weight="700" text-anchor="${capoAnchor}">Capo ${capoFret}</text>`;
            }
        }

        // Fret wire lines (horizontal)
        for (let f = 1; f <= numFrets; f++) {
            const y = startY + f * fretGap;
            svg += `<line x1="${startX}" y1="${y}" x2="${startX + boardWidth}" y2="${y}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Vertical strings and indicators
        for (let col = 0; col <= lastString; col++) {
            const x = startX + col * stringGap;
            const origIdx = getOrigStringIndex(col);
            const gauge = 1 + (lastString - origIdx) * 0.22;
            const f = frets[origIdx] || 'x';
            const fade = f.toLowerCase() === 'x' ? ' opacity="0.3"' : '';

            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + boardHeight}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"${fade}/>`;

            if (f.toLowerCase() === 'x') {
                svg += `<text x="${x}" y="${startY - 5}" fill="var(--ink2)" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="${x}" cy="${startY - 7}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }

            const strLabel = vertStringNames[col] || '';
            svg += `<text x="${x}" y="${startY + boardHeight + 13}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle"${fade}>${strLabel}</text>`;
        }

        if (baseFret > 1) {
            svg += `<text x="${fretBadgeX}" y="${startY + 0.5 * fretGap + 3}" fill="var(--ink2)" font-size="8.5" font-weight="bold" text-anchor="${fretBadgeAnchor}">${baseFret}fr</text>`;
        }

        svg += buildVerticalBarsSvg();

        for (let col = 0; col <= lastString; col++) {
            const origIdx = getOrigStringIndex(col);
            const f = frets[origIdx];
            if (f && f.toLowerCase() !== 'x' && f !== '0') {
                const fretVal = parseInt(f, 10);
                if (!isNaN(fretVal)) {
                    const relativeFret = fretVal - baseFret + 1;
                    if (relativeFret >= 1 && relativeFret <= numFrets) {
                        const x = startX + col * stringGap;
                        const y = startY + (relativeFret - 0.5) * fretGap;
                        const isRoot = isMoveable && (origIdx === rootString);

                        if (isRoot) {
                            svg += `<circle cx="${x}" cy="${y}" r="5.5" fill="var(--action)" />`;
                            svg += `<text x="${x}" y="${y + 2.5}" fill="var(--on-action, #fff)" font-size="6.5" font-weight="bold" text-anchor="middle">R</text>`;
                        } else if (isMoveable && shapeLabels && shapeLabels[origIdx]) {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                            const deg = shapeLabels[origIdx];
                            if (deg && deg !== 'R') {
                                svg += `<text x="${x}" y="${y + 2.5}" fill="var(--ground)" font-size="5.5" font-weight="bold" text-anchor="middle">${deg}</text>`;
                            }
                        } else {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                        }
                    }
                }
            }
        }

        svg += `</svg>`;
        return svg;
    }

    // Horizontal layout (default): Nut on side, strings horizontal, frets vertical
    const startY = 14;
    const stringGap = 10;
    const stringNames = isFlipped ? stringNamesFlipped : stringNamesNormal;

    const fretGap = numFrets > 4 ? 18 : 22;
    const boardWidth = numFrets * fretGap;
    const startX = (capoFret > 0 && baseFret > 1 && !isLeftHanded) ? 38 : 30;
    const rightMargin = (capoFret > 0 && baseFret > 1 && isLeftHanded) ? 38 : 12;
    const width = startX + boardWidth + rightMargin;
    const fretNumY = startY + lastString * stringGap + 12;
    const height = fretNumY + 6;

    const fingerBars = findFingerBars(frets);
    const buildBarsSvg = fretX => fingerBars.map(bar => {
        const relativeFret = bar.fret - baseFret + 1;
        if (relativeFret < 1 || relativeFret > numFrets) return '';
        const rows = bar.strings.map(i => isFlipped ? i : (lastString - i));
        const y1 = startY + Math.min(...rows) * stringGap;
        const y2 = startY + Math.max(...rows) * stringGap;
        return `<rect class="ref-chord-barre" x="${fretX(relativeFret) - 4.5}" y="${y1 - 4.5}" width="9" height="${y2 - y1 + 9}" rx="4.5" fill="var(--ink)" fill-opacity="0.22" />`;
    }).join('');

    let svg = `<svg viewBox="0 0 ${width} ${height}" class="ref-chord-diagram-svg ref-chord-diagram-horizontal" style="aspect-ratio: ${width} / ${height}" aria-hidden="true">`;

    if (!isLeftHanded) {
        // Nut / Capo
        if (baseFret === 1) {
            if (capoFret > 0) {
                svg += `<rect class="ref-chord-capo-bar" x="${startX - 3}" y="${startY - 2.5}" width="6" height="${lastString * stringGap + 5}" rx="3" fill="var(--ink)" fill-opacity="0.85" />`;
                svg += `<text class="ref-chord-capo-text" x="${startX}" y="8" fill="var(--ink2)" font-size="8" font-weight="700" text-anchor="middle">Capo ${capoFret}</text>`;
            } else {
                svg += `<line x1="${startX}" y1="${startY}" x2="${startX}" y2="${startY + lastString * stringGap}" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round"/>`;
            }
        } else {
            svg += `<line x1="${startX}" y1="${startY}" x2="${startX}" y2="${startY + lastString * stringGap}" stroke="var(--border-prominent)" stroke-width="1.8" stroke-linecap="round"/>`;
            if (capoFret > 0) {
                svg += `<text class="ref-chord-capo-text" x="${startX - 6}" y="8" fill="var(--ink2)" font-size="7.5" font-weight="700" text-anchor="end">Capo ${capoFret}</text>`;
            }
        }

        // Fret wire lines
        for (let f = 1; f <= numFrets; f++) {
            const x = startX + f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + lastString * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        // Horizontal string lines and string indicators on left
        for (let s = 0; s < numStrings; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((lastString - s) * 0.22) : 1 + (s * 0.22);
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex] || 'x';
            const fade = f.toLowerCase() === 'x' ? ' opacity="0.3"' : '';

            svg += `<line x1="${startX}" y1="${y}" x2="${startX + boardWidth}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"${fade}/>`;
            svg += `<text x="8" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle"${fade}>${stringNames[s]}</text>`;

            if (f.toLowerCase() === 'x') {
                svg += `<text x="20" y="${y + 3.5}" fill="var(--ink2)" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="20" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        svg += buildBarsSvg(relativeFret => startX + (relativeFret - 0.5) * fretGap);
        for (let s = 0; s < numStrings; s++) {
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex];
            if (f && f.toLowerCase() !== 'x' && f !== '0') {
                const fretVal = parseInt(f, 10);
                if (!isNaN(fretVal)) {
                    const relativeFret = fretVal - baseFret + 1;
                    if (relativeFret >= 1 && relativeFret <= numFrets) {
                        const x = startX + (relativeFret - 0.5) * fretGap;
                        const y = startY + s * stringGap;
                        const isRoot = isMoveable && (origStringIndex === rootString);

                        if (isRoot) {
                            svg += `<circle cx="${x}" cy="${y}" r="5.5" fill="var(--action)" />`;
                            svg += `<text x="${x}" y="${y + 2.5}" fill="var(--on-action, #fff)" font-size="6.5" font-weight="bold" text-anchor="middle">R</text>`;
                        } else if (isMoveable && shapeLabels && shapeLabels[origStringIndex]) {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                            const deg = shapeLabels[origStringIndex];
                            if (deg && deg !== 'R') {
                                svg += `<text x="${x}" y="${y + 2.5}" fill="var(--ground)" font-size="5.5" font-weight="bold" text-anchor="middle">${deg}</text>`;
                            }
                        } else {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                        }
                    }
                }
            }
        }

        for (let f = 1; f <= numFrets; f++) {
            const x = startX + (f - 0.5) * fretGap;
            const fretNumber = baseFret + f - 1;
            svg += `<text x="${x}" y="${fretNumY}" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
        }

        if (baseFret > 1) {
            svg += `<text x="${startX + (0.5 * fretGap)}" y="8" fill="var(--ink2)" font-size="8.5" font-weight="bold" text-anchor="middle">${baseFret}fr</text>`;
        }
    } else {
        // Left-handed horizontal
        const nutX = width - (capoFret > 0 && baseFret > 1 ? 38 : 30);

        // Nut / Capo
        if (baseFret === 1) {
            if (capoFret > 0) {
                svg += `<rect class="ref-chord-capo-bar" x="${nutX - 3}" y="${startY - 2.5}" width="6" height="${lastString * stringGap + 5}" rx="3" fill="var(--ink)" fill-opacity="0.85" />`;
                svg += `<text class="ref-chord-capo-text" x="${nutX}" y="8" fill="var(--ink2)" font-size="8" font-weight="700" text-anchor="middle">Capo ${capoFret}</text>`;
            } else {
                svg += `<line x1="${nutX}" y1="${startY}" x2="${nutX}" y2="${startY + lastString * stringGap}" stroke="var(--ink)" stroke-width="3.5" stroke-linecap="round"/>`;
            }
        } else {
            svg += `<line x1="${nutX}" y1="${startY}" x2="${nutX}" y2="${startY + lastString * stringGap}" stroke="var(--border-prominent)" stroke-width="1.8" stroke-linecap="round"/>`;
            if (capoFret > 0) {
                svg += `<text class="ref-chord-capo-text" x="${nutX + 6}" y="8" fill="var(--ink2)" font-size="7.5" font-weight="700" text-anchor="start">Capo ${capoFret}</text>`;
            }
        }

        for (let f = 1; f <= numFrets; f++) {
            const x = nutX - f * fretGap;
            svg += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${startY + lastString * stringGap}" stroke="var(--border-subtle)" stroke-width="1.2" stroke-linecap="round"/>`;
        }

        for (let s = 0; s < numStrings; s++) {
            const y = startY + s * stringGap;
            const gauge = isFlipped ? 1 + ((lastString - s) * 0.22) : 1 + (s * 0.22);
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex] || 'x';
            const fade = f.toLowerCase() === 'x' ? ' opacity="0.3"' : '';

            svg += `<line x1="12" y1="${y}" x2="${nutX}" y2="${y}" stroke="var(--border-subtle)" stroke-width="${gauge}" stroke-linecap="round"${fade}/>`;
            svg += `<text x="${nutX + 22}" y="${y + 3}" fill="var(--text-dim)" font-size="8" font-weight="bold" text-anchor="middle"${fade}>${stringNames[s]}</text>`;

            if (f.toLowerCase() === 'x') {
                svg += `<text x="${nutX + 10}" y="${y + 3.5}" fill="var(--ink2)" font-size="10" font-weight="bold" text-anchor="middle">×</text>`;
            } else if (f === '0') {
                svg += `<circle cx="${nutX + 10}" cy="${y}" r="3" fill="none" stroke="var(--text-muted)" stroke-width="1.3" />`;
            }
        }

        svg += buildBarsSvg(relativeFret => nutX - (relativeFret - 0.5) * fretGap);
        for (let s = 0; s < numStrings; s++) {
            const origStringIndex = isFlipped ? s : (lastString - s);
            const f = frets[origStringIndex];
            if (f && f.toLowerCase() !== 'x' && f !== '0') {
                const fretVal = parseInt(f, 10);
                if (!isNaN(fretVal)) {
                    const relativeFret = fretVal - baseFret + 1;
                    if (relativeFret >= 1 && relativeFret <= numFrets) {
                        const x = nutX - (relativeFret - 0.5) * fretGap;
                        const y = startY + s * stringGap;
                        const isRoot = isMoveable && (origStringIndex === rootString);

                        if (isRoot) {
                            svg += `<circle cx="${x}" cy="${y}" r="5.5" fill="var(--action)" />`;
                            svg += `<text x="${x}" y="${y + 2.5}" fill="var(--on-action, #fff)" font-size="6.5" font-weight="bold" text-anchor="middle">R</text>`;
                        } else if (isMoveable && shapeLabels && shapeLabels[origStringIndex]) {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                            const deg = shapeLabels[origStringIndex];
                            if (deg && deg !== 'R') {
                                svg += `<text x="${x}" y="${y + 2.5}" fill="var(--ground)" font-size="5.5" font-weight="bold" text-anchor="middle">${deg}</text>`;
                            }
                        } else {
                            svg += `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--ink)" />`;
                        }
                    }
                }
            }
        }

        for (let f = 1; f <= numFrets; f++) {
            const x = nutX - (f - 0.5) * fretGap;
            const fretNumber = baseFret + f - 1;
            svg += `<text x="${x}" y="${fretNumY}" fill="var(--text-dim)" font-size="8" text-anchor="middle">${fretNumber}</text>`;
        }

        if (baseFret > 1) {
            svg += `<text x="${nutX - (0.5 * fretGap)}" y="8" fill="var(--ink2)" font-size="8.5" font-weight="bold" text-anchor="middle">${baseFret}fr</text>`;
        }
    }

    svg += `</svg>`;
    return svg;
}
