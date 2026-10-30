import test from 'node:test';
import assert from 'node:assert/strict';
import { songTypeForName, isGpSong, chunkBase64, JAM_CHUNK_B64_CHARS } from '../../src/jam/jamProtocol.js';

test('song types', () => {
    assert.equal(songTypeForName('Duo No 2 In G Major.gp5'), 'gp');
    assert.equal(songTypeForName('a.GP5'), 'gp');
    assert.equal(songTypeForName('chart.PDF'), 'pdf');
    assert.equal(songTypeForName('tab.txt'), 'txt');
    assert.equal(songTypeForName('notes.doc'), null);
    assert.equal(isGpSong({ type: 'pdf' }), false);
    assert.equal(isGpSong({}), true); // older hosts sent no type
    assert.equal(isGpSong(null), false);
});

test('base64 chunks split on 4-char boundaries and rejoin', () => {
    assert.equal(JAM_CHUNK_B64_CHARS % 4, 0);
    const b64 = Buffer.from(new Uint8Array(JAM_CHUNK_B64_CHARS * 2).map((_, i) => i % 251)).toString('base64');
    const parts = chunkBase64(b64);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), b64);
    const decoded = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')));
    assert.deepEqual(decoded, Buffer.from(b64, 'base64'));
    assert.deepEqual(chunkBase64(''), ['']);
});
