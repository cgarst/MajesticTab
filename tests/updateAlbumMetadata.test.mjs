import test from 'node:test';
import assert from 'node:assert/strict';

// Mock IndexedDB before importing fileStore and libraryStore
class MockIDBRequest {
    constructor() {
        this.onsuccess = null;
        this.onerror = null;
        this.result = null;
        this.error = null;
    }
}

class MockObjectStore {
    constructor(dataMap) {
        this.dataMap = dataMap;
    }
    index(field) {
        return {
            getAll: (query) => {
                const req = new MockIDBRequest();
                queueMicrotask(() => {
                    const all = Array.from(this.dataMap.values());
                    req.result = query !== undefined ? all.filter(item => item[field] === query) : all;
                    if (req.onsuccess) req.onsuccess({ target: req });
                });
                return req;
            }
        };
    }
    getAll() {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = Array.from(this.dataMap.values());
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    get(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = this.dataMap.get(key) || null;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    put(value) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            const key = value.id;
            this.dataMap.set(key, value);
            req.result = key;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    delete(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this.dataMap.delete(key);
            req.result = undefined;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
}

class MockTransaction {
    constructor(stores) {
        this.stores = stores;
    }
    objectStore(name) {
        return this.stores[name];
    }
}

class MockDatabase {
    constructor() {
        this.stores = {
            stored_files: new MockObjectStore(new Map()),
            library_songs: new MockObjectStore(new Map()),
            library_collections: new MockObjectStore(new Map()),
            library_recents: new MockObjectStore(new Map()),
            soundfonts: new MockObjectStore(new Map()),
            library_setlists: new MockObjectStore(new Map())
        };
    }
    transaction(storeNames) {
        return new MockTransaction(this.stores);
    }
}

const mockDb = new MockDatabase();

globalThis.indexedDB = {
    open() {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = mockDb;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
};

const {
    saveSongToLibrary,
    getSongsByCollection,
    updateAlbumMetadataInLibrary,
    cleanTitle
} = await import('../src/libraryStore.js');

test('cleanTitle strips punctuation, brackets and extra whitespace', () => {
    assert.equal(cleanTitle("Ride The Lightning (Remastered)"), 'ridethelightning');
    assert.equal(cleanTitle("For Whom the Bell Tolls [Live]"), 'forwhomthebelltolls');
    assert.equal(cleanTitle("Don't Look Back"), 'dontlookback');
});

test('updateAlbumMetadataInLibrary updates album year, mbid, tracks and durations', async () => {
    const colId = 'test_col';

    // Seed library with album songs that have the wrong year (e.g. 2016 reissue instead of 1984)
    const song1 = {
        id: 'song_metallica_rtl_1',
        collectionId: colId,
        title: 'Fight Fire with Fire',
        artist: 'Metallica',
        album: 'Ride the Lightning',
        year: 2016,
        trackNumber: 1,
        length: 280,
        recordingMbid: 'rec_rtl_1'
    };

    const song2 = {
        id: 'song_metallica_rtl_2',
        collectionId: colId,
        title: 'Ride the Lightning',
        artist: 'Metallica',
        album: 'Ride the Lightning',
        year: 2016,
        trackNumber: 2,
        length: 390,
        recordingMbid: 'rec_rtl_2'
    };

    // A song from another album that should NOT be touched
    const songOther = {
        id: 'song_metallica_mop_1',
        collectionId: colId,
        title: 'Battery',
        artist: 'Metallica',
        album: 'Master of Puppets',
        year: 1986,
        trackNumber: 1,
        recordingMbid: 'rec_mop_1'
    };

    await saveSongToLibrary(song1, colId);
    await saveSongToLibrary(song2, colId);
    await saveSongToLibrary(songOther, colId);

    // Album data from MusicBrainz (as returned by getAlbumTracks)
    const albumData = {
        title: 'Ride the Lightning',
        artist: 'Metallica',
        artistMbid: 'mbid_artist_metallica',
        releaseGroupId: 'mbid_rg_rtl',
        releaseId: 'mbid_rel_rtl',
        year: 1984,
        coverUrl: 'https://coverartarchive.org/release/rtl/front.jpg',
        tracks: [
            {
                title: 'Fight Fire with Fire',
                length: 285,
                trackNumber: 1,
                mediumNumber: 1,
                recordingMbid: 'rec_rtl_1'
            },
            {
                title: 'Ride the Lightning',
                length: 397,
                trackNumber: 2,
                mediumNumber: 1,
                recordingMbid: 'rec_rtl_2'
            },
            {
                title: 'For Whom the Bell Tolls',
                length: 310,
                trackNumber: 3,
                mediumNumber: 1,
                recordingMbid: 'rec_rtl_3'
            }
        ]
    };

    const res = await updateAlbumMetadataInLibrary(albumData, colId);
    assert.equal(res.updatedSongsCount, 2);
    assert.equal(res.totalMatchedSongs, 2);

    const songsInCol = await getSongsByCollection(colId);
    const updated1 = songsInCol.find(s => s.id === 'song_metallica_rtl_1');
    const updated2 = songsInCol.find(s => s.id === 'song_metallica_rtl_2');
    const other = songsInCol.find(s => s.id === 'song_metallica_mop_1');

    // Both songs should now have the correct original year: 1984
    assert.equal(updated1.year, 1984);
    assert.equal(updated2.year, 1984);
    assert.equal(updated1.albumMbid, 'mbid_rg_rtl');
    assert.equal(updated2.albumMbid, 'mbid_rg_rtl');
    assert.equal(updated1.artistMbid, 'mbid_artist_metallica');
    assert.equal(updated1.coverUrl, 'https://coverartarchive.org/release/rtl/front.jpg');
    assert.equal(updated1.length, 285);
    assert.equal(updated2.length, 397);

    // Other album should remain untouched
    assert.equal(other.year, 1986);
    assert.equal(other.album, 'Master of Puppets');

    // Running again with identical data should detect no changes
    const res2 = await updateAlbumMetadataInLibrary(albumData, colId);
    assert.equal(res2.updatedSongsCount, 0);
});

test('updateAlbumMetadataInLibrary handles curly quotes and fills missing trackNumbers and lengths', async () => {
    const colId = 'test_col_quotes';
    const song = {
        id: 'song_gnr_1',
        collectionId: colId,
        title: "Don’t Cry",
        artist: "Guns N' Roses",
        album: "Use Your Illusion I",
        year: 1999 // Reissue / wrong year
    };
    await saveSongToLibrary(song, colId);

    const albumData = {
        title: "Use Your Illusion I",
        artist: "Guns N' Roses",
        releaseGroupId: 'mbid_rg_uyi1',
        year: 1991, // Original release year
        tracks: [
            {
                title: "Don't Cry",
                trackNumber: 4,
                mediumNumber: 1,
                length: 284,
                recordingMbid: 'rec_dont_cry'
            }
        ]
    };

    const res = await updateAlbumMetadataInLibrary(albumData, colId);
    assert.equal(res.updatedSongsCount, 1);

    const songsInCol = await getSongsByCollection(colId);
    const updated = songsInCol.find(s => s.id === 'song_gnr_1');
    assert.equal(updated.year, 1991);
    assert.equal(updated.trackNumber, 4);
    assert.equal(updated.length, 284);
    assert.equal(updated.recordingMbid, 'rec_dont_cry');
    assert.equal(updated.albumMbid, 'mbid_rg_uyi1');
});

test('updateAlbumMetadataInLibrary also updates isAlbumTabContainer', async () => {
    const colId = 'test_col_book';
    const albumBook = {
        id: 'book_iron_maiden_powerslave',
        collectionId: colId,
        title: 'Powerslave',
        artist: 'Iron Maiden',
        album: 'Powerslave',
        isAlbumTabContainer: true,
        year: 2000,
        tabOptions: [{ name: 'Powerslave.pdf', fileStoreId: 'file_book' }]
    };

    await saveSongToLibrary(albumBook, colId);

    const albumData = {
        title: 'Powerslave',
        artist: 'Iron Maiden',
        releaseGroupId: 'mbid_rg_powerslave',
        year: 1984,
        coverUrl: 'https://coverartarchive.org/release/powerslave/front.jpg',
        tracks: []
    };

    const res = await updateAlbumMetadataInLibrary(albumData, colId);
    assert.equal(res.updatedSongsCount, 1);

    const songsInCol = await getSongsByCollection(colId);
    const updated = songsInCol.find(s => s.id === 'book_iron_maiden_powerslave');
    assert.equal(updated.year, 1984);
    assert.equal(updated.albumMbid, 'mbid_rg_powerslave');
    assert.equal(updated.tabOptions.length, 1);
});
