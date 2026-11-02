// importers/detect.js
// Decides how to read downloaded text from what it looks like, never from where it came from. The formats are tried in
// a fixed order and the first one that recognises the text wins:
//   1. AlphaTab sync text (`\sync bar pass ms` lines)
//   2. a MajesticTab JSON export (`{ points: [{ barIndex, occurrence, timeMs, ... }] }`, or a bare array of such points)
//   3. JSON that holds lists of bar start times: any array of numbers that only goes up, found anywhere in the JSON
// Each format returns candidate sets, `{ label, points }` (already placed in the score) or `{ label, barTimesMs }` (one
// time per bar in play order, placed by importers/index.js). Pure; tested in tests/audioSync/importers.test.mjs.

import { importPoints } from '../syncEdit.js';

const MAX_DEPTH = 8;
const MAX_CANDIDATES = 50;
const MIN_BARS = 2;

/** Seconds or milliseconds? Bar lines are never 100 seconds apart, nor less than 100 ms, so the median gap tells. */
export function timesToMs(values) {
    const gaps = values.slice(1).map((v, i) => v - values[i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    const scale = median < 100 ? 1000 : 1;
    return values.map(v => Math.round(v * scale));
}

const isBarTimes = (value) => Array.isArray(value)
    && value.length >= MIN_BARS
    && value.every((v, i) => typeof v === 'number' && Number.isFinite(v) && v >= -1 && (i === 0 || v > value[i - 1]));

/** Short text fields of the object holding a list, to tell the lists apart (an id, a name, a status). */
function describe(owner) {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return '';
    return Object.entries(owner)
        .filter(([, v]) => typeof v === 'string' && v.length > 0 && v.length <= 32)
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
}

function findBarTimes(data) {
    const found = [];
    const walk = (value, path, owner, depth) => {
        if (found.length >= MAX_CANDIDATES || depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
        if (isBarTimes(value)) {
            found.push({ path, owner, values: value });
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            walk(child, path ? `${path}.${key}` : key, Array.isArray(value) ? child : value, depth + 1);
        }
    };
    walk(data, '', null, 0);
    return found;
}

const formats = [
    {
        id: 'sync-points',
        read(text) {
            const points = importPoints(text);
            // importPoints does not validate JSON entries, and any array of objects would pass for points
            const valid = points?.length && points.every(p => Number.isInteger(p.barIndex) && p.barIndex >= 0 && Number.isFinite(p.timeMs) && p.timeMs >= 0);
            return valid ? [{ label: `Sync points (${points.length})`, points }] : null;
        }
    },
    {
        id: 'bar-times',
        read(text) {
            let data;
            try { data = JSON.parse(text); } catch { return null; }
            const found = findBarTimes(data);
            if (!found.length) return null;
            return found.map((f, i) => ({
                label: [`${i + 1}. ${f.values.length} bars`, describe(f.owner) || f.path || null].filter(Boolean).join(' · '),
                barTimesMs: timesToMs(f.values)
            }));
        }
    }
];

/** The candidate sets in `text`, or throws a message fit for the user. */
export function detectSets(text) {
    const body = String(text ?? '');
    for (const format of formats) {
        const sets = format.read(body);
        if (sets) return sets;
    }
    if (/^\s*<(!doctype|html)/i.test(body)) {
        throw new Error('That address is a web page. Use the address of the data itself: sync text, a JSON export, or JSON that lists the start time of each bar.');
    }
    throw new Error('Nothing in that address reads as sync points: expected AlphaTab \\sync text, a MajesticTab JSON export, or JSON with a list of bar start times.');
}
