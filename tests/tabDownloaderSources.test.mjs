// Run with: node --test tests/tabDownloaderSources.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

after(() => {
    setTimeout(() => process.exit(0), 50);
});

// Set up mock DOM environment before importing tabDownloader.js
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.MutationObserver = class { observe() {} disconnect() {} };

const dummyEl = {
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    addEventListener() {},
    requestFullscreen() {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    removeChild() {},
    querySelectorAll: () => [],
    replaceChildren() {},
    append() {},
    closest: () => dummyEl,
    querySelector: () => dummyEl,
    getContext: () => ({ fillRect() {}, clearRect() {} })
};

global.window = {
    addEventListener: () => {},
    dispatchEvent: () => {},
    location: { href: 'http://localhost/', search: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} })
};

global.document = {
    documentElement: dummyEl,
    body: dummyEl,
    addEventListener: () => {},
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
    clear: () => { store = {}; }
};

const {
    DEFAULT_SOURCES,
    getSources,
    resetToDefaultSources,
    buildSearchUrl,
    formatSearchQueryForSource
} = await import('../src/tabDownloader.js');

test('DEFAULT_SOURCES has Google first and DuckDuckGo second', () => {
    assert.equal(DEFAULT_SOURCES.length, 2);
    const [google, duckduckgo] = DEFAULT_SOURCES;

    assert.equal(google.id, 'google');
    assert.equal(google.name, 'Google');
    assert.equal(google.urlTemplate, 'https://www.google.com/search?q=$s+guitar+pro+tab');
    assert.equal(google.defaultUrl, 'https://www.google.com/search?q=$s+guitar+pro+tab');
    assert.equal(google.queryFormat, 'artist_song');
    assert.equal(google.isSeed, true);

    assert.equal(duckduckgo.id, 'duckduckgo');
    assert.equal(duckduckgo.name, 'DuckDuckGo');
    assert.equal(duckduckgo.urlTemplate, 'https://duckduckgo.com/?q=$s+guitar+pro+tab');
    assert.equal(duckduckgo.defaultUrl, 'https://duckduckgo.com/?q=$s+guitar+pro+tab');
    assert.equal(duckduckgo.queryFormat, 'artist_song');
    assert.equal(duckduckgo.isSeed, true);
});

test('buildSearchUrl constructs expected search and home URLs for Google and DuckDuckGo', () => {
    const [google, duckduckgo] = DEFAULT_SOURCES;

    // Search queries
    assert.equal(
        buildSearchUrl(google, 'Carulli Duo No 2 In G Major'),
        'https://www.google.com/search?q=Carulli+Duo+No+2+In+G+Major+guitar+pro+tab'
    );
    assert.equal(
        buildSearchUrl(duckduckgo, 'Carulli Duo No 2 In G Major'),
        'https://duckduckgo.com/?q=Carulli+Duo+No+2+In+G+Major+guitar+pro+tab'
    );

    // Empty query returns home URLs
    assert.equal(buildSearchUrl(google, ''), 'https://www.google.com/');
    assert.equal(buildSearchUrl(duckduckgo, ''), 'https://duckduckgo.com/');
    assert.equal(buildSearchUrl(null, ''), 'https://www.google.com/');
});

test('formatSearchQueryForSource formats artist and song according to queryFormat', () => {
    const [google, duckduckgo] = DEFAULT_SOURCES;
    assert.equal(formatSearchQueryForSource(google, 'Metallica', 'One'), 'Metallica One');
    assert.equal(formatSearchQueryForSource(duckduckgo, 'Metallica', 'One'), 'Metallica One');
    assert.equal(formatSearchQueryForSource({ queryFormat: 'song_only' }, 'Metallica', 'One'), 'One');
});

test('resetToDefaultSources writes and returns default sources', () => {
    localStorage.clear();
    const sources = resetToDefaultSources();
    assert.equal(sources.length, 2);
    assert.equal(sources[0].id, 'google');
    assert.equal(sources[1].id, 'duckduckgo');
    assert.equal(sources[1].isSeed, true);
});

test('getSources upgrades existing user sources by inserting DuckDuckGo after Google', () => {
    localStorage.clear();
    // Simulate legacy storage containing only Google and a custom source
    const legacy = [
        {
            id: 'google',
            name: 'Google',
            urlTemplate: 'https://www.google.com/search?q=$s+guitar+pro+tab',
            defaultUrl: 'https://www.google.com/search?q=$s+guitar+pro+tab',
            queryFormat: 'artist_song',
            userscriptEnabled: false,
            isSeed: true
        },
        {
            id: 'custom_source',
            name: 'My Custom Source',
            urlTemplate: 'https://example.com/tabs?search=$s',
            defaultUrl: 'https://example.com/tabs',
            queryFormat: 'artist_song',
            isSeed: false
        }
    ];
    localStorage.setItem('majestictab_tab_sources', JSON.stringify(legacy));
    localStorage.setItem('majestictab_tab_sources_google_first', '1');

    const upgraded = getSources();
    assert.equal(upgraded.length, 3);
    assert.equal(upgraded[0].id, 'google');
    assert.equal(upgraded[1].id, 'duckduckgo');
    assert.equal(upgraded[2].id, 'custom_source');

    // Confirm it was saved to storage
    const stored = JSON.parse(localStorage.getItem('majestictab_tab_sources'));
    assert.equal(stored.length, 3);
    assert.equal(stored[1].id, 'duckduckgo');
});
