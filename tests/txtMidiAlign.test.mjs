import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBlocks } from '../src/textProcessor/textBlocks.js';
import {
    bpmFromHeaderText,
    tempoWordFromHeaderText,
    timeSigFromHeaderText,
    timeSigFromRuler,
    resolveTabTempoAndMeter
} from '../src/classtab/tabTempoMeta.js';
import { readMidiFile, createSilentMidiFile } from '../src/classtab/midiReader.js';
import { openStringPitchClasses, unfoldVisualBars, alignTxtAndMidi } from '../src/classtab/txtMidiAlign.js';

test('tabTempoMeta extracts BPM, tempo words, and time signatures from headers and beat rulers', () => {
    assert.equal(bpmFromHeaderText('Tempo: 108 bpm\nTime Signature: 3/4')?.bpm, 108);
    assert.equal(bpmFromHeaderText('MM = 84')?.bpm, 84);
    assert.deepEqual(bpmFromHeaderText('q. = 66'), { bpm: 66, beatUnit: 'dotted-quarter', rawBpm: 66 });

    const w = tempoWordFromHeaderText('Andante religioso\nTuning: DADGBE');
    assert.equal(w?.bpm, 76);

    assert.deepEqual(timeSigFromHeaderText('Time signature: 6/8'), { num: 6, den: 8 });
    assert.deepEqual(timeSigFromHeaderText('Meter: C'), { num: 4, den: 4 });

    const lines = [
        '   | . | . | .   | . | . | . ',
        'E|---0---2---3-|---0---2---3-|',
        'B|-------------|-------------|',
        'G|-------------|-------------|',
        'D|-------------|-------------|',
        'A|-0-----------|-0-----------|',
        'E|-------------|-------------|'
    ];
    const blocks = groupBlocks(lines);
    assert.deepEqual(timeSigFromRuler(blocks), { num: 3, den: 4 });

    const resolved = resolveTabTempoAndMeter({
        headerText: 'Allegretto\nTuning: Standard',
        blocks
    });
    assert.equal(resolved.bpm, 112);
    assert.equal(resolved.bpmSource, 'header-word');
    assert.deepEqual(resolved.timeSig, { num: 3, den: 4 });
    assert.equal(resolved.timeSigSource, 'ruler');
});

test('unfoldVisualBars unfolds repeat brackets, 1st/2nd endings, and detects pickup bars', () => {
    const lines = [
        'E|--0-|*-----2-----3-----|-----5-----7----*|-----8-----7-----|',
        'B|----|*-----------------|----------------*|-----------------|',
        'G|----|*-----------------|----------------*|-----------------|',
        'D|----|*-----------------|----------------*|-----------------|',
        'A|----|*--0--------------|--0-------------*|--0--------------|',
        'E|----|*-----------------|----------------*|-----------------|'
    ];
    const blocks = groupBlocks(lines);
    const { visualBars, unfoldedBars } = unfoldVisualBars(blocks);

    assert.equal(visualBars.length, 4);
    assert.equal(visualBars[0].isPickup, true);
    assert.equal(unfoldedBars.length > visualBars.length, true);
    // Pickup (0), then repeated bars (1, 2, 1, 2), then ending bar (3)
    assert.deepEqual(unfoldedBars.map(u => u.visualBar.visualIndex), [0, 1, 2, 1, 2, 3]);
});

test('alignTxtAndMidi Tier C builds a steady Bar-Paced Clock and createSilentMidiFile generates matching clicks', () => {
    const lines = [
        'Tempo: 120 bpm',
        'Time Signature: 3/4',
        '',
        'E|---0---2---3-|---5---3---2-|---0---------|',
        'B|-------------|-------------|-------1-----|',
        'G|-------------|-------------|-----------2-|',
        'D|-------------|-------------|-------------|',
        'A|-0-----------|-0-----------|-0-----------|',
        'E|-------------|-------------|-------------|'
    ];
    const blocks = groupBlocks(lines);
    const tempoMeta = resolveTabTempoAndMeter({ headerText: lines.slice(0, 3).join('\n'), blocks });
    const alignment = alignTxtAndMidi({
        blocks,
        midiData: null,
        baseBpm: tempoMeta.bpm,
        beatUnit: tempoMeta.beatUnit,
        timeSig: tempoMeta.timeSig,
        mode: 'silent'
    });

    assert.equal(alignment.tier, 'C');
    assert.equal(alignment.points.length, 3);
    assert.equal(alignment.barTimeline.length, 3);
    // At 120 bpm in 3/4, each bar is 3 * 500ms = 1500ms
    assert.equal(alignment.barTimeline[0].startMs, 0);
    assert.equal(alignment.barTimeline[1].startMs, 1500);
    assert.equal(alignment.barTimeline[2].startMs, 3000);
    assert.equal(alignment.totalDurationMs, 4500);

    const silentMidi = createSilentMidiFile(alignment.barTimeline, tempoMeta.timeSig, tempoMeta.bpm);
    assert.equal(silentMidi.clicks.length, 9); // 3 bars * 3 beats
    assert.equal(silentMidi.clicks[0].accent, true);
    assert.equal(silentMidi.clicks[1].accent, false);
    assert.equal(silentMidi.clicks[3].accent, true);
});

test('alignTxtAndMidi Tier A aligns tab bars against a synthesized MIDI note sequence via pitch-class DTW', () => {
    const lines = [
        'E|---0---------|---1---------|---3---------|',
        'B|-------1-----|-------3-----|-------0-----|',
        'G|-----------2-|-----------2-|-----------0-|',
        'D|-------------|-------------|-------------|',
        'A|-0-----------|-5-----------|-------------|',
        'E|-------------|-------------|-3-----------|'
    ];
    const blocks = groupBlocks(lines);

    // Construct a 3-bar MIDI metadata object matching the 3 chords (Am, Dm, G)
    const midiData = {
        primaryBpm: 100,
        initialTimeSig: { num: 4, den: 4 },
        notes: [
            { tick: 0, pitch: 45 }, { tick: 100, pitch: 60 }, { tick: 200, pitch: 64 },
            { tick: 3840, pitch: 50 }, { tick: 3940, pitch: 65 }, { tick: 4040, pitch: 69 },
            { tick: 7680, pitch: 43 }, { tick: 7780, pitch: 59 }, { tick: 7880, pitch: 67 }
        ],
        bars: [
            { index: 0, startTick: 0, endTick: 3840, startMs: 0, endMs: 2400, beats: 4 },
            { index: 1, startTick: 3840, endTick: 7680, startMs: 2400, endMs: 4800, beats: 4 },
            { index: 2, startTick: 7680, endTick: 11520, startMs: 4800, endMs: 7200, beats: 4 }
        ]
    };

    const alignment = alignTxtAndMidi({ blocks, midiData, baseBpm: 100, mode: 'midi' });
    assert.equal(alignment.tier, 'A');
    assert.equal(alignment.points.length, 3);
    assert.equal(alignment.points[0].timeMs, 0);
    assert.equal(alignment.points[1].timeMs, 2400);
    assert.equal(alignment.points[2].timeMs, 4800);
});
