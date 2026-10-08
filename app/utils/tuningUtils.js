// tuningUtils.js
// Helpers for parsing, formatting, and detecting guitar tunings from score data and text.

const KNOWN_TUNINGS = [
    { name: 'Standard (E A D G B E)', shortName: 'E Standard', midi: [64, 59, 55, 50, 45, 40], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'] },
    { name: 'Drop D (D A D G B E)', shortName: 'Drop D', midi: [64, 59, 55, 50, 45, 38], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'D2'] },
    { name: 'Eb Standard (Eb Ab Db Gb Bb Eb)', shortName: 'Eb Standard', midi: [63, 58, 54, 49, 44, 39], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Eb2'] },
    { name: 'Drop Db (Db Ab Db Gb Bb Eb)', shortName: 'Drop Db', midi: [63, 58, 54, 49, 44, 37], strings: ['Eb4', 'Bb3', 'Gb3', 'Db3', 'Ab2', 'Db2'] },
    { name: 'D Standard (D G C F A D)', shortName: 'D Standard', midi: [62, 57, 53, 48, 43, 38], strings: ['D4', 'A3', 'F3', 'C3', 'G2', 'D2'] },
    { name: 'Drop C (C G C F A D)', shortName: 'Drop C', midi: [62, 57, 53, 48, 43, 36], strings: ['D4', 'A3', 'F3', 'C3', 'G2', 'C2'] },
    { name: 'C# Standard (C# F# B E G# C#)', shortName: 'C# Standard', midi: [61, 56, 52, 47, 42, 37], strings: ['C#4', 'G#3', 'E3', 'B2', 'F#2', 'C#2'] },
    { name: 'Drop B (B F# B E G# C#)', shortName: 'Drop B', midi: [61, 56, 52, 47, 42, 35], strings: ['C#4', 'G#3', 'E3', 'B2', 'F#2', 'B1'] },
    { name: 'C Standard (C F Bb Eb G C)', shortName: 'C Standard', midi: [60, 55, 51, 46, 41, 36], strings: ['C4', 'G3', 'Eb3', 'Bb2', 'F2', 'C2'] },
    { name: 'Drop A# (A# F A# D# G C)', shortName: 'Drop A#', midi: [60, 55, 51, 46, 41, 34], strings: ['C4', 'G3', 'Eb3', 'Bb2', 'F2', 'Bb1'] },
    { name: 'B Standard (B E A D F# B)', shortName: 'B Standard', midi: [59, 54, 50, 45, 40, 35], strings: ['B3', 'F#3', 'D3', 'A2', 'E2', 'B1'] },
    { name: 'Drop A (A E A D F# B)', shortName: 'Drop A', midi: [59, 54, 50, 45, 40, 33], strings: ['B3', 'F#3', 'D3', 'A2', 'E2', 'A1'] },
    { name: 'Open D (D A D F# A D)', shortName: 'Open D', midi: [62, 57, 54, 50, 45, 38], strings: ['D4', 'A3', 'F#3', 'D3', 'A2', 'D2'] },
    { name: 'Open G (D G D G B D)', shortName: 'Open G', midi: [62, 59, 55, 50, 43, 38], strings: ['D4', 'B3', 'G3', 'D3', 'G2', 'D2'] },
    { name: 'DADGAD (D A D G A D)', shortName: 'DADGAD', midi: [62, 57, 55, 50, 45, 38], strings: ['D4', 'A3', 'G3', 'D3', 'A2', 'D2'] },
    // 7-String
    { name: '7-String Standard (B E A D G B E)', shortName: '7-String Standard', midi: [64, 59, 55, 50, 45, 40, 35], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1'] },
    { name: '7-String Drop A (A E A D G B E)', shortName: '7-String Drop A', midi: [64, 59, 55, 50, 45, 40, 33], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'A1'] },
    // 8-String
    { name: '8-String Standard (F# B E A D G B E)', shortName: '8-String Standard', midi: [64, 59, 55, 50, 45, 40, 35, 30], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'F#1'] },
    { name: '8-String Drop E (E B E A D G B E)', shortName: '8-String Drop E', midi: [64, 59, 55, 50, 45, 40, 35, 28], strings: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2', 'B1', 'E1'] },
    // Bass (4-string)
    { name: 'Bass Standard (E A D G)', shortName: 'Bass Standard', midi: [43, 38, 33, 28], strings: ['G2', 'D2', 'A1', 'E1'] },
    { name: 'Bass Drop D (D A D G)', shortName: 'Bass Drop D', midi: [43, 38, 33, 26], strings: ['G2', 'D2', 'A1', 'D1'] },
    // Bass (5-string)
    { name: '5-String Bass (B E A D G)', shortName: '5-String Bass', midi: [43, 38, 33, 28, 23], strings: ['G2', 'D2', 'A1', 'E1', 'B0'] },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNoteName(midiNumber) {
    if (typeof midiNumber !== 'number' || isNaN(midiNumber)) return '';
    const note = NOTE_NAMES[midiNumber % 12];
    const octave = Math.floor(midiNumber / 12) - 1;
    return `${note}${octave}`;
}

export function formatTuningFromMidi(midiArray) {
    if (!Array.isArray(midiArray) || midiArray.length === 0) return null;

    // Normalize order (highest to lowest or lowest to highest)
    const normalized = [...midiArray];
    if (normalized[0] < normalized[normalized.length - 1]) {
        normalized.reverse();
    }

    for (const known of KNOWN_TUNINGS) {
        if (known.midi.length === normalized.length) {
            let match = true;
            for (let i = 0; i < normalized.length; i++) {
                if (normalized[i] !== known.midi[i]) {
                    match = false;
                    break;
                }
            }
            if (match) return known.shortName || known.name;
        }
    }

    // Format custom notes (e.g. "E A D G B E")
    const notes = normalized.map(m => NOTE_NAMES[m % 12]).reverse().join(' ');
    return notes;
}

export function extractScoreTunings(score) {
    if (!score || !Array.isArray(score.tracks)) return [];
    const tunings = new Set();

    for (const track of score.tracks) {
        if (track.tuning && Array.isArray(track.tuning) && track.tuning.length >= 4) {
            const formatted = formatTuningFromMidi(track.tuning);
            if (formatted) tunings.add(formatted);
        } else if (track.tuningName) {
            tunings.add(track.tuningName);
        }
    }

    return Array.from(tunings);
}

export function inferTuningFromTextOrName(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    if (lower.includes('drop c#') || lower.includes('drop db')) return 'Drop Db';
    if (lower.includes('drop c')) return 'Drop C';
    if (lower.includes('drop b')) return 'Drop B';
    if (lower.includes('drop a#') || lower.includes('drop bb')) return 'Drop A#';
    if (lower.includes('drop a')) return 'Drop A';
    if (lower.includes('drop d')) return 'Drop D';
    if (lower.includes('eb standard') || lower.includes('half step down') || lower.includes('1/2 step down') || lower.includes('d# standard')) return 'Eb Standard';
    if (lower.includes('d standard') || lower.includes('one step down') || lower.includes('1 step down') || lower.includes('whole step down')) return 'D Standard';
    if (lower.includes('c# standard') || lower.includes('db standard')) return 'C# Standard';
    if (lower.includes('c standard')) return 'C Standard';
    if (lower.includes('b standard')) return 'B Standard';
    if (lower.includes('7 string') || lower.includes('7-string')) return '7-String Standard';
    if (lower.includes('8 string') || lower.includes('8-string')) return '8-String Standard';
    if (lower.includes('dadgad')) return 'DADGAD';
    if (lower.includes('open d')) return 'Open D';
    if (lower.includes('open g')) return 'Open G';
    if (lower.includes('standard')) return 'E Standard';

    return null;
}
