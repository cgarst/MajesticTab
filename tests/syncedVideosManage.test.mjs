// tests/syncedVideosManage.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

after(() => {
    setTimeout(() => process.exit(0), 50);
});

// Mock DOM
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.MutationObserver = class { observe() {} disconnect() {} };

const dummyEl = {
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    removeChild() {},
    querySelectorAll: () => [],
    replaceChildren() {},
    closest: () => dummyEl,
    querySelector: () => dummyEl,
    getBoundingClientRect: () => ({ height: 50, width: 200, bottom: 50, left: 100 })
};

global.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
};

global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    location: { href: 'http://localhost/', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    innerWidth: 1024,
    innerHeight: 768
};

global.document = {
    documentElement: dummyEl,
    body: dummyEl,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => dummyEl,
    querySelector: () => dummyEl,
    querySelectorAll: () => [],
    createElement: () => dummyEl
};

let store = {};
global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; }
};

const { extractSourceWebsite } = await import('../src/tabDownloader.js');
const {
    saveRecord,
    loadRecord,
    deleteRecord,
    listRecords
} = await import('../src/audioSync/syncStore.js');
const {
    getSongKey,
    getSyncedVideos,
    getSiblingSyncedVideos,
    copySyncedVideoFromSibling,
    deleteSyncedVideos,
    updateSongForYouTube,
    playerState
} = await import('../src/youtubePlayer.js');

test('extractSourceWebsite extracts friendly names and clean hostnames', () => {
    store = {};
    assert.equal(extractSourceWebsite('https://www.google.com/search?q=tab'), 'Google');
    assert.equal(extractSourceWebsite('https://duckduckgo.com/?q=tab'), 'DuckDuckGo');
    assert.equal(extractSourceWebsite('https://www.example.com/scores/123'), 'example.com');
    assert.equal(extractSourceWebsite('https://sub.domain.org/path/file.gp5'), 'sub.domain.org');
    assert.equal(extractSourceWebsite('not a url'), null);
    assert.equal(extractSourceWebsite(null), null);
});

test('getSyncedVideos returns only own synced videos and does not mix in sibling tabs automatically', async () => {
    store = {};
    const songId = 'song_123';

    // Simulate Tab A
    updateSongForYouTube({
        filename: 'Duo No 2 (Guitar 1).gp5',
        scoreTitle: 'Duo No 2 - Guitar 1',
        scoreArtist: 'Carulli',
        librarySongId: songId,
        tabName: 'Guitar 1',
        sourceWebsite: 'example.com'
    });
    const keyA = getSongKey();
    saveRecord(keyA, { kind: 'youtube', videoId: 'vidA1', label: 'Guitar 1 Video' }, [
        { barIndex: 0, timeMs: 1000 }
    ]);

    // Simulate Tab B
    updateSongForYouTube({
        filename: 'Duo No 2 (Guitar 2).gp5',
        scoreTitle: 'Duo No 2 - Guitar 2',
        scoreArtist: 'Carulli',
        librarySongId: songId,
        tabName: 'Guitar 2',
        sourceWebsite: 'other.com'
    });
    const keyB = getSongKey();
    saveRecord(keyB, { kind: 'youtube', videoId: 'vidB1', label: 'Guitar 2 Video' }, [
        { barIndex: 0, timeMs: 1200 },
        { barIndex: 1, timeMs: 2400 }
    ]);

    // Tab B's own synced videos should ONLY contain vidB1, not vidA1!
    const ownVideos = getSyncedVideos();
    assert.equal(ownVideos.length, 1);
    assert.equal(ownVideos[0].videoId, 'vidB1');
    assert.equal(ownVideos[0].own, true);

    // Sibling videos should offer vidA1 with origin indicating Tab A
    const siblingVideos = await getSiblingSyncedVideos();
    assert.equal(siblingVideos.length, 1);
    assert.equal(siblingVideos[0].videoId, 'vidA1');
    assert.equal(siblingVideos[0].originTabName, 'Guitar 1');
    assert.equal(siblingVideos[0].originSongKey, keyA);
    assert.equal(siblingVideos[0].originSourceWebsite, 'example.com');
});

test('copySyncedVideoFromSibling copies video and sync points with origin metadata', async () => {
    store = {};
    const songId = 'song_test_copy';

    // Set up sibling tab A
    updateSongForYouTube({
        filename: 'TabA.gp5',
        scoreTitle: 'Song A',
        scoreArtist: 'Artist',
        librarySongId: songId,
        tabName: 'Tab A Version',
        sourceWebsite: 'tabs.example'
    });
    const keyA = getSongKey();
    saveRecord(keyA, { kind: 'youtube', videoId: 'vid_sibling', label: 'Live Video' }, [
        { barIndex: 0, timeMs: 1000 },
        { barIndex: 2, timeMs: 3000 }
    ]);

    // Switch to active tab B
    updateSongForYouTube({
        filename: 'TabB.gp5',
        scoreTitle: 'Song B',
        scoreArtist: 'Artist',
        librarySongId: songId,
        tabName: 'Tab B Version'
    });

    const siblings = await getSiblingSyncedVideos();
    assert.equal(siblings.length, 1);

    // Copy from sibling tab
    const copied = copySyncedVideoFromSibling(siblings[0]);
    assert.equal(copied, true);

    // Verify it is now in active tab's own synced videos with origin
    const ownVideos = getSyncedVideos();
    assert.equal(ownVideos.length, 1);
    assert.equal(ownVideos[0].videoId, 'vid_sibling');
    assert.deepEqual(ownVideos[0].origin.fromTabName, 'Tab A Version');
    assert.deepEqual(ownVideos[0].origin.fromSongKey, keyA);
    assert.deepEqual(ownVideos[0].origin.fromSourceWebsite, 'tabs.example');
    assert.ok(typeof ownVideos[0].origin.copiedAt === 'number');

    // And now getSiblingSyncedVideos should not offer it again since active tab already has it
    const updatedSiblings = await getSiblingSyncedVideos();
    assert.equal(updatedSiblings.length, 0);
});

test('deleteSyncedVideos supports multi-select deletion of videos and associated sync points', () => {
    store = {};

    updateSongForYouTube({
        filename: 'MultiDelete.gp5',
        scoreTitle: 'Multi Delete Test',
        scoreArtist: 'Artist'
    });
    const key = getSongKey();

    // Create 3 synced videos
    saveRecord(key, { kind: 'youtube', videoId: 'v1', label: 'Video 1' }, [{ barIndex: 0, timeMs: 1000 }]);
    saveRecord(key, { kind: 'youtube', videoId: 'v2', label: 'Video 2' }, [{ barIndex: 0, timeMs: 2000 }]);
    saveRecord(key, { kind: 'youtube', videoId: 'v3', label: 'Video 3' }, [{ barIndex: 0, timeMs: 3000 }]);

    assert.equal(getSyncedVideos().length, 3);

    // Delete two of them: v1 and v3
    const deletedCount = deleteSyncedVideos(['v1', 'v3']);
    assert.equal(deletedCount, 2);

    // Verify only v2 remains in getSyncedVideos and listRecords
    const remaining = getSyncedVideos();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].videoId, 'v2');

    const records = listRecords(key);
    assert.equal(records.length, 1);
    assert.equal(records[0].media.videoId, 'v2');

    // Delete the last one
    deleteSyncedVideos(['v2']);
    assert.equal(getSyncedVideos().length, 0);
    assert.equal(listRecords(key).length, 0);
});
