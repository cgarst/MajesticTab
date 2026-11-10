// tuningVisual.js
// Procedural SVG generation for guitar and bass tunings (Option B: Stepped Pitch Bars)
// Visualizes string count, standard baseline horizon, and relative semitone pitch drops.

import { getTuningInfo, KNOWN_TUNINGS } from './tuningUtils.js';

const NOTE_PITCH_CLASSES = {
    c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6,
    g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11
};

// Standard MIDI pitches ordered low-to-high
const STANDARD_MIDIS = {
    4: [28, 33, 38, 43], // Bass: E1, A1, D2, G2
    5: [23, 28, 33, 38, 43], // 5-String Bass: B0, E1, A1, D2, G2
    6: [40, 45, 50, 55, 59, 64], // Guitar: E2, A2, D3, G3, B3, E4
    7: [35, 40, 45, 50, 55, 59, 64], // 7-String: B1, E2, A2, D3, G3, B3, E4
    8: [30, 35, 40, 45, 50, 55, 59, 64], // 8-String: F#1, B1, E2, A2, D3, G3, B3, E4
    bass6: [23, 28, 33, 38, 43, 48] // 6-String Bass: B0, E1, A1, D2, G2, C3
};

// Standard pitch classes ordered low-to-high
const STANDARD_PITCH_CLASSES = {
    4: [4, 9, 2, 7], // E, A, D, G
    5: [11, 4, 9, 2, 7], // B, E, A, D, G
    6: [4, 9, 2, 7, 11, 4], // E, A, D, G, B, E
    7: [11, 4, 9, 2, 7, 11, 4], // B, E, A, D, G, B, E
    8: [6, 11, 4, 9, 2, 7, 11, 4] // F#, B, E, A, D, G, B, E
};

/**
 * Extracts string count, semitone deltas (low-to-high), and metadata from any tuning object or string.
 * @param {Object|string} tuningInput - Tuning group object, tuning info object, or string key/name
 * @returns {{ stringCount: number, deltas: number[], displayName: string, isDrop: boolean, minDelta: number }}
 */
export function getTuningVisualData(tuningInput) {
    if (!tuningInput) {
        return { stringCount: 6, deltas: [0, 0, 0, 0, 0, 0], displayName: 'Standard', isDrop: false, minDelta: 0 };
    }

    let rawKey = '';
    let rawNotes = '';
    let rawName = '';

    if (typeof tuningInput === 'object') {
        rawKey = tuningInput.key || tuningInput.tuning || '';
        rawNotes = tuningInput.notes || '';
        rawName = tuningInput.name || tuningInput.displayName || tuningInput.defaultName || '';
    } else if (typeof tuningInput === 'string') {
        rawKey = tuningInput;
        rawName = tuningInput;
    }

    const info = getTuningInfo(rawKey) || getTuningInfo(rawNotes) || getTuningInfo(rawName);
    const displayName = info?.displayName || rawName || rawKey || 'Tuning';
    const isBass = (
        info?.displayName?.toLowerCase().includes('bass') ||
        info?.defaultName?.toLowerCase().includes('bass') ||
        rawName.toLowerCase().includes('bass')
    );

    let stringCount = info?.stringCount || 6;
    if (typeof stringCount !== 'number' || stringCount < 3) {
        // Infer from note tokens if possible
        const noteTokens = (rawNotes || rawKey).trim().split(/[\s,]+/);
        if (noteTokens.length >= 3 && noteTokens.length <= 12) {
            stringCount = noteTokens.length;
        } else {
            stringCount = 6;
        }
    }

    let deltas = [];

    // 1. Try to compute deltas using MIDI if known
    if (info?.midi && Array.isArray(info.midi) && info.midi.length === stringCount) {
        // info.midi is high-to-low; reverse to get low-to-high
        const actualMidis = [...info.midi].reverse();
        const stdKey = (isBass && stringCount === 6) ? 'bass6' : stringCount;
        const stdMidis = STANDARD_MIDIS[stdKey] || STANDARD_MIDIS[6];

        if (stdMidis && stdMidis.length === stringCount) {
            deltas = actualMidis.map((m, i) => m - stdMidis[i]);
        }
    }

    // 2. If no MIDI deltas yet, infer from note tokens
    if (deltas.length === 0) {
        const noteSource = (info?.notes || rawNotes || rawKey || '').trim();
        const tokens = noteSource.split(/[\s,]+/).map(t => t.replace(/\d+$/, '').toLowerCase()).filter(Boolean);

        if (tokens.length === stringCount) {
            const stdPcList = STANDARD_PITCH_CLASSES[stringCount] || STANDARD_PITCH_CLASSES[6];
            deltas = tokens.map((tok, i) => {
                const pc = NOTE_PITCH_CLASSES[tok];
                if (pc === undefined) return 0;
                const stdPc = stdPcList[i] !== undefined ? stdPcList[i] : 4;
                return ((pc - stdPc + 18) % 12) - 6;
            });
        }
    }

    // 3. Fallback to zeros if still missing
    if (deltas.length !== stringCount) {
        deltas = new Array(stringCount).fill(0);
    }

    const minDelta = deltas.length > 0 ? Math.min(...deltas) : 0;
    const isDrop = deltas.length > 1 && deltas[0] <= -2 && deltas.slice(1).every(d => d > deltas[0]);

    return {
        stringCount,
        deltas,
        displayName,
        isDrop,
        minDelta
    };
}

const glyphCache = new Map();

/**
 * Procedurally generates an SVG visual for the tuning (Option B: Stepped Pitch Bars).
 * Fits into the standard 40px square container, adapts to current theme via currentColor.
 *
 * @param {Object|string} tuningInput - Tuning object, group, key, or name
 * @param {number} [size=40] - Desired bounding box dimension (default 40px)
 * @returns {string} Safe SVG markup string
 */
export function renderTuningBarsSvg(tuningInput, size = 40) {
    const data = getTuningVisualData(tuningInput);
    const cacheKey = `${data.displayName}_${data.stringCount}_${data.deltas.join('_')}_${size}`;
    const cached = glyphCache.get(cacheKey);
    if (cached) return cached;

    const N = data.stringCount;
    const deltas = data.deltas;

    const padX = size <= 40 ? 7 : Math.round(size * 0.18);
    const availW = size - (padX * 2);
    const horizonY = size <= 40 ? 14 : Math.round(size * 0.36);
    const barW = (availW / N) * 0.68;
    const scaleStep = size <= 40 ? 2.3 : (size / 40) * 2.3;
    const minH = size <= 40 ? 3.2 : (size / 40) * 3.2;
    const maxDropH = size <= 40 ? 18 : Math.round(size * 0.45);

    let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(data.displayName)} (${N} strings)">`;

    // Standard Horizon Reference Line (subtle dashed ceiling)
    const lineX1 = (padX - 2).toFixed(1);
    const lineX2 = (size - padX + 2).toFixed(1);
    const lineY = horizonY.toFixed(1);
    svg += `<line x1="${lineX1}" y1="${lineY}" x2="${lineX2}" y2="${lineY}" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.2" stroke-linecap="round"/>`;

    // Stepped Pitch Bars
    for (let i = 0; i < N; i++) {
        const cx = padX + (i / (N - 1)) * availW;
        const x = (cx - barW / 2).toFixed(2);
        const d = deltas[i] || 0;

        let h;
        let y;
        let opacity;

        if (d < 0) {
            // Dropped or down-tuned: extends downwards below standard horizon
            const dropDist = Math.abs(d) * scaleStep;
            h = Math.min(maxDropH, dropDist + minH);
            y = horizonY;
            // Higher opacity for deeper drops
            opacity = Math.abs(d) >= 2 ? '0.95' : '0.70';
        } else if (d > 0) {
            // Up-tuned: extends upwards above standard horizon
            const riseDist = Math.abs(d) * scaleStep;
            h = Math.min(horizonY - 2, riseDist + minH);
            y = horizonY - (h - minH);
            opacity = '0.85';
        } else {
            // Standard baseline note: anchor cap
            h = minH;
            y = horizonY;
            opacity = '0.35';
        }

        const rx = (barW / 2).toFixed(2);
        svg += `<rect x="${x}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="${rx}" fill="currentColor" fill-opacity="${opacity}"/>`;
    }

    // String count micro-dots along bottom
    const dotY = (size <= 40 ? 33 : Math.round(size * 0.84)).toFixed(1);
    const dotR = (size <= 40 ? 0.85 : (size / 40) * 0.85).toFixed(2);
    for (let i = 0; i < N; i++) {
        const cx = (padX + (i / (N - 1)) * availW).toFixed(2);
        svg += `<circle cx="${cx}" cy="${dotY}" r="${dotR}" fill="currentColor" fill-opacity="0.35"/>`;
    }

    svg += `</svg>`;

    glyphCache.set(cacheKey, svg);
    return svg;
}

function escapeXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
