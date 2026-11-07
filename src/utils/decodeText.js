// utils/decodeText.js
// Turns the bytes of a text tab into a string without assuming UTF-8. Text tabs come as UTF-8, UTF-16, the legacy
// Chinese, Japanese and Korean code pages, or Latin-1 / Windows-1252 (accents in classical guitar tabs). Reading them
// all as UTF-8 turns everything outside ASCII into U+FFFD. Pure, so it runs under Node tests.
//
// Order: a byte order mark, then strict UTF-8 (a file that is valid UTF-8 almost certainly is), then the charset the
// server named, then a guess: decode with each legacy code page and keep the one whose text looks most like real
// writing (common Chinese characters, kana, hangul). With no such evidence the file is Windows-1252.

const HINT_FALLBACKS = ['gb18030', 'big5', 'shift_jis', 'euc-kr'];

// Very common characters, enough to tell a right decode from a wrong one (wrong ones give rare characters).
const COMMON_SIMPLIFIED = '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后';
const COMMON_TRADITIONAL = '的一是不了在人有我他這個們中來上大為和國地到以說時要就出會可也你對生能而子那得於著下自之年過發後';
const KANA = /[぀-ヿ]/g;
const HANGUL = /[가-힯]/g;

const count = (text, re) => (text.match(re) || []).length;
const countIn = (text, set) => { let n = 0; for (const ch of text) if (set.includes(ch)) n++; return n; };

function tryDecode(label, bytes, fatal) {
    try { return new TextDecoder(label, { fatal }).decode(bytes); } catch { return null; }
}

function normalizeLabel(charset) {
    if (!charset) return null;
    const label = String(charset).trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (!label || label === 'utf-8' || label === 'utf8') return null;
    try { return new TextDecoder(label).encoding; } catch { return null; }
}

function scoreCandidate(label, text) {
    const bad = count(text, /�/g);
    // private-use and compatibility ranges are what a wrong decode of double-byte text fills the page with
    const junk = count(text, /[-豈-﫿]/g);
    // Wrong decodes of double-byte text still yield valid-looking characters, so Japanese and Korean must be mostly
    // their own script, not a mix with ideographs (what GBK bytes read as EUC-KR look like).
    const wide = count(text, /[^\u0000-\u00ff\u2000-\u206f\u3000-\u303f\uff00-\uffef]/g) || 1;
    let evidence = 0;
    if (label === 'gb18030') evidence = countIn(text, COMMON_SIMPLIFIED);
    else if (label === 'big5') evidence = countIn(text, COMMON_TRADITIONAL);
    else if (label === 'shift_jis') { const kana = count(text, KANA); evidence = kana / wide >= 0.2 ? kana * 2 : 0; }
    else if (label === 'euc-kr') { const hangul = count(text, HANGUL); evidence = hangul / wide >= 0.8 ? hangul * 2 : 0; }
    return evidence * 3 - bad * 10 - junk * 5;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @param {string} [charsetHint] a charset the source declared (an HTTP Content-Type charset), used before guessing
 * @returns {string}
 */
export function decodeText(input, charsetHint) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));

    // No BOM but every other byte is zero: UTF-16 of mostly ASCII text
    if (bytes.length >= 8) {
        let even = 0, odd = 0;
        const n = Math.min(bytes.length, 400);
        for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 ? odd++ : even++);
        if (odd > n * 0.3 && even === 0) return new TextDecoder('utf-16le').decode(bytes);
        if (even > n * 0.3 && odd === 0) return new TextDecoder('utf-16be').decode(bytes);
    }

    const utf8 = tryDecode('utf-8', bytes, true);
    if (utf8 !== null) return utf8;

    const hinted = normalizeLabel(charsetHint);
    if (hinted) {
        const text = tryDecode(hinted, bytes, true);
        if (text !== null) return text;
    }

    let best = null;
    let bestScore = 0;
    for (const label of HINT_FALLBACKS) {
        const text = tryDecode(label, bytes, true);
        if (text === null) continue;
        const score = scoreCandidate(label, text);
        if (score > bestScore) { best = text; bestScore = score; }
    }
    // Some evidence of real CJK text, otherwise Latin-1 accents (Windows-1252 never fails)
    if (best !== null && bestScore >= 6) return best;
    return new TextDecoder('windows-1252').decode(bytes);
}

/** The charset named in a Content-Type header value ("text/plain; charset=gb2312"), or ''. */
export function charsetOf(contentType) {
    const m = /charset\s*=\s*([^;\s]+)/i.exec(contentType || '');
    return m ? m[1] : '';
}
