// libraryStore.js
// Storage and querying layer for Collections > Artists > Albums > Songs and Recents.

import { getDB, STORE_SONGS, STORE_COLLECTIONS, STORE_RECENTS, saveStoredFile, getStoredFile } from './fileStore.js';
import { extractScoreTunings, extractScoreMetadata, inferTuningFromTextOrName, detectFileMetadata, getTuningInfo, getTuningCategory } from './utils/tuningUtils.js';
import { getAlbumTracks, searchMusicBrainz, fetchMusicBrainz, getCoverArtUrl } from './musicbrainz.js';

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
        let isCustom = Boolean(song.isCustom);
        let artistName = (song.artist || '').trim();

        if (isCustom) {
            if (!artistName || artistName === 'Student Documents') {
                artistName = 'Custom Music';
            }
        } else if (!artistName) {
            artistName = 'Unknown Artist';
        }

        if (!artistMap.has(artistName)) {
            artistMap.set(artistName, {
                name: artistName,
                artistMbid: song.artistMbid || null,
                isCustom: isCustom,
                songs: [],
                albums: new Map()
            });
        }
        const artist = artistMap.get(artistName);
        if (isCustom) artist.isCustom = true;

        let rawAlbum = (song.album || '').trim();
        let folderPath = (song.folderPath || rawAlbum).trim();

        if (isCustom) {
            if (folderPath === 'Student Documents/General' || folderPath === 'General' || folderPath === 'Student Documents' || folderPath === 'Unknown Album' || folderPath === 'Singles / Other') {
                folderPath = '';
                rawAlbum = '';
            } else if (folderPath.startsWith('Student Documents/')) {
                folderPath = folderPath.replace(/^Student Documents\//, '');
                rawAlbum = folderPath;
            }
            if (rawAlbum === 'Unknown Album' || rawAlbum === 'General' || rawAlbum === 'Singles / Other') {
                rawAlbum = '';
            }
        }

        const isRootLayer = isCustom && (!folderPath || folderPath === '' || folderPath === 'Custom Music');

        if (isRootLayer) {
            if (!song.isAlbumTabContainer) {
                artist.songs.push(song);
            }
        } else {
            const albumName = folderPath || rawAlbum || 'Singles / Other';
            if (!artist.albums.has(albumName)) {
                artist.albums.set(albumName, {
                    title: albumName,
                    albumMbid: song.albumMbid || null,
                    coverUrl: song.coverUrl || null,
                    year: song.year || null,
                    isCustom: isCustom,
                    folderPath: isCustom ? albumName : null,
                    tabOptions: [],
                    defaultTabId: null,
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

            if (song.isAlbumTabContainer) {
                album.tabOptions = Array.isArray(song.tabOptions) ? song.tabOptions : [];
                album.defaultTabId = song.defaultTabId || (album.tabOptions[0]?.id || null);
            } else {
                album.songs.push(song);
            }
        }
    }

    // Convert map to sorted arrays
    const artists = Array.from(artistMap.values()).map(artist => {
        // Sort direct songs: pinned first, then title
        artist.songs.sort((a, b) => {
            if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
            return (a.title || '').localeCompare(b.title || '');
        });

        const albums = Array.from(artist.albums.values()).map(album => {
            // Sort songs strictly in album track order: medium number, then track number or title
            album.songs.sort((a, b) => {
                const medA = a.mediumNumber || 1;
                const medB = b.mediumNumber || 1;
                if (medA !== medB) return medA - medB;
                if (a.trackNumber && b.trackNumber) return a.trackNumber - b.trackNumber;
                return (a.title || '').localeCompare(b.title || '');
            });
            return album;
        });

        // Sort albums by release date (oldest first), then by title
        albums.sort((a, b) => {
            const yA = parseInt(a.year, 10) || 9999;
            const yB = parseInt(b.year, 10) || 9999;
            if (yA !== yB) return yA - yB;
            return (a.title || '').localeCompare(b.title || '');
        });

        return {
            name: artist.name,
            artistMbid: artist.artistMbid,
            isCustom: artist.isCustom,
            songs: artist.songs,
            albums
        };
    });

    // Sort artists alphabetically
    artists.sort((a, b) => a.name.localeCompare(b.name));

    const pinnedSongs = songs.filter(s => s.pinned && !s.isAlbumTabContainer);
    pinnedSongs.sort((a, b) => {
        const artDiff = (a.artist || '').localeCompare(b.artist || '');
        if (artDiff !== 0) return artDiff;
        return (a.title || '').localeCompare(b.title || '');
    });

    return {
        collectionId,
        pinnedSongs,
        artists
    };
}

/**
 * Return library organized by Tuning groups -> Song lists
 */
export async function getLibraryTuningsHierarchy(collectionId = DEFAULT_COLLECTION_ID) {
    const songs = await getSongsByCollection(collectionId);
    const tuningMap = new Map();

    for (const song of songs) {
        if (song.isAlbumTabContainer) continue;

        const tunings = Array.isArray(song.tunings) && song.tunings.length > 0
            ? song.tunings
            : (song.tabOptions?.map(t => t.tuning).filter(Boolean) || (song.tuning ? [song.tuning] : []));

        // Filter out 'Untuned / Other' or empty / null values
        const validTunings = tunings.filter(t => t && typeof t === 'string' && t.trim() && t !== 'Untuned / Other' && t.toLowerCase() !== 'untuned');

        for (const rawTuning of validTunings) {
            const info = getTuningInfo(rawTuning);
            if (!info || !info.key) continue;

            const tuningKey = info.key;

            if (!tuningMap.has(tuningKey)) {
                tuningMap.set(tuningKey, {
                    key: tuningKey,
                    tuning: tuningKey,
                    notes: info.notes,
                    name: info.displayName,
                    defaultName: info.defaultName,
                    stringCount: info.stringCount || song.stringCount || 6,
                    songs: []
                });
            }
            const group = tuningMap.get(tuningKey);
            if (!group.songs.some(s => s.id === song.id)) {
                group.songs.push(song);
            }
        }
    }

    const tuningsList = Array.from(tuningMap.values()).map(tGroup => {
        const info = getTuningInfo(tGroup.key);
        if (info) {
            tGroup.name = info.displayName;
            tGroup.notes = info.notes;
            tGroup.defaultName = info.defaultName;
            if (info.stringCount) {
                tGroup.stringCount = info.stringCount;
            }
        }
        tGroup.category = getTuningCategory(tGroup);

        tGroup.songs.sort((a, b) => {
            if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
            const artDiff = (a.artist || '').localeCompare(b.artist || '');
            if (artDiff !== 0) return artDiff;
            return (a.title || '').localeCompare(b.title || '');
        });
        return tGroup;
    });

    // Sort tunings by section order, then by song count descending, then alphabetically
    tuningsList.sort((a, b) => {
        const orderA = a.category?.order ?? 99;
        const orderB = b.category?.order ?? 99;
        if (orderA !== orderB) return orderA - orderB;
        return b.songs.length - a.songs.length || (a.name || a.key).localeCompare(b.name || b.key);
    });

    return {
        collectionId,
        tunings: tuningsList
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
        collectionId: songData.collectionId || collectionId,
        title: songData.title || 'Untitled Song',
        artist: songData.isCustom ? (songData.artist || 'Custom Music') : (songData.artist || 'Unknown Artist'),
        artistMbid: songData.artistMbid || null,
        album: songData.isCustom ? (songData.album || songData.folderPath || '') : (songData.album || 'Unknown Album'),
        albumMbid: songData.albumMbid || null,
        year: songData.year || null,
        length: typeof songData.length === 'number' ? songData.length : (songData.length ? parseInt(songData.length, 10) : null),
        trackNumber: songData.trackNumber || null,
        mediumNumber: songData.mediumNumber || 1,
        mediumTitle: songData.mediumTitle || null,
        mediumFormat: songData.mediumFormat || null,
        recordingMbid: songData.recordingMbid || null,
        coverUrl: songData.coverUrl || null,
        tunings: Array.isArray(songData.tunings) ? songData.tunings : [],
        stringCount: songData.stringCount || null,
        tabOptions: Array.isArray(songData.tabOptions) ? songData.tabOptions : [],
        defaultTabId: songData.defaultTabId || null,
        pinned: Boolean(songData.pinned),
        isCustom: Boolean(songData.isCustom),
        folderPath: songData.folderPath || null,
        isAlbumTabContainer: Boolean(songData.isAlbumTabContainer),
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
        const medNum = track.mediumNumber || 1;
        const trackNum = track.trackNumber || '';
        const id = `song_${albumData.artistMbid || albumData.artist}_${albumData.releaseGroupId || albumData.title}_m${medNum}_${track.recordingMbid || trackNum || track.title}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const song = {
            id,
            collectionId,
            title: track.title,
            artist: albumData.artist,
            artistMbid: albumData.artistMbid || null,
            album: albumData.title,
            albumMbid: albumData.releaseGroupId || albumData.releaseId || null,
            year: albumData.year || null,
            length: typeof track.length === 'number' ? track.length : (track.length ? parseInt(track.length, 10) : null),
            trackNumber: track.trackNumber || null,
            mediumNumber: track.mediumNumber || 1,
            mediumTitle: track.mediumTitle || null,
            mediumFormat: track.mediumFormat || null,
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
 * Delete an entire album and all of its songs from the library
 */
export async function deleteAlbumFromLibrary(artistName, albumTitle, collectionId = DEFAULT_COLLECTION_ID, songIds = []) {
    const db = await getDB();
    const songs = await getSongsByCollection(collectionId);
    const idSet = new Set(Array.isArray(songIds) ? songIds : []);
    const songsToDelete = songs.filter(s => {
        if (idSet.has(s.id)) return true;
        const sArtist = (s.artist || '').trim().toLowerCase();
        const sAlbum = (s.album || '').trim().toLowerCase();
        const targetArtist = (artistName || '').trim().toLowerCase();
        const targetAlbum = (albumTitle || '').trim().toLowerCase();
        return sArtist === targetArtist && sAlbum === targetAlbum;
    });

    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readwrite');
        const store = tx.objectStore(STORE_SONGS);
        for (const s of songsToDelete) {
            store.delete(s.id);
        }
        for (const id of idSet) {
            store.delete(id);
        }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
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
    const stringCount = tabOption.stringCount || (tabOption.tuning?.includes('8-String') ? 8 : tabOption.tuning?.includes('7-String') ? 7 : 6);
    const newOption = {
        id: optionId,
        name: tabOption.name || 'Tab',
        providerId: tabOption.providerId || 'local',
        relativePath: tabOption.relativePath || tabOption.name || '',
        fileStoreId: tabOption.fileStoreId || null,
        tuning: tabOption.tuning || null,
        tunings: Array.isArray(tabOption.tunings) ? tabOption.tunings : (tabOption.tuning ? [tabOption.tuning] : []),
        stringCount,
        fileType: tabOption.fileType || 'gp',
        isDefault: Boolean(tabOption.isDefault),
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

    if (!song.defaultTabId || song.tabOptions.length === 1 || newOption.isDefault) {
        song.defaultTabId = newOption.id;
    }

    if (newOption.stringCount && (!song.stringCount || newOption.stringCount > song.stringCount)) {
        song.stringCount = newOption.stringCount;
    }

    // Merge tunings
    if (!Array.isArray(song.tunings)) {
        song.tunings = [];
    }
    if (Array.isArray(tabOption.tunings)) {
        for (const t of tabOption.tunings) {
            if (t && !song.tunings.includes(t)) song.tunings.push(t);
        }
    } else if (newOption.tuning && !song.tunings.includes(newOption.tuning)) {
        song.tunings.push(newOption.tuning);
    }

    await saveSongToLibrary(song, song.collectionId);
    return newOption;
}

/**
 * Set the default tab option for a song
 */
export async function setDefaultTabOption(songId, tabId) {
    const song = await getSongById(songId);
    if (!song || !Array.isArray(song.tabOptions)) return false;
    song.defaultTabId = tabId;
    for (const t of song.tabOptions) {
        t.isDefault = (t.id === tabId);
    }
    await saveSongToLibrary(song, song.collectionId);
    return true;
}

/**
 * Toggle pin status of a song
 */
export async function togglePinSong(songId) {
    const song = await getSongById(songId);
    if (!song) return false;
    song.pinned = !Boolean(song.pinned);
    await saveSongToLibrary(song, song.collectionId);
    return song.pinned;
}

/**
 * Remove a tab option from a song
 */
export async function removeTabOptionFromSong(songId, tabOptionId) {
    const song = await getSongById(songId);
    if (!song || !Array.isArray(song.tabOptions)) return;

    song.tabOptions = song.tabOptions.filter(t => t.id !== tabOptionId);
    if (song.defaultTabId === tabOptionId) {
        song.defaultTabId = song.tabOptions[0]?.id || null;
    }
    song.tunings = Array.from(new Set(song.tabOptions.map(t => t.tuning).filter(Boolean)));
    await saveSongToLibrary(song, song.collectionId);
}

// -----------------------------------------------------------------------------
// ALBUM-LEVEL TABS (e.g. Full Album Tab Books)
// -----------------------------------------------------------------------------

function getAlbumTabSongId(collectionId, artistName, albumTitle) {
    return `album_tab_${collectionId}_${artistName}_${albumTitle}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get album-level tab options
 */
export async function getAlbumTabOptions(collectionId, artistName, albumTitle) {
    const albumSongId = getAlbumTabSongId(collectionId, artistName, albumTitle);
    const albumRecord = await getSongById(albumSongId);
    return albumRecord?.tabOptions || [];
}

/**
 * Add a tab option to an album
 */
export async function addTabOptionToAlbum(collectionId, artistName, albumTitle, tabOption) {
    const albumSongId = getAlbumTabSongId(collectionId, artistName, albumTitle);
    let albumRecord = await getSongById(albumSongId);
    if (!albumRecord) {
        albumRecord = {
            id: albumSongId,
            collectionId: collectionId || DEFAULT_COLLECTION_ID,
            title: albumTitle,
            artist: artistName,
            album: albumTitle,
            isAlbumTabContainer: true,
            tabOptions: [],
            tunings: [],
            addedAt: Date.now()
        };
    }

    const optionId = tabOption.id || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newOption = {
        id: optionId,
        name: tabOption.name || 'Album Tab Book',
        providerId: tabOption.providerId || 'local',
        relativePath: tabOption.relativePath || tabOption.name || '',
        fileStoreId: tabOption.fileStoreId || null,
        tuning: tabOption.tuning || null,
        stringCount: tabOption.stringCount || 6,
        fileType: tabOption.fileType || 'pdf',
        isDefault: Boolean(tabOption.isDefault),
        addedAt: Date.now()
    };

    if (!Array.isArray(albumRecord.tabOptions)) {
        albumRecord.tabOptions = [];
    }

    const existingIdx = albumRecord.tabOptions.findIndex(t => (t.fileStoreId && t.fileStoreId === newOption.fileStoreId) || (t.id === newOption.id));
    if (existingIdx >= 0) {
        albumRecord.tabOptions[existingIdx] = newOption;
    } else {
        albumRecord.tabOptions.push(newOption);
    }

    if (!albumRecord.defaultTabId || albumRecord.tabOptions.length === 1 || newOption.isDefault) {
        albumRecord.defaultTabId = newOption.id;
    }

    await saveSongToLibrary(albumRecord, collectionId);
    return newOption;
}

/**
 * Remove an album-level tab option
 */
export async function removeTabOptionFromAlbum(collectionId, artistName, albumTitle, tabOptionId) {
    const albumSongId = getAlbumTabSongId(collectionId, artistName, albumTitle);
    const albumRecord = await getSongById(albumSongId);
    if (!albumRecord || !Array.isArray(albumRecord.tabOptions)) return;

    albumRecord.tabOptions = albumRecord.tabOptions.filter(t => t.id !== tabOptionId);
    if (albumRecord.defaultTabId === tabOptionId) {
        albumRecord.defaultTabId = albumRecord.tabOptions[0]?.id || null;
    }
    await saveSongToLibrary(albumRecord, collectionId);
}

/**
 * Set default tab option for an album
 */
export async function setDefaultAlbumTabOption(collectionId, artistName, albumTitle, tabId) {
    const albumSongId = getAlbumTabSongId(collectionId, artistName, albumTitle);
    const albumRecord = await getSongById(albumSongId);
    if (!albumRecord || !Array.isArray(albumRecord.tabOptions)) return false;
    albumRecord.defaultTabId = tabId;
    for (const t of albumRecord.tabOptions) {
        t.isDefault = (t.id === tabId);
    }
    await saveSongToLibrary(albumRecord, collectionId);
    return true;
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

    const meta = await detectFileMetadata(file, file.name);
    const tabOption = {
        id: `tab_${Date.now()}`,
        name: tabName || file.name,
        providerId,
        relativePath: relativePath || file.name,
        fileStoreId: stored.id,
        tuning: meta.primaryTuning,
        tunings: meta.tunings,
        stringCount: meta.stringCount,
        fileType: file.name.split('.').pop().toLowerCase()
    };

    await addTabOptionToSong(songId, tabOption);
    return { song, tabOption, stored };
}

// -----------------------------------------------------------------------------
// RECENTS TRACKING
// -----------------------------------------------------------------------------

/**
 * Update library song and its attached tab tuning & string count on the fly when score is parsed
 */
export async function updateLibrarySongFromScore({ fileName, title, artist, album, primaryTuning, stringCount, tunings }) {
    if (!primaryTuning && !stringCount) return false;
    try {
        const songs = await getAllSongs();
        if (!songs || songs.length === 0) return false;

        const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
        const cTitle = clean(title);
        const cArtist = clean(artist);
        const cFile = clean((fileName || '').replace(/\.[^/.]+$/, ''));

        let matchedSong = null;
        let matchedTab = null;

        for (const song of songs) {
            // Check attached tabs
            if (Array.isArray(song.tabOptions)) {
                for (const t of song.tabOptions) {
                    if ((t.name && clean(t.name) === cFile) || (t.relativePath && clean(t.relativePath) === cFile)) {
                        matchedSong = song;
                        matchedTab = t;
                        break;
                    }
                }
            }
            if (matchedSong) break;

            // Check by title and artist match
            const sTitle = clean(song.title);
            const sArtist = clean(song.artist);
            if (cTitle && sTitle && (cTitle === sTitle || cTitle.includes(sTitle) || sTitle.includes(cTitle))) {
                if (!cArtist || !sArtist || cArtist === sArtist || cArtist.includes(sArtist) || sArtist.includes(cArtist)) {
                    matchedSong = song;
                    break;
                }
            }
        }

        if (matchedSong) {
            let updated = false;
            if (matchedTab) {
                if (primaryTuning && matchedTab.tuning !== primaryTuning) {
                    matchedTab.tuning = primaryTuning;
                    updated = true;
                }
                if (stringCount && matchedTab.stringCount !== stringCount) {
                    matchedTab.stringCount = stringCount;
                    updated = true;
                }
                if (Array.isArray(tunings) && tunings.length > 0) {
                    matchedTab.tunings = tunings;
                    updated = true;
                }
            }

            if (primaryTuning && matchedSong.tuning !== primaryTuning) {
                matchedSong.tuning = primaryTuning;
                updated = true;
            }
            if (stringCount && matchedSong.stringCount !== stringCount) {
                matchedSong.stringCount = stringCount;
                updated = true;
            }
            if (Array.isArray(tunings) && tunings.length > 0) {
                matchedSong.tunings = tunings;
                updated = true;
            }

            if (updated) {
                await saveSongToLibrary(matchedSong, matchedSong.collectionId);
                return true;
            }
        }
    } catch (e) {
        console.warn('[updateLibrarySongFromScore] Error:', e);
    }
    return false;
}

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
        tuning: fileInfo.tuning || null,
        stringCount: fileInfo.stringCount || null,
        tunings: Array.isArray(fileInfo.tunings) ? fileInfo.tunings : (fileInfo.tuning ? [fileInfo.tuning] : []),
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

/**
 * Delete a single item from recents
 */
export async function deleteRecentItem(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_RECENTS, 'readwrite');
        const store = tx.objectStore(STORE_RECENTS);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get all library songs
 */
export async function getAllSongs() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Export all library data (collections, songs, and recents)
 */
export async function getAllLibraryData() {
    const collections = await getCollections();
    const songs = await getAllSongs();
    const recents = await getRecents(500);
    return {
        collections,
        songs,
        recents
    };
}

/**
 * Clear all library stores
 */
export async function clearAllLibraryData() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_COLLECTIONS, STORE_SONGS, STORE_RECENTS], 'readwrite');
        tx.objectStore(STORE_COLLECTIONS).clear();
        tx.objectStore(STORE_SONGS).clear();
        tx.objectStore(STORE_RECENTS).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Import or restore library data
 * @param {object} data - { collections, songs, recents }
 * @param {object} options - { wipe: boolean }
 */
export async function importLibraryData(data = {}, { wipe = false } = {}) {
    if (wipe) {
        await clearAllLibraryData();
    }

    await ensureDefaultCollection();
    const db = await getDB();

    const collections = Array.isArray(data.collections) ? data.collections : [];
    const songs = Array.isArray(data.songs) ? data.songs : [];
    const recents = Array.isArray(data.recents) ? data.recents : [];

    let collectionsCount = 0;
    let songsCount = 0;
    let recentsCount = 0;

    // 1. Collections
    for (const col of collections) {
        if (!col || !col.id) continue;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_COLLECTIONS, 'readwrite');
            const store = tx.objectStore(STORE_COLLECTIONS);
            if (wipe) {
                const req = store.put(col);
                req.onsuccess = () => { collectionsCount++; resolve(); };
                req.onerror = () => reject(req.error);
            } else {
                const checkReq = store.get(col.id);
                checkReq.onsuccess = () => {
                    if (!checkReq.result) {
                        const putReq = store.put(col);
                        putReq.onsuccess = () => { collectionsCount++; resolve(); };
                        putReq.onerror = () => reject(putReq.error);
                    } else {
                        resolve();
                    }
                };
                checkReq.onerror = () => reject(checkReq.error);
            }
        });
    }

    // 2. Songs
    for (const song of songs) {
        if (!song || !song.id) continue;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_SONGS, 'readwrite');
            const store = tx.objectStore(STORE_SONGS);
            if (wipe) {
                const req = store.put(song);
                req.onsuccess = () => { songsCount++; resolve(); };
                req.onerror = () => reject(req.error);
            } else {
                const checkReq = store.get(song.id);
                checkReq.onsuccess = () => {
                    const existing = checkReq.result;
                    if (!existing) {
                        const putReq = store.put(song);
                        putReq.onsuccess = () => { songsCount++; resolve(); };
                        putReq.onerror = () => reject(putReq.error);
                    } else {
                        // Merge tab options and tunings into existing song
                        const existingTabs = Array.isArray(existing.tabOptions) ? existing.tabOptions : [];
                        const incomingTabs = Array.isArray(song.tabOptions) ? song.tabOptions : [];
                        let tabsAdded = false;

                        for (const inTab of incomingTabs) {
                            const match = existingTabs.some(t =>
                                (t.id && inTab.id && t.id === inTab.id) ||
                                (t.fileStoreId && inTab.fileStoreId && t.fileStoreId === inTab.fileStoreId) ||
                                (t.name && inTab.name && t.name === inTab.name && t.relativePath === inTab.relativePath)
                            );
                            if (!match) {
                                existingTabs.push(inTab);
                                tabsAdded = true;
                            }
                        }

                        const mergedTunings = Array.from(new Set([
                            ...(Array.isArray(existing.tunings) ? existing.tunings : []),
                            ...(Array.isArray(song.tunings) ? song.tunings : [])
                        ]));

                        if (tabsAdded || mergedTunings.length !== (existing.tunings?.length || 0)) {
                            existing.tabOptions = existingTabs;
                            existing.tunings = mergedTunings;
                            const putReq = store.put(existing);
                            putReq.onsuccess = () => { songsCount++; resolve(); };
                            putReq.onerror = () => reject(putReq.error);
                        } else {
                            resolve();
                        }
                    }
                };
                checkReq.onerror = () => reject(checkReq.error);
            }
        });
    }

    // 3. Recents
    for (const recent of recents) {
        if (!recent || !recent.id) continue;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_RECENTS, 'readwrite');
            const store = tx.objectStore(STORE_RECENTS);
            if (wipe) {
                const req = store.put(recent);
                req.onsuccess = () => { recentsCount++; resolve(); };
                req.onerror = () => reject(req.error);
            } else {
                const checkReq = store.get(recent.id);
                checkReq.onsuccess = () => {
                    if (!checkReq.result) {
                        const putReq = store.put(recent);
                        putReq.onsuccess = () => { recentsCount++; resolve(); };
                        putReq.onerror = () => reject(putReq.error);
                    } else {
                        resolve();
                    }
                };
                checkReq.onerror = () => reject(checkReq.error);
            }
        });
    }

    return {
        collectionsCount,
        songsCount,
        recentsCount
    };
}

/**
 * Reload all library metadata from MusicBrainz.
 * Re-queries MusicBrainz for all albums and songs in the library, filling in any missing fields
 * (such as track times/lengths, track numbers, release years, cover artwork, and MBIDs).
 * Attached tabs, file links, custom tunings, and collections remain strictly intact.
 *
 * @param {object} options
 * @param {function} [options.onProgress] - Progress callback: ({ current, total, percent, phase, name, stats })
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel reload operation
 * @param {boolean} [options.forceRefresh=true] - If true, clears session cache to force fresh MusicBrainz queries
 * @returns {Promise<object>} Stats summary of reloaded items
 */
export async function reloadAllLibraryMetadata({ onProgress = () => {}, signal = null, forceRefresh = true } = {}) {
    if (forceRefresh) {
        try {
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('mb_cache_')) {
                    sessionStorage.removeItem(key);
                }
            }
        } catch {}
    }

    const songs = await getAllSongs();
    if (!songs || songs.length === 0) {
        return {
            totalSongs: 0,
            updatedSongs: 0,
            updatedAlbums: 0,
            addedDurations: 0,
            addedCovers: 0,
            addedYears: 0,
            errors: []
        };
    }

    const stats = {
        totalSongs: songs.length,
        updatedSongs: 0,
        updatedAlbums: 0,
        addedDurations: 0,
        addedCovers: 0,
        addedYears: 0,
        updatedTunings: 0,
        errors: []
    };

    // Helper to analyze attached tabs from persistent fileStore and detect tunings & string counts
    const enrichSongWithTabMetadata = async (song) => {
        let changed = false;
        if (Array.isArray(song.tabOptions) && song.tabOptions.length > 0) {
            for (const tab of song.tabOptions) {
                if (tab.fileStoreId) {
                    try {
                        const stored = await getStoredFile(tab.fileStoreId);
                        if (stored && stored.file) {
                            const meta = await detectFileMetadata(stored.file, stored.file.name || tab.name);
                            if (meta.primaryTuning && tab.tuning !== meta.primaryTuning) {
                                tab.tuning = meta.primaryTuning;
                                changed = true;
                            }
                            if (meta.stringCount && tab.stringCount !== meta.stringCount) {
                                tab.stringCount = meta.stringCount;
                                changed = true;
                            }
                            if (Array.isArray(meta.tunings) && meta.tunings.length > 0) {
                                tab.tunings = meta.tunings;
                                changed = true;
                            }
                            if (!song.tuning || tab.isDefault) {
                                if (meta.primaryTuning && song.tuning !== meta.primaryTuning) {
                                    song.tuning = meta.primaryTuning;
                                    changed = true;
                                }
                            }
                            if (meta.stringCount && (!song.stringCount || meta.stringCount > song.stringCount)) {
                                song.stringCount = meta.stringCount;
                                changed = true;
                            }
                            if (Array.isArray(meta.tunings) && meta.tunings.length > 0) {
                                if (!Array.isArray(song.tunings)) song.tunings = [];
                                for (const t of meta.tunings) {
                                    if (t && !song.tunings.includes(t)) {
                                        song.tunings.push(t);
                                        changed = true;
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`[enrichSongWithTabMetadata] Error analyzing tab ${tab.name}:`, e);
                    }
                } else if (tab.name && (!tab.tuning || !tab.stringCount)) {
                    const meta = await detectFileMetadata(null, tab.name);
                    if (meta.primaryTuning && !tab.tuning) {
                        tab.tuning = meta.primaryTuning;
                        changed = true;
                    }
                    if (meta.stringCount && !tab.stringCount) {
                        tab.stringCount = meta.stringCount;
                        changed = true;
                    }
                    if (!song.tuning && meta.primaryTuning) {
                        song.tuning = meta.primaryTuning;
                        changed = true;
                    }
                    if (!song.stringCount && meta.stringCount) {
                        song.stringCount = meta.stringCount;
                        changed = true;
                    }
                }
            }
        }
        return changed;
    };

    // Helper for title cleaning and matching
    const cleanTitle = (t) => {
        return (t || '')
            .toLowerCase()
            .replace(/\(.*\)/g, '')
            .replace(/\[.*\]/g, '')
            .replace(/[^a-z0-9]/g, '')
            .trim();
    };

    // Group songs into Album Groups and Standalone Songs
    const albumGroups = new Map();
    const standaloneSongs = [];

    for (const song of songs) {
        const artist = (song.artist || '').trim();
        const album = (song.album || '').trim();
        const albumMbid = (song.albumMbid || '').trim();

        const isSingleOrUnknown = !album ||
            album.toLowerCase() === 'singles / other' ||
            album.toLowerCase() === 'unknown album' ||
            album.toLowerCase() === 'single' ||
            album.toLowerCase() === 'singles';

        if (!isSingleOrUnknown && (albumMbid || (artist && album))) {
            const groupKey = albumMbid ? `mbid:${albumMbid}` : `name:${artist.toLowerCase()}:::${album.toLowerCase()}`;
            if (!albumGroups.has(groupKey)) {
                albumGroups.set(groupKey, {
                    artist,
                    album,
                    albumMbid: albumMbid || null,
                    artistMbid: song.artistMbid || null,
                    songs: []
                });
            }
            const grp = albumGroups.get(groupKey);
            if (!grp.artist && artist) grp.artist = artist;
            if (!grp.artistMbid && song.artistMbid) grp.artistMbid = song.artistMbid;
            if (!grp.albumMbid && albumMbid) grp.albumMbid = albumMbid;
            grp.songs.push(song);
        } else {
            standaloneSongs.push(song);
        }
    }

    const totalSteps = albumGroups.size + standaloneSongs.length + songs.length;
    let currentStep = 0;

    const report = (name, phase = 'album') => {
        const percent = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 100;
        onProgress({
            current: currentStep,
            total: totalSteps,
            percent,
            phase,
            name,
            stats
        });
    };

    const updatedSongMap = new Map();

    // 1. Process Album Groups
    for (const [key, grp] of albumGroups.entries()) {
        if (signal?.aborted) break;
        currentStep++;
        report(`${grp.artist} - ${grp.album}`, 'album');

        try {
            let albumData = null;
            if (grp.albumMbid) {
                albumData = await getAlbumTracks(grp.albumMbid);
            }

            if (!albumData || !albumData.tracks || albumData.tracks.length === 0) {
                // Search by artist and album title
                const query = `${grp.artist} ${grp.album}`.trim();
                const searchResults = await searchMusicBrainz(query, 'album');
                if (searchResults && searchResults.length > 0) {
                    const match = searchResults.find(rg =>
                        cleanTitle(rg.artist).includes(cleanTitle(grp.artist)) ||
                        cleanTitle(grp.artist).includes(cleanTitle(rg.artist))
                    ) || searchResults[0];

                    if (match && match.id) {
                        albumData = await getAlbumTracks(match.id);
                    }
                }
            }

            if (albumData && albumData.tracks && albumData.tracks.length > 0) {
                stats.updatedAlbums++;
                const tracks = albumData.tracks;

                for (const song of grp.songs) {
                    if (signal?.aborted) break;

                    // Match track in albumData.tracks
                    let matchedTrack = null;
                    if (song.recordingMbid) {
                        matchedTrack = tracks.find(t => t.recordingMbid && t.recordingMbid === song.recordingMbid);
                    }
                    if (!matchedTrack && song.trackNumber) {
                        matchedTrack = tracks.find(t =>
                            t.trackNumber === song.trackNumber &&
                            (t.mediumNumber || 1) === (song.mediumNumber || 1)
                        );
                    }
                    if (!matchedTrack) {
                        const sClean = cleanTitle(song.title);
                        matchedTrack = tracks.find(t => cleanTitle(t.title) === sClean);
                    }
                    if (!matchedTrack) {
                        const sClean = cleanTitle(song.title);
                        matchedTrack = tracks.find(t => {
                            const tClean = cleanTitle(t.title);
                            return sClean && tClean && (tClean.includes(sClean) || sClean.includes(tClean));
                        });
                    }

                    let songUpdated = false;

                    // Update album-level fields
                    if (albumData.artist && song.artist !== albumData.artist) {
                        song.artist = albumData.artist;
                        songUpdated = true;
                    }
                    if (albumData.artistMbid && song.artistMbid !== albumData.artistMbid) {
                        song.artistMbid = albumData.artistMbid;
                        songUpdated = true;
                    }
                    if (albumData.title && song.album !== albumData.title) {
                        song.album = albumData.title;
                        songUpdated = true;
                    }
                    if (albumData.releaseGroupId && song.albumMbid !== albumData.releaseGroupId) {
                        song.albumMbid = albumData.releaseGroupId;
                        songUpdated = true;
                    }
                    if (albumData.year && song.year !== albumData.year) {
                        if (!song.year) stats.addedYears++;
                        song.year = albumData.year;
                        songUpdated = true;
                    }
                    if (albumData.coverUrl && (!song.coverUrl || song.coverUrl.includes('data:image/svg+xml') || song.coverUrl !== albumData.coverUrl)) {
                        if (!song.coverUrl || song.coverUrl.includes('data:image/svg+xml')) stats.addedCovers++;
                        song.coverUrl = albumData.coverUrl;
                        songUpdated = true;
                    }

                    if (matchedTrack) {
                        if (typeof matchedTrack.length === 'number' && matchedTrack.length > 0) {
                            if (!song.length || song.length <= 0) stats.addedDurations++;
                            song.length = matchedTrack.length;
                            songUpdated = true;
                        }
                        if (matchedTrack.trackNumber && song.trackNumber !== matchedTrack.trackNumber) {
                            song.trackNumber = matchedTrack.trackNumber;
                            songUpdated = true;
                        }
                        if (matchedTrack.mediumNumber && song.mediumNumber !== matchedTrack.mediumNumber) {
                            song.mediumNumber = matchedTrack.mediumNumber;
                            songUpdated = true;
                        }
                        if (matchedTrack.mediumTitle && song.mediumTitle !== matchedTrack.mediumTitle) {
                            song.mediumTitle = matchedTrack.mediumTitle;
                            songUpdated = true;
                        }
                        if (matchedTrack.mediumFormat && song.mediumFormat !== matchedTrack.mediumFormat) {
                            song.mediumFormat = matchedTrack.mediumFormat;
                            songUpdated = true;
                        }
                        if (matchedTrack.recordingMbid && song.recordingMbid !== matchedTrack.recordingMbid) {
                            song.recordingMbid = matchedTrack.recordingMbid;
                            songUpdated = true;
                        }
                        if (matchedTrack.coverUrl && (!song.coverUrl || song.coverUrl.includes('data:image/svg+xml'))) {
                            song.coverUrl = matchedTrack.coverUrl;
                            stats.addedCovers++;
                            songUpdated = true;
                        }
                    } else {
                        // Song not matched in album tracks -> fallback to standalone song query
                        standaloneSongs.push(song);
                    }

                    if (songUpdated) {
                        await saveSongToLibrary(song, song.collectionId);
                        updatedSongMap.set(song.id, song);
                        stats.updatedSongs++;
                    }
                }
            } else {
                // Album not found on MusicBrainz -> queue its songs as standalone songs
                for (const song of grp.songs) {
                    standaloneSongs.push(song);
                }
            }
        } catch (err) {
            console.warn(`[reloadMetadata] Error processing album ${grp.artist} - ${grp.album}:`, err);
            stats.errors.push(`${grp.artist} - ${grp.album}: ${err.message}`);
        }
    }

    // 2. Process Standalone Songs
    for (const song of standaloneSongs) {
        if (signal?.aborted) break;
        currentStep++;
        report(`${song.artist || 'Unknown'} - ${song.title}`, 'song');

        try {
            let songUpdated = false;

            if (song.recordingMbid) {
                const url = `https://musicbrainz.org/ws/2/recording/${song.recordingMbid}?inc=artists+releases+media&fmt=json`;
                const recData = await fetchMusicBrainz(url);
                if (recData) {
                    const lenSec = recData.length ? Math.round(recData.length / 1000) : null;
                    if (lenSec && lenSec > 0) {
                        if (!song.length || song.length <= 0) stats.addedDurations++;
                        song.length = lenSec;
                        songUpdated = true;
                    }
                    const artistCredit = recData['artist-credit']?.map(ac => ac.name || ac.artist?.name).join('');
                    if (artistCredit && song.artist !== artistCredit) {
                        song.artist = artistCredit;
                        songUpdated = true;
                    }
                    const artistMbid = recData['artist-credit']?.[0]?.artist?.id;
                    if (artistMbid && song.artistMbid !== artistMbid) {
                        song.artistMbid = artistMbid;
                        songUpdated = true;
                    }
                    const bestRelease = recData.releases?.[0];
                    if (bestRelease) {
                        const rgId = bestRelease['release-group']?.id || bestRelease.id;
                        if (rgId && song.albumMbid !== rgId) {
                            song.albumMbid = rgId;
                            songUpdated = true;
                        }
                        if (bestRelease.title && (!song.album || song.album === 'Singles / Other' || song.album === 'Unknown Album')) {
                            song.album = bestRelease.title;
                            songUpdated = true;
                        }
                        if (bestRelease.date && !song.year) {
                            song.year = parseInt(bestRelease.date.slice(0, 4), 10);
                            stats.addedYears++;
                            songUpdated = true;
                        }
                        if (rgId && (!song.coverUrl || song.coverUrl.includes('data:image/svg+xml'))) {
                            const cov = getCoverArtUrl(rgId);
                            if (cov) {
                                song.coverUrl = cov;
                                stats.addedCovers++;
                                songUpdated = true;
                            }
                        }
                    }
                }
            } else {
                // Search recording by artist & title
                const query = `${song.artist} ${song.title}`.trim();
                const searchResults = await searchMusicBrainz(query, 'song');
                if (searchResults && searchResults.length > 0) {
                    const sClean = cleanTitle(song.title);
                    const aClean = cleanTitle(song.artist);
                    const match = searchResults.find(r =>
                        (cleanTitle(r.title) === sClean || cleanTitle(r.title).includes(sClean) || sClean.includes(cleanTitle(r.title))) &&
                        (cleanTitle(r.artist).includes(aClean) || aClean.includes(cleanTitle(r.artist)))
                    ) || searchResults[0];

                    if (match) {
                        if (typeof match.length === 'number' && match.length > 0) {
                            if (!song.length || song.length <= 0) stats.addedDurations++;
                            song.length = match.length;
                            songUpdated = true;
                        }
                        if (match.recordingMbid && song.recordingMbid !== match.recordingMbid) {
                            song.recordingMbid = match.recordingMbid;
                            songUpdated = true;
                        }
                        if (match.artistMbid && song.artistMbid !== match.artistMbid) {
                            song.artistMbid = match.artistMbid;
                            songUpdated = true;
                        }
                        if (match.albumMbid && song.albumMbid !== match.albumMbid) {
                            song.albumMbid = match.albumMbid;
                            songUpdated = true;
                        }
                        if (match.album && (!song.album || song.album === 'Singles / Other' || song.album === 'Unknown Album')) {
                            song.album = match.album;
                            songUpdated = true;
                        }
                        if (match.year && song.year !== match.year) {
                            if (!song.year) stats.addedYears++;
                            song.year = match.year;
                            songUpdated = true;
                        }
                        if (match.coverUrl && (!song.coverUrl || song.coverUrl.includes('data:image/svg+xml'))) {
                            song.coverUrl = match.coverUrl;
                            stats.addedCovers++;
                            songUpdated = true;
                        }
                    }
                }
            }

            if (songUpdated) {
                await saveSongToLibrary(song, song.collectionId);
                updatedSongMap.set(song.id, song);
                stats.updatedSongs++;
            }
        } catch (err) {
            console.warn(`[reloadMetadata] Error processing song ${song.title}:`, err);
            stats.errors.push(`${song.title}: ${err.message}`);
        }
    }

    // 3. Scan all library songs to ensure stored tab files have tunings & string counts detected
    for (const song of songs) {
        if (signal?.aborted) break;
        currentStep++;
        report(`${song.artist ? `${song.artist} - ` : ''}${song.title} (Scanning tabs)`, 'tuning');
        try {
            const tabUpdated = await enrichSongWithTabMetadata(song);
            if (tabUpdated) {
                stats.updatedTunings++;
                await saveSongToLibrary(song, song.collectionId);
                if (!updatedSongMap.has(song.id)) {
                    updatedSongMap.set(song.id, song);
                    stats.updatedSongs++;
                }
            }
        } catch (e) {
            console.warn(`[reloadMetadata] Error enriching tab metadata for ${song.title}:`, e);
        }
    }

    // 4. Update matching recents if any were modified
    if (updatedSongMap.size > 0) {
        try {
            const recents = await getRecents(500);
            const db = await getDB();
            for (const rec of recents) {
                if (rec.librarySongId && updatedSongMap.has(rec.librarySongId)) {
                    const updatedSong = updatedSongMap.get(rec.librarySongId);
                    rec.songTitle = updatedSong.title || rec.songTitle;
                    rec.artist = updatedSong.artist || rec.artist;
                    rec.album = updatedSong.album || rec.album;
                    rec.coverUrl = updatedSong.coverUrl || rec.coverUrl;
                    await new Promise((res, rej) => {
                        const tx = db.transaction(STORE_RECENTS, 'readwrite');
                        const store = tx.objectStore(STORE_RECENTS);
                        const req = store.put(rec);
                        req.onsuccess = () => res();
                        req.onerror = () => rej(req.error);
                    });
                }
            }
        } catch (e) {
            console.warn('Could not update recents:', e);
        }
    }

    currentStep = totalSteps;
    report('Completed', 'complete');

    // Notify UI / other components that library data has updated
    try {
        window.dispatchEvent(new CustomEvent('libraryDataChanged'));
    } catch {}

    return stats;
}

