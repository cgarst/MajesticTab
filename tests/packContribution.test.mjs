// tests/packContribution.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { packAdds, describeAdds } from '../src/bulkImport/packContribution.js';

const manifest = {
    scores: [{ id: 'gp', sha256: 'aa', name: 'Song.gp' }],
    recordings: [
        { id: 'stem-1', role: 'stem', sources: [{ type: 'file', path: 'audio/g.m4a', size: 10 }], sync: { gp: 'sync/x.json' } },
        { id: 'stem-2', role: 'stem', sources: [{ type: 'file', path: 'audio/b.m4a', size: 20 }] },
        { id: 'mix', role: 'alternate', sources: [{ type: 'file', path: 'audio/m.m4a', size: 30 }] },
    ],
};
const none = async () => null;
const all = async (src) => `id${src.size}`;

test('a song the library does not have gets everything as new', async () => {
    const a = await packAdds({ manifest, song: null, isSameFile: none, hasSync: () => false });
    assert.deepEqual(a, { scores: 1, stems: 2, audio: 1, sync: 1, total: 5 });
    assert.equal(describeAdds(a), 'Adds 1 score, 2 stems, 1 audio file and sync data');
});

test('a pack the song already holds in full adds nothing', async () => {
    const song = { tabOptions: [{ sha256: 'aa', name: 'Song.gp' }] };
    const a = await packAdds({ manifest, song, isSameFile: all, hasSync: () => true });
    assert.equal(a.total, 0);
    assert.equal(describeAdds(a), 'Nothing new');
});

test('stems the song lacks and sync it lacks count, a score it has does not', async () => {
    const song = { tabOptions: [{ sha256: 'aa', name: 'Song.gp' }] };
    const has = async (src) => (src.size === 30 ? 'm' : null);
    const a = await packAdds({ manifest, song, isSameFile: has, hasSync: () => false });
    assert.deepEqual(a, { scores: 0, stems: 2, audio: 0, sync: 1, total: 3 });
});

test('a file the song has, with sync it does not have yet, adds sync only', async () => {
    const song = { tabOptions: [{ sha256: 'aa' }] };
    const a = await packAdds({ manifest, song, isSameFile: all, hasSync: () => false });
    assert.deepEqual(a, { scores: 0, stems: 0, audio: 0, sync: 1, total: 1 });
});

test('a tab without a hash matches by name', async () => {
    const song = { tabOptions: [{ name: 'song.gp' }] };
    const a = await packAdds({ manifest: { scores: manifest.scores, recordings: [] }, song, isSameFile: none, hasSync: () => true });
    assert.equal(a.scores, 0);
});
