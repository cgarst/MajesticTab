// classtab/midiReader.js
// Standard MIDI file -> alphaTab MidiFile, so a MIDI file can play through the same SoundFont synth as a score.
// alphaTab has no MIDI reader of its own. Reads the header, running status, note on/off, controllers, programs,
// pitch bend and tempo; sysex and other meta events are skipped.
// The result is a single-track file with every event on track 0 and the original channels kept: alphaTab 1.8.4's
// MidiFile.events getter recurses forever on a multi-track file, so a type 1 file is merged, never mapped track for track.

/** @param {Uint8Array} b @param {object} at the alphaTab namespace (globalThis.alphaTab in the app) */
export function readMidiFile(b, at = globalThis.alphaTab) {
    const { midi } = at;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 0;
    const tag = () => { const s = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]); p += 4; return s; };
    if (b.length < 14 || tag() !== 'MThd') throw new Error('Not a MIDI file.');
    p += 4;
    const tracks = dv.getUint16(p + 2);
    const division = dv.getUint16(p + 4);
    p += 6;
    if (division & 0x8000) throw new Error('This MIDI file uses time-code timing.');
    const file = new midi.MidiFile();
    file.division = division;
    file.format = midi.MidiFileFormat.SingleTrackMultiChannel;
    const vlq = () => { let v = 0; let c; do { c = b[p++]; v = (v << 7) | (c & 127); } while (c & 128 && p < b.length); return v; };
    // Collected first and added in tick order: alphaTab's sequencer builds its timeline from the tick difference between
    // consecutive events, so a type 1 file added track after track gives it negative differences and a broken clock
    const list = [];
    const add = (tick, ev) => list.push({ tick, n: list.length, ev });
    let events = 0;
    for (let t = 0; t < tracks && p + 8 <= b.length; t++) {
        if (tag() !== 'MTrk') break;
        const end = Math.min(p + 4 + dv.getUint32(p), b.length);
        p += 4;
        let tick = 0;
        let running = 0;
        while (p < end) {
            tick += vlq();
            let status = b[p];
            if (status & 128) { p++; if (status < 0xf0) running = status; } else status = running;
            if (status === 0xff) {
                const type = b[p++];
                const len = vlq();
                if (type === 0x51 && len === 3) { add(tick, new midi.TempoChangeEvent(tick, (b[p] << 16) | (b[p + 1] << 8) | b[p + 2])); events++; }
                p += len;
            } else if (status === 0xf0 || status === 0xf7) {
                p += vlq();
            } else {
                const kind = status >> 4;
                const ch = status & 15;
                const d1 = b[p++];
                const d2 = kind === 12 || kind === 13 ? 0 : b[p++];
                if (kind === 9 && d2 > 0) add(tick, new midi.NoteOnEvent(0, tick, ch, d1, d2));
                else if (kind === 8 || kind === 9) add(tick, new midi.NoteOffEvent(0, tick, ch, d1, d2));
                else if (kind === 11) add(tick, new midi.ControlChangeEvent(0, tick, ch, d1, d2));
                else if (kind === 12) add(tick, new midi.ProgramChangeEvent(0, tick, ch, d1));
                else if (kind === 14) add(tick, new midi.PitchBendEvent(0, tick, ch, d1 | (d2 << 7)));
                else continue;
                events++;
            }
        }
        p = end;
    }
    list.sort((x, y) => x.tick - y.tick || x.n - y.n);
    for (const { ev } of list) file.addEvent(ev);
    if (!events) throw new Error('That MIDI file has no notes.');
    return file;
}
