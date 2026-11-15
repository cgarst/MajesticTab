// Run with: node --test tests/audioSync/decodedMixSource.test.mjs
// The mix source on a fake AudioContext: it checks which parts are decoded, started together, kept in step, and released.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
after(() => {
    setTimeout(() => process.exit(0), 50);
});

import { createDecodedMixSource, MAX_LEVEL } from '../../src/audioSync/decodedMixSource.js';

function fakeContext() {
    const ctx = {
        currentTime: 10, state: 'running', decoded: [], sources: [], stretchers: [],
        destination: { kind: 'destination' },
        resume: async () => {},
        createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
        createBufferSource() {
            const node = {
                buffer: null, playbackRate: { value: 1 }, started: null, stopped: false, onended: null,
                connect() {}, disconnect() {},
                start(when, from) { node.started = { when, from }; },
                stop() { node.stopped = true; },
            };
            ctx.sources.push(node);
            return node;
        },
        // the byte length of a file is its duration in seconds
        async decodeAudioData(buf) {
            if (buf.byteLength === 13) throw new Error('bad');
            ctx.decoded.push(buf.byteLength);
            return { duration: buf.byteLength };
        },
    };
    return ctx;
}
class FakeStretch {
    constructor() { this.playbackRate = { value: 1 }; this.pitch = { value: 1 }; FakeStretch.made++; }
    connect() {} disconnect() {}
}
FakeStretch.made = 0;

const file = (id, seconds, extra = {}) => ({ id, name: id, type: 'audio/flac', data: new ArrayBuffer(seconds), durationMs: seconds * 1000, ...extra });
async function make(extra = {}) {
    const ctx = fakeContext();
    const src = createDecodedMixSource({
        id: 'mix', context: ctx, loadStretcher: async () => FakeStretch,
        base: file('nog', 100), stems: [file('g1', 100), file('g2', 100)], ...extra,
    });
    await src.ready();
    return { ctx, src };
}
const live = (ctx) => ctx.sources.filter((s) => s.started && !s.stopped);

test('ready decodes the base part only', async () => {
    const { ctx, src } = await make();
    assert.deepEqual(ctx.decoded, [100]);
    assert.equal(src.durationMs, 100000);
    assert.deepEqual(src.parts().map((p) => [p.id, p.base, p.enabled]), [['nog', true, true], ['g1', false, false], ['g2', false, false]]);
});

test('play starts the base part at the position, and a stem that is on starts with it at the same time', async () => {
    const { ctx, src } = await make();
    await src.setPartEnabled('g1', true);
    src.seek(12000);
    await src.play();
    const nodes = live(ctx);
    assert.equal(nodes.length, 2);
    assert.equal(new Set(nodes.map((n) => n.started.when)).size, 1);
    assert.deepEqual(nodes.map((n) => n.started.from), [12, 12]);
});

test('a stem switched on while playing joins at the current position, and a stem switched off stops and is released', async () => {
    const { ctx, src } = await make();
    await src.play();
    ctx.currentTime += 5;
    await src.setPartEnabled('g2', true);
    const joined = live(ctx).at(-1);
    assert.equal(live(ctx).length, 2);
    // playback began at context time 10.02 from 0, so at 15.02 the other parts are at 5 s
    assert.ok(Math.abs(joined.started.from - 5) < 1e-6, `started from ${joined.started.from}`);
    await src.setPartEnabled('g2', false);
    assert.equal(joined.stopped, true);
    assert.equal(src.parts().find((p) => p.id === 'g2').enabled, false);
    // switched on again, it is decoded again
    const before = ctx.decoded.length;
    await src.setPartEnabled('g2', true);
    assert.equal(ctx.decoded.length, before + 1);
});

test('the base part cannot be switched off', async () => {
    const { src } = await make();
    await src.setPartEnabled('nog', false);
    assert.equal(src.parts()[0].enabled, true);
});

test('pause then play restarts every enabled part from the same position', async () => {
    const { ctx, src } = await make();
    await src.setPartEnabled('g1', true);
    await src.play();
    ctx.currentTime += 3;
    src.pause();
    assert.equal(live(ctx).length, 0);
    assert.ok(Math.abs(src.getTimeMs() - 3000) < 50);
    await src.play();
    const nodes = live(ctx);
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((n) => Math.abs(n.started.from - 3) < 0.05));
});

test('seeking while playing restarts all parts at the new position', async () => {
    const { ctx, src } = await make();
    await src.setPartEnabled('g1', true);
    await src.play();
    src.seek(40000);
    assert.deepEqual(live(ctx).map((n) => n.started.from), [40, 40]);
});

test('a stem that cannot be decoded stays off and the error reaches the caller', async () => {
    const ctx = fakeContext();
    const src = createDecodedMixSource({ id: 'mix', context: ctx, loadStretcher: async () => FakeStretch, base: file('nog', 100), stems: [file('bad', 13)] });
    await src.ready();
    await assert.rejects(src.setPartEnabled('bad', true), /not supported/);
    assert.equal(src.parts()[1].enabled, false);
});

test('levels are kept between 0 and the maximum', async () => {
    const { src } = await make();
    src.setPartLevel('g1', 9);
    assert.equal(src.parts()[1].level, MAX_LEVEL);
    src.setPartLevel('g1', -1);
    assert.equal(src.parts()[1].level, 0);
});

test('at a practice rate one stretcher serves all parts', async () => {
    const { src } = await make();
    await src.setPartEnabled('g1', true);
    FakeStretch.made = 0;
    src.setRate(0.75);
    await src.play();
    assert.equal(FakeStretch.made, 1);
});

test('the base part ending ends the source', async () => {
    const { ctx, src } = await make();
    let ended = 0;
    src.on((e) => { if (e.type === 'ended') ended++; });
    await src.play();
    ctx.sources[0].onended();
    assert.equal(ended, 1);
    assert.equal(src.isPlaying(), false);
});
