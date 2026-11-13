// Run with: node --test tests/audioSync/mtab.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

after(() => {
    setTimeout(() => process.exit(0), 50);
});

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

// Minimal DOM / Web APIs for Node test environment
const lsMap = new Map();
globalThis.localStorage = {
    getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
    setItem: (k, v) => lsMap.set(k, String(v)),
    removeItem: (k) => lsMap.delete(k),
    clear: () => lsMap.clear(),
    key: (i) => Array.from(lsMap.keys())[i] ?? null,
    get length() { return lsMap.size; }
};

const ssMap = new Map();
globalThis.sessionStorage = {
    getItem: (k) => (ssMap.has(k) ? ssMap.get(k) : null),
    setItem: (k, v) => ssMap.set(k, String(v)),
    removeItem: (k) => ssMap.delete(k),
    clear: () => ssMap.clear(),
    key: (i) => Array.from(ssMap.keys())[i] ?? null,
    get length() { return ssMap.size; }
};

if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(name, init = {}) {
            super(name, init);
            this.detail = init.detail;
        }
    };
}

const dummyEl = {
    isConnected: true,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    addEventListener() {},
    removeEventListener() {},
    requestFullscreen() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    insertBefore() {},
    removeChild() {},
    remove() {},
    querySelectorAll: () => [],
    replaceChildren() {},
    append() {},
    closest: () => dummyEl,
    querySelector: () => dummyEl,
    getContext: () => ({ fillRect() {}, clearRect() {} }),
    getBoundingClientRect: () => ({ height: 84, width: 800 })
};

if (typeof globalThis.window === 'undefined') {
    const et = new EventTarget();
    globalThis.window = {
        location: { search: '', href: 'http://localhost/', pathname: '/', hash: '' },
        history: { replaceState() {}, pushState() {} },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        addEventListener: et.addEventListener.bind(et),
        removeEventListener: et.removeEventListener.bind(et),
        dispatchEvent: et.dispatchEvent.bind(et),
        focus: () => {}
    };
}

if (typeof globalThis.document === 'undefined') {
    const et = new EventTarget();
    globalThis.document = {
        readyState: 'loading',
        documentElement: dummyEl,
        body: dummyEl,
        getElementById: () => dummyEl,
        querySelector: () => dummyEl,
        querySelectorAll: () => [],
        createElement: () => dummyEl,
        createElementNS: () => dummyEl,
        addEventListener: et.addEventListener.bind(et),
        removeEventListener: et.removeEventListener.bind(et),
        dispatchEvent: et.dispatchEvent.bind(et)
    };
}

class MockIDBRequest {
    constructor(tx = null) {
        this.onsuccess = null;
        this.onerror = null;
        this.result = null;
        this.error = null;
        this._tx = tx;
    }
    _finish(val) {
        queueMicrotask(() => {
            this.result = val;
            if (this.onsuccess) this.onsuccess({ target: this });
            if (this._tx) this._tx._notifyComplete();
        });
    }
}

class MockObjectStore {
    constructor(dataMap, tx = null) {
        this.dataMap = dataMap;
        this.tx = tx;
    }
    createIndex() {}
    openCursor() {
        const req = new MockIDBRequest(this.tx);
        const items = Array.from(this.dataMap.values());
        let idx = 0;
        const step = () => {
            queueMicrotask(() => {
                if (idx < items.length) {
                    const value = items[idx++];
                    req.result = {
                        value,
                        delete: () => {},
                        continue: () => step()
                    };
                    if (req.onsuccess) req.onsuccess({ target: req });
                } else {
                    req.result = null;
                    if (req.onsuccess) req.onsuccess({ target: req });
                    if (this.tx) this.tx._notifyComplete();
                }
            });
        };
        step();
        return req;
    }
    index(field) {
        return {
            getAll: (query) => {
                const req = new MockIDBRequest(this.tx);
                const all = Array.from(this.dataMap.values());
                req._finish(query !== undefined ? all.filter(item => item[field] === query) : all);
                return req;
            },
            openCursor: () => this.openCursor()
        };
    }
    getAll() {
        const req = new MockIDBRequest(this.tx);
        req._finish(Array.from(this.dataMap.values()));
        return req;
    }
    get(key) {
        const req = new MockIDBRequest(this.tx);
        req._finish(this.dataMap.get(key) || null);
        return req;
    }
    put(value) {
        const req = new MockIDBRequest(this.tx);
        const key = value.id ?? value.key;
        this.dataMap.set(key, value);
        req._finish(key);
        return req;
    }
    delete(key) {
        const req = new MockIDBRequest(this.tx);
        this.dataMap.delete(key);
        req._finish(undefined);
        return req;
    }
    clear() {
        const req = new MockIDBRequest(this.tx);
        this.dataMap.clear();
        req._finish(undefined);
        return req;
    }
}

class MockTransaction {
    constructor(storeMaps) {
        this.storeMaps = storeMaps;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
        this._listeners = { complete: [], error: [], abort: [] };
        this._completed = false;
    }
    addEventListener(type, fn) {
        if (this._listeners[type]) this._listeners[type].push(fn);
    }
    _notifyComplete() {
        queueMicrotask(() => {
            if (this._completed) return;
            this._completed = true;
            if (this.oncomplete) this.oncomplete();
            for (const fn of this._listeners.complete) fn();
        });
    }
    objectStore(name) {
        if (!this.storeMaps.has(name)) {
            this.storeMaps.set(name, new Map());
        }
        return new MockObjectStore(this.storeMaps.get(name), this);
    }
}

class MockDatabase {
    constructor() {
        this.storeMaps = new Map([
            ['stored_files', new Map()],
            ['library_songs', new Map()],
            ['library_collections', new Map()],
            ['library_recents', new Map()],
            ['soundfonts', new Map()],
            ['library_setlists', new Map()],
            ['audio_files', new Map()],
            ['answers', new Map()]
        ]);
        this.objectStoreNames = {
            contains: (name) => this.storeMaps.has(name)
        };
    }
    createObjectStore(name) {
        if (!this.storeMaps.has(name)) {
            this.storeMaps.set(name, new Map());
        }
        return new MockObjectStore(this.storeMaps.get(name));
    }
    transaction(storeNames) {
        return new MockTransaction(this.storeMaps);
    }
}

const mockDb = new MockDatabase();
globalThis.indexedDB = {
    open() {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = mockDb;
            if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
};

const {
    MTAB_FORMAT,
    MTAB_VERSION,
    isMtabFile,
    isMtabBytes,
    normalizeMtabSong,
    buildMtab,
    readMtab,
    unpackMtab,
    applyMtabExtras,
    saveMtabToLibrary
} = await import('../../src/mtab.js');

const { saveAudioFile, getAudioFile } = await import('../../src/audioSync/audioFileStore.js');
const { saveRecord, loadRecord, listRecords } = await import('../../src/audioSync/syncStore.js');
const { songHasLocalSlot, libraryAudioKey, readLibraryAudio } = await import('../../src/audioSync/libraryAudio.js');
const { getSongsByCollection, getSongById, clearAllLibraryData } = await import('../../src/libraryStore.js');

const enc = (s) => encodeURIComponent(String(s).toLowerCase());

function createManualMtabBlob({ song, tabName = 'song.gp', tabBytes, origBytes, backBytes, origPoints = [], backPoints = [] }) {
    const header = {
        format: MTAB_FORMAT,
        version: MTAB_VERSION,
        createdAt: 1794520000000,
        song,
        tab: {
            name: tabName,
            type: 'application/octet-stream',
            size: tabBytes.byteLength
        },
        tuning: null,
        recordings: {},
        sync: [],
        shareSyncFromOriginal: false
    };

    const parts = [tabBytes];
    if (origBytes) {
        header.recordings.original = {
            source: 'local',
            audio: {
                id: 'orig-bundle-id',
                name: 'Original.mp3',
                type: 'audio/mpeg',
                durationMs: 240000,
                fingerprint: 'fp-orig',
                size: origBytes.byteLength
            }
        };
        parts.push(origBytes);
        if (origPoints.length) {
            header.sync.push({
                version: 1,
                media: {
                    kind: 'local',
                    audioId: 'orig-bundle-id',
                    name: 'Original.mp3',
                    durationMs: 240000,
                    fingerprint: 'fp-orig'
                },
                points: origPoints,
                updatedAt: 1794520000000
            });
        }
    }

    if (backBytes) {
        header.recordings.backing = {
            source: 'local',
            audio: {
                id: 'back-bundle-id',
                name: 'Backing.mp3',
                type: 'audio/mpeg',
                durationMs: 240000,
                fingerprint: 'fp-back',
                size: backBytes.byteLength
            }
        };
        parts.push(backBytes);
        if (backPoints.length) {
            header.sync.push({
                version: 1,
                media: {
                    kind: 'local',
                    audioId: 'back-bundle-id',
                    name: 'Backing.mp3',
                    durationMs: 240000,
                    fingerprint: 'fp-back'
                },
                points: backPoints,
                updatedAt: 1794520000000
            });
        }
    }

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, headerBytes.byteLength);
    return new Blob(['MTAB', lenBuf, headerBytes, ...parts], { type: 'application/x-majestictab-song' });
}

test('normalizeMtabSong normalizes direct and nested MusicBrainz IDs', () => {
    const direct = normalizeMtabSong({
        artist: 'Metallica',
        title: 'The Four Horsemen',
        album: "Kill 'Em All",
        year: 1983,
        trackNumber: '2',
        mediumNumber: '1',
        length: 433,
        recordingMbid: 'rec-mbid-123',
        artistMbid: 'art-mbid-456',
        albumMbid: 'alb-mbid-789'
    });
    assert.equal(direct.artist, 'Metallica');
    assert.equal(direct.title, 'The Four Horsemen');
    assert.equal(direct.album, "Kill 'Em All");
    assert.equal(direct.year, 1983);
    assert.equal(direct.trackNumber, 2);
    assert.equal(direct.mediumNumber, 1);
    assert.equal(direct.length, 433);
    assert.equal(direct.recordingMbid, 'rec-mbid-123');
    assert.equal(direct.artistMbid, 'art-mbid-456');
    assert.equal(direct.albumMbid, 'alb-mbid-789');
    assert.deepEqual(direct.musicbrainz, {
        recordingMbid: 'rec-mbid-123',
        artistMbid: 'art-mbid-456',
        albumMbid: 'alb-mbid-789'
    });

    const nested = normalizeMtabSong({
        artist: 'Megadeth',
        title: 'Holy Wars',
        musicbrainz: {
            recordingId: 'rec-999',
            artistId: 'art-888',
            releaseGroupId: 'rg-777'
        }
    });
    assert.equal(nested.recordingMbid, 'rec-999');
    assert.equal(nested.artistMbid, 'art-888');
    assert.equal(nested.albumMbid, 'rg-777');
});

test('buildMtab and readMtab roundtrip MusicBrainz IDs and song metadata', async () => {
    lsMap.clear();
    const tabContent = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const tabFile = new File([tabContent], 'Holy Wars.gp', { type: 'application/octet-stream' });

    const { blob, filename } = await buildMtab(tabFile, {
        songKey: 'Megadeth - Holy Wars',
        song: {
            artist: 'Megadeth',
            title: 'Holy Wars... The Punishment Due',
            album: 'Rust in Peace',
            year: 1990,
            trackNumber: 1,
            mediumNumber: 1,
            length: 392,
            recordingMbid: '11111111-2222-3333-4444-555555555555',
            artistMbid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            albumMbid: '99999999-8888-7777-6666-555555555555'
        }
    });

    assert.equal(filename, 'Megadeth - Holy Wars... The Punishment Due.mtab');
    assert.ok(isMtabFile({ name: filename }));
    assert.ok(isMtabBytes(await blob.arrayBuffer()));

    const { header, tabFile: unpackedTab } = await unpackMtab(blob);
    assert.equal(header.song.artist, 'Megadeth');
    assert.equal(header.song.title, 'Holy Wars... The Punishment Due');
    assert.equal(header.song.album, 'Rust in Peace');
    assert.equal(header.song.year, 1990);
    assert.equal(header.song.trackNumber, 1);
    assert.equal(header.song.recordingMbid, '11111111-2222-3333-4444-555555555555');
    assert.equal(header.song.artistMbid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(header.song.albumMbid, '99999999-8888-7777-6666-555555555555');
    assert.equal(unpackedTab.mtabSong.recordingMbid, '11111111-2222-3333-4444-555555555555');
});

test('unpackMtab and applyMtabExtras populate both original and backing local audio slots and sync points', async () => {
    lsMap.clear();
    const tabBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 10, 20, 30]);
    const origBytes = new Uint8Array(64).fill(0x11);
    const backBytes = new Uint8Array(96).fill(0x22);
    const origPoints = [
        { id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1200, source: 'auto' },
        { id: 'p1', barIndex: 1, occurrence: 0, pos: 0, timeMs: 3400, source: 'auto' }
    ];
    const backPoints = [
        { id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 2100, source: 'auto' },
        { id: 'p1', barIndex: 1, occurrence: 0, pos: 0, timeMs: 4300, source: 'auto' }
    ];

    const mtabBlob = createManualMtabBlob({
        song: { artist: 'Metallica', title: 'The Four Horsemen' },
        tabName: 'Metallica - The Four Horsemen.gp',
        tabBytes,
        origBytes,
        backBytes,
        origPoints,
        backPoints
    });

    const { header, part, tabFile } = await unpackMtab(mtabBlob);
    assert.equal(tabFile.name, 'Metallica - The Four Horsemen.gp');
    assert.equal(tabFile.size, tabBytes.byteLength);

    const mainKey = 'Metallica - The Four Horsemen';
    const aliasKey = 'Not Metallica - The Four Horsemen';
    await applyMtabExtras(header, part, {
        songKey: mainKey,
        aliasKeys: [aliasKey],
        applyToActiveReader: false
    });

    for (const k of [mainKey, aliasKey]) {
        const origId = localStorage.getItem(`audio_file_${enc(k)}_original`);
        const backId = localStorage.getItem(`audio_file_${enc(k)}_backing`);
        assert.ok(origId, `Expected original audio ID for ${k}`);
        assert.ok(backId, `Expected backing audio ID for ${k}`);
        assert.notEqual(origId, backId);
        assert.equal(localStorage.getItem(`real_audio_source_${enc(k)}_original`), 'local');
        assert.equal(localStorage.getItem(`real_audio_source_${enc(k)}_backing`), 'local');

        const origRec = await getAudioFile(origId);
        const backRec = await getAudioFile(backId);
        assert.equal(origRec.size, origBytes.byteLength);
        assert.equal(backRec.size, backBytes.byteLength);
        assert.ok(origRec.songKeys.includes(mainKey));
        assert.ok(origRec.songKeys.includes(aliasKey));

        const origSync = loadRecord(k, { kind: 'local', audioId: origId });
        const backSync = loadRecord(k, { kind: 'local', audioId: backId });
        assert.equal(origSync?.points?.length, 2);
        assert.equal(origSync.points[0].timeMs, 1200);
        assert.equal(backSync?.points?.length, 2);
        assert.equal(backSync.points[0].timeMs, 2100);
    }
});

test('saveMtabToLibrary queries MusicBrainz by IDs to add a new song in proper album/artist hierarchy, and merges when saving another .mtab for the same song', async () => {
    lsMap.clear();
    ssMap.clear();
    await clearAllLibraryData();

    const REC_MBID = 'b3b1e8c4-0000-4000-8000-000000000001';
    const ART_MBID = '65f4f0c5-ef9e-490c-aee3-909e7ae6b2ab';
    const ALB_MBID = '7f935664-f0c1-334a-9e2e-2e57c0f15d91';
    const REL_MBID = '12345678-f0c1-334a-9e2e-2e57c0f15d91';

    const originalFetch = globalThis.fetch;
    const fetchedUrls = [];
    globalThis.fetch = async (url) => {
        fetchedUrls.push(String(url));
        if (String(url).includes(`/recording/${REC_MBID}`)) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    id: REC_MBID,
                    title: 'The Four Horsemen',
                    length: 433000,
                    'first-release-date': '1983-07-25',
                    'artist-credit': [
                        { name: 'Metallica', artist: { id: ART_MBID, name: 'Metallica' } }
                    ],
                    releases: [
                        {
                            id: REL_MBID,
                            title: "Kill 'Em All",
                            status: 'Official',
                            country: 'US',
                            date: '1983-07-25',
                            'release-group': {
                                id: ALB_MBID,
                                title: "Kill 'Em All",
                                'primary-type': 'Album',
                                'secondary-types': []
                            },
                            media: [
                                {
                                    position: 1,
                                    format: 'CD',
                                    tracks: [{ position: 2, number: '2', title: 'The Four Horsemen' }]
                                }
                            ]
                        }
                    ]
                })
            };
        }
        throw new Error(`Unexpected fetch URL in test: ${url}`);
    };

    try {
        // 1. ADD CASE: Save first .mtab carrying only recordingMbid (and basic title/artist)
        const tab1Bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 1, 1]);
        const orig1Bytes = new Uint8Array(48).fill(0x33);
        const back1Bytes = new Uint8Array(48).fill(0x44);
        const mtab1 = createManualMtabBlob({
            song: {
                artist: 'Metallica',
                title: 'The Four Horsemen',
                recordingMbid: REC_MBID,
                artistMbid: ART_MBID,
                albumMbid: ALB_MBID
            },
            tabName: 'The Four Horsemen (Ver 1).gp',
            tabBytes: tab1Bytes,
            origBytes: orig1Bytes,
            backBytes: back1Bytes,
            origPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1120, source: 'auto' }],
            backPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 2050, source: 'auto' }]
        });

        const addResult = await saveMtabToLibrary(mtab1);
        assert.equal(addResult.created, true);
        assert.equal(addResult.merged, false);
        assert.ok(fetchedUrls.some(u => u.includes(`/recording/${REC_MBID}`)), 'Expected MusicBrainz recording lookup by ID');

        const songAfterAdd = await getSongById(addResult.song.id);
        assert.ok(songAfterAdd);
        assert.equal(songAfterAdd.artist, 'Metallica');
        assert.equal(songAfterAdd.title, 'The Four Horsemen');
        assert.equal(songAfterAdd.album, "Kill 'Em All");
        assert.equal(songAfterAdd.year, 1983);
        assert.equal(songAfterAdd.trackNumber, 2);
        assert.equal(songAfterAdd.length, 433);
        assert.equal(songAfterAdd.recordingMbid, REC_MBID);
        assert.equal(songAfterAdd.artistMbid, ART_MBID);
        assert.equal(songAfterAdd.albumMbid, ALB_MBID);
        assert.equal(songAfterAdd.tabOptions.length, 1);
        assert.equal(songAfterAdd.tabOptions[0].name, 'The Four Horsemen (Ver 1).gp');
        assert.ok(songHasLocalSlot(libraryAudioKey(songAfterAdd), 'original'));
        assert.ok(songHasLocalSlot(libraryAudioKey(songAfterAdd), 'backing'));
        assert.equal(readLibraryAudio(songAfterAdd.id).length, 2);

        // 2. MERGE CASE: Save second .mtab for the same song (matching by recordingMbid)
        const tab2Bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 2, 2, 2]);
        const mtab2 = createManualMtabBlob({
            song: {
                artist: 'Metallica',
                title: 'The Four Horsemen',
                recordingMbid: REC_MBID
            },
            tabName: 'The Four Horsemen (Ver 2).gp',
            tabBytes: tab2Bytes
        });

        const mergeResult = await saveMtabToLibrary(mtab2);
        assert.equal(mergeResult.merged, true);
        assert.equal(mergeResult.created, false);
        assert.equal(mergeResult.song.id, songAfterAdd.id);

        const allSongs = await getSongsByCollection();
        assert.equal(allSongs.length, 1, 'Should merge into existing song rather than creating a duplicate');
        const songAfterMerge = await getSongById(songAfterAdd.id);
        assert.equal(songAfterMerge.tabOptions.length, 2);
        assert.deepEqual(
            songAfterMerge.tabOptions.map(t => t.name),
            ['The Four Horsemen (Ver 1).gp', 'The Four Horsemen (Ver 2).gp']
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('handleDownloadedTabFile unpacks .mtab download and attaches inner tab and both audio slots to target song', async () => {
    lsMap.clear();
    await clearAllLibraryData();
    globalThis.window.__TAURI__ = {
        core: { invoke: async () => false },
        event: { listen: async () => () => {} }
    };

    const { saveSongToLibrary } = await import('../../src/libraryStore.js');
    const { openTabDownloader, handleDownloadedTabFile } = await import('../../src/tabDownloader.js');

    const targetSong = await saveSongToLibrary({
        id: 'song_metallica_master',
        title: 'Master of Puppets',
        artist: 'Metallica',
        album: 'Master of Puppets',
        year: 1986
    });

    await openTabDownloader({ artist: 'Metallica', songName: 'Master of Puppets', targetSong });

    const tabBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
    const origBytes = new Uint8Array(64).fill(0x55);
    const backBytes = new Uint8Array(64).fill(0x66);
    const mtabBlob = createManualMtabBlob({
        song: { artist: 'Metallica', title: 'Master of Puppets' },
        tabName: 'Metallica - Master of Puppets.gp',
        tabBytes,
        origBytes,
        backBytes,
        origPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 800, source: 'auto' }],
        backPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1500, source: 'auto' }]
    });
    const mtabUint8 = new Uint8Array(await mtabBlob.arrayBuffer());

    await handleDownloadedTabFile('Metallica - Master of Puppets.mtab', mtabUint8);

    const updatedSong = await getSongById(targetSong.id);
    assert.equal(updatedSong.tabOptions.length, 1);
    assert.equal(updatedSong.tabOptions[0].name, 'Metallica - Master of Puppets.gp');
    assert.equal(updatedSong.tabOptions[0].fileType, 'gp');

    const songKey = 'Metallica - Master of Puppets';
    const origId = localStorage.getItem(`audio_file_${enc(songKey)}_original`);
    const backId = localStorage.getItem(`audio_file_${enc(songKey)}_backing`);
    assert.ok(origId, 'Expected original slot audio ID after .mtab download');
    assert.ok(backId, 'Expected backing slot audio ID after .mtab download');
    assert.equal(loadRecord(songKey, { kind: 'local', audioId: origId })?.points?.[0]?.timeMs, 800);
    assert.equal(loadRecord(songKey, { kind: 'local', audioId: backId })?.points?.[0]?.timeMs, 1500);
});
