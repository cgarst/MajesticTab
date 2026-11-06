// classtab/parse.js
// Reads the catalog page (index_old.htm) of the Classtab archive into composers and pieces.
//
// Reads the page line by line (a composer heading, then one line per piece) without a DOM, so it runs on the main
// thread, in a worker and under Node. Flags: easy, left-hand fingering, duet, tuning, new/updated; plus MIDI,
// video and audio links. The page-heading entry is dropped, entities are decoded here, and nested parentheses in a
// composer's aliases are balanced.
//
// Classtab is a free archive of classical guitar tabs (the site's home page is on host www.classtab.org). The archive
// itself is never shipped with the app: the user downloads it, and this only reads its index.

const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
    'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil ' +
    'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute ' +
    'Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute ' +
    'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');

const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    cacute: 'ć', Cacute: 'Ć', ccaron: 'č', Ccaron: 'Č', Scaron: 'Š', scaron: 'š',
    zcaron: 'ž', Zcaron: 'Ž', omacr: 'ō', utilde: 'ũ', ndash: '–', mdash: '—',
    hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
};
LATIN1.forEach((n, i) => { NAMED[n] = String.fromCharCode(160 + i); });

export function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
        }
        return NAMED[e] ?? m;
    });
}

const tidy = (s) => decodeEntities(s).replace(/[\s ]+/g, ' ').trim();
const textOf = (html) => tidy(html.replace(/<[^>]*>/g, ''));

const RE_ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
const RE_DATES = /\((c?\d{4}[^)]*|\?+[^)]*)\)/;
const NOT_COMPOSER = ['SCROLLING APP', 'NEW HOME PAGE', 'zip file', 'Please try', 'top of page', 'recent additions'];

function anchors(line) {
    const out = [];
    RE_ANCHOR.lastIndex = 0;
    let m;
    while ((m = RE_ANCHOR.exec(line))) {
        out.push({ href: decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim(), text: textOf(m[4]), index: m.index });
    }
    return out;
}

/** "Name  (alias, alias)" -> { name, aliases }. Parentheses may nest. */
function splitNameAliases(text) {
    const open = text.indexOf('(');
    if (open < 0) return { name: text };
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0) close = text.length;
    const aliases = text.slice(open + 1, close).trim();
    const name = (text.slice(0, open) + ' ' + text.slice(close + 1)).replace(/\s+/g, ' ').trim();
    return aliases ? { name, aliases } : { name };
}

function parsePiece(line, links) {
    const tab = links.find((a) => a.href.endsWith('.txt'));
    const text = textOf(line);
    const lower = text.toLowerCase();
    const upper = line.toUpperCase();
    const piece = {
        title: tab.text,
        tab_url: tab.href,
        has_lhf: text.includes('LHF'),
        is_easy: lower.includes('easy'),
        is_duet: lower.includes('duet') || lower.includes('duo'),
        is_new: upper.includes('- NEW'),
        is_updated: upper.includes('- UPDATED') || upper.includes('- CORRECTED')
    };
    if (lower.includes('drop d')) piece.tuning = 'drop D';
    else if (text.includes('lute tuning')) piece.tuning = 'lute tuning';
    else if (text.includes('other tuning')) piece.tuning = 'other tuning';
    const midi = links.filter((a) => a.href.endsWith('.mid')).map((a) => a.href);
    if (midi.length) piece.midi_urls = midi;
    const video = [];
    const audio = [];
    for (const a of links) {
        const h = a.href;
        if (h.includes('youtube.com') || h.includes('youtu.be') || h.includes('vimeo.com')) {
            const before = line.slice(0, a.index);
            // an "[audio: ...]" tag opened earlier in the line marks the link as audio only
            (before.lastIndexOf('[audio:') >= 0 ? audio : video).push({ performer: a.text, url: h });
        } else if (h.includes('soundcloud.com')) {
            audio.push({ performer: a.text, url: h });
        }
    }
    if (video.length) piece.video_links = video;
    if (audio.length) piece.audio_links = audio;
    return piece;
}

/** @param {string} html the text of index_old.htm @returns {Array<object>} composers with their pieces */
export function parseClasstabIndex(html) {
    const bodyAt = html.search(/<body\b[^>]*>/i);
    const body = bodyAt >= 0 ? html.slice(bodyAt).replace(/^<body\b[^>]*>/i, '') : html;
    const catalog = [];
    let current = null;
    const flush = () => { if (current && current.pieces.length) catalog.push(current); };

    for (const raw of body.split(/<br\s*\/?>/i)) {
        const line = raw.trim();
        if (!line) continue;
        const links = anchors(line);
        const hasTab = links.some((a) => a.href.endsWith('.txt'));
        const bold = /<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(line);
        if (bold && !hasTab) {
            const boldText = textOf(bold[1]);
            if (boldText && !NOT_COMPOSER.some((p) => boldText.includes(p))) {
                flush();
                const rest = textOf(line.slice(bold.index + bold[0].length));
                const dates = RE_DATES.exec(rest) || RE_DATES.exec(textOf(line));
                current = { ...splitNameAliases(boldText), pieces: [] };
                if (dates) current.dates = dates[1].trim();
                continue;
            }
        }
        if (hasTab && current) current.pieces.push(parsePiece(line, links));
    }
    flush();
    // The page's own heading ("classical music played on ...") is not a composer
    return catalog.filter((c) => !/^classical music played on/i.test(c.name));
}

export function catalogCounts(composers) {
    let pieces = 0;
    for (const c of composers) pieces += c.pieces.length;
    return { composers: composers.length, pieces };
}
