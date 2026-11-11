// Run with: node --test tests/downloaderIntercept.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    unwrapGoogleUrl,
    unwrapRedirectUrl,
    isWsaTabUrl,
    getDownloaderUrlFromMatchedUrl,
    attachSyncForMatchedUrl,
    extractTabSongId,
    encodeTabDownloaderPayload,
    extractTabMetaFromHtml,
    generateDownloaderTransferScript
} from '../src/utils/downloaderIntercept.js';

test('unwrapRedirectUrl unwraps redirects across search engines and proxies', () => {
    const direct = 'https://www.example.com/a/wsa/artist-song-s1234';
    const googleQ = `https://www.google.com/url?q=${encodeURIComponent(direct)}&sa=U&ved=0ahUKEwi`;
    const googleUrl = `https://www.google.com/url?url=${encodeURIComponent(direct)}&usg=AFQjCN`;
    const ddgUddg = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(direct)}&rut=...`;
    const genericProxy = `https://out.reddit.com/url?url=${encodeURIComponent(direct)}`;

    assert.equal(unwrapRedirectUrl(googleQ), direct);
    assert.equal(unwrapRedirectUrl(googleUrl), direct);
    assert.equal(unwrapRedirectUrl(ddgUddg), direct);
    assert.equal(unwrapRedirectUrl(genericProxy), direct);
    assert.equal(unwrapRedirectUrl(direct), direct);
    assert.equal(unwrapRedirectUrl(''), '');
    assert.equal(unwrapRedirectUrl(null), '');
    // Alias check
    assert.equal(unwrapGoogleUrl(googleQ), direct);
});

test('isWsaTabUrl detects endpoint pattern on score URLs', () => {
    // Direct links on any website, forum, or blog
    assert.ok(isWsaTabUrl('https://www.example.com/a/wsa/artist-song-tab-s12345'));
    assert.ok(isWsaTabUrl('https://example.com/a/wsa/another-song-s999/r1'));
    assert.ok(isWsaTabUrl('https://tab-community.org/a/wsa/guitar-solo-s777'));

    // Negative cases
    assert.ok(!isWsaTabUrl('https://example.com/artists/artist-name'));
    assert.ok(!isWsaTabUrl('https://example.com/a/wsa/no-song-id-here'));
    assert.ok(!isWsaTabUrl('https://example.com/search?q=' + encodeURIComponent('https://example.com/a/wsa/song-s42')));
    assert.ok(!isWsaTabUrl('https://example.com/url?q=' + encodeURIComponent('https://example.com/a/wsa/song-s42')));
    assert.ok(!isWsaTabUrl('https://reddit.com/r/guitar'));
    assert.ok(!isWsaTabUrl(''));
    assert.ok(!isWsaTabUrl(null));
});

test('getDownloaderUrlFromMatchedUrl dynamically derives downloader destination', () => {
    assert.equal(
        getDownloaderUrlFromMatchedUrl('https://www.custombrand.com/a/wsa/song-s123'),
        'https://www.custombrand-downloader.com/'
    );
    assert.equal(
        getDownloaderUrlFromMatchedUrl('https://custombrand.com/a/wsa/song-s123'),
        'https://www.custombrand-downloader.com/'
    );
    assert.equal(
        getDownloaderUrlFromMatchedUrl('https://sub.platform.co.uk/a/wsa/song-s123'),
        'https://www.platform-downloader.com/'
    );
    // Unwraps Google redirect automatically
    const googleRedirect = 'https://www.google.com/url?q=' + encodeURIComponent('https://www.brandname.com/a/wsa/song-s99');
    assert.equal(
        getDownloaderUrlFromMatchedUrl(googleRedirect),
        'https://www.brandname-downloader.com/'
    );
});

test('extractTabSongId parses numeric song IDs from score paths', () => {
    assert.equal(extractTabSongId('https://www.custombrand.com/a/wsa/artist-song-s1234'), 1234);
    assert.equal(extractTabSongId('/a/wsa/artist-song-s5678/r2'), 5678);
    assert.equal(extractTabSongId('/a/wsa/song-s999/'), 999);
    assert.equal(extractTabSongId('/invalid/path-without-id'), null);
    assert.equal(extractTabSongId(''), null);
    assert.equal(extractTabSongId(null), null);
});

test('encodeTabDownloaderPayload normalizes tracks and serializes to base64url', () => {
    const current = {
        songId: 1234,
        revisionId: 5678,
        image: 'https://example.com/cover.jpg',
        title: 'Song Title',
        artist: 'Artist Name',
        artistId: 99,
        tracks: [
            {
                partId: 10,
                instrumentId: 25,
                title: 'Guitar Lead',
                name: 'Clean Guitar',
                tuning: [64, 59, 55, 50, 45, 40],
                isDrums: false,
                internalField: 'ignore_me'
            }
        ]
    };
    const targetUrl = 'https://www.custombrand.com/a/wsa/artist-song-s1234?tab=lead#anchor';
    const b64 = encodeTabDownloaderPayload(current, targetUrl);

    assert.ok(b64.length > 0);
    assert.ok(!b64.includes('+'));
    assert.ok(!b64.includes('/'));
    assert.ok(!b64.endsWith('='));

    let base64Std = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64Std.length % 4) base64Std += '=';
    const decoded = JSON.parse(Buffer.from(base64Std, 'base64').toString('utf8'));

    assert.equal(decoded.songId, 1234);
    assert.equal(decoded.revisionId, 5678);
    assert.equal(decoded.image, 'https://example.com/cover.jpg');
    assert.equal(decoded.title, 'Song Title');
    assert.equal(decoded.artist, 'Artist Name');
    assert.equal(decoded.artistId, 99);
    assert.equal(decoded.byLinkUrl, 'https://www.custombrand.com/a/wsa/artist-song-s1234');
    assert.equal(decoded.tracks.length, 1);
    assert.equal(decoded.tracks[0].partId, 10);
    assert.equal(decoded.tracks[0].instrumentId, 25);
    assert.equal(decoded.tracks[0].title, 'Guitar Lead');
    assert.equal(decoded.tracks[0].name, 'Clean Guitar');
    assert.deepEqual(decoded.tracks[0].tuning, [64, 59, 55, 50, 45, 40]);
    assert.equal(decoded.tracks[0].isDrums, false);
    assert.equal(decoded.tracks[0].internalField, undefined);
});

test('extractTabMetaFromHtml extracts state and matches song id', () => {
    const htmlWithMatchingId = `
        <!DOCTYPE html>
        <html>
            <head>
                <script id="state" type="application/json">{"meta":{"current":{"songId":1234,"title":"Valid Song"}}}</script>
            </head>
            <body></body>
        </html>
    `;
    const meta = extractTabMetaFromHtml(htmlWithMatchingId, 'https://www.custombrand.com/a/wsa/artist-song-s1234');
    assert.ok(meta);
    assert.equal(meta.songId, 1234);
    assert.equal(meta.title, 'Valid Song');

    const mismatched = extractTabMetaFromHtml(htmlWithMatchingId, 'https://www.custombrand.com/a/wsa/artist-song-s9999');
    assert.equal(mismatched, null);

    const empty = extractTabMetaFromHtml('<html><body></body></html>', 'https://www.custombrand.com/a/wsa/artist-song-s1234');
    assert.equal(empty, null);
});

test('getDownloaderUrlFromMatchedUrl builds url with hash payload when metadata provided', () => {
    const current = {
        songId: 4321,
        revisionId: 100,
        image: '',
        title: 'Track',
        artist: 'Band',
        artistId: 1,
        tracks: []
    };
    const targetUrl = 'https://www.custombrand.com/a/wsa/band-track-s4321';
    const fullUrl = getDownloaderUrlFromMatchedUrl(targetUrl, current);
    assert.ok(fullUrl.startsWith('https://www.custombrand-downloader.com/#custombrand='));
    const hash = fullUrl.split('#custombrand=')[1];
    assert.ok(hash && hash.length > 0);

    const baseOnly = getDownloaderUrlFromMatchedUrl(targetUrl);
    assert.equal(baseOnly, 'https://www.custombrand-downloader.com/');
});

test('generateDownloaderTransferScript produces executable script string', () => {
    const script = generateDownloaderTransferScript();
    assert.ok(typeof script === 'string');
    assert.ok(script.includes('-downloader.com/'));
    assert.ok(script.includes('readState'));
});

test('attachSyncForMatchedUrl feeds matched URL into sync pipeline and calls toast', async () => {
    const matchedUrl = 'https://www.example.com/a/wsa/artist-song-s1234';
    let loadedUrl = null;
    let attachedSets = null;
    let toastMessage = null;

    const mockLoad = async (url) => {
        loadedUrl = url;
        return [{ videoId: 'dQw4w9WgXcQ', barTimesMs: [0, 2000, 4000] }];
    };

    const mockAttach = async (sets) => {
        attachedSets = sets;
        return { saved: ['Official Video'], skipped: [] };
    };

    const mockToast = (msg) => {
        toastMessage = msg;
    };

    const { attachSyncForMatchedUrl } = await import('../src/utils/downloaderIntercept.js');
    const result = await attachSyncForMatchedUrl(matchedUrl, {
        showToast: mockToast,
        loadFromUrlFn: mockLoad,
        attachSyncSetsFn: mockAttach
    });

    assert.equal(loadedUrl, matchedUrl);
    assert.deepEqual(attachedSets, [{ videoId: 'dQw4w9WgXcQ', barTimesMs: [0, 2000, 4000] }]);
    assert.deepEqual(result.saved, ['Official Video']);
    assert.equal(toastMessage, 'Added sync points for Official Video');
});

test('attachSyncForMatchedUrl passes songKey and file when attaching to library song without opening', async () => {
    const matchedUrl = 'https://www.example.com/a/wsa/artist-song-s1234';
    let passedOptions = null;

    const mockLoad = async () => [{ videoId: 'dQw4w9WgXcQ', barTimesMs: [0, 2000, 4000] }];
    const mockAttach = async (sets, options) => {
        passedOptions = options;
        return { saved: ['Official Video'], skipped: [] };
    };

    const { attachSyncForMatchedUrl } = await import('../src/utils/downloaderIntercept.js');
    const result = await attachSyncForMatchedUrl(matchedUrl, {
        loadFromUrlFn: mockLoad,
        attachSyncSetsFn: mockAttach,
        songKey: 'Test Artist - Test Song'
    });

    assert.equal(passedOptions.songKey, 'Test Artist - Test Song');
    assert.deepEqual(result.saved, ['Official Video']);
});

