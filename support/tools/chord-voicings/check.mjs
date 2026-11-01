// Checks the chord library data: `node support/tools/chord-voicings/check.mjs`
// Exits with 1 when any voicing is wrong. Run it after touching chordData, chordData7 or chordData8, and after
// changing rules.mjs or playability.mjs (the well-known shapes below must keep passing).
//
// Per set it checks that every voicing: has one fret per string, plays only notes of its chord (rules.mjs), can be
// played by a hand (playability.mjs) and is unique per chord. Per chord it checks there is exactly one default row,
// and that the three sets list the same chords.
import { loadChordSets } from './data.mjs';
import { TUNINGS, isValidVoicing, splitChordName } from './rules.mjs';
import { analysePlayability } from './playability.mjs';

// Shapes every player knows. If one of these is rejected the playability model is too strict.
const WELL_KNOWN_SHAPES = {
  C: 'x 3 2 0 1 0', G: '3 2 0 0 0 3', D: 'x x 0 2 3 2', A: 'x 0 2 2 2 0', E: '0 2 2 1 0 0', Am: 'x 0 2 2 1 0',
  Em: '0 2 2 0 0 0', Dm: 'x x 0 2 3 1', F: '1 3 3 2 1 1', Bm: 'x 2 4 4 3 2', 'B♭': 'x 1 3 3 3 1', B7: 'x 2 1 2 0 2',
  E7: '0 2 0 1 0 0', A7: 'x 0 2 0 2 0', C7: 'x 3 2 3 1 0', G7: '3 2 0 0 0 1', Cmaj7: 'x 3 2 0 0 0',
  Fmaj7: 'x x 3 2 1 0', Am7: 'x 0 2 0 1 0', Dm7: 'x x 0 2 1 1', Gmaj7: '3 2 0 0 0 2', Cadd9: 'x 3 2 0 3 0',
  Dsus4: 'x x 0 2 3 3', Asus2: 'x 0 2 2 0 0', D7: 'x x 0 2 1 2', F7: '1 3 1 2 1 1', Bdim: 'x 2 3 4 3 x',
  'B♭7(-5)': 'x 1 2 1 3 x', 'F♯m': '2 4 4 2 2 2', Fm: '1 3 3 1 1 1', C9: 'x 3 2 3 3 3', E9: '0 2 0 1 0 2',
  Em7: '0 2 0 0 0 0', Cm: 'x 3 5 5 4 3', G6: '3 2 0 0 0 0', E6: '0 2 2 1 2 0', Am9: '5 7 5 5 5 7',
};

const problems = [];
const report = (set, message) => problems.push(`${set}-string: ${message}`);

for (const [name, frets] of Object.entries(WELL_KNOWN_SHAPES)) {
  const { ok, reasons } = analysePlayability(frets.split(' '));
  if (!ok) problems.push(`well-known shape ${name} ${frets} rejected: ${reasons.join(', ')}`);
}

const sets = await loadChordSets();
const chordNames = {};
for (const [strings, chords] of Object.entries(sets)) {
  const tuning = TUNINGS[strings];
  const seen = new Set();
  const defaults = new Map();
  for (const chord of chords) {
    const label = `${chord.name} ${chord.frets}`;
    const frets = chord.frets.split(' ');
    if (frets.length !== Number(strings)) { report(strings, `${label} has ${frets.length} strings`); continue; }
    if (!isValidVoicing(chord.name, chord.frets, tuning)) report(strings, `${label} plays notes outside the chord`);
    const playability = analysePlayability(frets);
    if (!playability.ok) report(strings, `${label} can't be played (${playability.reasons.join(', ')})`);
    if (seen.has(label)) report(strings, `${label} is listed twice`);
    seen.add(label);
    const key = `${chord.name}|${chord.cat}`;
    defaults.set(key, (defaults.get(key) || 0) + chord.default);
  }
  for (const [key, count] of defaults) if (count !== 1) report(strings, `${key} has ${count} default rows`);
  chordNames[strings] = new Set(chords.map(c => c.name));
}
for (const strings of ['7', '8']) {
  for (const name of chordNames['6']) if (!chordNames[strings].has(name)) report(strings, `${name} is missing`);
  for (const name of chordNames[strings]) if (!chordNames['6'].has(name)) report(strings, `${name} is not in the 6-string set`);
}

const counts = Object.entries(sets).map(([strings, chords]) => `${strings}-string ${chords.length}`).join(', ');
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) (${counts})`);
  process.exit(1);
}
console.log(`Chord voicings OK (${counts}, ${Object.keys(WELL_KNOWN_SHAPES).length} well-known shapes)`);
