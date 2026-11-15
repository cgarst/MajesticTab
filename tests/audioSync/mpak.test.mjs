// Run with: node --test tests/audioSync/mpak.test.mjs
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
    MPAK_FORMAT,
    MPAK_VERSION,
    isMpakFile,
    isMpakBytes,
    normalizeMpakSong,
    buildMpak,
    readMpak,
    unpackMpak,
    applyMpakExtras,
    saveMpakToLibrary
} = await import('../../src/mpak.js');

const {
    MEDIA_TYPE,
    MpakError,
    sha256,
    buildMpak: coreBuildMpak,
} = await import('../../src/mpak/core/index.js');

const { scoreSyncKey, legacyScoreSyncKey } = await import('../../src/audioSync/anchors.js');
const { saveAudioFile, getAudioFile, getAudioMeta, linkAudioFile } = await import('../../src/audioSync/audioFileStore.js');
const { saveRecord, loadRecord, listRecords } = await import('../../src/audioSync/syncStore.js');
const { songHasLocalSlot, libraryAudioKey, readLibraryAudio } = await import('../../src/audioSync/libraryAudio.js');
const { getSongsByCollection, getSongById, clearAllLibraryData } = await import('../../src/libraryStore.js');

const enc = (s) => encodeURIComponent(String(s).toLowerCase());

async function createManualMpakBlob({ song, tabName = 'song.gp', tabBytes, origBytes, backBytes, origPoints = [], backPoints = [] }) {
    const ext = tabName.split('.').pop().toLowerCase();
    const tabPath = `score/${tabName}`;
    const files = new Map([[tabPath, tabBytes]]);
    const mb = {};
    if (song?.recordingMbid) mb.recording = song.recordingMbid;
    if (song?.artistMbid) mb.artist = song.artistMbid;
    if (song?.albumMbid) mb.releaseGroup = song.albumMbid;
    const manifest = {
        format: MPAK_FORMAT,
        version: MPAK_VERSION,
        createdAt: '2026-11-14T12:00:00Z',
        song: {
            ...(song?.artist ? { artist: song.artist } : {}),
            ...(song?.title ? { title: song.title } : {}),
            ...(song?.album ? { album: song.album } : {}),
            ...(Object.keys(mb).length ? { ids: { musicbrainz: mb } } : {}),
        },
        scores: [{
            id: ext,
            path: tabPath,
            format: ext,
            sha256: await sha256(tabBytes),
            name: tabName,
        }],
        recordings: [],
    };

    const addSlot = async (id, bytes, name, points) => {
        if (!bytes) return;
        const audioPath = `audio/${name}`;
        files.set(audioPath, bytes);
        const rec = {
            id,
            role: id,
            sources: [{
                type: 'file',
                path: audioPath,
                mime: 'audio/mpeg',
                sha256: await sha256(bytes),
                durationMs: 240000,
            }],
        };
        if (points.length) {
            const syncPath = `sync/${id}.json`;
            const syncDoc = {
                version: 1,
                recording: id,
                score: ext,
                anchorType: 'bar',
                updatedAt: '2026-11-14T12:00:00Z',
                points: points.map((p) => ({
                    id: p.id,
                    timeMs: p.timeMs,
                    bar: p.barIndex,
                    occurrence: p.occurrence ?? 0,
                    pos: p.pos ?? 0,
                    source: p.source || 'manual',
                })),
            };
            files.set(syncPath, new TextEncoder().encode(JSON.stringify(syncDoc)));
            rec.sync = { [ext]: syncPath };
        }
        manifest.recordings.push(rec);
    };

    await addSlot('original', origBytes, 'Original.mp3', origPoints);
    await addSlot('backing', backBytes, 'Backing.mp3', backPoints);

    const { parts } = await coreBuildMpak(manifest, files);
    return new Blob(parts, { type: MEDIA_TYPE });
}

test('normalizeMpakSong normalizes direct and nested MusicBrainz IDs', () => {
    const direct = normalizeMpakSong({
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

    const nested = normalizeMpakSong({
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

test('buildMpak and readMpak roundtrip MusicBrainz IDs and song metadata', async () => {
    lsMap.clear();
    const tabContent = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const tabFile = new File([tabContent], 'Holy Wars.gp', { type: 'application/octet-stream' });

    const { blob, filename } = await buildMpak(tabFile, {
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

    assert.equal(filename, 'Megadeth - Holy Wars... The Punishment Due.mpak');
    assert.ok(isMpakFile({ name: filename }));
    assert.ok(await isMpakBytes(await blob.arrayBuffer()));
    assert.ok(!(await isMpakBytes(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))));
    assert.ok(!(await isMpakBytes(new Uint8Array(8))));

    const { header, tabFile: unpackedTab } = await unpackMpak(blob);
    assert.equal(header.song.artist, 'Megadeth');
    assert.equal(header.song.title, 'Holy Wars... The Punishment Due');
    assert.equal(header.song.album, 'Rust in Peace');
    assert.equal(header.song.year, 1990);
    assert.equal(header.song.trackNumber, 1);
    assert.equal(header.song.recordingMbid, '11111111-2222-3333-4444-555555555555');
    assert.equal(header.song.artistMbid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(header.song.albumMbid, '99999999-8888-7777-6666-555555555555');
    assert.equal(unpackedTab.mpakSong.recordingMbid, '11111111-2222-3333-4444-555555555555');
});

test('unpackMpak and applyMpakExtras populate both original and backing local audio slots and sync points', async () => {
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

    const mpakBlob = await createManualMpakBlob({
        song: { artist: 'Metallica', title: 'The Four Horsemen' },
        tabName: 'Metallica - The Four Horsemen.gp',
        tabBytes,
        origBytes,
        backBytes,
        origPoints,
        backPoints
    });

    const { header, part, tabFile } = await unpackMpak(mpakBlob);
    assert.equal(tabFile.name, 'Metallica - The Four Horsemen.gp');
    assert.equal(tabFile.size, tabBytes.byteLength);

    const mainKey = 'Metallica - The Four Horsemen';
    const aliasKey = 'Not Metallica - The Four Horsemen';
    await applyMpakExtras(header, part, {
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

test('saveMpakToLibrary queries MusicBrainz by IDs to add a new song in proper album/artist hierarchy, and merges when saving another .mpak for the same song', async () => {
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
        // 1. ADD CASE: Save first .mpak carrying only recordingMbid (and basic title/artist)
        const tab1Bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 1, 1]);
        const orig1Bytes = new Uint8Array(48).fill(0x33);
        const back1Bytes = new Uint8Array(48).fill(0x44);
        const mpak1 = await createManualMpakBlob({
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

        const addResult = await saveMpakToLibrary(mpak1);
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

        // 2. MERGE CASE: Save second .mpak for the same song (matching by recordingMbid)
        const tab2Bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 2, 2, 2]);
        const mpak2 = await createManualMpakBlob({
            song: {
                artist: 'Metallica',
                title: 'The Four Horsemen',
                recordingMbid: REC_MBID
            },
            tabName: 'The Four Horsemen (Ver 2).gp',
            tabBytes: tab2Bytes
        });

        const mergeResult = await saveMpakToLibrary(mpak2);
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

test('handleDownloadedTabFile unpacks .mpak download and attaches inner tab and both audio slots to target song', async () => {
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
    const mpakBlob = await createManualMpakBlob({
        song: { artist: 'Metallica', title: 'Master of Puppets' },
        tabName: 'Metallica - Master of Puppets.gp',
        tabBytes,
        origBytes,
        backBytes,
        origPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 800, source: 'auto' }],
        backPoints: [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1500, source: 'auto' }]
    });
    const mpakUint8 = new Uint8Array(await mpakBlob.arrayBuffer());

    await handleDownloadedTabFile('Metallica - Master of Puppets.mpak', mpakUint8);

    const updatedSong = await getSongById(targetSong.id);
    assert.equal(updatedSong.tabOptions.length, 1);
    assert.equal(updatedSong.tabOptions[0].name, 'Metallica - Master of Puppets.gp');
    assert.equal(updatedSong.tabOptions[0].fileType, 'gp');

    const songKey = 'Metallica - Master of Puppets';
    const origId = localStorage.getItem(`audio_file_${enc(songKey)}_original`);
    const backId = localStorage.getItem(`audio_file_${enc(songKey)}_backing`);
    assert.ok(origId, 'Expected original slot audio ID after .mpak download');
    assert.ok(backId, 'Expected backing slot audio ID after .mpak download');
    assert.equal(loadRecord(songKey, { kind: 'local', audioId: origId })?.points?.[0]?.timeMs, 800);
    assert.equal(loadRecord(songKey, { kind: 'local', audioId: backId })?.points?.[0]?.timeMs, 1500);
});

test('system-browser openTabDownloader records pending target and missingTabsTool serializes batch payloads', async () => {
    lsMap.clear();
    let openedUrl = null;
    globalThis.window.__TAURI__ = {
        core: { invoke: async () => false },
        event: { listen: async () => () => {} },
        opener: { openUrl: async (url) => { openedUrl = url; } }
    };
    localStorage.setItem('majestictab_web_search_browser', 'system');

    const { openTabDownloader } = await import('../../src/tabDownloader.js');
    await openTabDownloader({
        artist: 'Metallica',
        songName: 'Orion',
        songId: 'song_orion_1',
        collectionId: 'default'
    });

    assert.ok(openedUrl, 'Expected system browser opener to be called');
    const pending = JSON.parse(localStorage.getItem('majestictab_pending_browser_target') || 'null');
    assert.equal(pending?.songId, 'song_orion_1');
    assert.equal(pending?.artist, 'Metallica');
    assert.equal(pending?.title, 'Orion');

    const { serializeMissingSongs, encodeBatchPayload, findCompanionOrigin } = await import('../../src/bulkFill/missingTabsTool.js');
    const serialized = serializeMissingSongs([{
        id: 'song_orion_1',
        title: 'Orion',
        artist: 'Metallica',
        album: 'Master of Puppets',
        year: '1986',
        trackNumber: 7,
        recordingMbid: 'rec-1',
        artistMbid: 'art-1',
        albumMbid: 'alb-1'
    }]);
    assert.equal(serialized[0].songId, 'song_orion_1');
    assert.equal(serialized[0].recordingMbid, 'rec-1');

    const encoded = encodeBatchPayload([{ id: 'song_orion_1', title: 'Orion', artist: 'Metallica' }]);
    const decodedJson = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const decoded = JSON.parse(decodedJson);
    assert.equal(decoded[0].songId, 'song_orion_1');
    assert.equal(decoded[0].title, 'Orion');

    const origin = findCompanionOrigin([
        { id: 'duckduckgo', isSeed: true, urlTemplate: 'https://duckduckgo.com/?q=$s' },
        { id: 'companion', isSeed: false, urlTemplate: 'http://127.0.0.1:8765/search?q=$s' }
    ]);
    assert.equal(origin, 'http://127.0.0.1:8765');
});

test('buildMpak roundtrips local audio, youtube fallback, tuning, and sync points in v1 format, and unpackMpak handles externalPath + page range', async () => {
    lsMap.clear();
    const songKey = 'Opeth - Windowpane';
    const audioBytes = new Uint8Array(64).fill(0x55).buffer;
    const savedAudio = await saveAudioFile({
        name: 'windowpane.mp3',
        type: 'audio/mpeg',
        data: audioBytes,
        songKey,
        durationMs: 465000,
    });
    localStorage.setItem(`audio_file_${enc(songKey)}_original`, savedAudio.id);
    localStorage.setItem(`real_audio_source_${enc(songKey)}_original`, 'local');
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    saveRecord(songKey, { kind: 'local', audioId: savedAudio.id }, [
        { id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1500, source: 'tap' },
        { id: 'p1', barIndex: 1, occurrence: 0, pos: 0, timeMs: 3500, source: 'manual' },
    ]);

    const tabFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9])], 'Windowpane.gp5', { type: 'application/octet-stream' });
    tabFile.tabTuning = { tuning: 'E A D G B E', source: 'user' };
    const { blob } = await buildMpak(tabFile, {
        songKey,
        song: { artist: 'Opeth', title: 'Windowpane' },
    });

    const { header, opened, tabFile: unpacked } = await unpackMpak(blob);
    assert.equal(header.format, 'mpak');
    assert.equal(header.version, 1);
    assert.deepEqual(header.scores[0].instruments[0].tuning, ['E', 'A', 'D', 'G', 'B', 'E']);
    assert.equal(unpacked.tabTuning.tuning, 'E A D G B E');
    assert.equal(header.recordings.length, 1);
    assert.equal(header.recordings[0].sources[0].type, 'file');
    assert.equal(header.recordings[0].sources[1].type, 'youtube');
    assert.equal(opened.sync('original')?.points?.length, 2);

    // externalPath + startPage / endPage
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const extManifest = {
        format: 'mpak',
        version: 1,
        song: { title: 'Book Song', artist: 'Book Artist' },
        scores: [{
            id: 'pdf',
            externalPath: 'books/realbook.pdf',
            format: 'pdf',
            sha256: await sha256(pdfBytes),
            pages: 100,
            startPage: 12,
            endPage: 14,
        }],
    };
    const { parts } = await coreBuildMpak(extManifest, {});
    const extBlob = new Blob(parts, { type: MEDIA_TYPE });
    const extUnpacked = await unpackMpak(extBlob, { externalScore: pdfBytes });
    assert.equal(extUnpacked.tabFile.name, 'realbook.pdf');
    assert.deepEqual(extUnpacked.tabFile.mpakPageRange, { startPage: 12, endPage: 14, pages: 100 });
});

test('buildMpak packs every audio file of the song, not only the active slot files, and an import lists them', async () => {
    lsMap.clear();
    const songKey = 'Dream Theater - Another Day';
    const otherKey = 'Another Day';
    const save = (name, fill, key) => saveAudioFile({ name, type: 'audio/mpeg', data: new Uint8Array(32).fill(fill).buffer, songKey: key });
    const inSlot = await save('full-mix.mp3', 1, songKey);
    await save('live.mp3', 2, songKey);
    const onOtherKey = await save('backing.mp3', 3, otherKey);
    localStorage.setItem(`audio_file_${enc(songKey)}_original`, inSlot.id);
    localStorage.setItem(`real_audio_source_${enc(songKey)}_original`, 'youtube'); // the slot plays a video, its file is inactive
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    localStorage.setItem(`audio_file_${enc(otherKey)}_backing`, onOtherKey.id);
    localStorage.setItem('yt_song_keys_song-1', JSON.stringify([songKey, otherKey])); // the keys the song's tabs were opened under

    const tabFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 8, 9])], 'Another Day.gp5', { type: 'application/octet-stream' });
    const { blob } = await buildMpak(tabFile, {
        songKey,
        song: { id: 'song-1', artist: 'Dream Theater', title: 'Another Day' },
        scores: [],
    });
    const { header } = await unpackMpak(blob);
    const paths = header.recordings.flatMap((r) => r.sources).filter((x) => x.type === 'file').map((x) => x.path).sort();
    assert.deepEqual(paths, ['audio/backing.mp3', 'audio/full-mix.mp3', 'audio/live.mp3']);
    assert.ok(header.recordings.some((r) => r.id === 'original' && r.sources.some((x) => x.type === 'youtube')));
    assert.equal(header.recordings.find((r) => r.sources[0].path === 'audio/backing.mp3').role, 'backing');
});

test('a pack\'s temporary storage is removed with the pack, and a library song of the same name keeps its own', async () => {
    lsMap.clear();
    const { newPackId, packSongKey, clearPackStorage, plainSongKey } = await import('../../src/mpakSession.js');
    const base = 'Dream Theater - Another Day';
    const id = newPackId();
    const packKey = packSongKey(id, base);
    assert.equal(plainSongKey(packKey), base);
    const save = (name, fill, key) => saveAudioFile({ name, type: 'audio/mpeg', data: new Uint8Array(16).fill(fill).buffer, songKey: key });
    const own = await save('pack-only.mp3', 11, packKey);
    const shared = await save('shared.mp3', 12, packKey);
    await linkAudioFile(shared.id, base); // a library song uses this file too
    const lib = await save('library.mp3', 13, base);
    localStorage.setItem(`audio_file_${enc(packKey)}_original`, own.id);
    localStorage.setItem(`yt_track_${enc(packKey)}_original`, 'dQw4w9WgXcQ');
    localStorage.setItem(`audio_file_${enc(base)}_original`, lib.id);
    saveRecord(packKey, { kind: 'local', audioId: own.id }, [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1, source: 'tap' }]);
    saveRecord(base, { kind: 'local', audioId: lib.id }, [{ id: 'p0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1, source: 'tap' }]);

    await clearPackStorage(id);

    assert.equal(localStorage.getItem(`audio_file_${enc(packKey)}_original`), null);
    assert.equal(localStorage.getItem(`yt_track_${enc(packKey)}_original`), null);
    assert.equal(localStorage.getItem(`audio_file_${enc(base)}_original`), lib.id, 'the library song keeps its slot');
    assert.equal(listRecords(packKey).length, 0);
    assert.equal(listRecords(base).length, 1, 'and its sync points');
    assert.equal(await getAudioMeta(own.id), null, 'a file only the pack used is deleted');
    assert.deepEqual((await getAudioMeta(shared.id)).songKeys, [base], 'a file the library also uses stays, unlinked from the pack');
    assert.ok(await getAudioMeta(lib.id));
});

test('applyMpakExtras keeps every synced YouTube recording, not only the original and backing slots', async () => {
    lsMap.clear();
    const point = (bar, timeMs) => ({ timeMs, bar, occurrence: 0, pos: 0 });
    const syncs = {
        v1: { anchorType: 'bar', points: [point(0, 1000), point(1, 3000)] },
        v2: { anchorType: 'bar', points: [point(0, 1100), point(1, 3100)] },
        v3: { anchorType: 'bar', points: [point(0, 1200), point(1, 3200)] },
        v4: { anchorType: 'bar', points: [point(0, 1300), point(1, 3300)] },
        v5: { anchorType: 'bar', points: [point(0, 9999), point(1, 9999 + 1)] },
        v6: { anchorType: 'bar', points: [point(0, 1500), point(1, 3500)] }
    };
    const youtube = (id, videoId, role, label) => ({ id, role, label, sources: [{ type: 'youtube', videoId }] });
    const data = {
        scores: [{ id: 'gp5', format: 'gp5', sha256: 'a'.repeat(64) }],
        recordings: [
            youtube('v1', 'AAAAAAAAAAA', 'original', 'Full mix'),
            youtube('v2', 'BBBBBBBBBBB', 'alternate', 'Full mix (alternative 1)'),
            { ...youtube('v3', 'CCCCCCCCCCC', 'backing', 'Backing track (without Drums)'), scoreTracks: { gp5: { omits: [1] } } },
            youtube('v4', 'DDDDDDDDDDD', 'backing', 'Backing track (without Bass)'),
            youtube('v5', 'BBBBBBBBBBB', 'original', 'Same video again'),
            youtube('v6', 'EEEEEEEEEEE', 'solo', 'Solo'),
            { id: 'v7', role: 'original', label: 'No sync', sources: [{ type: 'youtube', videoId: 'FFFFFFFFFFF' }] }
        ]
    };
    const opened = { entries: [], sync: (id) => syncs[id] || null };

    await applyMpakExtras(data, opened, { songKey: 'Band - Song', applyToActiveReader: false });

    const saved = (videoId) => loadRecord('Band - Song', { kind: 'youtube', videoId });
    assert.equal(saved('AAAAAAAAAAA')?.points[0].timeMs, 1000);
    assert.equal(saved('BBBBBBBBBBB')?.points[0].timeMs, 1100, 'a video listed twice keeps its first points');
    assert.equal(saved('BBBBBBBBBBB')?.media.label, 'Full mix (alternative 1)');
    assert.equal(saved('CCCCCCCCCCC')?.points[0].timeMs, 1200);
    assert.equal(saved('DDDDDDDDDDD')?.media.label, 'Backing track (without Bass)');
    assert.equal(saved('EEEEEEEEEEE')?.points[1].timeMs, 3500);
    assert.equal(saved('FFFFFFFFFFF'), null, 'a recording without sync points is not stored');
});

test('a pack with no original plays its default recording in the original slot, and finds its sync points there', async () => {
    lsMap.clear();
    const point = (page, timeMs) => ({ timeMs, page, x: 0.25, y: 0.5 });
    const yt = (id, videoId, role, extra = {}) => ({ id, role, label: id, sources: [{ type: 'youtube', videoId }], ...extra });
    const data = {
        scores: [{ id: 'tab', format: 'pdf', sha256: 'b'.repeat(64) }],
        recordings: [
            yt('band', 'AAAAAAAAAAA', 'backing', { without: ['g1'] }),
            yt('g1', 'BBBBBBBBBBB', 'stem', { syncFrom: 'band' }),
            yt('other', 'CCCCCCCCCCC', 'backing'),
        ]
    };
    const opened = { entries: [], sync: (id) => (id === 'band' ? { anchorType: 'pdf', points: [point(1, 1000), point(1, 2000)] } : null) };
    await applyMpakExtras(data, opened, { songKey: 'Band - Song', applyToActiveReader: false });
    const enc = (s) => encodeURIComponent(String(s).toLowerCase());
    const key = enc('Band - Song');
    assert.equal(localStorage.getItem(`yt_track_${key}_original`), 'AAAAAAAAAAA', 'the default recording is the original slot');
    assert.equal(localStorage.getItem(`yt_track_${key}_backing`), 'CCCCCCCCCCC', 'the backing slot takes the next backing recording, not the same one');
    const stored = loadRecord(`score:${'b'.repeat(64)}:Band - Song`, { kind: 'youtube', videoId: 'AAAAAAAAAAA' });
    assert.equal(stored?.points.length, 2);
    assert.equal(stored.points[0].x, 0.25, 'the position is kept in the store');
});

test('a pack whose first recording is a stem leaves the original slot empty', async () => {
    lsMap.clear();
    const yt = (id, videoId, role) => ({ id, role, label: id, sources: [{ type: 'youtube', videoId }] });
    const data = { scores: [{ id: 'tab', format: 'pdf', sha256: 'c'.repeat(64) }], recordings: [yt('g1', 'BBBBBBBBBBB', 'stem'), yt('band', 'AAAAAAAAAAA', 'backing')] };
    await applyMpakExtras(data, { entries: [], sync: () => null }, { songKey: 'Band - Song2', applyToActiveReader: false });
    const key = encodeURIComponent('band - song2');
    assert.equal(localStorage.getItem(`yt_track_${key}_original`), null);
    assert.equal(localStorage.getItem(`yt_track_${key}_backing`), 'AAAAAAAAAAA');
});

test('unpackMpak rejects a pack with no score the app can open, and opens the first score it can', async () => {
    const xml = new TextEncoder().encode('<score-partwise/>');
    const gp = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const only = {
        format: 'mpak', version: 1,
        scores: [{ id: 'xml', path: 'score/song.musicxml', format: 'musicxml', sha256: await sha256(xml) }],
    };
    const { parts } = await coreBuildMpak(only, { 'score/song.musicxml': xml });
    await assert.rejects(
        unpackMpak(new Blob(parts, { type: MEDIA_TYPE })),
        (e) => e instanceof MpakError && /MusicXML score, which MajesticTab cannot open/.test(e.message)
    );

    // a MusicXML primary score does not stop the Guitar Pro score beside it from opening
    const both = {
        format: 'mpak', version: 1,
        scores: [
            { id: 'xml', path: 'score/song.musicxml', format: 'musicxml', sha256: await sha256(xml) },
            { id: 'gp', path: 'score/song.gp', format: 'gp', sha256: await sha256(gp), name: 'song.gp' },
        ],
    };
    const built = await coreBuildMpak(both, { 'score/song.musicxml': xml, 'score/song.gp': gp });
    const unpacked = await unpackMpak(new Blob(built.parts, { type: MEDIA_TYPE }));
    assert.equal(unpacked.tabFile.name, 'song.gp');
    assert.equal(unpacked.score.id, 'gp');
    assert.deepEqual(unpacked.otherScores, []);
});

const YT = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' };

async function textFixture() {
    const { groupBlocks } = await import('../../src/textProcessor/textBlocks.js');
    const staff = (a) => ['e|--0--2--3--|', 'B|--1--3--3--|', 'G|--0--2--0--|', 'D|--2--0--0--|', 'A|--3--------|', 'E|--------' + a + '--|'];
    const text = ['My Song', '', ...staff('1'), '', ...staff('2'), ''].join('\r\n');
    const blocks = groupBlocks(text.split('\r\n'));
    const systems = blocks.map((b, i) => ({ unit: i, line: b.staffStart ?? b.start })).filter((x, i) => blocks[i].kind === 'system');
    assert.equal(systems.length, 2);
    return { text, systems, file: new File([text], 'song.txt', { type: 'text/plain' }) };
}

test('a text tab\'s sync points are stored as lines, written to the archive as they are, and read back the same', async () => {
    lsMap.clear();
    const { text, systems, file } = await textFixture();
    const songKey = 'Band - Text Song';
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    const fileSha = await sha256(new Uint8Array(await file.arrayBuffer()));
    saveRecord(scoreSyncKey(songKey, fileSha), YT, [
        { id: 'a', line: systems[0].line, col: 3, timeMs: 1000, source: 'tap' },
        { id: 'b', line: systems[1].line, timeMs: 5000, source: 'tap' },
    ], undefined, undefined, 'text');
    const { blob } = await buildMpak(file, { songKey, song: { artist: 'Band', title: 'Text Song' } });

    const { header, opened } = await unpackMpak(blob);
    const doc = opened.sync('original');
    assert.equal(doc.anchorType, 'text');
    assert.deepEqual(doc.points.map((p) => [p.line, p.col, p.timeMs]), [[systems[0].line, 3, 1000], [systems[1].line, undefined, 5000]], 'the column is kept');
    assert.deepEqual(opened.warnings, []);

    lsMap.clear();
    await applyMpakExtras(header, opened, { songKey: 'Other - Key', applyToActiveReader: false });
    const back = loadRecord(scoreSyncKey('Other - Key', header.scores[0].sha256), YT);
    assert.equal(back.anchorType, 'text');
    assert.deepEqual(back.points.map((p) => [p.line, p.col, p.timeMs]), [[systems[0].line, 3, 1000], [systems[1].line, undefined, 5000]]);
    assert.equal(loadRecord('Other - Key', YT), null, 'bar points stay separate');
});

test('a PDF tab\'s sync points are stored as pages of the PDF, written as they are, and read back the same', async () => {
    lsMap.clear();
    const songKey = 'Book - Song';
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    saveRecord(scoreSyncKey(songKey, await sha256(pdfBytes)), YT, [
        { id: 'a', page: 12, timeMs: 0, source: 'tap' },
        { id: 'b', page: 14, x: 0.25, y: 0.5, timeMs: 4000, source: 'tap' },
        { id: 'c', page: 12, timeMs: 8000, source: 'tap' },
        { id: 'far', page: 90, timeMs: 9000, source: 'tap' },
    ], undefined, undefined, 'pdf');
    const file = new File([pdfBytes], 'book.pdf', { type: 'application/pdf' });
    const { blob } = await buildMpak(file, { songKey, song: { artist: 'Book', title: 'Song' }, startPage: 12, endPage: 14, pages: 100 });

    const { header, opened } = await unpackMpak(blob);
    const doc = opened.sync('original');
    assert.equal(doc.anchorType, 'pdf');
    assert.deepEqual(doc.points.map((p) => p.page), [12, 14, 12], 'a page outside the range is not written, and a jump back is a repeat');
    assert.deepEqual([doc.points[1].x, doc.points[1].y], [0.25, 0.5], 'a position on the page is kept');
    assert.deepEqual(opened.warnings, []);

    lsMap.clear();
    await applyMpakExtras(header, opened, { songKey: 'Other - Book', applyToActiveReader: false });
    const back = loadRecord(scoreSyncKey('Other - Book', header.scores[0].sha256), YT);
    assert.deepEqual(back.points.map((p) => p.page), [12, 14, 12]);
});

test('a version 1 record of units is converted to lines and pages when a tab is exported', async () => {
    lsMap.clear();
    const { systems, file } = await textFixture();
    const { storageKey } = await import('../../src/audioSync/syncStore.js');
    const { recordStorage } = await import('../../src/audioSync/syncRecordStore.js');
    const songKey = 'Band - Old Text';
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    const v1 = (units) => JSON.stringify({
        version: 1, media: YT, updatedAt: 1,
        points: units.map((u, i) => ({ id: `p${i}`, barIndex: u, occurrence: 0, pos: 0, timeMs: 1000 * (i + 1), source: 'tap' })),
    });
    recordStorage.setItem(storageKey(`text:${songKey}`, YT), v1([systems[0].unit, systems[1].unit, 99]));
    const read = loadRecord(`text:${songKey}`, YT);
    assert.equal(read.anchorType, 'unit');
    assert.deepEqual(read.points.map((p) => p.unit), [systems[0].unit, systems[1].unit, 99]);

    const { blob } = await buildMpak(file, { songKey, song: { artist: 'Band', title: 'Old Text' } });
    const { opened } = await unpackMpak(blob);
    assert.deepEqual(opened.sync('original').points.map((p) => p.line), systems.map((x) => x.line), 'a unit that is not in the text is dropped');

    // and the same record for a PDF whose first page is 12
    recordStorage.setItem(storageKey(`text:${songKey}`, YT), v1([0, 2]));
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'book.pdf', { type: 'application/pdf' });
    const out = await buildMpak(pdf, { songKey, song: { artist: 'Band', title: 'Old Text' }, startPage: 12, endPage: 14, pages: 40 });
    assert.deepEqual((await unpackMpak(out.blob)).opened.sync('original').points.map((p) => p.page), [12, 14]);
});

test('the text and the PDF tab of one song keep separate sync points, and a legacy shared record is still exported', async () => {
    lsMap.clear();
    const { systems, file: txt } = await textFixture();
    const songKey = 'Band - Both';
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const pdf = new File([pdfBytes], 'song.pdf', { type: 'application/pdf' });
    const txtSha = await sha256(new Uint8Array(await txt.arrayBuffer()));
    saveRecord(scoreSyncKey(songKey, txtSha), YT, [{ id: 't', line: systems[0].line, timeMs: 100, source: 'tap' }], undefined, undefined, 'text');
    saveRecord(scoreSyncKey(songKey, await sha256(pdfBytes)), YT, [{ id: 'p', page: 2, timeMs: 200, source: 'tap' }], undefined, undefined, 'pdf');

    const meta = { songKey, song: { artist: 'Band', title: 'Both' } };
    const t = (await unpackMpak((await buildMpak(txt, meta)).blob)).opened.sync('original');
    const p = (await unpackMpak((await buildMpak(pdf, meta)).blob)).opened.sync('original');
    assert.deepEqual([t.anchorType, t.points.map((x) => x.line)], ['text', [systems[0].line]]);
    assert.deepEqual([p.anchorType, p.points.map((x) => x.page)], ['pdf', [2]]);

    // a record from before the key named the score: used by the tab of its kind, not by the other
    lsMap.clear();
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    saveRecord(legacyScoreSyncKey(songKey), YT, [{ id: 'l', page: 3, timeMs: 300, source: 'tap' }], undefined, undefined, 'pdf');
    assert.deepEqual((await unpackMpak((await buildMpak(pdf, meta)).blob)).opened.sync('original').points.map((x) => x.page), [3]);
    assert.equal((await unpackMpak((await buildMpak(txt, meta)).blob)).opened.sync('original'), null);
});

// --- Several scores in one pack (SPEC section 6.2) ----------------------------------------------------------------

async function multiScoreFixture(songKey) {
    const { systems, file: txt } = await textFixture();
    const gp = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9])], 'song.gp', { type: 'application/octet-stream' });
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);
    const pdf = new File([pdfBytes], 'song.pdf', { type: 'application/pdf' });
    localStorage.setItem(`yt_track_${enc(songKey)}_original`, 'dQw4w9WgXcQ');
    saveRecord(songKey, YT, [
        { id: 'b0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1000, source: 'tap' },
        { id: 'b1', barIndex: 1, occurrence: 0, pos: 0, timeMs: 3000, source: 'tap' },
    ]);
    saveRecord(scoreSyncKey(songKey, await sha256(pdfBytes)), YT, [{ id: 'p0', page: 1, timeMs: 1500, source: 'tap' }, { id: 'p1', page: 2, timeMs: 4000, source: 'tap' }], undefined, undefined, 'pdf');
    const txtSha = await sha256(new Uint8Array(await txt.arrayBuffer()));
    saveRecord(scoreSyncKey(songKey, txtSha), YT, [{ id: 't0', line: systems[0].line, timeMs: 2000, source: 'tap' }], undefined, undefined, 'text');
    return { gp, pdf, txt, systems };
}

test('buildMpak writes every score of the song with its own sync, and an import attaches each under its own key', async () => {
    lsMap.clear();
    const songKey = 'Band - Multi';
    const { gp, pdf, txt, systems } = await multiScoreFixture(songKey);
    const { blob } = await buildMpak(gp, {
        songKey, song: { artist: 'Band', title: 'Multi' },
        scores: [{ file: pdf, label: 'PDF' }, { file: txt }, { file: new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9])], 'copy.gp') }],
    });

    const { header, opened, score, otherScores } = await unpackMpak(blob);
    assert.deepEqual(header.scores.map((s) => [s.id, s.format]), [['gp', 'gp'], ['pdf', 'pdf'], ['txt', 'txt']], 'the same file twice is one score');
    assert.equal(header.scores[1].label, 'PDF');
    assert.deepEqual(Object.keys(header.recordings[0].sync).sort(), ['gp', 'pdf', 'txt']);
    assert.equal(score.id, 'gp');
    assert.deepEqual(otherScores.map((o) => o.file.name), ['song.pdf', 'song.txt']);
    assert.deepEqual(opened.warnings, []);
    assert.deepEqual(opened.sync('original', 'gp').points.map((p) => p.bar), [0, 1]);
    assert.deepEqual(opened.sync('original', 'pdf').points.map((p) => p.page), [1, 2]);
    assert.deepEqual(opened.sync('original', 'txt').points.map((p) => p.line), [systems[0].line]);
    assert.equal(opened.sync('original', 'pdf').score, 'pdf');

    lsMap.clear();
    await applyMpakExtras(header, opened, { songKey: 'Other - Multi', applyToActiveReader: false });
    assert.deepEqual(loadRecord('Other - Multi', YT).points.map((p) => p.barIndex), [0, 1]);
    assert.deepEqual(loadRecord(scoreSyncKey('Other - Multi', header.scores[1].sha256), YT).points.map((p) => p.page), [1, 2]);
    assert.deepEqual(loadRecord(scoreSyncKey('Other - Multi', header.scores[2].sha256), YT).points.map((p) => p.line), [systems[0].line]);
});

test('a backing track that shares the original\'s points does so for every score', async () => {
    lsMap.clear();
    const songKey = 'Band - Shared';
    const { gp, pdf } = await multiScoreFixture(songKey);
    const { setSyncSharedFromOriginal, isSyncSharedFromOriginal } = await import('../../src/audioSync/syncStore.js');
    localStorage.setItem(`yt_track_${enc(songKey)}_backing`, 'BBBBBBBBBBB');
    setSyncSharedFromOriginal(songKey, true);
    const { blob } = await buildMpak(gp, { songKey, song: { artist: 'Band', title: 'Shared' }, scores: [{ file: pdf }] });
    const { header, opened } = await unpackMpak(blob);
    const backing = header.recordings.find((r) => r.id === 'backing');
    assert.equal(backing.syncFrom, 'original');
    assert.equal(backing.sync, undefined);
    assert.equal(opened.sync('backing', 'pdf').points.length, 2, 'the backing track resolves the original\'s points for the PDF');

    lsMap.clear();
    await applyMpakExtras(header, opened, { songKey: 'Other - Shared', applyToActiveReader: false });
    assert.ok(isSyncSharedFromOriginal('Other - Shared'));
    assert.ok(isSyncSharedFromOriginal(scoreSyncKey('Other - Shared', header.scores[1].sha256)));
});

test('saveMpakToLibrary adds every score the app can show as a tab of the song, and exporting that tab finds the others', async () => {
    lsMap.clear();
    await clearAllLibraryData();
    const songKey = 'Band - Library';
    const { gp, pdf } = await multiScoreFixture(songKey);
    const { blob } = await buildMpak(gp, { songKey, song: { artist: 'Band', title: 'Library' }, scores: [{ file: pdf }] });

    const saved = await saveMpakToLibrary(blob, { queryMusicBrainz: false, allowTextFallback: true });
    const song = await getSongById(saved.song.id);
    assert.deepEqual(song.tabOptions.map((t) => t.name).sort(), ['song.gp', 'song.pdf']);

    const { otherScores } = await import('../../src/mpak.js').then((m) => ({ otherScores: m.otherLibraryScores }));
    const gpTab = song.tabOptions.find((t) => t.name === 'song.gp');
    const others = await otherScores({ librarySongId: song.id, tabId: gpTab.id });
    assert.deepEqual(others.map((o) => o.file.name), ['song.pdf']);
    assert.deepEqual(await otherScores({ librarySongId: null }), []);
});
