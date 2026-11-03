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
