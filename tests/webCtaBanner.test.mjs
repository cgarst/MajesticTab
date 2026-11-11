import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal browser mock before importing libraryModal
const dummyEl = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    removeChild: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    style: {},
    classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false
    }
};

globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    location: { href: 'http://localhost/', search: '', hash: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1024,
    innerHeight: 768
};
global.window = globalThis.window;

globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
};
global.MutationObserver = globalThis.MutationObserver;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
global.requestAnimationFrame = globalThis.requestAnimationFrame;
global.cancelAnimationFrame = globalThis.cancelAnimationFrame;

globalThis.document = {
    documentElement: dummyEl,
    body: dummyEl,
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => dummyEl
};

let store = {};
globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; }
};

const {
    webCtaBannerHtml,
    isWebCtaCollapsed,
    setWebCtaCollapsed,
    toggleWebCtaCollapse,
    syncWebCtaCollapseState
} = await import('../src/libraryModal.js');

test('webCtaBanner description uses "web tab search with ad blocking" instead of "ad-free tab search"', () => {
    setWebCtaCollapsed(false);
    const html = webCtaBannerHtml();
    assert.match(html, /web tab search with ad blocking/);
    assert.doesNotMatch(html, /ad-free tab search/);
});

test('webCtaBanner handles collapse and expand state persistence', () => {
    localStorage.clear();
    assert.strictEqual(isWebCtaCollapsed(), false);

    let html = webCtaBannerHtml();
    assert.doesNotMatch(html, /is-collapsed/);
    assert.match(html, />Collapse<\/button>/);
    assert.match(html, /aria-expanded="true"/);

    setWebCtaCollapsed(true);
    assert.strictEqual(isWebCtaCollapsed(), true);
    assert.strictEqual(localStorage.getItem('majestictab_web_cta_collapsed'), '1');

    html = webCtaBannerHtml();
    assert.match(html, /is-collapsed/);
    assert.match(html, />Expand<\/button>/);
    assert.match(html, /aria-expanded="false"/);

    setWebCtaCollapsed(false);
    assert.strictEqual(isWebCtaCollapsed(), false);
    assert.strictEqual(localStorage.getItem('majestictab_web_cta_collapsed'), '0');
});

test('toggleWebCtaCollapse toggles DOM classes, aria attributes, and storage', () => {
    localStorage.clear();

    const classes = new Set();
    const attrs = {};
    const toggleBtn = {
        textContent: 'Collapse',
        setAttribute: (k, v) => { attrs[k] = String(v); },
        getAttribute: (k) => attrs[k] ?? null
    };

    const mockBanner = {
        classList: {
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
                const add = force !== undefined ? force : !classes.has(c);
                if (add) classes.add(c);
                else classes.delete(c);
                return classes.has(c);
            }
        },
        querySelector: (sel) => {
            if (sel === '#webCtaToggleBtn') return toggleBtn;
            return null;
        }
    };

    // Initially expanded
    assert.strictEqual(isWebCtaCollapsed(), false);

    // Toggle to collapsed
    toggleWebCtaCollapse(mockBanner);
    assert.strictEqual(isWebCtaCollapsed(), true);
    assert.strictEqual(classes.has('is-collapsed'), true);
    assert.strictEqual(toggleBtn.textContent, 'Expand');
    assert.strictEqual(attrs['aria-expanded'], 'false');

    // Toggle back to expanded
    toggleWebCtaCollapse(mockBanner);
    assert.strictEqual(isWebCtaCollapsed(), false);
    assert.strictEqual(classes.has('is-collapsed'), false);
    assert.strictEqual(toggleBtn.textContent, 'Collapse');
    assert.strictEqual(attrs['aria-expanded'], 'true');

    setTimeout(() => process.exit(0), 20);
});
