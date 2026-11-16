// Run with: node --test tests/audioSync/localMixSource.test.mjs
// The streaming mix source on fake HTMLAudioElements: checks lazy loading, drift sync, rate/seek/play/pause, and levels.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
after(() => {
    setTimeout(() => process.exit(0), 50);
});

import { createLocalMixSource } from '../../src/audioSync/localMixSource.js';
import { MAX_LEVEL } from '../../src/audioSync/decodedMixSource.js';

function fakeAudioFactory() {
    const created = [];
    function createAudio() {
        const listeners = new Map();
        const audio = {
            readyState: 0,
            duration: 1416.779,
            currentTime: 0,
            playbackRate: 1,
            paused: true,
            ended: false,
            seeking: false,
            muted: false,
            volume: 1,
            _src: '',
            removed: false,
            addEventListener(type, cb) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(cb);
            },
            removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
            emit(type) { listeners.get(type)?.forEach((cb) => cb()); },
            set src(v) {
                audio._src = v;
                queueMicrotask(() => {
                    if (audio.removed) return;
                    audio.readyState = 1;
                    audio.emit('loadedmetadata');
                });
            },
            get src() { return audio._src; },
            removeAttribute(attr) { if (attr === 'src') { audio._src = ''; audio.removed = true; } },
            load() {},
            async play() { audio.paused = false; audio.emit('play'); },
            pause() { if (!audio.paused) { audio.paused = true; audio.emit('pause'); } },
        };
        created.push(audio);
        return audio;
    }
    return { createAudio, created };
}

function fakeContext() {
    const gains = [];
    return {
        state: 'running',
        destination: { kind: 'destination' },
        gains,
        resume: async () => {},
        createGain() {
            const g = { gain: { value: 1 }, connect() {}, disconnect() {} };
            gains.push(g);
            return g;
        },
        createMediaElementSource() {
            return { connect() {}, disconnect() {} };
        },
    };
}

const file = (id, ms = 1416779) => ({ id, name: id, type: 'audio/mp4', data: new ArrayBuffer(8), durationMs: ms });

test('ready loads only the base part and exposes all parts', async () => {
    const { createAudio, created } = fakeAudioFactory();
    const src = createLocalMixSource({
        id: 'guitar-1',
        base: file('guitar-1'),
        stems: [file('bass'), file('drums')],
        mutableBase: true,
        context: fakeContext(),
        createAudio,
    });
    const dur = await src.ready();
    assert.ok(Math.abs(dur - 1416779) < 1);
    assert.equal(created.length, 1);
    assert.deepEqual(src.parts().map((p) => [p.id, p.enabled]), [
        ['guitar-1', true],
        ['bass', false],
        ['drums', false],
    ]);
    src.destroy();
});

test('setPartEnabled loads stems lazily, syncs play/seek/rate/drift, and tears down on mute', async () => {
    const { createAudio, created } = fakeAudioFactory();
    const ctx = fakeContext();
    const src = createLocalMixSource({
        id: 'guitar-1',
        base: file('guitar-1'),
        stems: [file('bass')],
        mutableBase: true,
        context: ctx,
        createAudio,
    });
    await src.ready();
    await src.setPartEnabled('bass', true);
    assert.equal(created.length, 2);

    await src.play();
    assert.equal(created[0].paused, false);
    assert.equal(created[1].paused, false);

    src.seek(120_000);
    assert.equal(created[0].currentTime, 120);
    assert.equal(created[1].currentTime, 120);

    src.setRate(0.75);
    assert.equal(created[0].playbackRate, 0.75);
    assert.equal(created[1].playbackRate, 0.75);

    // Simulate drift on secondary stem
    created[0].currentTime = 125;
    created[1].currentTime = 125.2;
    created[0].emit('timeupdate');
    assert.equal(created[1].currentTime, 125);

    // Muting secondary stem tears it down
    await src.setPartEnabled('bass', false);
    assert.equal(created[1].paused, true);
    assert.equal(created[1].removed, true);

    // Muting base part when mutableBase: true silences its gain without tearing it down
    await src.setPartEnabled('guitar-1', false);
    assert.equal(created[0].removed, false);
    assert.equal(ctx.gains[1].gain.value, 0);

    src.destroy();
});

test('setPartLevel clamps to MAX_LEVEL and ended stops secondary stems', async () => {
    const { createAudio, created } = fakeAudioFactory();
    const ctx = fakeContext();
    const src = createLocalMixSource({
        id: 'guitar-1',
        base: file('guitar-1'),
        stems: [file('bass')],
        mutableBase: true,
        context: ctx,
        createAudio,
    });
    await src.ready();
    await src.setPartEnabled('bass', true);
    await src.play();

    src.setPartLevel('bass', 5);
    assert.equal(src.parts().find((p) => p.id === 'bass').level, MAX_LEVEL);
    assert.equal(ctx.gains[2].gain.value, MAX_LEVEL);

    let ended = false;
    src.on((e) => { if (e.type === 'ended') ended = true; });
    created[0].ended = true;
    created[0].emit('ended');
    assert.equal(ended, true);
    assert.equal(created[1].paused, true);

    src.destroy();
});
