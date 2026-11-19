// stemGuess.js
// Names and instruments for stems added from loose files (addStems.js): what a file's name most likely says it is. The
// instrument is what decides which part Backing starts without (the guitars, or the bass in bass mode), so a wrong guess
// is one the person fixes in the sheet. Pure, so it is unit tested.

export const INSTRUMENTS = [['guitar', 'Guitar'], ['bass', 'Bass'], ['drums', 'Drums'], ['keys', 'Keys'], ['vocals', 'Vocals'], ['other', 'Other']];

const WORDS = [
    ['bass', /\bbass\b|\bbs\b/],
    ['drums', /\bdrums?\b|\bkick\b|\bsnare\b|\bperc(ussion)?\b|\bkit\b/],
    ['vocals', /\bvocals?\b|\bvox\b|\bvoice\b|\bsing(er|ing)?\b/],
    ['keys', /\bkeys?\b|\bkeyboards?\b|\bpiano\b|\borgan\b|\bsynth\b/],
    ['guitar', /\bguitars?\b|\bgtrs?\b|\bgt\b|\blead\b|\brhythm\b|\bclean\b|\bacoustic\b|\briff\b/]
];

/** The instrument a file name says, or 'other'. */
export function guessInstrument(name) {
    const text = String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[_\-.()[\]]+/g, ' ');
    for (const [instrument, re] of WORDS) if (re.test(text)) return instrument;
    return 'other';
}

const tidy = (s) => s.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A label for each file: its name without the extension, and without what every name starts with (the song's own title).
 * A name left empty by that keeps the whole name.
 */
export function labelsFromNames(names) {
    const clean = names.map((n) => tidy(String(n || '')));
    let prefix = '';
    if (clean.length > 1) {
        const first = clean[0];
        let n = 0;
        while (n < first.length && clean.every((c) => c[n] && c[n].toLowerCase() === first[n].toLowerCase())) n++;
        const isSep = (ch) => !ch || /[\s\-–—:,.()]/.test(ch);
        let cut = n;
        // Never through the middle of a word
        if (!(isSep(first[n - 1]) || clean.every((c) => isSep(c[n])))) while (cut > 0 && !isSep(first[cut - 1])) cut--;
        prefix = first.slice(0, cut);
        // Only when what is left still names each part (not just a number) and the shared start is long enough to be a title
        if (prefix.length < 4 || !clean.every((c) => /[a-z]/i.test(c.slice(prefix.length)))) prefix = '';
    }
    return clean.map((c) => {
        const rest = prefix ? c.slice(prefix.length).replace(/^[\s\-–—:,.()]+/, '').trim() : c;
        const label = rest || c;
        return label.charAt(0).toUpperCase() + label.slice(1);
    });
}
