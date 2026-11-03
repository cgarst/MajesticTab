// Run with: node --test tests/extensionDedupe.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeExtensions } from '../src/extensionDedupe.js';

const ext = (id, source, enabled = true) => ({ id, source, enabled, name: id });

test('exact copies collapse to the lowest id, whichever order they arrive in', () => {
    const a = dedupeExtensions([ext('b', 'code'), ext('a', 'code')]);
    const b = dedupeExtensions([ext('a', 'code'), ext('b', 'code')]);
    assert.deepEqual(a.map(e => e.id), ['a']);
    assert.deepEqual(b.map(e => e.id), ['a']);
});

test('different code stays, line endings and outer spaces do not matter', () => {
    const out = dedupeExtensions([ext('a', 'one'), ext('b', 'two'), ext('c', ' one\r\n')]);
    assert.deepEqual(out.map(e => e.id), ['a', 'b']);
});

test('the kept copy is enabled if any copy was', () => {
    const out = dedupeExtensions([ext('a', 'x', false), ext('b', 'x', true)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].enabled, true);
});

test('entries without source are left alone and the input is not changed', () => {
    const input = [ext('a', 'x'), { id: 'z' }, ext('b', 'x')];
    const out = dedupeExtensions(input);
    assert.deepEqual(out.map(e => e.id), ['a', 'z']);
    assert.equal(input.length, 3);
});
