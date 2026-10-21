// Run with: node --test tests/jam/jamSha256.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256HexFallback } from '../../app/jam/jamSha256.js';

const ref = (buf) => createHash('sha256').update(buf).digest('hex');

test('matches known vectors', () => {
    assert.equal(sha256HexFallback(new Uint8Array(0).buffer), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256HexFallback(new TextEncoder().encode('abc').buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('matches node crypto across padding boundaries', () => {
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100000]) {
        const buf = randomBytes(n);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n);
        assert.equal(sha256HexFallback(ab), ref(buf), `length ${n}`);
    }
});

test('accepts typed array views of the right range', () => {
    const buf = randomBytes(300);
    assert.equal(sha256HexFallback(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 300)), ref(buf));
});
