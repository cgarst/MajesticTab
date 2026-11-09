// sectionKinds.js
// What kind of section a name is, whatever way the file wrote it: "Chorus 2", "chorus (0:41)", "Pre Chorus",
// "Estribillo", "Guitar Solo" all say what they are. Pure: no DOM, no AlphaTab.
//
// The word lists come from reading the section marks of a few hundred real tabs: about nine in ten named
// marks are one of these words, in English, Spanish, French or Italian. A name that says none of them (a
// lyric line, a cue like "choir enters", a movement title) has no kind and stays plain: a kind is never
// guessed. The earliest naming word wins, so "Intro Solo" is an intro and "Guitar Solo (Transition)" a solo;
// "pre chorus" is read as a pair before "chorus" is, so a Pre-Chorus is never a Chorus.
//
// `family` is what the ruler colours by: six families, so a song's chorus looks the same in every file.

export const FAMILIES = ['verse', 'chorus', 'bridge', 'solo', 'bookend', 'instrumental'];

const WORDS = [
    ['chorus', 'pre-chorus', /^(pre ?chorus|prechorus|pre ?estribillo|build ?up|buildup)$/],
    ['chorus', 'post-chorus', /^(post ?chorus|postchorus)$/],
    ['verse', 'pre-verse', /^(pre ?verse|preverse|pre ?verso)$/],
    ['chorus', 'chorus', /^(chorus|estribillo|refrain|refran|coro|ritornello|hook)$/],
    ['verse', 'verse', /^(verse|verso|strophe|strofa|estrofa|couplet|stanza)$/],
    ['bridge', 'bridge', /^(bridge|puente|pont|brucke|ponte|middle 8|middle eight)$/],
    ['solo', 'solo', /^(solo|soli|solos|improv|improvisation|cadenza)$/],
    ['bookend', 'intro', /^(intro|introduction|introduccion|opening|prelude)$/],
    ['bookend', 'outro', /^(outro|outtro|ending|end|coda|finale|closing|conclusion)$/],
    ['instrumental', 'interlude', /^(interlude|interludio|instrumental|transition|link|passage|segue|intermezzo|vamp)$/],
    ['instrumental', 'riff', /^(riff|lick|motif|theme|ostinato|groove)$/],
    ['instrumental', 'break', /^(break|breakdown|tag|turnaround)$/]
];

function normalize(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** { family, kind } for a section name, or null when the name does not say what it is. */
export function sectionKind(name) {
    const t = normalize(name).split(' ');
    for (let i = 0; i < t.length; i++) {
        for (const span of [2, 1]) {
            if (i + span > t.length) continue;
            const w = t.slice(i, i + span).join(' ');
            for (const [family, kind, re] of WORDS) if (re.test(w)) return { family, kind };
        }
    }
    return null;
}
