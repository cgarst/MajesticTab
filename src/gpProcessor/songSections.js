// songSections.js
// Turns the section marks in a Guitar Pro file into the labelled parts of the song map.
// Pure functions: no DOM, no AlphaTab. Input is a list of master bars, each with an optional
// `section` ({ marker, text }). Rules are written down in MajesticTab-local/section-labeling.md.
//
// Sections are never invented. A label is read from the file, derived from the file's own
// letters or numbers, or an honest ordinal. A file with no usable boundary gives no parts.

export const DEFAULT_MIN_BARS = 4;

const SHORTHAND = {
    v: 'Verse', c: 'Chorus', i: 'Intro', o: 'Outro', b: 'Bridge', s: 'Solo', pc: 'Pre-chorus', pv: 'Pre-verse'
};

// Short labels chosen from the first word
const SHORT_WORDS = {
    verse: 'V', chorus: 'C', intro: 'In', outro: 'Out', bridge: 'Br', solo: 'S', interlude: 'I', riff: 'R',
    part: 'P', 'pre-verse': 'PV', 'pre-chorus': 'PC', 'post-chorus': 'PoC', preverse: 'PV', prechorus: 'PC',
    postchorus: 'PoC'
};

const TIME_CODE = /\(\s*\d+:\d{2}(?::\d{2})?\s*\)/g;

function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Read one mark. Returns { kind, name, letter, raw }.
 * kind: 'named' | 'letter' | 'generic' | 'time' | 'blank' | 'lyric' | 'tempo'
 */
export function classifyMark(section) {
    const raw = String(section?.text || section?.marker || '').trim();
    if (!raw) return { kind: 'blank', name: '', letter: '', raw };
    if (/^["'“”‘’]/.test(raw)) return { kind: 'lyric', name: '', letter: '', raw };
    if (/^tempo\s*[:=]/i.test(raw)) return { kind: 'tempo', name: '', letter: '', raw };

    let text = raw.replace(TIME_CODE, '').trim();
    if (!text) return { kind: 'time', name: '', letter: '', raw };

    // Songsterr style: [A], [A'], [E | Solo 1]
    let letter = '';
    const bracket = text.match(/^\[\s*([^\]|]*?)\s*(?:\|\s*([^\]]*?))?\s*\]\s*(.*)$/);
    if (bracket) {
        letter = bracket[1].trim();
        const afterBar = (bracket[2] || '').trim();
        const tail = (bracket[3] || '').trim();
        text = afterBar || tail;
        if (!text) return { kind: letter ? 'letter' : 'blank', name: '', letter, raw };
    }

    text = text.replace(/\s+/g, ' ').replace(/[.:\-\s]+$/, '').trim();
    if (!text) return { kind: letter ? 'letter' : 'blank', name: '', letter, raw };

    if (/^(section|part)\s+\d+$/i.test(text)) return { kind: 'generic', name: cap(text.toLowerCase()), letter, raw };

    // v, v2, c, c3, i, o, b, s, pc
    const short = text.toLowerCase().match(/^(pc|pv|v|c|i|o|b|s)\s*(\d+)?$/);
    if (short) {
        return { kind: 'named', name: SHORTHAND[short[1]] + (short[2] ? ` ${short[2]}` : ''), letter, raw };
    }
    // 1st Verse, 2nd Chorus -> Verse 1, Chorus 2
    const ordinal = text.match(/^(\d+)(?:st|nd|rd|th)\s+(.+)$/i);
    if (ordinal) return { kind: 'named', name: `${cap(ordinal[2].toLowerCase())} ${ordinal[1]}`, letter, raw };

    return { kind: 'named', name: cap(text), letter, raw };
}

function firstWordKey(name) {
    return name.toLowerCase().split(/[\s.]+/)[0];
}

/** A short label for narrow maps: V, C2, In, PC, S, or initials. */
export function shortLabel(name) {
    const m = name.match(/^(.*?)(?:\s+(\d+|[ivx]+))?$/i);
    const base = (m?.[1] || name).trim();
    const num = m?.[2] && /^\d+$/.test(m[2]) ? m[2] : '';
    const key = base.toLowerCase();
    let core = SHORT_WORDS[key] || SHORT_WORDS[firstWordKey(base)];
    if (!core) {
        const words = base.split(/[\s-]+/).filter(Boolean);
        core = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3).toUpperCase() : base.slice(0, 2);
        core = core.charAt(0).toUpperCase() + core.slice(1);
    }
    return core + num;
}

/**
 * Derive the parts of a song.
 * @param {Array<{section?: {marker?: string, text?: string}}>} masterBars
 * @param {{minBars?: number}} [options]
 * @returns {{parts: Array, marks: Array}} parts: [{ startBar, endBar, name, short, letter, raw: string[] }] with 1-based
 *   inclusive bars; marks: every classified mark (what the file contains). parts is [] when nothing usable exists.
 */
export function deriveSections(masterBars, options = {}) {
    const minBars = Math.max(1, options.minBars ?? DEFAULT_MIN_BARS);
    const total = masterBars?.length || 0;
    const marks = [];
    for (let i = 0; i < total; i++) {
        const s = masterBars[i]?.section;
        if (!s || (!s.text && !s.marker)) continue;
        marks.push({ bar: i + 1, ...classifyMark(s) });
    }
    if (!marks.length) return { parts: [], marks };

    const isBoundary = (m) => m.kind === 'named' || m.kind === 'letter' || m.kind === 'generic';
    let boundaries = marks.filter(isBoundary);
    let numberedFromTimes = false;
    if (!boundaries.length) {
        // No names, letters or generic marks at all: time-only marks become the boundaries
        boundaries = marks.filter((m) => m.kind === 'time');
        numberedFromTimes = boundaries.length > 0;
    }
    if (!boundaries.length) return { parts: [], marks };

    let parts = boundaries.map((m, i) => ({
        startBar: m.bar,
        endBar: i + 1 < boundaries.length ? boundaries[i + 1].bar - 1 : total,
        name: m.name || (m.letter ? `Section ${m.letter}` : ''),
        letter: m.letter || '',
        raw: [m.raw]
    }));

    // Fold the marks that are not boundaries into the part before (their text stays reachable)
    for (const m of marks) {
        if (boundaries.includes(m)) continue;
        const part = parts.filter((p) => p.startBar <= m.bar).pop();
        if (part) part.raw.push(m.raw);
    }

    // Lead-in when the first mark is after bar 1
    if (parts[0].startBar > 1) {
        parts.unshift({ startBar: 1, endBar: parts[0].startBar - 1, name: 'Start', letter: '', raw: [] });
    }

    // Join short parts: into the one before, the first into the one after
    let changed = true;
    while (changed && parts.length > 1) {
        changed = false;
        for (let i = 0; i < parts.length; i++) {
            const len = parts[i].endBar - parts[i].startBar + 1;
            if (len >= minBars) continue;
            if (i === 0) {
                parts[1].startBar = parts[0].startBar;
                parts[1].raw = [...parts[0].raw, ...parts[1].raw];
                parts.splice(0, 1);
            } else {
                parts[i - 1].endBar = parts[i].endBar;
                parts[i - 1].raw = [...parts[i - 1].raw, ...parts[i].raw];
                parts.splice(i, 1);
            }
            changed = true;
            break;
        }
    }

    if (numberedFromTimes) {
        parts.forEach((p, i) => { p.name = `Part ${i + 1}`; });
    } else {
        // Number repeats: Chorus, Chorus, Chorus -> Chorus, Chorus 2, Chorus 3 (names that already carry a number stay)
        const counts = new Map();
        for (const p of parts) {
            if (/\d+\s*$|\s[ivx]+$/i.test(p.name) || p.name === 'Start') continue;
            counts.set(p.name, (counts.get(p.name) || 0) + 1);
        }
        const seen = new Map();
        for (const p of parts) {
            if (!counts.has(p.name) || counts.get(p.name) < 2) continue;
            const n = (seen.get(p.name) || 0) + 1;
            seen.set(p.name, n);
            if (n > 1) p.name = `${p.name} ${n}`;
        }
    }

    parts.forEach((p) => { p.short = shortLabel(p.name); });
    return { parts, marks };
}

/** The part that contains a 1-based bar, or null. */
export function partAtBar(parts, bar) {
    return parts.find((p) => bar >= p.startBar && bar <= p.endBar) || null;
}
