// Run with: node --test tests/audioSync/syncShrink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { planShrink, siblingKey, entryOf, shrunkRestore, stemIsCopy } from '../../src/audioSync/syncShrink.js';
import { normalizeRecord, serializeRecord } from '../../src/audioSync/syncStore.js';

const pts = [{ id: 'a', page: 1, x: 0.1, y: 0.2, timeMs: 1000, source: 'manual' }, { id: 'b', page: 2, x: 0.1, y: 0.2, timeMs: 5000, source: 'manual' }];
const rec = (audioId, points = pts, extra = {}) => ({ version: 2, media: { kind: 'local', audioId, name: audioId, durationMs: 1, fingerprint: audioId }, anchorType: 'pdf', points, updatedAt: 7, ...extra });
const entry = (key, raw) => entryOf(key, JSON.stringify(raw));
const K = (id) => `audio_sync_score%3Aabc%3Asong_local_${id}`;

test('siblingKey swaps the media part of a key', () => {
    assert.equal(siblingKey(K('x'), rec('x').media, 'local_y'), K('y'));
    assert.equal(siblingKey('audio_sync_song_yt_abc', { kind: 'local', audioId: 'x' }, 'local_y'), null);
});

test('a restore copy identical to the points shrinks to the marker, and reads back the same', () => {
    const raw = rec('x', pts, { restore: { points: pts, savedAt: 9 } });
    const plan = planShrink([entry(K('x'), raw)]);
    assert.equal(plan.restore.length, 1);
    const next = shrunkRestore(raw);
    assert.deepEqual(next.restore, { same: true, savedAt: 9 });
    assert.equal(next.updatedAt, 7);
    assert.ok(JSON.stringify(next).length < JSON.stringify(raw).length * 0.8);
    const before = normalizeRecord(raw), after = normalizeRecord(next);
    assert.deepEqual(after.restore, before.restore);
    assert.deepEqual(after.points, before.points);
    assert.deepEqual(serializeRecord(after).restore, { same: true, savedAt: 9 });
});

test('an edited record, or one already shrunk, is left alone', () => {
    const edited = rec('x', [pts[0]], { restore: { points: pts, savedAt: 9 } });
    const done = rec('y', pts, { restore: { same: true, savedAt: 9 } });
    const plain = rec('z');
    const plan = planShrink([entry(K('x'), edited), entry(K('y'), done), entry(K('z'), plain)]);
    assert.equal(plan.restore.length, 0);
    assert.equal(plan.stems.length, 0);
    assert.equal(shrunkRestore(edited), null);
    assert.equal(shrunkRestore(done), null);
    assert.equal(shrunkRestore(plain), null);
});

test('a stem with its parent\'s exact points can go; a different one, an edited restore and a stem of a stem stay', () => {
    const lead = rec('lead');
    const stemSame = rec('s1', pts, { restore: { points: pts, savedAt: 1 } });
    const stemDiff = rec('s2', [pts[0]]);
    const stemEdited = rec('s3', pts, { restore: { points: [pts[1]], savedAt: 1 } });
    const parents = { s1: 'local_lead', s2: 'local_lead', s3: 'local_lead' };
    const plan = planShrink([entry(K('lead'), lead), entry(K('s1'), stemSame), entry(K('s2'), stemDiff), entry(K('s3'), stemEdited)], {
        stemParentOf: (e) => parents[e.key.split('_local_')[1]] || null
    });
    assert.deepEqual(plan.stems.map((s) => s.key), [K('s1')]);
    assert.equal(plan.stems[0].parentKey, K('lead'));
    // the removed stem is not also counted as a restore copy
    assert.equal(plan.restore.length, 0);
    assert.equal(plan.stemBytes, JSON.stringify(stemSame).length);
    assert.equal(stemIsCopy(stemSame, lead), true);
    assert.equal(stemIsCopy(stemDiff, lead), false);
    assert.equal(stemIsCopy(stemEdited, lead), false);
    assert.equal(stemIsCopy(stemSame, { ...lead, anchorType: 'bar' }), false);
});

test('a stem whose parent has no record, another score\'s record, or is itself a stem is kept', () => {
    const orphan = rec('s1');
    const pdfParent = { ...rec('lead'), anchorType: 'bar' };
    const stemOfStem = rec('s2');
    const chain = { s1: 'local_lead', s2: 'local_mid', mid: 'local_lead' };
    const plan = planShrink([entry(K('s1'), orphan), entry(K('s2'), stemOfStem), entry(K('mid'), rec('mid'))], {
        stemParentOf: (e) => chain[e.key.split('_local_')[1]] || null
    });
    assert.equal(plan.stems.length, 0);
    const plan2 = planShrink([entry(K('lead'), pdfParent), entry(K('s1'), rec('s1'))], { stemParentOf: (e) => (e.key === K('s1') ? 'local_lead' : null) });
    assert.equal(plan2.stems.length, 0);
});
