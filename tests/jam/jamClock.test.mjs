// Run with: node --test tests/jam/jamClock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    median, computeSample, ClockSync, decideDriftAction, DriftFilter, computeLeadMs,
    DRIFT_IGNORE_MS, DRIFT_HARD_SEEK_MS
} from '../../app/jam/jamClock.js';

// Deterministic PRNG so jitter tests are repeatable.
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5 >>> 0) / 2 ** 32);
}

test('median handles odd, even and empty input', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
});

test('computeSample recovers offset with symmetric delay', () => {
    // Host clock is 1000 ms ahead; 5 ms each way; host turnaround 1 ms.
    const t0 = 100, t1 = 100 + 5 + 1000, t1b = t1 + 1, t2 = t0 + 5 + 1 + 5;
    const { rtt, offset } = computeSample(t0, t1, t1b, t2);
    assert.equal(rtt, 10);
    assert.equal(offset, 1000);
});

test('ClockSync converges under jitter and rejects high-RTT outliers', () => {
    const rand = rng(42);
    const trueOffset = -2345.6;
    const sync = new ClockSync();
    let local = 0;
    for (let i = 0; i < 20; i++) {
        local += 100;
        const up = 2 + rand() * 4;
        // Every 4th sample has a large, asymmetric delay (Wi-Fi retransmit).
        const down = i % 4 === 0 ? 60 + rand() * 40 : 2 + rand() * 4;
        const t0 = local;
        const t1 = t0 + up + trueOffset;
        const t1b = t1 + 0.2;
        const t2 = t0 + up + 0.2 + down;
        sync.addSample(t0, t1, t1b, t2);
    }
    assert.ok(sync.synced);
    assert.ok(Math.abs(sync.offset - trueOffset) < 3, `offset ${sync.offset}`);
    assert.ok(sync.rtt < 15, `rtt ${sync.rtt}`);
    assert.equal(sync.localFromHost(sync.hostFromLocal(500)), 500);
});

test('ClockSync ignores invalid samples', () => {
    const sync = new ClockSync();
    sync.addSample(10, NaN, NaN, 20);
    sync.addSample(10, 5, 5, 0); // negative RTT
    assert.equal(sync.synced, false);
});

test('decideDriftAction follows the ignore / nudge / seek policy', () => {
    assert.equal(decideDriftAction(DRIFT_IGNORE_MS - 1).action, 'none');
    const ahead = decideDriftAction(50);
    assert.equal(ahead.action, 'nudge');
    assert.ok(ahead.speedFactor < 1, 'client ahead slows down');
    const behind = decideDriftAction(-50);
    assert.ok(behind.speedFactor > 1, 'client behind speeds up');
    assert.equal(decideDriftAction(50, { allowNudge: false }).action, 'none');
    assert.equal(decideDriftAction(-DRIFT_HARD_SEEK_MS).action, 'seek');
    assert.equal(decideDriftAction(DRIFT_HARD_SEEK_MS, { allowNudge: false }).action, 'seek');
});

test('DriftFilter suppresses a single outlier', () => {
    const f = new DriftFilter(5);
    [5, 6, 4, 5].forEach((v) => f.push(v));
    assert.equal(f.push(300), 5);
});

test('computeLeadMs honours default, worst peer, override and clamps', () => {
    assert.equal(computeLeadMs([]), 150);
    assert.equal(computeLeadMs([10, 300]), 220); // 300/2 + 70
    assert.equal(computeLeadMs([2000]), 400);
    assert.equal(computeLeadMs([10], { override: 20 }), 80);
    assert.equal(computeLeadMs([10], { override: 250 }), 250);
});

test('decideDriftAction re-seeks earlier when nudging is unavailable', () => {
    assert.equal(decideDriftAction(50, { allowNudge: false, hardSeekMs: 40 }).action, 'seek');
    assert.equal(decideDriftAction(30, { allowNudge: false, hardSeekMs: 40 }).action, 'none');
});

test('NudgeMonitor flags nudges that do not reduce drift', async () => {
    const { NudgeMonitor } = await import('../../app/jam/jamClock.js');
    const working = new NudgeMonitor({ windowMs: 3000 });
    assert.equal(working.update(0, -60, true), false);
    assert.equal(working.update(3000, -20, true), false);
    // Half speed closes drift half as fast (Mac: -63 -> -52 in ~3 s) and still counts as working.
    const slow = new NudgeMonitor({ windowMs: 3000 });
    slow.update(0, -63, true, 0.5);
    assert.equal(slow.update(3000, -52, true, 0.5), false);
    const stuck = new NudgeMonitor({ windowMs: 3000 });
    stuck.update(0, -60, true);
    assert.equal(stuck.update(1000, -61, true), false, 'waits for the window');
    assert.equal(stuck.update(3000, -62, true), true);
    const reset = new NudgeMonitor({ windowMs: 3000 });
    reset.update(0, -60, true);
    reset.update(1000, -60, false);
    assert.equal(reset.update(3500, -60, true), false, 'a pause in nudging restarts the window');
});
