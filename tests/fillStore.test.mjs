// Run with: node --test tests/fillStore.test.mjs
// The cache file of Fill in missing tabs: what is saved, and that a restored run carries on from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFillState, saveFillState, clearFillState, snapshotOf } from '../src/bulkFill/fillStore.js';
import { createFillRun } from '../src/bulkFill/fillRun.js';

// A stand-in for Cache Storage: named caches holding one Response per key
const fakeCaches = () => {
    const named = new Map();
    return {
        open: async (name) => {
            if (!named.has(name)) named.set(name, new Map());
            const entries = named.get(name);
            return { put: async (key, res) => { entries.set(key, await res.text()); }, match: async (key) => (entries.has(key) ? new Response(entries.get(key)) : undefined) };
        },
        delete: async (name) => named.delete(name)
    };
};

const SRC = { id: 's1', name: 's1', urlTemplate: 'https://s1.test/api/get?q=$s', kind: 'api' };
const song = (id, title) => ({ id, title, artist: 'Band' });

test('settled states are saved, in-flight ones are not, and a pick keeps the address of each match', async () => {
    const choose = { title: 'Svc', query: 'q', options: [{ label: 'Two', detail: 'Band', value: '1' }, { label: 'Two (live)', detail: 'Band', value: '2' }], addressFor: (v) => `https://s1.test/api/get?song=${v}` };
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two'), song('c', 'Three')],
        sources: [SRC],
        fetchOne: async (s) => (s.id === 'a' ? { kind: 'file', file: { name: 'a.gp5' } } : s.id === 'b' ? { kind: 'choose', choose } : (() => { throw new Error('The service answered 500.'); })()),
        attach: async () => true
    });
    await run.start();
    const snap = snapshotOf({ songIds: ['a', 'b', 'c'], items: run.items, notFound: new Set(['z']) });
    assert.deepEqual(Object.keys(snap.items).sort(), ['a', 'b', 'c']);
    assert.equal(snap.items.b.choose.addresses['2'], 'https://s1.test/api/get?song=2');
    assert.equal(snap.items.c.message, 'The service answered 500.');
    assert.deepEqual(snap.notFound, ['z']);
    assert.equal('addressFor' in snap.items.b.choose, false);
});

test('a saved state round trips through the cache, and clearing the cache removes it', async () => {
    const caches = fakeCaches();
    assert.equal(await loadFillState(caches), null);
    await saveFillState({ v: 1, at: Date.now(), songIds: ['a'], items: {}, notFound: ['z'] }, caches);
    assert.deepEqual((await loadFillState(caches)).notFound, ['z']);
    await clearFillState(caches);
    assert.equal(await loadFillState(caches), null);
});

test('a stale or unreadable state is ignored, and a missing Cache Storage is not an error', async () => {
    const caches = fakeCaches();
    await saveFillState({ v: 1, at: Date.now() - 15 * 24 * 60 * 60 * 1000, songIds: [], items: {}, notFound: [] }, caches);
    assert.equal(await loadFillState(caches), null);
    await saveFillState({ v: 2, at: Date.now() }, caches);
    assert.equal(await loadFillState(caches), null);
    assert.equal(await loadFillState(null), null);
    assert.equal(await saveFillState({}, null), false);
});

test('a restored run keeps its added, failed and parked songs, and a parked pick asks again from the saved address', async () => {
    const saved = {
        a: { state: 'added', label: 'a.gp5', message: '' },
        b: { state: 'pick', label: '', message: '', choose: { title: 'Svc', query: 'q', options: [{ label: 'Two', detail: 'Band', value: '1' }], sourceId: 's1', addresses: { 1: 'https://s1.test/api/get?song=1' } } },
        c: { state: 'failed', label: '', message: 'The service answered 500.' }
    };
    const asked = [];
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two'), song('c', 'Three'), song('d', 'Four')],
        sources: [SRC],
        restored: saved,
        fetchOne: async (s, source, o) => { asked.push(`${s.id}:${o.address || ''}`); return { kind: 'file', file: { name: 'x.gp5' } }; },
        attach: async () => true
    });
    assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => run.items.get(id).state), ['added', 'pick', 'failed', 'queued']);
    await run.start();
    assert.deepEqual(asked, ['d:'], 'only the song nothing was settled for is asked');
    await run.resolvePick('b', '1');
    assert.deepEqual(asked, ['d:', 'b:https://s1.test/api/get?song=1']);
    assert.equal(run.items.get('b').state, 'added');
});
