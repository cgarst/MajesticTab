// trackColors.js
// Shared per-track color palette: drives fretboard markers and the opt-in colored tab notation

const STORAGE_KEY_TAB_COLORS = 'majestictab_tab_track_colors';

// Track 0 follows the active finish theme; the rest are fixed hues. `end` is the fretboard gradient's second stop.
export const TRACK_COLORS = [
    { color: 'var(--accent-primary, #6366f1)', end: 'var(--accent-secondary, #10b981)' },
    { color: '#ec4899', end: '#8b5cf6' },
    { color: '#f59e0b', end: '#ef4444' },
    { color: '#06b6d4', end: '#3b82f6' },
    { color: '#22c55e', end: '#14b8a6' },
    { color: '#ef4444', end: '#f97316' },
    { color: '#a855f7', end: '#6366f1' },
    { color: '#84cc16', end: '#eab308' }
];

export const TRACK_PALETTE = TRACK_COLORS.map(c => c.color);

export function getTrackColorIndexFor(position) {
    return position >= 0 ? position % TRACK_PALETTE.length : 0;
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

// AlphaTab needs concrete colors, so resolve CSS variables through a probe element.
// Darkened so amber/lime stay legible on light sheet themes.
function resolveTabColor(cssColor) {
    const probe = document.createElement('span');
    probe.style.color = cssColor;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || [];
    probe.remove();
    if (rgb.length < 3) return null;
    const [r, g, b] = rgb.slice(0, 3).map(v => Math.round(parseFloat(v) * 0.78));
    return { r, g, b };
}

const NOTE_ELEMENTS = ['GuitarTabFretNumber', 'GuitarTabEffects'];
const BEAT_ELEMENTS = ['GuitarTabStem', 'GuitarTabFlags', 'GuitarTabBeams', 'GuitarTabTuplet'];

function forEachBeat(track, fn) {
    for (const staff of track.staves || []) {
        for (const bar of staff.bars || []) {
            for (const voice of bar.voices || []) {
                for (const beat of voice.beats || []) fn(beat);
            }
        }
    }
}

function paint(style, elements, enumObj, color) {
    for (const name of elements) {
        if (enumObj[name] !== undefined) style.colors.set(enumObj[name], color);
    }
}

/**
 * Colors tab fret numbers and stems per track to match the fretboard, or clears them.
 * Only active with 2+ visible tracks. Notes carrying another style (e.g. tuning-adapter highlights) are left alone.
 * Call before api.render()/renderTracks().
 * @param {Object} score AlphaTab score
 * @param {Array<number>} visibleTrackIndices track.index values currently rendered, in display order
 */
export function applyTabTrackColors(score, visibleTrackIndices) {
    const model = globalThis.alphaTab?.model;
    if (!score?.tracks || !model?.NoteStyle || !model.BeatStyle || !model.Color) return;

    const active = isTabTrackColorsEnabled() && (visibleTrackIndices?.length || 0) > 1;

    for (const track of score.tracks) {
        const position = active ? visibleTrackIndices.indexOf(track.index) : -1;
        const rgb = position >= 0 ? resolveTabColor(TRACK_PALETTE[getTrackColorIndexFor(position)]) : null;
        const color = rgb ? new model.Color(rgb.r, rgb.g, rgb.b) : null;

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
