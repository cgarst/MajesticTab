// syncEdit.js
// Pure helpers for editing a list of sync points and for importing and exporting them. A point is
// `{ id, barIndex, occurrence, pos, timeMs, source }` (see syncStore.js). No DOM access, so it is unit tested in
// Node (tests/audioSync/syncEdit.test.mjs). Edits return new lists sorted by time and never validate order; the
// editor checks that against the score (see audioSyncController.pointProblems).

let idCounter = 0;

export function makeId() {
    idCounter = (idCounter + 1) % 1e6;
    return `p${Date.now().toString(36)}${idCounter.toString(36)}`;
}

const byTime = (a, b) => a.timeMs - b.timeMs;

/** "1:23.456" for 83456, with "-" for a missing value. Whole minutes are not padded, seconds and ms are. */
export function formatTime(ms) {
    if (!Number.isFinite(ms)) return '-';
    const total = Math.max(0, Math.round(ms));
    const m = Math.floor(total / 60000);
    const s = Math.floor((total % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

/** Accepts "m:ss.mmm", "m:ss", "ss.mmm" or plain seconds. Returns milliseconds, or null when it isn't a time. */
export function parseTime(text) {
    const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ''));
    if (!m) return null;
    const seconds = Number(m[2]);
    const minutes = m[1] ? Number(m[1]) : 0;
    if (m[1] && seconds >= 60) return null;
    return Math.round((minutes * 60 + seconds) * 1000);
}

export function addPoint(points, point) {
    return [...points, { id: makeId(), occurrence: 0, pos: 0, source: 'manual', ...point }].sort(byTime);
}

export function updatePoint(points, id, patch) {
    return points.map(p => (p.id === id ? { ...p, ...patch } : p)).sort(byTime);
}

export function removePoints(points, ids) {
    const drop = new Set(ids);
    return points.filter(p => !drop.has(p.id));
}

/** Moves every point at or after `fromMs` by `deltaMs` (clamped at 0). */
export function shiftAfter(points, fromMs, deltaMs) {
    return points.map(p => (p.timeMs >= fromMs ? { ...p, timeMs: Math.max(0, p.timeMs + deltaMs) } : p)).sort(byTime);
}

/** Deletes the points whose time is within `fromMs` to `toMs`, inclusive. */
export function deleteRange(points, fromMs, toMs) {
    return points.filter(p => p.timeMs < fromMs || p.timeMs > toMs);
}

// --- AlphaTab sync points text -------------------------------------------------------------------------------------
// One `\sync barIndex occurrence millisecondOffset [barPosition]` per line, the form AlphaTab's alphaTex uses.

export function toAlphaTexSync(points) {
    return [...points].sort(byTime).map(p => {
        const base = `\\sync ${p.barIndex} ${p.occurrence || 0} ${Math.round(p.timeMs)}`;
        return p.pos > 0 ? `${base} ${Number(p.pos.toFixed(6))}` : base;
    }).join('\n');
}

/** Reads every `\sync` entry in `text` (other text, such as the rest of an alphaTex file, is ignored). */
export function fromAlphaTexSync(text) {
    const re = /\\sync\s+(\d+)\s+(\d+)\s+(-?\d+(?:\.\d+)?)(?:\s+(\d*\.?\d+))?/g;
    const points = [];
    let m;
    while ((m = re.exec(String(text ?? ''))) !== null) {
        const timeMs = Number(m[3]);
        const pos = m[4] === undefined ? 0 : Number(m[4]);
        if (timeMs < 0 || pos > 1) continue;
        points.push({ id: makeId(), barIndex: Number(m[1]), occurrence: Number(m[2]), pos, timeMs: Math.round(timeMs), source: 'manual' });
    }
    return points.sort(byTime);
}

// --- JSON ----------------------------------------------------------------------------------------------------------

export function toJson(points) {
    return JSON.stringify({ version: 1, points: [...points].sort(byTime) }, null, 2);
}

/** Accepts the exported object or a bare array of points. Returns the parsed points (unvalidated) or null. */
export function fromJson(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    const list = Array.isArray(data) ? data : data?.points;
    if (!Array.isArray(list)) return null;
    return list
        .filter(p => p && typeof p === 'object')
        .map(p => ({ ...p, id: typeof p.id === 'string' && p.id ? p.id : makeId() }));
}

/** Imports either format, picking by content. Returns the points, or null when neither parses. */
export function importPoints(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return fromJson(trimmed);
    const points = fromAlphaTexSync(trimmed);
    return points.length ? points : null;
}
