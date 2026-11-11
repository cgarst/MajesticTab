// Physical playability model for chord voicings: four fretting fingers, bars, no thumb.
//
//  - A finger can lie across several strings only at one fret. A bar may not pass over a string that is open or
//    held at a lower fret (the highest fret pressed decides the pitch, so the bar would fret or raise it).
//    Strings fretted higher up, or muted, may sit under a bar.
//  - Every bar run needs its own finger, assigned in fret order (index, middle, ring, pinky), skipping fingers is
//    allowed (the G chord uses index, middle and pinky). At most four runs.
//  - The index finger bars any width, the middle and ring fingers at most 4 strings wide, the pinky never.
//  - Fingers k apart sit at most 3k strings apart and reach at most k + 1 frets apart.
//  - Using all four fingers together with a stretch (a finger reaching further than its distance from its
//    neighbour) is rejected.
//  - The fretted notes fit in a five-fret reach.
//
// The model rejects shapes that cannot be played; it does not rate comfort. check.mjs keeps a list of
// well-known shapes that must always pass, so loosening or tightening a rule shows up there first.

const permutations = items => (items.length < 2
  ? [items]
  : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest])));

// Every way to give `count` runs rising finger numbers from 1 to `max`
const handings = (max, count, from = 1) => (count === 0
  ? [[]]
  : Array.from({ length: max - from + 1 }, (_, i) => from + i).flatMap(finger => handings(max, count - 1, finger + 1).map(rest => [finger, ...rest])));

const MAX_BAR_WIDTH = { 1: 8, 2: 4, 3: 4, 4: 1 };

/**
 * @param {string[]} frets fret strings, lowest string first ('x' for muted)
 * @returns {{ ok: boolean, reasons: string[], runs: { fret: number, strings: number[] }[], fingers: number, span: number, stretch: number }}
 */
export function analysePlayability(frets) {
  const fretNumbers = frets.map(f => (f === 'x' ? NaN : parseInt(f, 10)));
  const stringsByFret = new Map();
  fretNumbers.forEach((fret, i) => {
    if (fret > 0) stringsByFret.set(fret, [...(stringsByFret.get(fret) || []), i]);
  });

  // Split each fret's strings into runs one finger can bar: a lower or open string in between cuts a run
  const runsByFret = [...stringsByFret.entries()].sort((a, b) => a[0] - b[0]).map(([fret, strings]) => {
    const runs = [];
    let current = null;
    for (const string of strings) {
      const blocked = current && fretNumbers.slice(current[current.length - 1] + 1, string).some(other => other < fret);
      if (current && !blocked) current.push(string);
      else {
        current = [string];
        runs.push({ fret, strings: current });
      }
    }
    return runs;
  });
  const runs = runsByFret.flat();

  const frettedFrets = [...stringsByFret.keys()];
  const span = frettedFrets.length ? Math.max(...frettedFrets) - Math.min(...frettedFrets) : 0;
  const reasons = [];
  let stretch = 0;
  if (runs.length > 4) reasons.push(`${runs.length} fingers`);
  if (span > 4) reasons.push(`${span + 1}-fret reach`);

  if (!reasons.length) {
    const stringGap = (a, b) => Math.min(...a.strings.flatMap(x => b.strings.map(y => Math.abs(x - y))));
    // Runs at the same fret may be played by either finger, so try every order
    const orders = runsByFret.reduce((acc, group) => acc.flatMap(prefix => permutations(group).map(p => [...prefix, ...p])), [[]]);
    let bestStretch = Infinity;
    for (const order of orders) {
      for (const hand of handings(4, runs.length)) {
        if (order.some((run, i) => run.strings[run.strings.length - 1] - run.strings[0] + 1 > MAX_BAR_WIDTH[hand[i]])) continue;
        let reachable = true;
        for (let i = 0; i < order.length && reachable; i++) {
          for (let j = i + 1; j < order.length; j++) {
            if (stringGap(order[i], order[j]) > 3 * (hand[j] - hand[i])) reachable = false;
            if (order[j].fret - order[i].fret > hand[j] - hand[i] + 1) reachable = false;
          }
        }
        if (!reachable) continue;
        let handStretch = 0;
        for (let i = 1; i < order.length; i++) handStretch += Math.max(0, order[i].fret - order[i - 1].fret - (hand[i] - hand[i - 1]));
        bestStretch = Math.min(bestStretch, handStretch);
      }
    }
    if (bestStretch === Infinity) reasons.push('fingers too far apart');
    else {
      stretch = bestStretch;
      if (runs.length >= 4 && stretch >= 1) reasons.push('four fingers and a stretch');
    }
  }
  return { ok: reasons.length === 0, reasons, runs, fingers: runs.length, span, stretch };
}
