// chordShapeDefaults.js
// The default movable shape of each chord type, per root string (the lowest string it sounds), written as frets
// relative to the lowest fret (1 is the lowest, x is muted) on the top six strings of the guitar.
//
// Taken from the moveable chord shapes pages of Chord Options (chordoptions.com, a one-person project): the root
// position shape listed for each root string of each chord type. Its chord data is published under CC BY 4.0
// (attribution, with a link back to the site); the common shapes it lists come from chords-db (MIT License,
// David Rubert) and carry that license. Only the fret patterns of those default root position shapes were taken;
// its inversions, drops, tensions and descriptions were left out.

export const DEFAULT_SHAPES = {
    '11': { 0: '1 1 1 2 1 1', 1: 'x 1 1 1 3 1', 2: 'x x 1 1 2 1' },
    '13': { 0: '1 x 1 2 3 x', 1: 'x 1 x 1 3 3' },
    '5': { 0: '1 3 3 x x x', 1: 'x 1 3 3 x x', 2: 'x x 1 3 4 x', 3: 'x x x 1 4 4' },
    '6': { 0: '1 3 3 2 3 x', 1: 'x 1 3 3 3 3', 2: 'x x 1 3 1 3' },
    '69': { 0: '2 1 1 1 2 x', 1: 'x 2 1 1 2 2', 2: 'x x 2 1 2 2' },
    '7': { 0: '1 3 1 2 1 1', 1: 'x 1 3 1 3 1', 2: 'x x 1 3 2 3' },
    '7b5': { 0: '1 2 1 2 x x', 1: 'x 1 2 1 3 x', 2: 'x x 1 2 2 3' },
    '7b9': { 0: '1 3 1 2 1 2', 1: 'x 2 1 2 1 x', 2: 'x x 2 1 3 1' },
    '7sharp9': { 0: '1 3 1 2 4 4', 1: 'x 2 1 2 3 x', 2: 'x x 2 1 3 3' },
    '7sus4': { 0: '1 3 1 3 1 1', 1: 'x 1 3 1 4 1', 2: 'x x 1 3 2 4' },
    '9': { 0: '2 1 2 1 x x', 1: 'x 2 1 2 2 x', 2: 'x x 2 1 3 2' },
    '9b5': { 0: '2 1 2 1 1 2', 1: 'x 2 1 2 2 1' },
    '9sharp11': { 0: '1 2 1 2 1 1', 1: 'x 1 2 1 3 x', 2: 'x x 1 2 2 3' },
    add9: { 1: 'x 4 3 1 4 x', 2: 'x x 3 2 1 3' },
    alt: { 0: '1 x 1 2 2 2', 1: 'x 2 1 2 1 1' },
    aug: { 0: '1 x 3 2 2 1', 1: 'x 1 4 3 3 x', 2: 'x x 1 4 4 3', 3: 'x x x 2 2 1' },
    aug7: { 0: '1 4 1 2 2 x', 1: 'x 1 4 1 3 2', 2: 'x x 1 4 2 3' },
    aug9: { 0: '2 1 2 1 3 x', 1: 'x 2 1 2 2 3' },
    dim: { 0: '1 2 3 1 x x', 1: 'x 1 2 3 2 x', 2: 'x x 1 2 4 2', 3: 'x x x 4 3 1' },
    dim7: { 0: '1 2 3 1 3 1', 1: 'x 2 3 1 3 1', 2: 'x x 1 2 1 2' },
    m11: { 0: '1 1 1 1 1 x', 1: 'x 1 1 1 2 1', 2: 'x x 1 1 2 2' },
    m6: { 0: '1 3 3 1 3 1', 1: 'x 1 3 x 2 3', 2: 'x x 1 3 1 2' },
    m69: { 0: '1 x 3 1 3 3' },
    m7: { 0: '1 3 1 1 1 1', 1: 'x 1 3 1 2 1', 2: 'x x 1 3 2 2' },
    m7b5: { 0: '1 2 3 1 4 1', 1: 'x 1 2 1 2 x', 2: 'x x 1 2 2 2' },
    m9: { 0: '1 3 1 1 1 3', 1: 'x 3 1 3 3 x', 2: 'x x 3 1 4 3' },
    madd9: { 0: '4 2 1 3 x x', 1: 'x 4 2 1 4 x', 2: 'x x 3 1 1 3' },
    maj11: { 0: '1 1 2 2 1 1', 1: 'x 1 1 2 3 1', 2: 'x x 1 1 3 3' },
    maj13: { 0: '1 x 2 2 3 x', 1: 'x 1 x 2 3 3' },
    maj7: { 0: '1 x 2 2 1 x', 1: 'x 1 3 2 3 1', 2: 'x x 1 3 3 3' },
    maj7b5: { 0: '1 2 2 2 x 1', 1: 'x 1 2 2 3 x', 2: 'x x 1 2 3 3' },
    maj7sharp5: { 0: '1 x 2 2 2 1', 1: 'x 1 4 2 3 x', 2: 'x x 1 4 3 3' },
    maj9: { 0: '2 1 3 1 2 1', 1: 'x 2 1 3 2 x', 2: 'x x 2 1 4 2' },
    major: { 0: '1 3 3 2 1 1', 1: 'x 1 3 3 3 1', 2: 'x x 1 3 4 3' },
    minor: { 0: '1 3 3 1 1 1', 1: 'x 1 3 3 2 1', 2: 'x x 1 3 4 2' },
    mmaj11: { 0: '1 1 2 1 1 3', 1: 'x 1 1 2 2 1' },
    mmaj7: { 0: '1 3 2 1 1 x', 1: 'x 1 3 2 2 1', 2: 'x x 1 3 3 2' },
    mmaj7b5: { 0: '1 2 2 1 x 1', 1: 'x 1 2 2 2 x', 2: 'x x 1 2 3 2' },
    mmaj9: { 0: '3 1 x 2 3 2' },
    sus2: { 0: '1 3 3 x 1 3', 1: 'x 1 3 3 1 1', 2: 'x x 1 3 4 1' },
    sus2sus4: { 0: '1 1 3 3 1 3', 1: 'x 1 1 3 1 1' },
    sus4: { 0: '1 3 3 3 1 1', 1: 'x 1 3 3 4 1', 2: 'x x 3 3 1 1', 3: 'x x x 3 4 1' },
};
