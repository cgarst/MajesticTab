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
    isConnected: true,
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
    removeEventListener: () => {},
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
    assert.equal(google.urlTemplate, 'https://www.google.com/search?q=$s+guitar+tab');
    assert.equal(google.defaultUrl, 'https://www.google.com/search?q=$s+guitar+tab');
    assert.equal(google.queryFormat, 'artist_song');
    assert.equal(google.isSeed, true);

    assert.equal(duckduckgo.id, 'duckduckgo');
    assert.equal(duckduckgo.name, 'DuckDuckGo');
    assert.equal(duckduckgo.urlTemplate, 'https://duckduckgo.com/?q=$s+guitar+tab');
    assert.equal(duckduckgo.defaultUrl, 'https://duckduckgo.com/?q=$s+guitar+tab');
    assert.equal(duckduckgo.queryFormat, 'artist_song');
    assert.equal(duckduckgo.isSeed, true);
});

test('buildSearchUrl constructs expected search and home URLs for Google and DuckDuckGo', () => {
    const [duckduckgo, google] = DEFAULT_SOURCES;

    // Search queries
    assert.equal(
        buildSearchUrl(google, 'Carulli Duo No 2 In G Major'),
        'https://www.google.com/search?q=Carulli+Duo+No+2+In+G+Major+guitar+tab'
    );
    assert.equal(
        buildSearchUrl(duckduckgo, 'Carulli Duo No 2 In G Major'),
        'https://duckduckgo.com/?q=Carulli+Duo+No+2+In+G+Major+guitar+tab'
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
    localStorage.setItem(ADBLOCK_ENABLED_KEY, 'false');
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

test('openTabDownloader respects majestictab_web_search_browser === "system"', async () => {
    let openedUrl = null;
    let invokedCommands = [];
    global.window.__TAURI__ = {
        core: {
            invoke: async (cmd, args) => {
                invokedCommands.push({ cmd, args });
                return {};
            }
        },
        opener: {
            openUrl: async (url) => {
                openedUrl = url;
            }
        }
    };

    localStorage.setItem('majestictab_web_search_browser', 'system');
    await openTabDownloader({ query: 'Sor Studies', artist: 'Sor' });

    assert.ok(openedUrl && openedUrl.includes('Sor+Studies'), 'Expected system browser opener to be called with query URL');
    assert.equal(invokedCommands.length, 0, 'In-app webview commands should not be invoked when preferSystemBrowser is true');

    localStorage.removeItem('majestictab_web_search_browser');
    delete global.window.__TAURI__;
});

test('system-browser stub operates correctly', async () => {
    const stub = await import('../build/tauri/stubs/system-browser/tabDownloader.js');
    assert.equal(stub.DEFAULT_SOURCES.length, 2);

    const [ddg] = stub.DEFAULT_SOURCES;
    const url = stub.buildSearchUrl(ddg, 'Tarrega Capricho Arabe');
    assert.ok(url.includes('duckduckgo.com') && url.includes('Tarrega+Capricho+Arabe'));

    let openedUrl = null;
    global.window.__TAURI__ = {
        opener: {
            openUrl: async (u) => { openedUrl = u; }
        }
    };

    assert.equal(stub.isNative(), true);
    await stub.openTabDownloader({ query: 'Giuliani Sonatina' });
    assert.ok(openedUrl && openedUrl.includes('Giuliani+Sonatina'));

    assert.equal(await stub.handleWsaUrlIntercept('https://example.com'), false);
    delete global.window.__TAURI__;
});

test('webSearchSettings disables adblock and test search when system browser is chosen and renders in correct order', async () => {
    function createMockElement(tag) {
        const children = [];
        const listeners = {};
        const classes = new Set();
        const elNode = {
            isConnected: true,
            tagName: tag.toUpperCase(),
            style: {},
            get className() { return [...classes].join(' '); },
            set className(val) {
                classes.clear();
                String(val || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
            },
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => {
                    if (force !== undefined) {
                        if (force) classes.add(c); else classes.delete(c);
                        return force;
                    }
                    if (classes.has(c)) { classes.delete(c); return false; }
                    classes.add(c); return true;
                },
                contains: (c) => classes.has(c)
            },
            dataset: {},
            children,
            textContent: '',
            value: '',
            get innerHTML() { return this.textContent; },
            set innerHTML(val) { this.textContent = String(val || ''); },
            disabled: false,
            appendChild: (child) => children.push(child),
            addEventListener: (evt, fn) => {
                listeners[evt] = listeners[evt] || [];
                listeners[evt].push(fn);
            },
            click: () => {
                (listeners['click'] || []).forEach(fn => fn({ target: elNode }));
            },
            dispatchChange: () => {
                (listeners['change'] || []).forEach(fn => fn({ target: elNode }));
            },
            setAttribute: () => {},
            getAttribute: () => null,
            querySelector: function(sel) {
                return this.querySelectorAll(sel)[0] || null;
            },
            querySelectorAll: function(sel) {
                const results = [];
                const match = (node) => {
                    if (sel.startsWith('.') && node.classList?.contains(sel.slice(1))) results.push(node);
                    else if (sel === 'h3' && node.tagName === 'H3') results.push(node);
                    else if (sel === 'button' && node.tagName === 'BUTTON') results.push(node);
                    else if (sel === 'select' && node.tagName === 'SELECT') results.push(node);
                    else if (sel === 'option' && node.tagName === 'OPTION') results.push(node);
                    for (const ch of node.children || []) match(ch);
                };
                for (const ch of this.children || []) match(ch);
                return results;
            }
        };
        return elNode;
    }

    const prevCreate = document.createElement;
    document.createElement = (tag) => createMockElement(tag);

    try {
        const { initWebSearchSettings } = await import('../src/utils/webSearchSettings.js');
        const container = createMockElement('div');

        localStorage.setItem('majestictab_web_search_browser', 'in-app');
        initWebSearchSettings(container);

        const groups = container.querySelectorAll('.sgroup');
        assert.equal(groups.length, 3);
        assert.equal(groups[0].querySelector('h3')?.textContent, 'Search providers');
        assert.equal(groups[1].querySelector('h3')?.textContent, 'Ad and tracker blocking');
        assert.equal(groups[2].querySelector('h3')?.textContent, 'Test');

        const sw = container.querySelector('.theme-switch');
        const testBtn = container.querySelectorAll('.srow-ghost').find(b => b.textContent === 'Test');
        assert.ok(sw);
        assert.ok(testBtn);
        assert.equal(sw.disabled, false);
        assert.equal(testBtn.disabled, false);

        // Click "System default browser"
        const sysBtn = container.querySelectorAll('button').find(b => b.textContent === 'System default browser');
        assert.ok(sysBtn);
        sysBtn.click();

        assert.equal(localStorage.getItem('majestictab_web_search_browser'), 'system');
        assert.equal(sw.disabled, true);
        assert.equal(testBtn.disabled, true);

        // Click "In-app browser"
        const inAppBtn = container.querySelectorAll('button').find(b => b.textContent === 'In-app browser');
        assert.ok(inAppBtn);
        inAppBtn.click();

        assert.equal(localStorage.getItem('majestictab_web_search_browser'), 'in-app');
        assert.equal(sw.disabled, false);
        assert.equal(testBtn.disabled, false);

        // Click "Add" custom search provider
        const initialCount = getSources().length;
        const addBtn = container.querySelectorAll('button').find(b => b.textContent === 'Add');
        assert.ok(addBtn);
        addBtn.click();
        assert.equal(getSources().length, initialCount + 1);

        // Verify default search provider is rendered as a dropdown (<select>)
        const defaultSelect = container.querySelector('select');
        assert.ok(defaultSelect);
        const options = defaultSelect.querySelectorAll('option');
        assert.ok(options.length >= 2);
        assert.equal(options[0].value, 'duckduckgo');
        assert.equal(options[1].value, 'google');

        // Change default provider via dropdown
        defaultSelect.value = 'google';
        defaultSelect.dispatchChange();
        assert.equal(getSources()[0].id, 'google');

        localStorage.removeItem('majestictab_web_search_browser');
    } finally {
        document.createElement = prevCreate;
    }
});

test('missingTabsTool renders Start button for in-app browser and hides it for system browser', async () => {
    const { renderMissingTabsTool } = await import('../src/bulkFill/missingTabsTool.js');
    let capturedElement = null;
    const container = {
        appendChild(child) {
            capturedElement = child;
        }
    };

    // Case 1: In-app browser preference -> renders Start button
    localStorage.setItem('majestictab_web_search_browser', 'in-app');
    let cleanup = renderMissingTabsTool(container);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(capturedElement);
    assert.equal(capturedElement.innerHTML.includes('data-act="start"'), true);
    assert.equal(capturedElement.innerHTML.includes('Search the web for a tab of each song that has none, one song at a time.'), true);
    cleanup();

    // Case 2: System default browser preference -> hides Start button and renders system-browser copy
    localStorage.setItem('majestictab_web_search_browser', 'system');
    cleanup = renderMissingTabsTool(container);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(capturedElement);
    assert.equal(capturedElement.innerHTML.includes('data-act="start"'), false);
    assert.equal(capturedElement.innerHTML.includes('Search the web for a tab of each song that has none. Open a search in your web browser'), true);
    cleanup();

    localStorage.removeItem('majestictab_web_search_browser');
});
