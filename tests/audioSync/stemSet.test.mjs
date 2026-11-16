// tests/audioSync/stemSet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMutedIds, getMutedIds, setMutedIds, resetMutedIds, stemsOfMeta, createStemSource, applyMutes } from '../../src/audioSync/stemSet.js';
import { stemSetOf } from '../../src/mpak.js';
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
    assert.equal(stemSetOf({ recordings: [{ id: 'mix', role: 'original', sources: [] }, rec('a', { stemOf: 'mix' }), rec('b', { stemOf: 'mix' })] }), null);
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
