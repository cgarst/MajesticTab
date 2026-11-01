// Pitch rules for the chord library voicings (src/referenceLibrary.js `chordData`, src/extendedRangeChords.js).
//
// A voicing is a space-separated fret string, lowest string first ('x' mutes, '0' is open). It is valid for a
// chord when every sounded note belongs to the chord, the root is present, the third is present (except for
// sus chords) and the notes that define the chord type are present.
// Chord names are root + suffix, e.g. 'B♭maj7-11'; roots use ♯ and ♭ (C♯ E♭ F♯ A♭ B♭).

// Open-string pitch classes, lowest string first (C = 0)
export const TUNINGS = {
  6: [4, 9, 2, 7, 11, 4], // E A D G B E
  7: [11, 4, 9, 2, 7, 11, 4], // B E A D G B E
  8: [6, 11, 4, 9, 2, 7, 11, 4], // F♯ B E A D G B E
};

export const ROOT_PITCH = {
  C: 0, 'C♯': 1, D: 2, 'E♭': 3, E: 4, F: 5, 'F♯': 6, G: 7, 'A♭': 8, A: 9, 'B♭': 10, B: 11,
};

// Per suffix: `allowed` semitones above the root a voicing may sound, `signature` tones that must be present
// (an array means any one of them), and `noThird` for chords that replace the third.
// '-11' means ♯11 and '-13' means 13; 9ths are allowed as extra colour on those chords.
export const QUALITIES = {
  '': { allowed: [0, 4, 7], signature: [] },
  m: { allowed: [0, 3, 7], signature: [] },
  maj7: { allowed: [0, 4, 7, 11], signature: [11] },
  maj9: { allowed: [0, 2, 4, 7, 11], signature: [2, 11] },
  'maj7-11': { allowed: [0, 2, 4, 5, 6, 7, 11], signature: [11, [5, 6]] },
  'maj7-13': { allowed: [0, 2, 4, 7, 9, 11], signature: [11, 9] },
  6: { allowed: [0, 4, 7, 9], signature: [9] },
  7: { allowed: [0, 4, 7, 10], signature: [10] },
  9: { allowed: [0, 2, 4, 7, 10], signature: [2, 10] },
  '7-11': { allowed: [0, 2, 4, 5, 6, 7, 10], signature: [10, [5, 6]] },
  '7-13': { allowed: [0, 2, 4, 7, 9, 10], signature: [10, 9] },
  m6: { allowed: [0, 3, 7, 9], signature: [9] },
  m7: { allowed: [0, 3, 7, 10], signature: [10] },
  m9: { allowed: [0, 2, 3, 7, 10], signature: [2, 10] },
  'm7-11': { allowed: [0, 2, 3, 5, 7, 10], signature: [10, 5] },
  'm7-13': { allowed: [0, 2, 3, 5, 7, 9, 10], signature: [10, 9] },
  dim: { allowed: [0, 3, 6], signature: [6] },
  dim7: { allowed: [0, 3, 6, 9], signature: [6, 9] },
  aug: { allowed: [0, 4, 8], signature: [8] },
  '7(-5)': { allowed: [0, 4, 6, 10], signature: [6, 10] },
  '6/9': { allowed: [0, 2, 4, 7, 9], signature: [2, 9] },
  sus2: { allowed: [0, 2, 7], signature: [2], noThird: true },
  sus4: { allowed: [0, 5, 7], signature: [5], noThird: true },
  '7sus2': { allowed: [0, 2, 7, 10], signature: [2, 10], noThird: true },
  '7sus4': { allowed: [0, 5, 7, 10], signature: [5, 10], noThird: true },
  add9: { allowed: [0, 2, 4, 7], signature: [2] },
  madd9: { allowed: [0, 2, 3, 7], signature: [2] },
};

export function splitChordName(name) {
  const [, root, suffix] = name.match(/^([A-G][♯♭]?)(.*)$/);
  return { root, suffix };
}

/** The chord's quality entry plus each string's pitch class relative to the root (null when muted). */
export function relativePitches(name, frets, tuning) {
  const { root, suffix } = splitChordName(name);
  const rootPitch = ROOT_PITCH[root];
  return {
    quality: QUALITIES[suffix],
    pitches: frets.split(' ').map((fret, i) => (fret === 'x' ? null : (tuning[i] + Number(fret) - rootPitch + 120) % 12)),
  };
}

/** Which tone counts as the fifth for a chord type (the bass note may be the root or the fifth). */
export function fifthTones(suffix) {
  if (['dim', 'dim7', '7(-5)'].includes(suffix)) return [6];
  if (suffix === 'aug') return [8];
  return [7];
}

export function isValidVoicing(name, frets, tuning) {
  const { quality, pitches } = relativePitches(name, frets, tuning);
  if (!quality) return false;
  const sounded = pitches.filter(p => p !== null);
  if (sounded.length < 3) return false;
  if (!sounded.every(p => quality.allowed.includes(p))) return false;
  if (!sounded.includes(0)) return false;
  if (!quality.noThird && !(sounded.includes(3) || sounded.includes(4))) return false;
  return quality.signature.every(tone => (Array.isArray(tone) ? tone.some(t => sounded.includes(t)) : sounded.includes(tone)));
}
