import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenStemLayer, nestStemLayer, recordingSources, stemsOf } from '../../src/mpak/stemLayer.js';
import { expectedFiles } from '../../src/storage/packStore.js';

const file = (path) => ({ type: 'file', path });
const nested = () => [
    { id: 'mix', role: 'original', stemsComplete: true, sync: { tab: 'sync/mix.json' }, sources: [file('audio/mix.mp3'), { type: 'youtube', videoId: 'lUBCXGeK694' }],
      stems: [{ id: 'gtr', label: 'Guitar', stem: { instrument: 'guitar', track: 0 }, sources: [file('audio/gtr.mp3')] }, { id: 'bass', sources: [file('audio/bass.mp3')] }] },
    { id: 'live', role: 'live', sources: [] },
];

test('a stem layer is read as stems that name their mix, after it, and written back as a stem layer', () => {
    const flat = flattenStemLayer(nested());
    assert.deepEqual(flat.map((r) => r.id), ['mix', 'gtr', 'bass', 'live']);
    assert.equal(flat[0].stems, undefined);
    assert.equal(flat[0].stemsComplete, true);
    assert.deepEqual(flat[1], { id: 'gtr', label: 'Guitar', stem: { instrument: 'guitar', track: 0 }, sources: [file('audio/gtr.mp3')], role: 'stem', stemOf: 'mix' });
    assert.deepEqual(nestStemLayer(flat), nested());
});

test('a pack from before the stem layer (stemOf) is written in the new form', () => {
    const old = [{ id: 'mix', role: 'original', stemsComplete: true, sources: [] },
        { id: 's1', role: 'stem', stemOf: 'mix', stem: { instrument: 'drums' }, sources: [file('a.mp3')] }];
    const out = nestStemLayer(old);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].stems, [{ id: 's1', stem: { instrument: 'drums' }, sources: [file('a.mp3')] }]);
    assert.ok(!JSON.stringify(out).includes('stemOf'));
});

test('a stem with its own sync, or no mix in the pack, stays a recording of its own, without stemOf', () => {
    const out = nestStemLayer([
        { id: 'mix', role: 'original', sources: [] },
        { id: 'own', role: 'stem', stemOf: 'mix', sync: { tab: 'x.json' }, sources: [] },
        { id: 'lost', role: 'stem', stemOf: 'gone', sources: [] },
    ]);
    assert.deepEqual(out.map((r) => [r.id, r.stemOf, r.stems]), [['mix', undefined, undefined], ['own', undefined, undefined], ['lost', undefined, undefined]]);
});

test('stemsComplete is dropped from a recording that has no stem layer', () => {
    assert.equal('stemsComplete' in nestStemLayer([{ id: 'mix', role: 'original', stemsComplete: true, sources: [] }])[0], false);
});

test('the sources of a recording include its stems', () => {
    assert.deepEqual(recordingSources(nested()[0]).map((s) => s.path || s.videoId), ['audio/mix.mp3', 'lUBCXGeK694', 'audio/gtr.mp3', 'audio/bass.mp3']);
    assert.deepEqual(stemsOf({ stems: 'x' }), []);
});

test('the files a manifest needs include the audio of the stems', () => {
    const want = [...expectedFiles({ scores: [], recordings: nested() }).keys()];
    assert.deepEqual(want, ['audio/mix.mp3', 'audio/gtr.mp3', 'audio/bass.mp3']);
});
