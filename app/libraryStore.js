// libraryStore.js
// Storage and querying layer for Collections > Artists > Albums > Songs and Recents.

import { getDB, STORE_SONGS, STORE_COLLECTIONS, STORE_RECENTS, saveStoredFile, getStoredFile } from './fileStore.js';
import { extractScoreTunings, inferTuningFromTextOrName } from './utils/tuningUtils.js';

export const DEFAULT_COLLECTION_ID = 'default';

/**
 * Ensures default collection exists
 */
export async function ensureDefaultCollection() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_COLLECTIONS, 'readwrite');
        const store = tx.objectStore(STORE_COLLECTIONS);
        const req = store.get(DEFAULT_COLLECTION_ID);

        req.onsuccess = () => {
            if (!req.result) {
                store.put({
                    id: DEFAULT_COLLECTION_ID,
                    name: 'My Library',
                    createdAt: Date.now()
                });
            }
            resolve();
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get all collections
 */
export async function getCollections() {
    await ensureDefaultCollection();
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_COLLECTIONS, 'readonly');
        const store = tx.objectStore(STORE_COLLECTIONS);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Add a new collection
 */
export async function createCollection(name) {
    const db = await getDB();
    const id = `col_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const collection = {
        id,
        name: name || 'New Collection',
        createdAt: Date.now()
    };
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_COLLECTIONS, 'readwrite');
        const store = tx.objectStore(STORE_COLLECTIONS);
        const req = store.put(collection);
        req.onsuccess = () => resolve(collection);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete a collection and its songs
 */
export async function deleteCollection(id) {
    if (id === DEFAULT_COLLECTION_ID) return;
    const db = await getDB();
    const songs = await getSongsByCollection(id);

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_COLLECTIONS, STORE_SONGS], 'readwrite');
        tx.objectStore(STORE_COLLECTIONS).delete(id);
        const songStore = tx.objectStore(STORE_SONGS);
        for (const s of songs) {
            songStore.delete(s.id);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get all songs in a collection
 */
export async function getSongsByCollection(collectionId = DEFAULT_COLLECTION_ID) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const index = store.index('collectionId');
        const req = index.getAll(collectionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Return library organized as Collection > Artist > Album > Song hierarchy
 */
export async function getLibraryHierarchy(collectionId = DEFAULT_COLLECTION_ID) {
    const songs = await getSongsByCollection(collectionId);

    const artistMap = new Map();

    for (const song of songs) {
        const artistName = (song.artist || 'Unknown Artist').trim();
        if (!artistMap.has(artistName)) {
            artistMap.set(artistName, {
                name: artistName,
                artistMbid: song.artistMbid || null,
                albums: new Map()
            });
        }
        const artist = artistMap.get(artistName);

        const albumName = (song.album || 'Singles / Other').trim();
        if (!artist.albums.has(albumName)) {
            artist.albums.set(albumName, {
                title: albumName,
                albumMbid: song.albumMbid || null,
                coverUrl: song.coverUrl || null,
                year: song.year || null,
                songs: []
            });
        }
        const album = artist.albums.get(albumName);
        if (!album.coverUrl && song.coverUrl) {
            album.coverUrl = song.coverUrl;
        }
        if (!album.year && song.year) {
            album.year = song.year;
        }
        album.songs.push(song);
    }

    // Convert map to sorted arrays
    const artists = Array.from(artistMap.values()).map(artist => {
        const albums = Array.from(artist.albums.values()).map(album => {
            // Sort songs by track number or title
            album.songs.sort((a, b) => {
                if (a.trackNumber && b.trackNumber) return a.trackNumber - b.trackNumber;
                return (a.title || '').localeCompare(b.title || '');
            });
            return album;
        });

        // Sort albums by year
        albums.sort((a, b) => (a.year || 9999) - (b.year || 9999));

        return {
            name: artist.name,
            artistMbid: artist.artistMbid,
            albums
        };
    });

    // Sort artists alphabetically
    artists.sort((a, b) => a.name.localeCompare(b.name));

    return {
        collectionId,
        artists
    };
}

/**
 * Add or update a song in library
 */
export async function saveSongToLibrary(songData, collectionId = DEFAULT_COLLECTION_ID) {
    const db = await getDB();
    const id = songData.id || `song_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const song = {
        id,
        collectionId,
        title: songData.title || 'Untitled Song',
        artist: songData.artist || 'Unknown Artist',
        artistMbid: songData.artistMbid || null,
        album: songData.album || 'Unknown Album',
        albumMbid: songData.albumMbid || null,
        year: songData.year || null,
        trackNumber: songData.trackNumber || null,
        recordingMbid: songData.recordingMbid || null,
        coverUrl: songData.coverUrl || null,
        tunings: Array.isArray(songData.tunings) ? songData.tunings : [],
        tabOptions: Array.isArray(songData.tabOptions) ? songData.tabOptions : [],
        addedAt: songData.addedAt || Date.now(),
        lastOpenedAt: songData.lastOpenedAt || null
    };

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readwrite');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.put(song);
        req.onsuccess = () => resolve(song);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Add an entire album with tracklist to library
 */
export async function addAlbumToLibrary(albumData, tracks = [], collectionId = DEFAULT_COLLECTION_ID) {
    const db = await getDB();
    const results = [];

    for (const track of tracks) {
        const id = `song_${albumData.artistMbid || albumData.artist}_${albumData.releaseGroupId || albumData.title}_${track.recordingMbid || track.title}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const song = {
            id,
            collectionId,
            title: track.title,
            artist: albumData.artist,
            artistMbid: albumData.artistMbid || null,
            album: albumData.title,
            albumMbid: albumData.releaseGroupId || albumData.releaseId || null,
            year: albumData.year || null,
            trackNumber: track.trackNumber || null,
            recordingMbid: track.recordingMbid || null,
            coverUrl: albumData.coverUrl || track.coverUrl || null,
            tunings: [],
            tabOptions: [],
            addedAt: Date.now()
        };

        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_SONGS, 'readwrite');
            const store = tx.objectStore(STORE_SONGS);
            const req = store.put(song);
            req.onsuccess = () => { results.push(song); resolve(); };
            req.onerror = () => reject(req.error);
        });
    }

    return results;
}

/**
 * Delete a song from library
 */
export async function deleteSongFromLibrary(songId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readwrite');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.delete(songId);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get single song by ID
 */
export async function getSongById(songId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.get(songId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Attach a tab option to a library song
 */
export async function addTabOptionToSong(songId, tabOption) {
    const song = await getSongById(songId);
    if (!song) throw new Error(`Song not found: ${songId}`);

    const optionId = tabOption.id || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newOption = {
        id: optionId,
        name: tabOption.name || 'Tab',
        providerId: tabOption.providerId || 'local',
        relativePath: tabOption.relativePath || tabOption.name || '',
        fileStoreId: tabOption.fileStoreId || null,
        tuning: tabOption.tuning || null,
        fileType: tabOption.fileType || 'gp',
        addedAt: Date.now()
    };

    if (!Array.isArray(song.tabOptions)) {
        song.tabOptions = [];
    }

    // Replace if same fileStoreId or append
    const existingIdx = song.tabOptions.findIndex(t => (t.fileStoreId && t.fileStoreId === newOption.fileStoreId) || (t.id === newOption.id));
    if (existingIdx >= 0) {
        song.tabOptions[existingIdx] = newOption;
    } else {
        song.tabOptions.push(newOption);
    }

    // Merge tuning into song's tunings
    if (newOption.tuning && !song.tunings.includes(newOption.tuning)) {
        song.tunings.push(newOption.tuning);
    }

    await saveSongToLibrary(song, song.collectionId);
    return newOption;
}

/**
 * Remove a tab option from a song
 */
export async function removeTabOptionFromSong(songId, tabOptionId) {
    const song = await getSongById(songId);
    if (!song || !Array.isArray(song.tabOptions)) return;

    song.tabOptions = song.tabOptions.filter(t => t.id !== tabOptionId);
    song.tunings = Array.from(new Set(song.tabOptions.map(t => t.tuning).filter(Boolean)));
    await saveSongToLibrary(song, song.collectionId);
}

/**
 * Map an open file to an existing or new library song
 */
export async function mapOpenFileToSong(file, songId, tabName, providerId = 'local', relativePath = '') {
    // Save file into fileStore first
    const stored = await saveStoredFile(file, providerId, {
        name: file.name,
        type: file.type,
        relativePath: relativePath || file.name,
        songId
    });

    let song = await getSongById(songId);
    if (!song) {
        throw new Error('Target song does not exist in library.');
    }

    const detectedTuning = inferTuningFromTextOrName(file.name);
    const tabOption = {
        id: `tab_${Date.now()}`,
        name: tabName || file.name,
        providerId,
        relativePath: relativePath || file.name,
        fileStoreId: stored.id,
        tuning: detectedTuning,
        fileType: file.name.split('.').pop().toLowerCase()
    };

    await addTabOptionToSong(songId, tabOption);
    return { song, tabOption, stored };
}

// -----------------------------------------------------------------------------
// RECENTS TRACKING
// -----------------------------------------------------------------------------

/**
 * Add or update a recently opened file with library/metadata enrichment
 */
export async function addRecentOpened(fileInfo) {
    const db = await getDB();
    const id = fileInfo.id || fileInfo.name || `recent_${Date.now()}`;
    const recent = {
        id,
        name: fileInfo.name,
        fileStoreId: fileInfo.fileStoreId || null,
        providerId: fileInfo.providerId || 'local',
        relativePath: fileInfo.relativePath || fileInfo.name,
        librarySongId: fileInfo.librarySongId || null,
        songTitle: fileInfo.songTitle || fileInfo.name,
        artist: fileInfo.artist || '',
        album: fileInfo.album || '',
        coverUrl: fileInfo.coverUrl || null,
        tunings: Array.isArray(fileInfo.tunings) ? fileInfo.tunings : [],
        openedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RECENTS, 'readwrite');
        const store = tx.objectStore(STORE_RECENTS);
        const req = store.put(recent);
        req.onsuccess = () => resolve(recent);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get list of recents sorted newest first
 */
export async function getRecents(limit = 30) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RECENTS, 'readonly');
        const store = tx.objectStore(STORE_RECENTS);
        const index = store.index('openedAt');
        const req = index.openCursor(null, 'prev');
        const results = [];

        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor && results.length < limit) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Clear all recents
 */
export async function clearRecents() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RECENTS, 'readwrite');
        const store = tx.objectStore(STORE_RECENTS);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}
