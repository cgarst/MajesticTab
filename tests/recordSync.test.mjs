// Run with: node --test tests/recordSync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRecord, planRecords, describeRecords, fingerprintValue as fp, RECORD_ACTION as A } from '../src/recordSync.js';

const rec = (key, kind, value, time) => [key, { key, kind, id: key, label: key, fp: fp(value), value, time }];

test('an edit on one side moves to the other, a new record is added, a removal is carried', () => {
    assert.equal(decideRecord('b', 'a', 'a').action, A.PUSH);
    assert.equal(decideRecord('a', 'b', 'a').action, A.PULL);
    assert.equal(decideRecord('a', undefined, undefined).action, A.PUSH);
    assert.equal(decideRecord(undefined, 'a', undefined).action, A.PULL);
    assert.equal(decideRecord('a', undefined, 'a').action, A.DELETE_LOCAL);
    assert.equal(decideRecord(undefined, 'a', 'a').action, A.DELETE_REMOTE);
    assert.equal(decideRecord('a', 'a', 'z'), null);
});

test('an edit beats a removal on the other side', () => {
    assert.deepEqual(decideRecord('b', undefined, 'a'), { action: A.PUSH, conflict: true });
    assert.deepEqual(decideRecord(undefined, 'b', 'a'), { action: A.PULL, conflict: true });
});

test('a record changed on both sides keeps this device unless a time says the snapshot is newer', () => {
    assert.deepEqual(decideRecord('x', 'y', 'a'), { action: A.PUSH, conflict: true });
    assert.deepEqual(decideRecord('x', 'y', 'a', () => 'theirs'), { action: A.PULL, conflict: true });
});

test('record timestamps: the change made after the last sync wins', () => {
    const base = { 'set:1': fp({ enabled: true }) };
    // Changed here, untouched in the snapshot: the change is sent
    let d = planRecords(new Map([rec('set:1', 'setting', { enabled: false }, 5)]), new Map([rec('set:1', 'setting', { enabled: true }, 1)]), base);
    assert.equal(d[0].action, A.PUSH);
    // Changed elsewhere: this device follows
    d = planRecords(new Map([rec('set:1', 'setting', { enabled: true }, 1)]), new Map([rec('set:1', 'setting', { enabled: false }, 5)]), base);
    assert.equal(d[0].action, A.PULL);
    // Changed on both sides: the later change wins
    d = planRecords(new Map([rec('set:1', 'setting', { enabled: false }, 5)]), new Map([rec('set:1', 'setting', { enabled: true, name: 'n' }, 9)]), base);
    assert.deepEqual([d[0].action, d[0].conflict], [A.PULL, true]);
});

test('kinds a snapshot does not carry are left alone', () => {
    const mine = new Map([rec('sl:1', 'setlist', {})]);
    assert.equal(planRecords(mine, new Map(), { 'sl:1': fp({}) }, new Set(['setlist'])).length, 0);
    assert.equal(planRecords(mine, new Map(), { 'sl:1': fp({}) }).length, 1);
});

test('fingerprints ignore key order and the plan text counts each kind', () => {
    assert.equal(fp({ a: 1, b: [1, { c: 2, d: 3 }] }), fp({ b: [1, { d: 3, c: 2 }], a: 1 }));
    const d = planRecords(new Map(), new Map([rec('song:1', 'song', {}), rec('song:2', 'song', {})]), null);
    assert.match(describeRecords(d).receive[0].text, /^2 songs new or changed in the snapshot/);
});

test('a restore point is kept across edits, survives clearing, and is held on the first edit', async () => {
    const { saveRecord, loadRecord, loadRestorePoint, samePoints } = await import('../src/audioSync/syncStore.js');
    const mem = new Map();
    const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    const media = { kind: 'youtube', videoId: 'abcdefghijk' };
    const pts = (...t) => t.map((timeMs, i) => ({ id: `p${i}`, barIndex: i, occurrence: 0, pos: 0, timeMs, source: 'manual' }));
    const a = pts(1000, 3000, 5000);
    saveRecord('s', media, a, storage, 10, undefined, { restoreTo: a });
    saveRecord('s', media, pts(1100, 3100, 5100), storage, 20, undefined, { holdPrevious: true });
    assert.ok(samePoints(loadRestorePoint('s', media, storage).points, a));
    assert.equal(loadRecord('s', media, storage).points[0].timeMs, 1100);
    saveRecord('s', media, [], storage, 30, undefined, { holdPrevious: true });
    assert.equal(loadRecord('s', media, storage), null);
    assert.ok(loadRestorePoint('s', media, storage));
    // no restore point yet: the first edit holds what was there
    const m2 = { kind: 'youtube', videoId: 'bbbbbbbbbbb' };
    saveRecord('s', m2, a, storage, 40);
    assert.equal(loadRestorePoint('s', m2, storage), null);
    saveRecord('s', m2, pts(1, 2, 3), storage, 50, undefined, { holdPrevious: true });
    assert.ok(samePoints(loadRestorePoint('s', m2, storage).points, a));
});
