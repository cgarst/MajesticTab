// extendedRangeChords.js
// Chord voicings for 7-string and 8-string guitars, powered by chords-db datasets in src/chordDb/.

import { getNormalizedChordList } from './utils/chordEngine.js';

export async function getChordData7() {
    return getNormalizedChordList(7);
}

export async function getChordData8() {
    return getNormalizedChordList(8);
}

export default { getChordData7, getChordData8 };
