// Run with: node --test tests/audioSync/syncRecordStore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fflate from 'fflate';
import { packValue, unpackValue } from '../../src/audioSync/syncRecordStore.js';
import { saveRecord, loadRecord, listRecords } from '../../src/audioSync/syncStore.js';

const points = Array.from({ length: 700 }, (_, i) => ({ id: `p_${i}`, page: 1 + (i % 40), x: 0.12431, y: 0.07143, timeMs: 5000 + i * 1593, source: 'manual' }));
const text = JSON.stringify({ version: 2, media: { kind: 'local', audioId: 'u1' }, anchorType: 'pdf', points, savedAt: 1 });

test('without fflate a value is kept as text', () => {
    delete globalThis.fflate;
    assert.equal(packValue(text), text);
    assert.equal(unpackValue(text), text);
});

test('with fflate a large value is deflated, much smaller, and reads back identical', () => {
    globalThis.fflate = fflate;
    try {
        const packed = packValue(text);
        assert.ok(packed instanceof Uint8Array);
        assert.ok(packed.length < text.length / 4, `${packed.length} vs ${text.length}`);
        assert.equal(unpackValue(packed), text);
        // a small value, such as a share flag, stays text
        assert.equal(packValue('1'), '1');
        assert.equal(unpackValue(undefined), undefined);
    } finally { delete globalThis.fflate; }
});

test('a deflated value that fails to inflate is not mistaken for text', () => {
    globalThis.fflate = fflate;
    try {
        assert.throws(() => unpackValue(new Uint8Array([1, 2, 3, 4])));
    } finally { delete globalThis.fflate; }
});

test('records saved through syncStore still round trip (localStorage-style storage)', () => {
    const m = new Map();
    const real = {
        get length() { return m.size; },
        key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => (m.has(k) ? unpackValue(m.get(k)) : null),
        setItem: (k, v) => m.set(k, packValue(String(v))),
        removeItem: (k) => m.delete(k)
    };
    globalThis.fflate = fflate;
    try {
        const media = { kind: 'local', audioId: 'u1', name: 'a', durationMs: 1, fingerprint: 'f' };
        saveRecord('Song', media, points.map((p) => ({ ...p, page: p.page })), real, 1000, 'pdf');
        assert.ok([...m.values()].some((v) => v instanceof Uint8Array));
        assert.equal(loadRecord('Song', media, real).points.length, 700);
        assert.equal(listRecords('Song', real).length, 1);
    } finally { delete globalThis.fflate; }
});
