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
    postchorus: 'PoC', 'main riff': 'MR'
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
    text = text.replace(/\(\s*tempo\s*[:=]\s*\d+\s*\)/i, '').trim();
    if (!text) return { kind: 'time', name: '', letter: '', raw };

    // Songsterr style: [A], [A'], [E | Solo 1]
    let letter = '';
    const bracket = text.match(/^\[\s*([A-Za-z0-9'′″]+)(?:\s*\|\s*([^\]]*?))?\s*\]\s*(.*)$/);
    if (bracket) {
        letter = bracket[1].trim().replace(/''/g, '″').replace(/'/g, '′');
        const afterBar = (bracket[2] || '').trim();
        const tail = (bracket[3] || '').trim();
        text = afterBar || tail;
        if (!text) return { kind: 'letter', name: letter, letter, raw };
    }

    text = text.replace(/\s+/g, ' ').replace(/[.:\-\s]+$/, '').trim();
    if (!text) return { kind: letter ? 'letter' : 'blank', name: letter, letter, raw };

    const g = text.match(/^(?:section|part)\s*-?(\d+)$/i);
    if (g) return { kind: 'generic', name: 'Part ' + g[1], letter, raw };

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
    const num = m?.[2] || '';
    const key = base.toLowerCase();
    let core = SHORT_WORDS[key];
    if (!core) {
        const words = base.split(/[\s\-/]+/).filter(Boolean);
        core = words.length > 1
            ? words.map((w) => w[0].toUpperCase()).join('').slice(0, 3)
            : (words[0] || '').slice(0, 2);
    }
    return core + num;
}

/**
 * Derive the parts of a song.
 * @param {Array<{section?: {marker?: string, text?: string}}>} masterBars
 * @param {{minBars?: number}} [options]
 * @returns {{parts: Array, marks: Array, moved: number}} parts: [{ startBar, endBar, name, short, letter, raw: string[] }] with 1-based
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
    if (!marks.length) return { parts: [], marks, moved: 0 };

    const hasNamed = marks.some(m => ['named', 'letter', 'generic'].includes(m.kind));
    const isBoundary = (m) => m.kind === 'named' || m.kind === 'letter' || m.kind === 'generic' || (!hasNamed && m.kind === 'time');
    const boundaries = marks.filter(isBoundary);
    if (!boundaries.length) return { parts: [], marks, moved: 0 };

    let ordinal = 0;
    let parts = boundaries.map((m, i) => {
        let name = m.name;
        if (m.kind === 'letter' || (m.letter && !m.name)) {
            name = m.letter.replace(/''/g, '″').replace(/'/g, '′');
        } else if (m.letter && m.name) {
            name = m.name;
        }
        if (m.kind === 'time' || (!name && m.kind !== 'generic')) {
            ordinal++;
            name = 'Part ' + ordinal;
        }
        return {
            startBar: m.bar,
            endBar: i + 1 < boundaries.length ? boundaries[i + 1].bar - 1 : total,
            name,
            kind: m.kind,
            letter: m.letter || '',
            raw: [m.raw]
        };
    });

    // Fold the marks that are not boundaries into the part before (their text stays reachable)
    for (const m of marks) {
        if (boundaries.includes(m)) continue;
        const part = parts.filter((p) => p.startBar <= m.bar).pop();
        if (part) part.raw.push(m.raw);
    }

    // Lead-in when the first mark is after bar 1
    if (parts.length && parts[0].startBar > 1) {
        parts.unshift({ startBar: 1, endBar: parts[0].startBar - 1, name: 'Start', kind: 'lead', letter: '', raw: [] });
    }

    // Number repeats BEFORE short parts merge: Chorus, Chorus, Chorus -> Chorus, Chorus 2, Chorus 3
    const seen = {};
    parts.forEach(p => {
        if (p.kind !== 'named' && p.kind !== 'name') return;
        const k = p.name.toLowerCase();
        if (/\d+$/.test(k) || /^[ivx]+\.?$/i.test(k)) return;
        seen[k] = (seen[k] || 0) + 1;
        if (seen[k] > 1) p.name += ' ' + seen[k];
    });

    // Join short parts: into the one before, the first into the one after
    let changed = true;
    let moved = 0;
    while (changed && parts.length > 1) {
        changed = false;
        for (let i = 0; i < parts.length; i++) {
            const len = parts[i].endBar - parts[i].startBar + 1;
            if (len >= minBars) continue;
            const j = i > 0 ? i - 1 : 1;
            const a = parts[j];
            const b = parts[i];
            a.raw = i > 0 ? a.raw.concat(b.raw) : b.raw.concat(a.raw);
            if (i > 0) a.endBar = b.endBar;
            else a.startBar = b.startBar;
            parts.splice(i, 1);
            moved++;
            changed = true;
            break;
        }
    }

    // Re-index any sequential non-generic Part N names
    let pn = 0;
    parts.forEach(p => {
        if (/^Part \d+$/.test(p.name) && p.kind !== 'generic') {
            pn++;
            p.name = 'Part ' + pn;
        }
    });

    parts.forEach((p) => { p.short = shortLabel(p.name); });
    return { parts, marks, moved };
}

/** The part that contains a 1-based bar, or null. */
export function partAtBar(parts, bar) {
    return parts.find((p) => bar >= p.startBar && bar <= p.endBar) || null;
}
