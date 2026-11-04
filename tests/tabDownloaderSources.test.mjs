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
    getContext: () => ({ fillRect() {}, clearRect() {} }),
    getBoundingClientRect: () => ({ height: 84, width: 800 })
};
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

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
    saveSources,
    resetToDefaultSources,
    buildSearchUrl,
    formatSearchQueryForSource,
    isAdblockEnabled,
    setAdblockEnabled,
    getAdblockStatus,
    ADBLOCK_ENABLED_KEY,
    ADBLOCK_HOSTS_KEY,
    ADBLOCK_UPDATED_KEY,
    openTabDownloader,
    closeTabDownloaderModal
} = await import('../src/tabDownloader.js');

test('DEFAULT_SOURCES has DuckDuckGo first and Google second', () => {
    assert.equal(DEFAULT_SOURCES.length, 2);
    const [duckduckgo, google] = DEFAULT_SOURCES;

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
    const [duckduckgo, google] = DEFAULT_SOURCES;

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
    const [duckduckgo, google] = DEFAULT_SOURCES;
    assert.equal(formatSearchQueryForSource(google, 'Carulli', 'Duo No 2 In G Major'), 'Carulli Duo No 2 In G Major');
    assert.equal(formatSearchQueryForSource(duckduckgo, 'Carulli', 'Duo No 2 In G Major'), 'Carulli Duo No 2 In G Major');
    assert.equal(formatSearchQueryForSource({ queryFormat: 'song_only' }, 'Carulli', 'Duo No 2 In G Major'), 'Duo No 2 In G Major');
});

test('resetToDefaultSources writes and returns default sources', () => {
    localStorage.clear();
    const sources = resetToDefaultSources();
    assert.equal(sources.length, 2);
    assert.equal(sources[0].id, 'duckduckgo');
    assert.equal(sources[1].id, 'google');
    assert.equal(sources[0].isSeed, true);
});

test('getSources upgrades existing user sources by moving DuckDuckGo first', () => {
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

    const upgraded = getSources();
    assert.equal(upgraded.length, 3);
    assert.equal(upgraded[0].id, 'duckduckgo');
    assert.equal(upgraded[1].id, 'google');
    assert.equal(upgraded[2].id, 'custom_source');
    // Confirm legacy userscript properties are sanitized
    assert.equal(upgraded[1].userscriptEnabled, undefined);

    // Confirm it was saved to storage
    const stored = JSON.parse(localStorage.getItem('majestictab_tab_sources'));
    assert.equal(stored.length, 3);
    assert.equal(stored[0].id, 'duckduckgo');

    // The move happens once: a user who puts Google back on top keeps that order
    stored.unshift(...stored.splice(1, 1));
    localStorage.setItem('majestictab_tab_sources', JSON.stringify(stored));
    assert.equal(getSources()[0].id, 'google');
});

test('adblock starts disabled and handles enabling with mocked fetch and caching', async () => {
    localStorage.clear();
    assert.equal(isAdblockEnabled(), false);
    const initialStatus = getAdblockStatus();
    assert.equal(initialStatus.enabled, false);
    assert.equal(initialStatus.count, 0);

    // Mock fetch for Peter Lowe list
    const sampleList = [
        '# Peter Lowe list header',
        '! Some comment',
        'doubleclick.net',
        '  ',
        'googlesyndication.com',
        'taboola.com',
        '# another comment'
    ].join('\n');

    global.fetch = async (url) => {
        return {
            ok: true,
            status: 200,
            text: async () => sampleList
        };
    };

    // Enable adblock
    const res = await setAdblockEnabled(true);
    assert.equal(res.enabled, true);
    assert.equal(res.count, 3);
    assert.equal(isAdblockEnabled(), true);

    const storedHosts = JSON.parse(localStorage.getItem(ADBLOCK_HOSTS_KEY));
    assert.deepEqual(storedHosts, ['doubleclick.net', 'googlesyndication.com', 'taboola.com']);
    assert.equal(Number(localStorage.getItem(ADBLOCK_UPDATED_KEY)) > 0, true);

    // Disable adblock
    const resOff = await setAdblockEnabled(false);
    assert.equal(resOff.enabled, false);
    assert.equal(isAdblockEnabled(), false);

    // Cached hosts remain in storage for fast re-enabling
    assert.equal(JSON.parse(localStorage.getItem(ADBLOCK_HOSTS_KEY)).length, 3);

    // Verify native HTTP fetch is preferred when available (bypassing CORS in Tauri)
    let nativeHttpCalled = false;
    global.window.__TAURI__ = {
        http: {
            fetch: async (url) => {
                nativeHttpCalled = true;
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => new TextEncoder().encode('native-ad.com\nanother-ad.net')
                };
            }
        }
    };
    const resNative = await setAdblockEnabled(true, true);
    assert.equal(nativeHttpCalled, true);
    assert.equal(resNative.count, 2);
    assert.deepEqual(JSON.parse(localStorage.getItem(ADBLOCK_HOSTS_KEY)), ['native-ad.com', 'another-ad.net']);
    delete global.window.__TAURI__;
});

test('openTabDownloader executes in native environment without ReferenceError', async () => {
    let invokedCommands = [];
    global.window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                invokedCommands.push({ cmd, args });
                if (cmd === 'tab_downloader_is_debug_tools_enabled') return false;
                return {};
            }
        }
    };

    let windowFocused = false;
    global.window.focus = () => { windowFocused = true; };

    await openTabDownloader({ query: 'Duo No 2 In G Major', artist: 'Carulli' });
    assert.ok(invokedCommands.some(c => c.cmd === 'open_tab_downloader'), 'Expected open_tab_downloader to be invoked');

    closeTabDownloaderModal();
    assert.ok(invokedCommands.some(c => c.cmd === 'tab_downloader_hide'), 'Expected tab_downloader_hide to be invoked');
    assert.equal(windowFocused, true, 'Expected window.focus() on close');

    delete global.window.__TAURI__;
    delete global.window.focus;
});
