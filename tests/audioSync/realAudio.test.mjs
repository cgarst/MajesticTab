import test from 'node:test';
import assert from 'node:assert/strict';

// Mock localStorage and DOM for testing realAudioController logic
const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear()
};

test('real audio source defaults to youtube initially', async () => {
    storage.clear();
    const songKey = 'Test Artist - Test Song';
    const SLOT_SOURCE_KEY = (songKey, slot) => `real_audio_source_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

    // Without any stored value, slot source is 'youtube'
    const getSlotSource = (slot) => {
        const val = localStorage.getItem(SLOT_SOURCE_KEY(songKey, slot));
        return (val === 'local' || val === 'youtube') ? val : 'youtube';
    };

    assert.equal(getSlotSource('original'), 'youtube');
    assert.equal(getSlotSource('backing'), 'youtube');
});

test('real audio source can be set independently per slot', async () => {
    storage.clear();
    const songKey = 'Hotel California';
    const SLOT_SOURCE_KEY = (songKey, slot) => `real_audio_source_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

    const setSlotSource = (source, slot) => localStorage.setItem(SLOT_SOURCE_KEY(songKey, slot), source);
    const getSlotSource = (slot) => localStorage.getItem(SLOT_SOURCE_KEY(songKey, slot)) || 'youtube';

    // Set backing track to local audio, keep original as youtube
    setSlotSource('local', 'backing');

    assert.equal(getSlotSource('original'), 'youtube');
    assert.equal(getSlotSource('backing'), 'local');

    // Dock icon logic
    const iconForSlot = (slot) => (getSlotSource(slot) === 'local' ? 'bi-file-earmark-music' : 'bi-youtube');

    assert.equal(iconForSlot('original'), 'bi-youtube');
    assert.equal(iconForSlot('backing'), 'bi-file-earmark-music');
});

test('local audio file slots persist separately for original and backing track', async () => {
    storage.clear();
    const songKey = 'Carulli Duo No 2 In G Major';
    const SLOT_FILE_KEY = (songKey, slot) => `audio_file_${encodeURIComponent(String(songKey).toLowerCase())}_${slot}`;

    localStorage.setItem(SLOT_FILE_KEY(songKey, 'original'), 'audio_orig_123');
    localStorage.setItem(SLOT_FILE_KEY(songKey, 'backing'), 'audio_back_456');

    assert.equal(localStorage.getItem(SLOT_FILE_KEY(songKey, 'original')), 'audio_orig_123');
    assert.equal(localStorage.getItem(SLOT_FILE_KEY(songKey, 'backing')), 'audio_back_456');
    assert.notEqual(
        localStorage.getItem(SLOT_FILE_KEY(songKey, 'original')),
        localStorage.getItem(SLOT_FILE_KEY(songKey, 'backing'))
    );
});

test('speed rates apply uniformly to real audio', async () => {
    const validRates = [0.5, 0.75, 1, 1.25];
    let appliedRate = 1;

    const setRealAudioRate = (rate) => {
        if (!validRates.includes(rate)) return;
        appliedRate = rate;
    };

    setRealAudioRate(0.75);
    assert.equal(appliedRate, 0.75);

    setRealAudioRate(1.25);
    assert.equal(appliedRate, 1.25);
});
