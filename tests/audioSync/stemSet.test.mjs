// tests/audioSync/stemSet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMutedIds, getMutedIds, setMutedIds, resetMutedIds, stemsOfMeta, createStemSource, applyMutes, loadRecordingPeaks, loadRecordingFlux } from '../../src/audioSync/stemSet.js';
import { stemSetOf, stemGroupOf } from '../../src/mpak.js';
import { metaOfPackRecording, setRecordingMeta, listRecordingMeta, tracksNote } from '../../src/audioSync/recordingMeta.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const stems = [
    { audioId: 'g1', label: 'Guitar 1', instrument: 'guitar' }, { audioId: 'g2', label: 'Guitar 2', instrument: 'guitar' },
    { audioId: 'b', label: 'Bass', instrument: 'bass' }, { audioId: 'd', label: 'Drums', instrument: 'drums' },
];

test('Original starts with every stem, Backing without the guitars (without the bass in bass mode)', () => {
    assert.deepEqual(defaultMutedIds(stems, 'original'), []);
    assert.deepEqual(defaultMutedIds(stems, 'backing'), ['g1', 'g2']);
    assert.deepEqual(defaultMutedIds(stems, 'backing', 'bass'), ['b']);
});

test('the person\'s choice is kept per sound and beats the default; reset brings the default back', () => {
    const s = store();
    assert.deepEqual(getMutedIds('Song', 'backing', stems, 'guitar', s), ['g1', 'g2']);
    setMutedIds('Song', 'backing', ['g1', 'g2', 'd', 'gone'], s);
    assert.deepEqual(getMutedIds('Song', 'backing', stems, 'guitar', s), ['g1', 'g2', 'd']); // an id the set lost is dropped
    assert.deepEqual(getMutedIds('Song', 'original', stems, 'guitar', s), []);
    setMutedIds('Song', 'backing', [], s); // an empty choice is a choice: everything heard
    assert.deepEqual(getMutedIds('Song', 'backing', stems, 'guitar', s), []);
    resetMutedIds('Song', 'backing', s);
    assert.deepEqual(getMutedIds('Song', 'backing', stems, 'guitar', s), ['g1', 'g2']);
});

const rec = (id, extra = {}) => ({ id, role: 'stem', label: id, sources: [{ type: 'file', path: `audio/${id}.flac` }], stem: { instrument: id }, ...extra });

test('a pack of only stems is a stem set, led by the stem with sync points', () => {
    const set = stemSetOf({ recordings: [rec('guitar', { sync: { s: 'x.json' } }), rec('bass', { syncFrom: 'guitar' }), rec('drums', { syncFrom: 'guitar' })] });
    assert.equal(set.lead.id, 'guitar');
    assert.equal(set.members.length, 3);
    assert.equal(stemSetOf({ recordings: [rec('guitar', { sync: { s: 'x' } })] }), null);
    // stems of a mix that has no audio of its own (a video, or the score's sound) are the song's audio: they are the set
    const noFile = stemSetOf({ recordings: [{ id: 'mix', role: 'original', sources: [{ type: 'youtube', videoId: 'lUBCXGeK694' }] }, rec('a', { stemOf: 'mix' }), rec('b', { stemOf: 'mix' })] });
    assert.deepEqual(noFile.members.map((m) => m.id), ['a', 'b']);
    // with a mix file of its own, the mix is the Original and the stems are not the only sound
    assert.equal(stemSetOf({ recordings: [{ id: 'mix', role: 'original', sources: [{ type: 'file', path: 'audio/mix.mp3' }] }, rec('a', { stemOf: 'mix' }), rec('b', { stemOf: 'mix' })] }), null);
});

test('a stem set with a backing track of its own is still a stem set, and the backing stays the backing', () => {
    const backing = { id: 'backing', role: 'backing', sources: [{ type: 'file', path: 'audio/backing.mp3' }] };
    const set = stemSetOf({ recordings: [rec('guitar', { sync: { s: 'x.json' } }), rec('bass', { syncFrom: 'guitar' }), backing] });
    assert.equal(set?.lead.id, 'guitar');
    assert.deepEqual(set.members.map((m) => m.id), ['guitar', 'bass']);
    // an original with a file is a full mix, so the stems are not the only sound; an alternate file sits beside the set
    assert.equal(stemSetOf({ recordings: [rec('a'), rec('b'), { id: 'x', role: 'original', sources: [{ type: 'file', path: 'audio/x.mp3' }] }] }), null);
    assert.deepEqual(stemSetOf({ recordings: [rec('a'), rec('b'), { id: 'x', role: 'alternate', sources: [{ type: 'file', path: 'audio/x.mp3' }] }] }).members.map((m) => m.id), ['a', 'b']);
});

test('the set rides on the lead\'s meta, and the instrument on each stem\'s', () => {
    assert.equal(metaOfPackRecording(rec('bass'), 0).instrument, 'bass');
    const s = store();
    setRecordingMeta('Song', { kind: 'local', audioId: 'g1' }, { role: 'original', label: 'All stems', stems }, s);
    const meta = listRecordingMeta('Song', s).local_g1;
    assert.equal(stemsOfMeta(meta).length, 4);
    assert.equal(tracksNote(meta), '4 stems');
    assert.equal(stemsOfMeta({ stems: [stems[0]] }), null);
});

test('every part of a stem source can be muted, and the mutes are applied together', async () => {
    const mk = () => ({ currentTime: 0, state: 'running', destination: {}, gains: [],
        createGain() { const g = { gain: { value: 1 }, connect() {}, disconnect() {} }; this.gains.push(g); return g; },
        createBufferSource() { return { playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {} }; },
        async resume() {}, async decodeAudioData(b) { return { duration: b.byteLength }; } });
    const f = (id) => ({ id, name: id, type: 'audio/flac', data: new ArrayBuffer(60), durationMs: 60000 });
    const src = createStemSource({ lead: f('g1'), others: [f('b'), f('d')] }, { context: mk(), loadStretcher: async () => class { constructor() { this.playbackRate = {}; this.pitch = {}; } connect() {} disconnect() {} } });
    await src.ready();
    await applyMutes(src, ['g1', 'd']);
    assert.deepEqual(src.parts().map((p) => [p.id, p.enabled]), [['g1', false], ['b', true], ['d', false]]);
    await applyMutes(src, []);
    assert.deepEqual(src.parts().map((p) => p.enabled), [true, true, true]);
    src.destroy();
});

test('loadRecordingPeaks and loadRecordingFlux combine every stem in a set', async () => {
    const s = store();
    setRecordingMeta('Song', { kind: 'local', audioId: 'g1' }, { role: 'original', label: 'All stems', stems }, s);
    const peaksById = { g1: new Uint8Array([10, 0]), g2: new Uint8Array([0, 20]), b: new Uint8Array([30, 40]) };
    const combinedPeaks = await loadRecordingPeaks('Song', { kind: 'local', audioId: 'g1' }, {
        storage: s,
        getMeta: async (id) => (peaksById[id] ? { peaks: peaksById[id] } : null),
    });
    assert.deepEqual([...combinedPeaks], [40, 60]);

    const standalonePeaks = await loadRecordingPeaks('Song', { kind: 'local', audioId: 'solo' }, {
        storage: s,
        getMeta: async () => ({ peaks: new Uint8Array([7, 8]) }),
    });
    assert.deepEqual([...standalonePeaks], [7, 8]);

    let activeDecodes = 0;
    let maxConcurrent = 0;
    const fluxById = { g1: Float32Array.from([1, 0]), b: Float32Array.from([0, 2]), d: Float32Array.from([3, 4]) };
    const combinedFlux = await loadRecordingFlux('Song', { kind: 'local', audioId: 'g1' }, {
        storage: s,
        getFile: async (id) => (fluxById[id] ? { data: id } : null),
        decode: async (id) => {
            activeDecodes += 1;
            maxConcurrent = Math.max(maxConcurrent, activeDecodes);
            await Promise.resolve();
            activeDecodes -= 1;
            return fluxById[id];
        },
    });
    assert.equal(maxConcurrent, 1); // decodes one stem at a time
    assert.deepEqual([...combinedFlux], [4, 6]);
});

test('stems beside a full mix of their own are not the song\'s only sound, but they are still one group', () => {
    const mix = { id: 'x', role: 'original', sources: [{ type: 'file', path: 'audio/x.mp3' }] };
    const recs = [rec('a', { sync: { s: 'a.json' } }), rec('b', { syncFrom: 'a' }), mix];
    assert.equal(stemSetOf({ recordings: recs }), null, 'the mix keeps the Original slot');
    const group = stemGroupOf({ recordings: recs });
    assert.deepEqual(group.members.map((m) => m.id), ['a', 'b']);
    assert.equal(group.lead.id, 'a');
    assert.equal(stemGroupOf({ recordings: [rec('a'), mix] }), null, 'one stem is not a group');
    // stems that name the mix they were split from are the same group (the link to the mix is kept on the lead, see applyMpakExtras)
    const split = stemGroupOf({ recordings: [mix, rec('a', { stemOf: 'x' }), rec('b', { stemOf: 'x' })] });
    assert.deepEqual(split.members.map((m) => m.id), ['a', 'b']);
    assert.equal(stemSetOf({ recordings: [mix, rec('a', { stemOf: 'x' }), rec('b', { stemOf: 'x' })] }), null, 'and the mix keeps the Original');
    assert.deepEqual(stemGroupOf({ recordings: [rec('a'), rec('b')] }).members.map((m) => m.id), ['a', 'b'], 'with no mix it is the set');
});
