// Repairs chord voicings that fail check.mjs: `node support/tools/chord-voicings/repair.mjs [--apply]`
// Without --apply it only prints what it would change. Run check.mjs afterwards.
//
// For each row that plays notes outside its chord or can't be played by a hand:
//  1. 7- and 8-string rows first try muting the extra low strings.
//  2. Otherwise the six standard strings are searched for the closest valid, playable voicing: fewest changed
//     strings, then most strings sounded, then the root in the bass (a fifth only if no root-bass voicing exists),
//     then the smallest move. Open rows (barreChord 0) search frets 0 to 5, barre rows stay within a few frets of
//     startFret and never use open strings; if nothing fits the window is widened once.
//  3. 7- and 8-string rows then try to use the extra low strings again (see enrichExtraStrings).
//
// Extra-string rule: the new low notes are the root or the fifth (the fifth only with the root directly above it),
// at most one muted string may sit between an open low string and the shape, fretted additions must stay within the
// hand's reach, and nothing may break playability.
import { readFileSync, writeFileSync } from 'node:fs';
import { referenceLibraryPath, extendedRangePath } from './data.mjs';
import { TUNINGS, fifthTones, isValidVoicing, relativePitches, splitChordName } from './rules.mjs';
import { analysePlayability } from './playability.mjs';

const apply = process.argv.includes('--apply');
const ROW = /^(    \{ name: ')([^']+)(', cat: ')([^']+)(', frets: ')([^']+)(', startFret: )(\d+)(, barreChord: )(\d)(, default: )(\d)( \},?)$/;
const STANDARD = TUNINGS[6];

const isGoodSix = (name, frets) => isValidVoicing(name, frets.join(' '), STANDARD) && analysePlayability(frets).ok;

/** Closest valid, playable voicing for the six standard strings, or null. */
function searchSixStrings(name, original, barreChord, startFret) {
  const open = barreChord === 0;
  for (const wide of [false, true]) {
    const low = open ? 0 : Math.max(1, startFret - (wide ? 3 : 1));
    const high = open ? (wide ? 7 : 5) : startFret + (wide ? 6 : 4);
    const options = ['x', ...Array.from({ length: high - low + 1 }, (_, k) => String(low + k)).filter(f => open || f !== '0')];
    for (const allowFifthBass of [false, true]) {
      let best = null;
      const frets = [];
      const search = string => {
        if (string === 6) {
          const sounded = frets.filter(f => f !== 'x');
          if (sounded.length < 4 || !isGoodSix(name, frets)) return;
          const bass = relativePitches(name, frets.join(' '), STANDARD).pitches.find(p => p !== null);
          if (!(bass === 0 || (allowFifthBass && bass === 7))) return;
          const edits = frets.filter((f, i) => f !== original[i]).length;
          const distance = frets.reduce((sum, f, i) => sum + (f !== 'x' && original[i] !== 'x' ? Math.abs(f - original[i]) : 0), 0);
          const score = [edits, -sounded.length, bass === 0 ? 0 : 1, distance];
          if (!best || score.some((x, k) => score.slice(0, k).every((y, j) => y === best.score[j]) && x < best.score[k] && x !== best.score[k])) best = { frets: [...frets], score };
          return;
        }
        for (const option of options) {
          frets[string] = option;
          search(string + 1);
        }
      };
      search(0);
      if (best) return best.frets;
    }
  }
  return null;
}

/** Adds root or fifth notes on the extra low strings of a 7- or 8-string voicing. Returns the new frets or null. */
function enrichExtraStrings(name, six, strings, allowOpen) {
  const extra = strings - 6;
  const tuning = TUNINGS[strings];
  const { quality } = relativePitches(name, [...Array(extra).fill('x'), ...six].join(' '), tuning);
  const fifths = fifthTones(splitChordName(name).suffix).filter(p => quality.allowed.includes(p));
  const fretted = six.filter(f => f !== 'x' && Number(f) > 0).map(Number);
  const lowestSix = six.findIndex(f => f !== 'x') + extra;
  if (lowestSix < extra) return null;
  const options = ['x', ...(allowOpen ? ['0'] : []), ...Array.from({ length: 7 }, (_, k) => String(k + 1))];
  let best = null;
  const added = [];
  const search = string => {
    if (string === extra) {
      const sounded = added.map((f, k) => (f === 'x' ? -1 : k)).filter(k => k >= 0);
      if (!sounded.length) return;
      const all = [...added, ...six];
      const newlyFretted = added.filter(f => f !== 'x' && f !== '0').map(Number);
      const reach = [...fretted, ...newlyFretted];
      if (reach.length && Math.max(...reach) - Math.min(...reach) > 3) return;
      const { pitches } = relativePitches(name, all.join(' '), tuning);
      if (!sounded.every(k => pitches[k] === 0 || fifths.includes(pitches[k]))) return;
      const bass = pitches.findIndex(p => p !== null);
      if (pitches[bass] !== 0 && pitches[pitches.findIndex((p, k) => k > bass && p !== null)] !== 0) return;
      const gap = lowestSix - (Math.max(...sounded) + 1);
      const onlyOpen = added.every(f => f === 'x' || f === '0');
      if (gap > 0 && !(onlyOpen && gap <= 1)) return;
      if (sounded.length > 1 && sounded[sounded.length - 1] - sounded[0] + 1 !== sounded.length) return;
      if (!isValidVoicing(name, all.join(' '), tuning) || !analysePlayability(all).ok) return;
      const opens = added.filter(f => f === '0').length;
      const score = [sounded.length, opens, -newlyFretted.reduce((a, b) => a + b, 0), pitches[bass] === 0 ? 1 : 0];
      if (!best || score.some((x, k) => score.slice(0, k).every((y, j) => y === best.score[j]) && x > best.score[k])) best = { all, score };
      return;
    }
    for (const option of options) {
      added[string] = option;
      search(string + 1);
    }
  };
  search(0);
  return best && best.all;
}

const startFretFor = (frets, old) => {
  if (frets.includes('0')) return 1;
  const lowest = Math.min(...frets.filter(f => f !== 'x').map(Number));
  return old > lowest ? lowest : old;
};

function repairBlock(lines, strings) {
  const changes = [];
  const unresolved = [];
  const tuning = TUNINGS[strings];
  const extra = strings - 6;
  const rows = lines.map(line => {
    const m = line.match(ROW);
    if (!m) return line;
    const [, a, name, b, cat, c, fretString, d, start, e, barre, f, isDefault, g] = m;
    const frets = fretString.split(' ');
    if (analysePlayability(frets).ok && isValidVoicing(name, fretString, tuning)) return line;
    const six = frets.slice(extra);
    let repaired = extra && isGoodSix(name, six) ? six : searchSixStrings(name, six, Number(barre), Number(start));
    if (!repaired) {
      unresolved.push(`${name} ${fretString}`);
      return line;
    }
    let all = [...Array(extra).fill('x'), ...repaired];
    if (extra) all = enrichExtraStrings(name, repaired, strings, barre === '0') || all;
    changes.push(`${name.padEnd(10)} ${fretString.padEnd(18)} -> ${all.join(' ')}`);
    return a + name + b + cat + c + all.join(' ') + d + startFretFor(all, Number(start)) + e + barre + f + isDefault + g;
  });
  return { rows, changes, unresolved };
}

const files = { [referenceLibraryPath]: readFileSync(referenceLibraryPath, 'utf8'), [extendedRangePath]: readFileSync(extendedRangePath, 'utf8') };
for (const [file, header, strings] of [
  [referenceLibraryPath, 'export const chordData = [', 6],
  [extendedRangePath, 'export const chordData7 = [', 7],
  [extendedRangePath, 'export const chordData8 = [', 8],
]) {
  const text = files[file];
  const start = text.indexOf(header);
  const end = text.indexOf('\n];', start);
  const { rows, changes, unresolved } = repairBlock(text.slice(start, end).split('\n'), strings);
  files[file] = text.slice(0, start) + rows.join('\n') + text.slice(end);
  console.log(`${strings}-string: ${changes.length} to change, ${unresolved.length} unresolved`);
  changes.forEach(change => console.log(`  ${change}`));
  unresolved.forEach(row => console.log(`  UNRESOLVED ${row}`));
}
if (apply) for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
else console.log('\nDry run, nothing written. Pass --apply to write the changes.');
