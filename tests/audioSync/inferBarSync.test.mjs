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

test('detects leading PDF count-in bar using system-break layout on mixed-time score', () => {
    const tl = makeMixedTimeline();
    // PDF has 1 extra 4/4 bar (4 beats) at t=0..1500, then the 8 GP bars (4,4,4,2,4,4,4,4 = 30 beats).
    // Systems break at PDF bar 0+1 (8 beats), bar 2+3+4 (4+4+2 = 10 beats -> wait: GP bars 1,2,3), etc.
    // Specifically: Sys 0 = PDF bar 0 + GP bar 0 (8 beats), Sys 1 = GP bars 1,2,3 (10 beats), Sys 2 = GP bars 4..7 (16 beats).
    const sysSizes = [8, 10, 16];
    const pdfPoints = [];
    let idx = 0;
    sysSizes.forEach((count, sysIdx) => {
        for (let k = 0; k < count; k++) {
            pdfPoints.push({ page: 1, y: 0.1 + sysIdx * 0.2, x: 0.1 + k * 0.08, timeMs: idx * 500 });
            idx++;
        }
    });
    const res = inferBarSyncFromPdf(tl, pdfPoints);
    assert.ok(res);
    assert.equal(res.points[0].barIndex, 0);
    assert.equal(res.points[0].timeMs, 2000);
});

test('detects leading PDF count-in bar on uniform 4/4 score using audio onsets', () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(i, i * 3840, (i + 1) * 3840, i === 0 ? [{ tick: 0, tempo: 120 }] : []));
    const tl = buildScoreTimeline(bars);
    // PDF has 1 extra 4/4 count-in bar (t=0..1500) before GP bar 0 (t=2000)
    const pdfPoints = Array.from({ length: 36 }, (_, i) => ({ page: 1, y: 0.1 + Math.floor(i / 8) * 0.2, timeMs: i * 500 }));
    // GP notes start at 500ms into bar 0 (beat 2) and repeat every beat; audio is silent until 2500ms
    const noteScoreTimesMs = Array.from({ length: 16 }, (_, i) => 500 + i * 500);
    const audioOnsets = { times: Array.from({ length: 16 }, (_, i) => 2500 + i * 500) };

    const res = inferBarSyncFromPdf(tl, pdfPoints, { audioOnsets, noteScoreTimesMs });
    assert.ok(res);
    assert.equal(res.points[0].barIndex, 0);
    assert.equal(res.points[0].timeMs, 2000);
});

test('detects leading GP rest bar when audio/PDF start at bar 1 using audio onsets', () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(i, i * 3840, (i + 1) * 3840, i === 0 ? [{ tick: 0, tempo: 120 }] : []));
    const tl = buildScoreTimeline(bars);
    // GP has a leading rest bar (bar 0: 0..2000ms), first note is at scoreMs=2000 (bar 1 beat 1).
    // PDF/audio omitted bar 0 and start at t=0 for GP bar 1.
    const pdfPoints = Array.from({ length: 28 }, (_, i) => ({ page: 1, y: 0.1 + Math.floor(i / 8) * 0.2, timeMs: i * 500 }));
    const noteScoreTimesMs = Array.from({ length: 16 }, (_, i) => 2000 + i * 500);
    const audioOnsets = { times: Array.from({ length: 16 }, (_, i) => i * 500) };

    const res = inferBarSyncFromPdf(tl, pdfPoints, { audioOnsets, noteScoreTimesMs });
    assert.ok(res);
    assert.equal(res.points[0].barIndex, 1);
    assert.equal(res.points[0].timeMs, 0);
});

test('infers bar sync from PDF points that follow each bar\'s own beat: dotted quarters in 12/8, quarters in 4/4', () => {
    const bars = [];
    let tick = 0;
    // 4/4 (2000 ms), 4/4, 12/8 (3000 ms), 12/8, 4/4, 12/8, 12/8, 4/4, 4/4, 12/8 at 120 BPM
    const meters = [[4, 4], [4, 4], [12, 8], [12, 8], [4, 4], [12, 8], [12, 8], [4, 4], [4, 4], [12, 8]];
    const expected = [];
    let ms = 4000;
    const pdfPoints = [];
    meters.forEach(([num, den], i) => {
        const len = num * 3840 / den;
        bars.push({ barIndex: i, start: tick, end: tick + len, num, den, tempoChanges: i === 0 ? [{ tick: 0, tempo: 120 }] : [] });
        tick += len;
        expected.push(ms);
        const beats = den === 8 ? num / 3 : num;
        const step = (len * 60000 / (120 * 960)) / beats;
        for (let b = 0; b < beats; b++) pdfPoints.push({ timeMs: Math.round(ms + b * step) });
        ms += Math.round(len * 60000 / (120 * 960));
    });
    const res = inferBarSyncFromPdf(buildScoreTimeline(bars), pdfPoints);
    assert.ok(res, 'a map that is one point per beat of a mixed-meter score is read');
    assert.equal(res.unit, 'beat');
    assert.equal(res.fit.placed, 10);
    assert.deepEqual(res.points.map((p) => p.timeMs), expected);
});

test('the PDF\'s first point stays on the score\'s first bar instead of skipping a long stretch of the PDF', () => {
    const tl = makeMixedTimeline();
    // 30 quarter beats from 0 ms: the first bar starts at 0, not 15 steps in
    const pdfPoints = Array.from({ length: 30 }, (_, i) => ({ timeMs: i * 500 }));
    const res = inferBarSyncFromPdf(tl, pdfPoints);
    assert.ok(res);
    assert.equal(res.points[0].timeMs, 0);
});

test('a slow fade-in bar at the start of the score takes the many PDF beats it stands for', () => {
    // Bar 0 is 4/4 written at 24 BPM (10 s); the PDF spends 20 beats (500 ms each) on it, then 39 bars of 4/4 at 120 BPM
    const bars = [];
    let tick = 0;
    for (let i = 0; i < 40; i++) {
        bars.push({ barIndex: i, start: tick, end: tick + 3840, num: 4, den: 4, tempoChanges: i === 0 ? [{ tick: 0, tempo: 24 }] : i === 1 ? [{ tick: 3840, tempo: 120 }] : [] });
        tick += 3840;
    }
    // 20 beats for bar 0 (0..10 s), then 39 bars x 4 beats at 500 ms
    const pdfPoints = Array.from({ length: 20 + 156 }, (_, i) => ({ timeMs: i * 500 }));
    const res = inferBarSyncFromPdf(buildScoreTimeline(bars), pdfPoints);
    assert.ok(res);
    assert.equal(res.points[0].timeMs, 0);
    assert.equal(res.points[1].barIndex, 1);
    assert.equal(res.points[1].timeMs, 10000);
    assert.equal(res.points[2].timeMs, 12000);
});

test('a PDF that steps by quarters in a slow intro and by eighths after it still lines up with the score', () => {
    // 20 bars of 4/4 at 120 BPM (2000 ms each): the PDF has a point per quarter (500 ms) for bars 0-5, then one per eighth (250 ms)
    const bars = [];
    let tick = 0;
    for (let i = 0; i < 20; i++) {
        bars.push({ barIndex: i, start: tick, end: tick + 3840, num: 4, den: 4, tempoChanges: i === 0 ? [{ tick: 0, tempo: 120 }] : [] });
        tick += 3840;
    }
    const offset = 2500;
    const pdfPoints = [];
    for (let i = 0; i < 24; i++) pdfPoints.push({ timeMs: offset + i * 500 });
    for (let i = 0; i < 14 * 8; i++) pdfPoints.push({ timeMs: offset + 12000 + i * 250 });
    const res = inferBarSyncFromPdf(buildScoreTimeline(bars), pdfPoints);
    assert.ok(res);
    assert.equal(res.points.length, 20);
    for (const p of res.points) assert.equal(Math.abs(p.timeMs - (offset + p.barIndex * 2000)) <= 1, true, `bar ${p.barIndex} at ${p.timeMs}`);
});
