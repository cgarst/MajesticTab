// Run with: node --test tests/audioSync/audioBackup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads preferences from localStorage; give Node a small one
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

const {
    AUDIO_BACKUP_STORE, AUDIO_SYNC_ACTION, audioManifestEntry, audioItemFingerprint, audioSyncDecision, isAudioItem,
    isAudioDownloadEnabled, setAudioDownloadEnabled
} = await import('../../src/audioSync/audioBackup.js');

const meta = { id: 'a1', name: 'take.mp3', type: 'audio/mpeg', size: 1234, durationMs: 60000, fingerprint: 'ff00', songKeys: ['Song'], savedAt: 99, peaks: new Uint8Array(4), data: new ArrayBuffer(1) };

test('a snapshot entry carries what relinking needs and never the audio or the waveform', () => {
    const e = audioManifestEntry(meta, 'abc123');
    assert.deepEqual(e, { store: 'audio', id: 'a1', name: 'take.mp3', type: 'audio/mpeg', size: 1234, durationMs: 60000, fingerprint: 'ff00', songKeys: ['Song'], savedAt: 99, blob: 'abc123' });
    assert.ok(isAudioItem(e));
    assert.ok(!isAudioItem({ store: 'soundfonts' }));
    assert.ok(!isAudioItem({ id: 'tab' }));
    assert.equal(AUDIO_BACKUP_STORE, 'audio');
});

test('the change detector follows content and size, not names or times', () => {
    assert.equal(audioItemFingerprint(meta), '1234:ff00');
    assert.equal(audioItemFingerprint({ ...meta, name: 'renamed.mp3', savedAt: 5 }), audioItemFingerprint(meta));
    assert.notEqual(audioItemFingerprint({ ...meta, fingerprint: 'ff01' }), audioItemFingerprint(meta));
    assert.notEqual(audioItemFingerprint({ ...meta, size: 1235 }), audioItemFingerprint(meta));
});

test('receiving audio is on until turned off', () => {
    assert.ok(isAudioDownloadEnabled());
    setAudioDownloadEnabled(false);
    assert.ok(!isAudioDownloadEnabled());
    setAudioDownloadEnabled(true);
});

const item = (fingerprint, time = 0) => ({ fingerprint, time });

test('sync decision: new files move in the obvious direction', () => {
    assert.equal(audioSyncDecision(item('a'), null, undefined, true).action, 'upload');
    assert.equal(audioSyncDecision(null, item('a'), undefined, true).action, 'download');
    assert.equal(audioSyncDecision(null, item('a'), undefined, false), null);          // this device takes no audio
    assert.equal(audioSyncDecision(item('a'), item('a'), 'a', true), null);
});

test('sync decision never deletes a local file', () => {
    // The snapshot lost a file this device still has: it goes back in, it is not removed here
    const lost = audioSyncDecision(item('a'), null, 'a', true);
    assert.equal(lost.action, 'upload');
    // Removed here since the last sync: dropped from the next snapshot, nothing else
    assert.equal(audioSyncDecision(null, item('a'), 'a', true).action, 'delete-remote');
    for (const was of [undefined, 'a', 'b']) {
        for (const allow of [true, false]) {
            for (const [mine, theirs] of [[item('a'), item('a')], [item('a'), item('b')], [item('a'), null], [null, item('a')]]) {
                const d = audioSyncDecision(mine, theirs, was, allow);
                assert.notEqual(d?.action, 'delete-local');
            }
        }
    }
});

test('sync decision: the same id with different audio goes to the newer side, and never overwrites when downloads are off', () => {
    assert.equal(audioSyncDecision(item('a', 10), item('b', 5), 'x', true).action, 'upload');
    assert.equal(audioSyncDecision(item('a', 5), item('b', 10), 'x', true).action, 'download');
    assert.equal(audioSyncDecision(item('a', 5), item('b', 10), 'x', false).action, 'upload');
    assert.ok(audioSyncDecision(item('a', 5), item('b', 10), 'x', true).conflict);
});

test('its action names are the ones the sync engine defines', () => {
    // SYNC_ACTION in syncEngine.js: upload, download, delete-local, delete-remote (the engine needs a browser to load)
    assert.deepEqual(AUDIO_SYNC_ACTION, { UPLOAD: 'upload', DOWNLOAD: 'download', DELETE_REMOTE: 'delete-remote' });
});
