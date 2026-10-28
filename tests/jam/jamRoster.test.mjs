// Run with: node --test tests/jam/jamRoster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNames, cleanAlias, MAX_ALIAS_LENGTH } from '../../app/jam/jamRoster.js';

const peers = (...names) => names.map((name, i) => ({ id: `p${i}`, name }));

test('unique names are left alone', () => {
    const out = resolveNames(peers('Sam', 'Alex'), new Map());
    assert.deepEqual(out.map((p) => p.name), ['Sam', 'Alex']);
    assert.deepEqual(out.map((p) => p.originalName), ['Sam', 'Alex']);
});

test('shared names are numbered in join order', () => {
    const out = resolveNames(peers('MajesticTab', 'Sam', 'MajesticTab'), new Map());
    assert.deepEqual(out.map((p) => p.name), ['MajesticTab (1)', 'Sam', 'MajesticTab (2)']);
});

test('an alias replaces the name and resolves a clash', () => {
    const out = resolveNames(peers('MajesticTab', 'MajesticTab'), new Map([['p1', 'Riley']]));
    assert.deepEqual(out.map((p) => p.name), ['MajesticTab', 'Riley']);
    assert.equal(out[1].originalName, 'MajesticTab');
});

test('two aliases that match are numbered too', () => {
    const out = resolveNames(peers('a', 'b'), new Map([['p0', 'Sam'], ['p1', 'Sam']]));
    assert.deepEqual(out.map((p) => p.name), ['Sam (1)', 'Sam (2)']);
});

test('cleanAlias trims, collapses spaces and caps the length', () => {
    assert.equal(cleanAlias('  Sam   B  '), 'Sam B');
    assert.equal(cleanAlias(''), '');
    assert.equal(cleanAlias(null), '');
    assert.equal(cleanAlias('x'.repeat(100)).length, MAX_ALIAS_LENGTH);
});
