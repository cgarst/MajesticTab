import assert from 'node:assert/strict';

// Setup mock browser environment for node testing
const mockEl = {
    checked: false,
    value: '',
    dataset: {},
    style: { setProperty: () => {}, removeProperty: () => {} },
    classList: { contains: () => false, add: () => {}, remove: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    focus: () => {}
};

globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => mockEl,
    body: mockEl,
    documentElement: mockEl
};

globalThis.window = {
    location: {
        hash: '',
        pathname: '/src/index.html',
        search: ''
    },
    history: {
        pushState: (_state, _title, url) => {
            const hashIdx = url.indexOf('#');
            window.location.hash = hashIdx !== -1 ? url.slice(hashIdx) : '';
        },
        replaceState: (_state, _title, url) => {
            const hashIdx = url.indexOf('#');
            window.location.hash = hashIdx !== -1 ? url.slice(hashIdx) : '';
        }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
};

globalThis.localStorage = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); }
};

globalThis.MutationObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

const { getRouteFromUrl, updateUrl } = await import('../src/utils/urlRouter.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('Testing urlRouter tools routes...');

// 1. URL generation with updateUrl
updateUrl('tools', 'scales');
assert.equal(window.location.hash, '#tools/scales', 'updateUrl("tools", "scales") should set #tools/scales');
await sleep(150);

updateUrl('tools', 'chords');
assert.equal(window.location.hash, '#tools/chords', 'updateUrl("tools", "chords") should set #tools/chords');
await sleep(150);

updateUrl('tools', 'circle');
assert.equal(window.location.hash, '#tools/circle', 'updateUrl("tools", "circle") should set #tools/circle');
await sleep(150);

updateUrl('tools', 'tuner');
assert.equal(window.location.hash, '#tools/tuner', 'updateUrl("tools", "tuner") should set #tools/tuner');
await sleep(150);

updateUrl('tools', 'metronome');
assert.equal(window.location.hash, '#tools/metronome', 'updateUrl("tools", "metronome") should set #tools/metronome');
await sleep(150);

updateUrl('tools', 'classtab');
assert.equal(window.location.hash, '#tools/classtab', 'updateUrl("tools", "classtab") should set #tools/classtab');
await sleep(150);

updateUrl('tools', 'openfile');
assert.equal(window.location.hash, '#tools/openfile', 'updateUrl("tools", "openfile") should set #tools/openfile');
await sleep(150);

updateUrl('tools', 'bulkexport');
assert.equal(window.location.hash, '#tools/bulkexport', 'updateUrl("tools", "bulkexport") should set #tools/bulkexport');
await sleep(150);

updateUrl('tools');
assert.equal(window.location.hash, '#tools', 'updateUrl("tools") should set #tools');
await sleep(150);

// 2. Legacy / tool shortcut mapping in updateUrl
updateUrl('reference', 'scales');
assert.equal(window.location.hash, '#tools/scales', 'legacy updateUrl("reference", "scales") should set #tools/scales');
await sleep(150);

updateUrl('scales');
assert.equal(window.location.hash, '#tools/scales', 'updateUrl("scales") should set #tools/scales');
await sleep(150);

updateUrl('tuner');
assert.equal(window.location.hash, '#tools/tuner', 'updateUrl("tuner") should set #tools/tuner');
await sleep(150);

updateUrl('metronome');
assert.equal(window.location.hash, '#tools/metronome', 'updateUrl("metronome") should set #tools/metronome');
await sleep(150);

updateUrl('classtab');
assert.equal(window.location.hash, '#tools/classtab', 'updateUrl("classtab") should set #tools/classtab');
await sleep(150);

// Other top-level views
updateUrl('library');
assert.equal(window.location.hash, '#library', 'updateUrl("library") should set #library');
await sleep(150);

updateUrl('settings');
assert.equal(window.location.hash, '#settings', 'updateUrl("settings") should set #settings');
await sleep(150);

// 3. Route parsing with getRouteFromUrl
window.location.hash = '#tools/scales';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: 'scales' });

window.location.hash = '#/tools/scales';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: 'scales' });

window.location.hash = '#tools/circle';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: 'circle' });

window.location.hash = '#tools/chords';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: 'chords' });

window.location.hash = '#tools';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: undefined });

window.location.hash = '';
window.location.search = '?view=tools&tab=scales';
assert.deepEqual(getRouteFromUrl(), { main: 'tools', sub: 'scales' });

// 4. Consecutive updateUrl calls without delay (should not drop updates)
updateUrl('tools', 'chords');
updateUrl('tools', 'classtab');
assert.equal(window.location.hash, '#tools/classtab', 'Rapid updateUrl("tools", "classtab") should not be dropped by previous update');

// 5. Embedded tool closing should not overwrite subroute
const { closeReferenceModal } = await import('../src/referenceLibrary.js');
const refModal = document.getElementById('referenceModal');
refModal.style.display = 'flex';
refModal.classList.contains = (c) => c === 'tool-embedded';
closeReferenceModal();
assert.equal(window.location.hash, '#tools/classtab', 'closeReferenceModal on embedded tool should not reset URL to #tools');

// 6. openfile and bulkexport routing transitions
updateUrl('tools', 'openfile');
assert.equal(window.location.hash, '#tools/openfile', 'updateUrl("tools", "openfile") should set #tools/openfile');
updateUrl('tools', 'classtab');
assert.equal(window.location.hash, '#tools/classtab', 'Switching from openfile to classtab should set #tools/classtab');

updateUrl('tools', 'bulkexport');
assert.equal(window.location.hash, '#tools/bulkexport', 'updateUrl("tools", "bulkexport") should set #tools/bulkexport');
updateUrl('tools', 'classtab');
assert.equal(window.location.hash, '#tools/classtab', 'Switching from bulkexport to classtab should set #tools/classtab');

// 7. openLibraryModal with tools view when hash is already a subroute should not clobber to #tools
const { openLibraryModal } = await import('../src/libraryModal.js');
window.location.hash = '#tools/openfile';
try { await openLibraryModal('tools'); } catch (_) {}
assert.equal(window.location.hash, '#tools/openfile', 'openLibraryModal("tools") should not clobber #tools/openfile to #tools');

window.location.hash = '#tools/bulkexport';
try { await openLibraryModal('tools'); } catch (_) {}
assert.equal(window.location.hash, '#tools/bulkexport', 'openLibraryModal("tools") should not clobber #tools/bulkexport to #tools');

console.log('✓ All urlRouter tests passed successfully!');
