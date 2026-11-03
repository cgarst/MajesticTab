// Run with: node --test tests/downloaderIntercept.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    unwrapGoogleUrl,
    unwrapRedirectUrl,
    isWsaTabUrl,
    getDownloaderUrlFromMatchedUrl,
    attachSyncForMatchedUrl
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

test('isWsaTabUrl detects endpoint pattern on any website or search engine', () => {
    // Direct links on any website, forum, or blog
    assert.ok(isWsaTabUrl('https://www.example.com/a/wsa/artist-song-tab-s12345'));
    assert.ok(isWsaTabUrl('https://example.com/a/wsa/another-song-s999/r1'));
    assert.ok(isWsaTabUrl('https://tab-community.org/a/wsa/guitar-solo-s777'));

    // Wrapped redirect links from Google, DuckDuckGo, Reddit, etc.
    assert.ok(isWsaTabUrl('https://www.google.com/url?q=' + encodeURIComponent('https://example.com/a/wsa/song-s42')));
    assert.ok(isWsaTabUrl('https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/a/wsa/song-s42')));
    assert.ok(isWsaTabUrl('https://out.reddit.com/url?url=' + encodeURIComponent('https://example.com/a/wsa/song-s42')));

    // Negative cases
    assert.ok(!isWsaTabUrl('https://example.com/artists/artist-name'));
    assert.ok(!isWsaTabUrl('https://example.com/a/wsa/no-song-id-here'));
    assert.ok(!isWsaTabUrl('https://google.com/search?q=tab'));
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

