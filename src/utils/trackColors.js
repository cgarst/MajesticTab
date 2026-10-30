// trackColors.js
// Shared per-track color palette: drives fretboard markers and the opt-in colored tab notation

const STORAGE_KEY_TAB_COLORS = 'majestictab_tab_track_colors';

// Six well-separated hues (Okabe-Ito style, safe for common color blindness). A track's color is keyed to its
// score track index, so it never changes when other tracks are shown or hidden.
//   sheet: color handed to AlphaTab (tuned for light paper); dark: swapped in by CSS on dark sheets and used
//   by the fretboard/track list; end: second stop of the fretboard gradient.
const TRACK_HUES = [
    { sheet: '#1D6FD6', dark: '#5CAEFF', end: '#7C6CFF' },
    { sheet: '#B45600', dark: '#FFA94D', end: '#FF7A59' },
    { sheet: '#08795A', dark: '#3DDC97', end: '#2BC4C4' },
    { sheet: '#C2307A', dark: '#FF6FB5', end: '#FF6B8B' },
    { sheet: '#7B4BD6', dark: '#B596FF', end: '#E08CFF' },
    { sheet: '#8A7000', dark: '#FFD84D', end: '#FFB347' }
];

export const TRACK_COLORS = TRACK_HUES.map(h => ({ color: h.dark, end: h.end }));

export const TRACK_PALETTE = TRACK_COLORS.map(c => c.color);

/** Palette slot for a score track (pass track.index, not its position among visible tracks). */
export function getTrackColorIndexFor(trackIndex) {
    return trackIndex >= 0 ? trackIndex % TRACK_PALETTE.length : 0;
}

export function isTabTrackColorsEnabled() {
    try {
        return localStorage.getItem(STORAGE_KEY_TAB_COLORS) === 'true';
    } catch {
        return false;
    }
}

export function setTabTrackColorsEnabled(enabled) {
    try {
        localStorage.setItem(STORAGE_KEY_TAB_COLORS, enabled ? 'true' : 'false');
    } catch { /* preference is optional */ }
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// AlphaTab writes these colors into SVG fill/stroke attributes. Dark sheet modes force every SVG element to one
// light gray with !important, so re-assert the track hue there (using the lighter dark-sheet variant). Light
// sheets have no override, so the attribute applies as-is.
// :not(#_) adds id-level specificity so these rules beat the :not()-heavy path/rect overrides.
const BOOST = ':not(#_)';
const TINT_STYLE_ID = 'track-tint-styles';
function installTrackTintStyles() {
    if (document.getElementById(TINT_STYLE_ID)) return;
    const scope = 'body:is(.sheet-mode-dark, .theme-sheet-active) #output svg';
    const css = TRACK_HUES.map(h => `
${scope} [fill="${h.sheet}" i]${BOOST} { fill: ${h.dark} !important; }
${scope} [stroke="${h.sheet}" i]${BOOST} { stroke: ${h.dark} !important; }
${scope} [fill^="rgba(${hexToRgb(h.sheet).r},${hexToRgb(h.sheet).g},${hexToRgb(h.sheet).b}," i]${BOOST} { fill: ${h.dark} !important; fill-opacity: ${STAFF_LINE_ALPHA}; }`).join('');
    const style = document.createElement('style');
    style.id = TINT_STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
}

// Staff lines are tinted softly so the notation, not the grid, carries the color.
const STAFF_LINE_ALPHA = 0.55;

const NOTE_ELEMENTS = [
    'GuitarTabFretNumber', 'GuitarTabEffects', 'Effects',
    'StandardNotationNoteHead', 'StandardNotationAccidentals', 'StandardNotationEffects'
];
const BEAT_ELEMENTS = [
    'GuitarTabStem', 'GuitarTabFlags', 'GuitarTabBeams', 'GuitarTabTuplet', 'GuitarTabEffects', 'GuitarTabRests',
    'StandardNotationStem', 'StandardNotationFlags', 'StandardNotationBeams', 'StandardNotationTuplet',
    'StandardNotationEffects', 'StandardNotationRests'
];
const BAR_SOLID_ELEMENTS = ['GuitarTabsClef', 'StandardNotationClef'];
const BAR_SOFT_ELEMENTS = ['GuitarTabsStaffLine', 'StandardNotationStaffLine'];

function forEachBar(track, fn) {
    for (const staff of track.staves || []) {
        for (const bar of staff.bars || []) fn(bar);
    }
}

function forEachBeat(track, fn) {
    forEachBar(track, (bar) => {
        for (const voice of bar.voices || []) {
            for (const beat of voice.beats || []) fn(beat);
        }
    });
}

function paint(style, elements, enumObj, color) {
    for (const name of elements) {
        if (enumObj[name] !== undefined) style.colors.set(enumObj[name], color);
    }
}

/**
 * Colors each track's notation (fret numbers, stems, rests, ties, clef, staff lines) with its palette hue to
 * match the fretboard, or clears it. Only active with 2+ visible tracks. Notes carrying another style
 * (e.g. tuning-adapter highlights) are left alone. Call before api.render()/renderTracks().
 * @param {Object} score AlphaTab score
 * @param {Array<number>} visibleTrackIndices track.index values currently rendered
 */
export function applyTabTrackColors(score, visibleTrackIndices) {
    const model = globalThis.alphaTab?.model;
    if (!score?.tracks || !model?.NoteStyle || !model.BeatStyle || !model.BarStyle || !model.Color) return;

    const active = isTabTrackColorsEnabled() && (visibleTrackIndices?.length || 0) > 1;
    if (active) installTrackTintStyles();

    for (const track of score.tracks) {
        const visible = active && visibleTrackIndices.includes(track.index);
        const hue = visible ? TRACK_HUES[getTrackColorIndexFor(track.index)] : null;
        const rgb = hue ? hexToRgb(hue.sheet) : null;
        const color = rgb ? new model.Color(rgb.r, rgb.g, rgb.b) : null;
        const softColor = rgb ? new model.Color(rgb.r, rgb.g, rgb.b, Math.round(STAFF_LINE_ALPHA * 255)) : null;

        forEachBar(track, (bar) => {
            if (color) {
                if (!bar.style || bar.style._trackColor) {
                    const bs = new model.BarStyle();
                    paint(bs, BAR_SOLID_ELEMENTS, model.BarSubElement, color);
                    paint(bs, BAR_SOFT_ELEMENTS, model.BarSubElement, softColor);
                    bs._trackColor = true;
                    bar.style = bs;
                }
            } else if (bar.style?._trackColor) {
                bar.style = undefined;
            }
        });

        forEachBeat(track, (beat) => {
            if (color) {
                if (!beat.style || beat.style._trackColor) {
                    const bs = new model.BeatStyle();
                    paint(bs, BEAT_ELEMENTS, model.BeatSubElement, color);
                    bs._trackColor = true;
                    beat.style = bs;
                }
            } else if (beat.style?._trackColor) {
                beat.style = undefined;
            }

            for (const note of beat.notes || []) {
                if (color) {
                    if (!note.style || note.style._trackColor) {
                        const ns = new model.NoteStyle();
                        paint(ns, NOTE_ELEMENTS, model.NoteSubElement, color);
                        ns._trackColor = true;
                        note.style = ns;
                    }
                } else if (note.style?._trackColor) {
                    note.style = undefined;
                }
            }
        });
    }
}

const CURVE_MAX_DISTANCE = 45;
const isDefaultInk = (v) => v == null || v === '' || /^#000(000)?$/i.test(v);

/**
 * AlphaTab has no per-track style for ties, slurs, bends and similar curves, so color the ones it drew in the
 * default ink after render: each belongs to the track staff it sits closest to. Must run before Page mode
 * clones the rendered blocks. Only active with 2+ visible tracks.
 * @param {Object} api AlphaTab API
 * @param {HTMLElement} container element AlphaTab renders into
 */
export function tintTrackCurves(api, container) {
    if (!isTabTrackColorsEnabled() || (api.tracks?.length || 0) < 2) return;
    const systems = api.renderer?.boundsLookup?.staffSystems;
    if (!systems?.length || !container) return;

    const staves = [];
    for (const system of systems) {
        for (const masterBar of system.bars || []) {
            for (const barBounds of masterBar.bars || []) {
                const vb = barBounds.visualBounds;
                const trackIndex = barBounds.beats?.[0]?.beat?.voice?.bar?.staff?.track?.index;
                if (vb && trackIndex !== undefined) staves.push({ x: vb.x, y: vb.y, w: vb.w, h: vb.h, trackIndex });
            }
        }
    }
    if (!staves.length) return;

    for (const block of container.querySelectorAll('div.at-surface > div')) {
        const svg = block.querySelector('svg');
        if (!svg) continue;
        const offX = parseFloat(block.style.left) || 0;
        const offY = parseFloat(block.style.top) || 0;

        for (const path of svg.querySelectorAll('path')) {
            const fill = path.getAttribute('fill');
            const stroke = path.getAttribute('stroke');
            const style = path.getAttribute('style') || '';
            const strokedCurve = (fill === 'none' || style.includes('fill: none')) && /^#000(000)?$/i.test(stroke || '');
            const filledShape = style.includes('stroke: none') && isDefaultInk(fill);
            if (!strokedCurve && !filledShape) continue;

            let box;
            try { box = path.getBBox(); } catch { continue; }
            const cx = box.x + box.width / 2 + offX;
            const cy = box.y + box.height / 2 + offY;

            let best = null;
            let bestDistance = CURVE_MAX_DISTANCE;
            for (const st of staves) {
                if (cx < st.x - 4 || cx > st.x + st.w + 4) continue;
                const d = cy < st.y ? st.y - cy : cy > st.y + st.h ? cy - (st.y + st.h) : 0;
                if (d < bestDistance) { best = st; bestDistance = d; }
            }
            if (!best) continue;

            const hex = TRACK_HUES[getTrackColorIndexFor(best.trackIndex)].sheet;
            path.setAttribute(strokedCurve ? 'stroke' : 'fill', hex);
        }
    }
}
