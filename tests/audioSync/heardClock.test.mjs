// Run with: node --test tests/audioSync/heardClock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeardClock } from '../../src/audioSync/heardClock.js';

function make(latency = 400) {
    const src = { t: 0, playing: false, rate: 1, getTimeMs() { return this.t; }, isPlaying() { return this.playing; }, getRate() { return this.rate; } };
    const clock = createHeardClock({ source: src, getLatencyMs: () => latency });
    return { src, clock };
}

test('no latency: the clock is what is heard', () => {
    const { src, clock } = make(0);
    src.t = 5000; assert.equal(clock.heard(), 5000);
    assert.equal(clock.waitMs(), 0);
});

test('after play the cursor stands at the start for the latency, then moves', () => {
    const { src, clock } = make(400);
    src.t = 10000; src.playing = true; clock.restart();
    assert.equal(clock.heard(), 10000); assert.equal(clock.waitMs(), 400);
    src.t = 10200; assert.equal(clock.heard(), 10000); assert.equal(clock.waitMs(), 200);
    src.t = 10400; assert.equal(clock.heard(), 10000); assert.equal(clock.waitMs(), 0);
    src.t = 10700; assert.equal(clock.heard(), 10300); assert.equal(clock.waitMs(), 0);
});

test('the wait is wall time, so a slower rate waits longer in recording time', () => {
    const { src, clock } = make(400);
    src.rate = 0.5; src.t = 1000; src.playing = true; clock.restart();
    assert.equal(clock.heard(), 1000); assert.equal(clock.waitMs(), 800);
});

test('a seek while playing starts a new run', () => {
    const { src, clock } = make(400);
    src.t = 1000; src.playing = true; clock.restart(); src.t = 2000; clock.heard();
    src.t = 60000; assert.equal(clock.heard(), 60000); assert.equal(clock.waitMs(), 400);
    src.t = 30000; assert.equal(clock.heard(), 30000);
});

test('reset after a requested seek puts the cursor on the target, not the latency before it', () => {
    const { src, clock } = make(400);
    src.t = 1000; clock.heard();
    src.t = 1300; clock.reset(); assert.equal(clock.heard(), 1300);
});

test('pausing shortly after play does not send the cursor back', () => {
    const { src, clock } = make(400);
    src.t = 5000; src.playing = true; clock.restart(); src.t = 5100; clock.heard();
    src.playing = false; assert.equal(clock.heard(), 5000);
});

test('resuming where it paused keeps the cursor where it was', () => {
    const { src, clock } = make(400);
    src.t = 5000; src.playing = true; clock.restart();
    for (let t = 5100; t <= 6000; t += 100) { src.t = t; clock.heard(); }
    assert.equal(clock.heard(), 5600);
    src.playing = false; src.t = 6020; clock.heard();
    src.playing = true; clock.restart();
    assert.ok(clock.heard() <= 5620); assert.equal(clock.waitMs(), 0);
});
