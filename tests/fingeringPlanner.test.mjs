import test from 'node:test';
import assert from 'node:assert/strict';
import { planFingering } from '../src/utils/fingeringPlanner.js';
import { applyScoreAdaptation, restoreScoreAdaptation } from '../src/utils/tabAdapter.js';

const STD = [64, 59, 55, 50, 45, 40]; // highest string first
const EB = [63, 58, 54, 49, 44, 39];

// helper: a unit from [stringIndexOnTab, fret] pairs written for E standard, mapped straight across (k = 0)
const unitOf = (pairs, extra = {}) => ({
    notes: pairs.map(([i, fret], q) => ({ pitch: STD[i] + fret, staticJ: i, srcFretted: fret > 0, ...(extra[q] || {}) }))
});
const span = (placed) => {
    const f = placed.filter(x => x.fret > 0).map(x => x.fret);
    return f.length ? Math.max(...f) - Math.min(...f) : 0;
};

test('notes that already fit stay on their string', () => {
    const units = [unitOf([[0, 3], [5, 0]]), unitOf([[1, 2]]), unitOf([[2, 0], [4, 2]])];
    const { units: out, folded } = planFingering({ units, player: STD });
    assert.equal(folded, 0);
    out.forEach((placed, ui) => placed.forEach((p, q) => {
        assert.equal(p.j, units[ui].notes[q].staticJ);
        assert.equal(p.fret, units[ui].notes[q].pitch - STD[p.j]);
    }));
});

test('an open string inside a high-position chord does not stretch the hand when the guitar is tuned down', () => {
    // E standard tab: fret 5 on the high E with the open D below it. A half step down, the open D becomes fret 1,
    // which would stretch a hand sitting at fret 6 over five frets.
    const units = [unitOf([[0, 5], [3, 0]])];
    const { units: out } = planFingering({ units, player: EB });
    assert.ok(span(out[0]) <= 3, `span was ${span(out[0])}`);
    out[0].forEach((p, q) => assert.equal(EB[p.j] + p.fret, units[0].notes[q].pitch)); // pitch kept, no fold
});

test('a displaced note stays near the hand instead of jumping to the nut or a far position', () => {
    // A phrase around fret 7 with one open string. Capo 2 removes the open G, so it needs a fretted G3 elsewhere.
    const phrase = [
        unitOf([[1, 7]]), unitOf([[2, 7]]), unitOf([[2, 0], [0, 7]]), unitOf([[1, 8]]), unitOf([[2, 7]])
    ];
    const { units: out } = planFingering({ units: phrase, player: STD, capo: 2 });
    const pos = out.map(placed => { const f = placed.filter(x => x.fret > 0).map(x => x.fret); return f.length ? Math.min(...f) : null; })
        .filter(x => x !== null);
    for (let i = 1; i < pos.length; i++) assert.ok(Math.abs(pos[i] - pos[i - 1]) <= 4, `hand jumped ${pos[i - 1]} -> ${pos[i]}`);
});

test('open strings carry the hand position through instead of resetting it', () => {
    const units = [unitOf([[1, 7]]), unitOf([[5, 0]]), unitOf([[1, 8]])];
    const { units: out } = planFingering({ units, player: STD });
    assert.equal(out[1][0].fret, 0);
    assert.equal(out[0][0].j, 1);
    assert.equal(out[2][0].j, 1);
});

test('a chord that cannot be fingered folds an inner voice before the bass', () => {
    // G2 B2 D3 G3 with a capo at 2: the four notes need more strings than are low enough
    const units = [{ notes: [[55 - 12, 0], [47, 0], [50, 0], [55, 0]].map(([pitch], q) => ({ pitch, staticJ: 5 - q, srcFretted: false })) }];
    const { units: out, folded } = planFingering({ units, player: STD, capo: 2 });
    assert.ok(folded >= 1);
    const bass = out[0][0];
    assert.equal(bass.shift, 0, 'the bass note must not be folded');
    assert.equal(new Set(out[0].map(p => p.j)).size, 4, 'every note on its own string');
});

test('a tied note stays on the string of the note it continues', () => {
    const units = [unitOf([[1, 7]], [{ id: 'a' }]), unitOf([[0, 5], [1, 7]], { 1: { id: 'b', linkId: 'a' } })];
    const { units: out } = planFingering({ units, player: EB });
    assert.equal(out[1][1].j, out[0][0].j);
    assert.equal(out[1][1].fret, out[0][0].fret);
});

test('pinned notes (harmonics) keep their string and fret, and other notes avoid that string', () => {
    const units = [{ notes: [
        { pitch: 64 + 12, staticJ: 0, srcFretted: true, fixed: { j: 0, fret: 12 } },
        { pitch: 64, staticJ: 0, srcFretted: false }
    ] }];
    const { units: out } = planFingering({ units, player: STD });
    assert.deepEqual([out[0][0].j, out[0][0].fret], [0, 12]);
    assert.notEqual(out[0][1].j, 0);
});

test('a note no string can reach is parked and counted, not dropped', () => {
    const units = [{ notes: [{ pitch: 10, staticJ: 0, srcFretted: false }] }];
    const { units: out, folded } = planFingering({ units, player: STD });
    assert.equal(out[0].length, 1);
    assert.equal(folded, 1);
});

test('empty input and empty units are fine', () => {
    assert.deepEqual(planFingering({ units: [], player: STD }).units, []);
    assert.equal(planFingering({ units: [{ notes: [] }], player: STD }).units[0].length, 0);
});

// ---- through the real adapter, with a minimal score
function mockScore(bars) {
    const staff = {
        bars: bars.map(beats => ({ voices: [{ beats: beats.map((notes, i) => ({ playbackStart: i * 960, notes: notes.map(([i2, fret]) => ({ string: 6 - i2, fret, isStringed: true })) })) }] })),
        capo: 0,
        stringTuning: { tunings: [...STD], name: 'E Standard', finish() {} }
    };
    return { tracks: [{ name: 'Guitar', staves: [staff], tuning: [...STD], playbackInfo: {} }] };
}

test('applyScoreAdaptation keeps every sounding pitch, stays inside the fret range, and restores cleanly', () => {
    const bars = [
        [[[0, 5], [3, 0]], [[1, 7]], [[2, 7], [5, 0]], [[0, 3]]],
        [[[1, 8]], [[0, 5], [4, 0]], [[3, 0]], [[2, 9], [5, 3]]]
    ];
    const score = mockScore(bars);
    const original = bars.flat().map(b => b.map(([i, f]) => STD[i] + f));
    for (const [name, method] of [['Eb Standard', 'shift'], ['D Standard', 'shift'], ['Drop D', 'shift'], ['E Standard', 'capo']]) {
        const sum = applyScoreAdaptation(score, { enabled: true, tuningName: name, method, capo: 2 }, 'guitar');
        assert.ok(sum, name);
        const staff = score.tracks[0].staves[0];
        const tun = staff.stringTuning.tunings;
        const sounded = staff.bars.flatMap(b => b.voices[0].beats).map(b => b.notes.map(n => tun[tun.length - n.string] + staff.capo + n.fret));
        sounded.forEach((chord, bi) => chord.forEach((pitch, q) => {
            if (sum.unplayable === 0) assert.equal(pitch, original[bi][q], `${name} beat ${bi}`);
        }));
        for (const b of staff.bars.flatMap(b => b.voices[0].beats)) for (const n of b.notes) assert.ok(n.fret >= 0 && n.fret + staff.capo <= 24);
    }
    restoreScoreAdaptation(score, 'guitar');
    const back = score.tracks[0].staves[0].bars.flatMap(b => b.voices[0].beats).map(b => b.notes.map(n => STD[6 - n.string] + n.fret));
    assert.deepEqual(back, original);
});
