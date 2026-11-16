// Run with: node --test tests/audioSync/inferBarSync.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferBarSyncFromPdf } from '../../src/audioSync/inferBarSync.js';
import { buildScoreTimeline } from '../../src/audioSync/scorePositions.js';
import { saveRecord, listPdfRecordsForMedia } from '../../src/audioSync/syncStore.js';
import { scoreSyncKey, legacyScoreSyncKey } from '../../src/audioSync/anchors.js';

const bar = (barIndex, startTick, endTick, tempoChanges = []) => ({
    barIndex,
    start: startTick,
    end: endTick,
    tempoChanges,
});

// 8 bars of 4/4 at 120 BPM (2000 ms/bar), with bar 3 being 2/4 (1000 ms)
function makeMixedTimeline() {
    const bars = [];
    let tick = 0;
    const lengths = [3840, 3840, 3840, 1920, 3840, 3840, 3840, 3840];
    lengths.forEach((len, i) => {
        bars.push(bar(i, tick, tick + len, i === 0 ? [{ tick: 0, tempo: 120 }] : []));
        tick += len;
    });
    return buildScoreTimeline(bars);
}

test('infers bar sync from quarter-note PDF points including a 2/4 bar', () => {
    const tl = makeMixedTimeline();
    // 4 + 4 + 4 + 2 + 4 + 4 + 4 + 4 = 30 quarter beats, starting at 1500 ms, 500 ms per beat
    const pdfPoints = Array.from({ length: 30 }, (_, i) => ({ timeMs: 1500 + i * 500 }));
    const res = inferBarSyncFromPdf(tl, pdfPoints);
    assert.ok(res);
    assert.equal(res.unit, 'quarter');
    assert.equal(res.fit.level, 'good');
    assert.equal(res.points.length, 8);
    assert.deepEqual(res.points.map(p => p.timeMs), [1500, 3500, 5500, 7500, 8500, 10500, 12500, 14500]);
});

test('infers bar sync from eighth-note PDF points when GP has a trailing rest bar', () => {
    const tl = makeMixedTimeline(); // 60 eighth-notes total (last bar is 8 eighth-notes)
    // PDF has 52 eighth-notes (bars 0..6), with ~2% tempo drift
    const pdfPoints = Array.from({ length: 52 }, (_, i) => ({ timeMs: 2000 + Math.round(i * 255) }));
    const res = inferBarSyncFromPdf(tl, pdfPoints);
    assert.ok(res);
    assert.equal(res.unit, 'eighth');
    assert.equal(res.points.length, 7);
    assert.equal(res.fit.placed, 7);
    assert.equal(res.fit.flagged, 0);
});

test('infers bar sync from bar-start PDF points', () => {
    const tl = makeMixedTimeline();
    const expected = [1000, 3000, 5000, 7000, 8000, 10000, 12000, 14000];
    const pdfPoints = expected.map(timeMs => ({ timeMs }));
    const res = inferBarSyncFromPdf(tl, pdfPoints);
    assert.ok(res);
    assert.equal(res.unit, 'bar');
    assert.equal(res.fit.level, 'good');
    assert.deepEqual(res.points.map(p => p.timeMs), expected);
});

test('returns null for irregular/sparse PDF points', () => {
    const tl = makeMixedTimeline();
    const irregular = [{ timeMs: 500 }, { timeMs: 900 }, { timeMs: 6200 }, { timeMs: 6500 }, { timeMs: 14000 }];
    assert.equal(inferBarSyncFromPdf(tl, irregular), null);
});

test('listPdfRecordsForMedia finds PDF records for the same song and media', () => {
    const map = new Map();
    const storage = {
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
    };
    const songKey = 'Dream Theater - Another Day';
    const media = { kind: 'local', audioId: 'a1', name: 'guitar-1.flac', durationMs: 266651 };
    const otherMedia = { kind: 'local', audioId: 'a2', name: 'other.flac', durationMs: 200000 };
    saveRecord(scoreSyncKey(songKey, 'deadbeef'), media, [{ id: 'p1', page: 1, timeMs: 1000 }], storage, 100, 'pdf');
    saveRecord(legacyScoreSyncKey(songKey), media, [{ id: 'p2', page: 1, timeMs: 2000 }], storage, 200, 'pdf');
    saveRecord(scoreSyncKey(songKey, 'deadbeef'), otherMedia, [{ id: 'p3', page: 1, timeMs: 3000 }], storage, 300, 'pdf');
    saveRecord(songKey, media, [{ id: 'b1', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1000 }], storage, 400, 'bar');

    const found = listPdfRecordsForMedia(songKey, media, storage);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map(r => r.points[0].id), ['p2', 'p1']);
});
