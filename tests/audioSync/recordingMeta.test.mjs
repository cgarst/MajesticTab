// tests/audioSync/recordingMeta.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    setRecordingMeta, listRecordingMeta, forgetRecordingMeta, metaOfPackRecording, orderRecordings, roleLabel, tracksNote, isRecordingMetaKey,
} from '../../src/audioSync/recordingMeta.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const yt = (videoId) => ({ kind: 'youtube', videoId });
const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc', D = 'ddddddddddd', E = 'eeeeeeeeeee';
const keyOf = (c) => `yt_${c.videoId}`;
const order = (items, metas, tie) => orderRecordings(items, keyOf, metas, tie).map((e) => e.item.videoId + (e.nested ? '*' : ''));

test('stores, reads and forgets a recording\'s meta per song', () => {
    const s = store();
    setRecordingMeta('Song', yt(A), { role: 'alternate', label: ' Remaster ', packIndex: 2 }, s);
    assert.deepEqual(listRecordingMeta('song', s), { [`yt_${A}`]: { role: 'alternate', label: 'Remaster', packIndex: 2 } });
    assert.deepEqual(listRecordingMeta('other', s), {});
    forgetRecordingMeta('Song', yt(A), s);
    assert.deepEqual(listRecordingMeta('Song', s), {});
    assert.equal(s.getItem('rec_meta_song'), null);
});

test('drops entries without a role and tolerates bad storage', () => {
    const s = store();
    setRecordingMeta('Song', yt(A), { label: 'No role' }, s);
    assert.deepEqual(listRecordingMeta('Song', s), {});
    s.setItem('rec_meta_song', '{not json');
    assert.deepEqual(listRecordingMeta('Song', s), {});
    assert.ok(isRecordingMetaKey('rec_meta_x') && !isRecordingMetaKey('yt_videos_x'));
});

test('a pack recording becomes meta, with the stem parent and the track names', () => {
    const ids = { mix: 'yt_mmmmmmmmmmm' };
    const stem = { id: 'gtr', role: 'stem', stemOf: 'mix', label: 'Lead guitar' };
    assert.deepEqual(metaOfPackRecording(stem, 3, (id) => ids[id] || null), { role: 'stem', label: 'Lead guitar', packIndex: 3, stemOf: 'yt_mmmmmmmmmmm' });
    const backing = { id: 'v3', role: 'backing', scoreTracks: { main: { omits: [1], names: ['Drums'] } } };
    assert.deepEqual(metaOfPackRecording(backing, 1, () => null, 'main').tracks, { mode: 'omits', names: ['Drums'] });
    // Indexes without names, or names that do not line up: no tracks, since a name cannot be made up
    assert.equal(metaOfPackRecording({ role: 'backing', scoreTracks: { main: { omits: [1] } } }, 0, () => null, 'main').tracks, undefined);
    assert.equal(metaOfPackRecording({ role: 'backing', scoreTracks: { main: { omits: [1, 2], names: ['Drums'] } } }, 0, () => null, 'main').tracks, undefined);
});

test('role first: original, alternate, other roles, backing, then recordings the pack did not describe', () => {
    const items = [A, B, C, D, E].map((videoId) => ({ videoId, lastUsedAt: 0 }));
    const metas = {
        [`yt_${A}`]: { role: 'backing', packIndex: 0 },
        [`yt_${B}`]: { role: 'alternate', packIndex: 1 },
        [`yt_${C}`]: { role: 'original', packIndex: 2 },
        [`yt_${D}`]: { role: 'live', packIndex: 3 },
    };
    assert.deepEqual(order(items, metas), [C, B, D, A, E]);
});

test('inside a role the pack\'s order wins, then the newest', () => {
    const items = [{ videoId: A, lastUsedAt: 5 }, { videoId: B, lastUsedAt: 1 }, { videoId: C, lastUsedAt: 9 }, { videoId: D, lastUsedAt: 2 }];
    const metas = { [`yt_${A}`]: { role: 'alternate', packIndex: 4 }, [`yt_${B}`]: { role: 'alternate', packIndex: 1 } };
    // A and B are described (B first by pack order); C and D are not, so the newest of them comes first
    assert.deepEqual(order(items, metas, (a, b) => b.lastUsedAt - a.lastUsedAt), [B, A, C, D]);
});

test('with no meta at all the caller\'s order is kept', () => {
    const items = [C, A, B].map((videoId) => ({ videoId, lastUsedAt: 0 }));
    assert.deepEqual(order(items, {}), [C, A, B]);
});

test('a stem follows its parent, and a stem whose parent is not listed stays on its own', () => {
    const items = [A, B, C, D].map((videoId) => ({ videoId, lastUsedAt: 0 }));
    const metas = {
        [`yt_${A}`]: { role: 'original', packIndex: 0 },
        [`yt_${B}`]: { role: 'stem', packIndex: 1, stemOf: `yt_${A}` },
        [`yt_${C}`]: { role: 'alternate', packIndex: 2 },
        [`yt_${D}`]: { role: 'stem', packIndex: 3, stemOf: 'yt_zzzzzzzzzzz' },
    };
    assert.deepEqual(order(items, metas), [A, `${B}*`, C, D]);
});

test('two stems of each other do not vanish', () => {
    const items = [A, B].map((videoId) => ({ videoId, lastUsedAt: 0 }));
    const metas = { [`yt_${A}`]: { role: 'stem', stemOf: `yt_${B}` }, [`yt_${B}`]: { role: 'stem', stemOf: `yt_${A}` } };
    assert.deepEqual(order(items, metas).sort(), [A, B]);
});

test('role and tracks as text', () => {
    assert.equal(roleLabel({ role: 'alternate' }), 'Alternate');
    assert.equal(roleLabel({ role: 'original' }), '');
    assert.equal(roleLabel({ role: 'backing' }), '');
    assert.equal(roleLabel(null), '');
    assert.equal(tracksNote({ tracks: { mode: 'omits', names: ['Drums', 'Bass'] } }), 'Without Drums, Bass');
    assert.equal(tracksNote({ tracks: { mode: 'only', names: ['Lead'] } }), 'Only Lead');
    assert.equal(tracksNote({}), '');
});
