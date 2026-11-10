// tests/bulkExport.test.mjs
import assert from 'node:assert/strict';
import {
    escapeCsvCell,
    toCsvRow,
    safeName,
    uniquePath,
    getCandidateKeysForSong,
    exportMetadataCsv,
    buildOriginalsZipEntries,
    buildLibraryPdfsZipEntries,
    getMimeType,
    formatBytes,
    saveOrDownloadBlob
} from '../src/bulkExport/bulkExportCore.js';

console.log('Testing bulkExportCore...');

// 1. escapeCsvCell
assert.equal(escapeCsvCell(null), '');
assert.equal(escapeCsvCell(undefined), '');
assert.equal(escapeCsvCell(''), '');
assert.equal(escapeCsvCell('plain text'), 'plain text');
assert.equal(escapeCsvCell('text with, comma'), '"text with, comma"');
assert.equal(escapeCsvCell('text with "quotes"'), '"text with ""quotes"""');
assert.equal(escapeCsvCell('line 1\nline 2'), '"line 1\nline 2"');
assert.equal(escapeCsvCell('line 1\r\nline 2'), '"line 1\r\nline 2"');

// 2. toCsvRow
assert.equal(toCsvRow(['a', 'b', 'c']), 'a,b,c');
assert.equal(toCsvRow(['a,1', 'b"2', 'c\n3']), '"a,1","b""2","c\n3"');

// 3. safeName
assert.equal(safeName('Artist / Band: Name *?'), 'Artist _ Band_ Name __');
assert.equal(safeName('   Spaced   Out   '), 'Spaced Out');
assert.equal(safeName('', 'Fallback'), 'Fallback');
assert.equal(safeName(null, 'Fallback'), 'Fallback');

// 4. uniquePath
const used = new Set();
assert.equal(uniquePath('Artist/Album/Tab.gp5', used), 'Artist/Album/Tab.gp5');
assert.equal(uniquePath('Artist/Album/Tab.gp5', used), 'Artist/Album/Tab (2).gp5');
assert.equal(uniquePath('Artist/Album/Tab.gp5', used), 'Artist/Album/Tab (3).gp5');
assert.equal(uniquePath('Folder/PlainName', used), 'Folder/PlainName');
assert.equal(uniquePath('Folder/PlainName', used), 'Folder/PlainName (2)');

// 5. getCandidateKeysForSong
class MockStorage {
    constructor(data = {}) {
        this.store = new Map(Object.entries(data));
    }
    getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
    setItem(k, v) { this.store.set(k, String(v)); }
}

const mockStorage = new MockStorage({
    'yt_song_keys_song1': JSON.stringify(['Custom Key', 'Another Tab Name']),
    'yt_track_metallica%20-%20master%20of%20puppets_original': 'dQw4w9WgXcQ',
    'yt_track_metallica%20-%20master%20of%20puppets_backing': 'xyz12345678'
});

const song1 = {
    id: 'song1',
    artist: 'Metallica',
    title: 'Master of Puppets',
    album: 'Master of Puppets',
    year: 1986,
    tunings: ['E Standard'],
    tabOptions: [
        { name: 'Lead Guitar.gp5', fileStoreId: 'file_lead' },
        { name: 'Rhythm Guitar.pdf', fileStoreId: 'file_rhythm' }
    ]
};

const keys = getCandidateKeysForSong(song1, mockStorage);
assert(keys.includes('Metallica - Master of Puppets'));
assert(keys.includes('Master of Puppets'));
assert(keys.includes('Custom Key'));
assert(keys.includes('Lead Guitar.gp5'));

// 6. exportMetadataCsv
const mockSyncRecords = [
    {
        version: 1,
        media: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' },
        points: [
            { id: 'p_0_0_0', barIndex: 0, occurrence: 0, pos: 0, timeMs: 1200, source: 'manual' },
            { id: 'p_1_0_0', barIndex: 1, occurrence: 0, pos: 0, timeMs: 3400, source: 'manual' }
        ],
        updatedAt: 1700000000000
    }
];

const mockListRecords = (key) => {
    if (key.toLowerCase().includes('master of puppets')) return mockSyncRecords;
    return [];
};

const { csvString, count, stats } = exportMetadataCsv({
    songs: [song1],
    collections: [],
    storage: mockStorage,
    listRecordsFn: mockListRecords
});

assert.equal(count, 1);
assert.equal(stats.totalSongs, 1);
assert.equal(stats.songsWithOriginalVideo, 1);
assert.equal(stats.songsWithBackingVideo, 1);
assert.equal(stats.songsWithSync, 1);

// Verify CSV content and parseability
const lines = csvString.split('\r\n');
assert.equal(lines.length, 2); // Header + 1 row
const headerParts = lines[0].split(',');
assert.deepEqual(headerParts, [
    'artist',
    'album',
    'song',
    'youtube url',
    'youtube backing url',
    'sync data',
    'tunings',
    'tab_files',
    'year'
]);

assert(lines[1].includes('Metallica'));
assert(lines[1].includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
assert(lines[1].includes('https://www.youtube.com/watch?v=xyz12345678'));
assert(lines[1].includes('E Standard'));
assert(lines[1].includes('1986'));

// Verify that the sync data column in the CSV is valid JSON when unescaped
const matches = lines[1].match(/"(\[\{.*\}\])"/);
assert(matches, 'Sync data JSON should be enclosed in quotes');
const unescapedSync = matches[1].replace(/""/g, '"');
const parsedSync = JSON.parse(unescapedSync);
assert.equal(parsedSync.length, 1);
assert.equal(parsedSync[0].points.length, 2);
assert.equal(parsedSync[0].points[0].timeMs, 1200);

// 7. buildOriginalsZipEntries
const mockStoredFilesMap = new Map([
    ['file_lead', { file: { name: 'Lead Guitar.gp5', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } }],
    ['file_rhythm', { file: { name: 'Rhythm Guitar.pdf', arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer } }],
    ['file_orphan', { file: { name: 'Unlinked.gp4', arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer } }]
]);

const allStoredFilesMeta = [
    { id: 'file_lead', name: 'Lead Guitar.gp5' },
    { id: 'file_rhythm', name: 'Rhythm Guitar.pdf' },
    { id: 'file_orphan', name: 'Unlinked.gp4' }
];

const originalsResult = await buildOriginalsZipEntries({
    songs: [song1],
    collections: [],
    allStoredFiles: allStoredFilesMeta,
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    includeUnlinked: true
});

assert.equal(originalsResult.count, 3);
const entryPaths = Object.keys(originalsResult.entries);
assert(entryPaths.includes('Metallica/Master of Puppets/Lead Guitar.gp5'));
assert(entryPaths.includes('Metallica/Master of Puppets/Rhythm Guitar.pdf'));
assert(entryPaths.includes('Unsorted/Unlinked.gp4'));

// Verify byte arrays in entries
assert.deepEqual(originalsResult.entries['Metallica/Master of Puppets/Lead Guitar.gp5'][0], new Uint8Array([1, 2, 3]));

// 8. buildOriginalsZipEntries with collections
const songWithCollection = {
    ...song1,
    id: 'song2',
    collectionId: 'col_metal',
    tabOptions: [{ name: 'Solo.gp5', fileStoreId: 'file_lead' }]
};

const collectionsResult = await buildOriginalsZipEntries({
    songs: [songWithCollection],
    collections: [{ id: 'col_metal', name: 'Metal' }, { id: 'col_rock', name: 'Rock' }],
    allStoredFiles: [],
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    includeUnlinked: false
});

assert(Object.keys(collectionsResult.entries).includes('Metal/Metallica/Master of Puppets/Lead Guitar.gp5'));

// 9. Abort signal test
const controller = new AbortController();
controller.abort();
const abortedResult = await buildOriginalsZipEntries({
    songs: [song1],
    collections: [],
    allStoredFiles: allStoredFilesMeta,
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    abortSignal: controller.signal
});
assert.equal(abortedResult, null);

// 10. getMimeType and formatBytes
assert.equal(getMimeType('test.csv'), 'text/csv');
assert.equal(getMimeType('test.zip'), 'application/zip');
assert.equal(getMimeType('test.pdf'), 'application/pdf');
assert.equal(getMimeType('test.txt'), 'text/plain');
assert.equal(getMimeType('test.unknown'), 'application/octet-stream');

assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(1024), '1 KB');
assert.equal(formatBytes(1048576), '1 MB');

// 11. saveOrDownloadBlob in non-DOM environment
const dummyBlob = new Blob(['hello'], { type: 'text/plain' });
const res = await saveOrDownloadBlob(dummyBlob, 'test.txt');
assert.equal(res, false);

// 12. buildLibraryPdfsZipEntries
const mockPdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
const mockRenderTabToPdf = async (file) => {
    return mockPdfBytes;
};

const pdfsResult = await buildLibraryPdfsZipEntries({
    songs: [song1],
    collections: [],
    allStoredFiles: allStoredFilesMeta,
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    renderTabToPdfFn: mockRenderTabToPdf,
    includeUnlinked: true
});

assert.equal(pdfsResult.count, 3);
const pdfEntryPaths = Object.keys(pdfsResult.entries);
assert(pdfEntryPaths.includes('Metallica/Master of Puppets/Lead Guitar.pdf'), 'Should rename gp5 to .pdf');
assert(pdfEntryPaths.includes('Metallica/Master of Puppets/Rhythm Guitar.pdf'), 'Should keep pdf extension');
assert(pdfEntryPaths.includes('Unsorted/Unlinked.pdf'), 'Should rename unsorted gp4 to .pdf');
assert.deepEqual(pdfsResult.entries['Metallica/Master of Puppets/Lead Guitar.pdf'][0], mockPdfBytes);

// 13. buildLibraryPdfsZipEntries with collections and abort signal
const colPdfsResult = await buildLibraryPdfsZipEntries({
    songs: [songWithCollection],
    collections: [{ id: 'col_metal', name: 'Metal' }, { id: 'col_rock', name: 'Rock' }],
    allStoredFiles: [],
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    renderTabToPdfFn: mockRenderTabToPdf
});
assert(Object.keys(colPdfsResult.entries).includes('Metal/Metallica/Master of Puppets/Solo.pdf'));

const pdfsAborted = await buildLibraryPdfsZipEntries({
    songs: [song1],
    collections: [],
    getStoredFile: async (id) => mockStoredFilesMap.get(id),
    renderTabToPdfFn: mockRenderTabToPdf,
    abortSignal: controller.signal
});
assert.equal(pdfsAborted, null);

console.log('bulkExportCore tests passed!');
