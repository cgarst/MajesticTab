// classtab/midiReader.js
// Standard MIDI file -> alphaTab MidiFile, so a MIDI file can play through the same SoundFont synth as a score.
// alphaTab has no MIDI reader of its own. Reads the header, running status, note on/off, controllers, programs,
// pitch bend and tempo; sysex and other meta events are skipped.
// The result is a single-track file with every event on track 0 and the original channels kept: alphaTab 1.8.4's
// MidiFile.events getter recurses forever on a multi-track file, so a type 1 file is merged, never mapped track for track.

const FALLBACK_AT = {
    midi: {
        MidiFile: class { constructor() { this.events = []; } addEvent(e) { this.events.push(e); } },
        MidiFileFormat: { SingleTrackMultiChannel: 0 },
        TempoChangeEvent: class { constructor(tick, usq) { this.tick = tick; this.usq = usq; } },
        TimeSignatureEvent: class { constructor(tr, tick, num, den) { this.tick = tick; this.num = num; this.den = den; } },
        NoteOnEvent: class { constructor(tr, tick, ch, pitch, vel) { this.tick = tick; this.ch = ch; this.pitch = pitch; this.vel = vel; } },
        NoteOffEvent: class { constructor(tr, tick, ch, pitch, vel) { this.tick = tick; this.ch = ch; this.pitch = pitch; this.vel = vel; } },
        ControlChangeEvent: class { constructor(tr, tick, ch, ctrl, val) { this.tick = tick; this.ch = ch; this.ctrl = ctrl; this.val = val; } },
        ProgramChangeEvent: class { constructor(tr, tick, ch, prog) { this.tick = tick; this.ch = ch; this.prog = prog; } },
        PitchBendEvent: class { constructor(tr, tick, ch, val) { this.tick = tick; this.ch = ch; this.val = val; } },
        AlphaTabMetronomeEvent: class { constructor(tr, tick, counter, beat, len) { this.tick = tick; this.counter = counter; this.beat = beat; this.len = len; } }
    }
};

/**
 * @param {Uint8Array} b @param {object} [at] the alphaTab namespace (globalThis.alphaTab in the app)
 * @returns {{
 *   file: object,
 *   clicks: Array<{ ms: number, accent: boolean }>,
 *   notes: Array<{ tick: number, ms: number, ch: number, pitch: number }>,
 *   bars: Array<{ index: number, startTick: number, endTick: number, startMs: number, endMs: number, beats: number, num: number, den: number }>,
 *   primaryBpm: number,
 *   initialTimeSig: { num: number, den: number } | null
 * }}
 */
export function readMidiFile(b, at = globalThis.alphaTab || FALLBACK_AT) {
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
    const tempos = [];
    const sigs = [];
    const rawNotes = [];
    let lastTick = 0;
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
                if (type === 0x51 && len === 3) {
                    const usq = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
                    add(tick, new midi.TempoChangeEvent(tick, usq));
                    tempos.push({ tick, usq });
                    events++;
                } else if (type === 0x58 && len >= 2) {
                    const num = b[p];
                    const den = b[p + 1];
                    add(tick, new midi.TimeSignatureEvent(0, tick, num, den, 24, 8));
                    sigs.push({ tick, num, den });
                }
                p += len;
            } else if (status === 0xf0 || status === 0xf7) {
                p += vlq();
            } else {
                const kind = status >> 4;
                const ch = status & 15;
                const d1 = b[p++];
                const d2 = kind === 12 || kind === 13 ? 0 : b[p++];
                if (kind === 9 && d2 > 0) {
                    add(tick, new midi.NoteOnEvent(0, tick, ch, d1, d2));
                    rawNotes.push({ tick, ch, pitch: d1 });
                }
                else if (kind === 8 || kind === 9) add(tick, new midi.NoteOffEvent(0, tick, ch, d1, d2));
                else if (kind === 11) add(tick, new midi.ControlChangeEvent(0, tick, ch, d1, d2));
                else if (kind === 12) add(tick, new midi.ProgramChangeEvent(0, tick, ch, d1));
                else if (kind === 14) add(tick, new midi.PitchBendEvent(0, tick, ch, d1 | (d2 << 7)));
                else continue;
                events++;
            }
        }
        p = end;
        lastTick = Math.max(lastTick, tick);
    }
    const hadExplicitSig = sigs.length > 0;
    const { clicks, bars, millis, primaryBpm } = addClickAndBars(list, add, midi, division, tempos, sigs, lastTick);
    const initialTimeSig = hadExplicitSig
        ? { num: sigs[0].num, den: Math.max(1, 2 ** sigs[0].den) }
        : null;
    rawNotes.sort((a, b) => a.tick - b.tick);
    const notes = rawNotes.map(n => ({
        tick: n.tick,
        ms: millis(0, n.tick),
        ch: n.ch,
        pitch: n.pitch
    }));
    list.sort((x, y) => x.tick - y.tick || x.n - y.n);
    for (const { ev } of list) file.addEvent(ev);
    if (!events) throw new Error('That MIDI file has no notes.');
    return { file, clicks, notes, bars, primaryBpm, initialTimeSig, division, lastTick, millis };
}

/**
 * The metronome and the count-in of alphaTab's synth play from metronome events it writes into the MIDI it makes from a
 * score; a MIDI file has none. Write one per beat (the beat is the time signature's unit, and the first beat of each
 * bar counts 0 so it is accented), and a time signature at the start for the count-in's length. AlphaTab's own
 * metronome events play late above 100% speed, so they are not what is heard: the returned click list is, scheduled by
 * gpPlayer. The events stay because AlphaTab's bar math still reads them.
 */
function addClickAndBars(list, add, midi, division, tempos, sigs, lastTick) {
    tempos.sort((x, y) => x.tick - y.tick);
    sigs.sort((x, y) => x.tick - y.tick);
    if (!sigs.length || sigs[0].tick > 0) {
        sigs.unshift({ tick: 0, num: 4, den: 2 });
        add(0, new midi.TimeSignatureEvent(0, 0, 4, 2, 24, 8));
    }
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usq: 500000 });
    // Milliseconds of a span of ticks, through the tempo changes inside it
    const millis = (from, to) => {
        let ms = 0;
        for (let i = 0; i < tempos.length; i++) {
            const a = Math.max(from, tempos[i].tick);
            const z = Math.min(to, i + 1 < tempos.length ? tempos[i + 1].tick : Infinity);
            if (z > a) ms += ((z - a) / division) * (tempos[i].usq / 1000);
        }
        return ms;
    };

    // Compute duration-weighted median BPM so trailing ritardandos don't skew the piece's primary tempo
    const end = lastTick + 1;
    const tempoSpans = [];
    let totalWeight = 0;
    for (let i = 0; i < tempos.length; i++) {
        const a = tempos[i].tick;
        const z = Math.min(end, i + 1 < tempos.length ? tempos[i + 1].tick : end);
        if (z > a && tempos[i].usq > 0) {
            const durTicks = z - a;
            const bpm = Math.round(60000000 / tempos[i].usq);
            tempoSpans.push({ bpm, weight: durTicks });
            totalWeight += durTicks;
        }
    }
    let primaryBpm = 120;
    if (tempoSpans.length > 0) {
        tempoSpans.sort((a, b) => a.bpm - b.bpm);
        let acc = 0;
        for (const sp of tempoSpans) {
            acc += sp.weight;
            primaryBpm = sp.bpm;
            if (acc >= totalWeight * 0.5) break;
        }
    }

    const clicks = [];
    const bars = [];
    for (let i = 0; i < sigs.length; i++) {
        const { tick: start, num, den } = sigs[i];
        const stop = Math.min(end, i + 1 < sigs.length ? sigs[i + 1].tick : end);
        const beat = Math.max(1, Math.round((division * 4) / 2 ** den));
        const beatsPerBar = Math.max(1, num);
        const barTicks = beat * beatsPerBar;
        let counter = 0;
        let ms = millis(0, start);
        for (let t = start; t < stop; t += beat) {
            const len = millis(t, t + beat);
            add(t, new midi.AlphaTabMetronomeEvent(0, t, counter, beat, len));
            clicks.push({ ms, accent: counter === 0 });
            if (counter === 0) {
                const bEndTick = Math.min(stop, t + barTicks);
                bars.push({
                    index: bars.length,
                    startTick: t,
                    endTick: bEndTick,
                    startMs: ms,
                    endMs: millis(0, bEndTick),
                    beats: beatsPerBar,
                    num: beatsPerBar,
                    den: 2 ** den
                });
            }
            ms += len;
            counter = (counter + 1) % beatsPerBar;
        }
    }
    return { clicks, bars, millis, primaryBpm };
}

/**
 * Builds a silent alphaTab MidiFile + metronome click list for the steady Bar-Paced Clock
 * (used on MIDI-less staff tabs and when Sound -> Hear is set to "Silent (scroll only)").
 *
 * @param {Array<{ startMs: number, endMs: number, beats?: number }>} barTimeline
 * @param {{ num: number, den: number }} timeSig
 * @param {number} baseBpm
 * @param {object} [at]
 * @returns {{ file: object, clicks: Array<{ ms: number, accent: boolean }>, bars: Array<any>, primaryBpm: number, initialTimeSig: { num: number, den: number } }}
 */
export function createSilentMidiFile(barTimeline, timeSig = { num: 4, den: 4 }, baseBpm = 100, at = globalThis.alphaTab || FALLBACK_AT) {
    const { midi } = at;
    const division = 960;
    const file = new midi.MidiFile();
    file.division = division;
    file.format = midi.MidiFileFormat.SingleTrackMultiChannel;

    const num = Math.max(1, timeSig?.num || 4);
    const den = Math.max(1, timeSig?.den || 4);
    const denPow = Math.max(1, Math.round(Math.log2(den)));
    const bpm = Math.max(20, Math.min(320, Math.round(baseBpm || 100)));
    // Quarter-note microseconds
    const usq = Math.round(60000000 / bpm);
    const beatTicks = Math.max(1, Math.round((division * 4) / (2 ** denPow)));
    const beatMs = (beatTicks / division) * (usq / 1000);

    file.addEvent(new midi.TimeSignatureEvent(0, 0, num, denPow, 24, 8));
    file.addEvent(new midi.TempoChangeEvent(0, usq));

    const clicks = [];
    const bars = [];
    let curTick = 0;
    let curMs = 0;

    const totalBars = Array.isArray(barTimeline) && barTimeline.length > 0
        ? barTimeline
        : [{ beats: num }];

    for (let bIdx = 0; bIdx < totalBars.length; bIdx++) {
        const bItem = totalBars[bIdx];
        const beatsInBar = Math.max(1, Math.round(bItem.beats || num));
        const barStartTick = curTick;
        const barStartMs = curMs;
        for (let c = 0; c < beatsInBar; c++) {
            file.addEvent(new midi.AlphaTabMetronomeEvent(0, curTick, c, beatTicks, beatMs));
            clicks.push({ ms: curMs, accent: c === 0 });
            curTick += beatTicks;
            curMs += beatMs;
        }
        bars.push({
            index: bIdx,
            startTick: barStartTick,
            endTick: curTick,
            startMs: barStartMs,
            endMs: curMs,
            beats: beatsInBar,
            num: beatsInBar,
            den
        });
    }

    // Add a silent anchor event at the final tick so alphaTab's sequencer spans the full duration
    file.addEvent(new midi.ControlChangeEvent(0, curTick, 0, 7, 0));
    file.addEvent(new midi.NoteOffEvent(0, curTick, 0, 60, 0));

    return {
        file,
        clicks,
        bars,
        notes: [],
        primaryBpm: bpm,
        initialTimeSig: { num, den }
    };
}
