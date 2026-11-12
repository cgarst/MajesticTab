// Run with: node --test tests/pageNavigation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal globals required by module imports
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    location: { search: '' },
    history: { pushState: () => {} },
    innerWidth: 1024,
    innerHeight: 768
};
globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { style: { removeProperty: () => {}, setProperty: () => {} } },
    body: { classList: { contains: () => false, add: () => {}, remove: () => {} } }
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { handleSwipeNavigation, handleTapNavigation, setupTapClickNavigation } = await import('../src/utils/navigationUtils.js');

function createMockElement(rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }) {
    const listeners = {};
    return {
        listeners,
        addEventListener(event, fn) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        removeEventListener(event, fn) {
            listeners[event] = (listeners[event] || []).filter(h => h !== fn);
        },
        dispatchEvent(event) {
            const handlers = listeners[event.type] || [];
            handlers.forEach(h => h(event));
        },
        getBoundingClientRect() {
            return rect;
        },
        querySelectorAll() {
            return [];
        }
    };
}

test('handleSwipeNavigation with Guitar Pro file advances and rewinds pages', () => {
    let nextCalled = false;
    let prevCalled = false;
    let renderCalled = false;

    const config = {
        currentFile: { name: 'test.gp5' },
        pageModeRadio: { checked: true },
        gpState: { canvases: [{}] },
        nextGPPage: () => { nextCalled = true; return true; },
        prevGPPage: () => { prevCalled = true; return true; },
        renderGPPage: () => { renderCalled = true; }
    };

    handleSwipeNavigation('left', config);
    assert.equal(nextCalled, true, 'swiping left advances GP page');
    assert.equal(renderCalled, true, 're-renders GP page');

    renderCalled = false;
    handleSwipeNavigation('right', config);
    assert.equal(prevCalled, true, 'swiping right goes to previous GP page');
    assert.equal(renderCalled, true, 're-renders GP page');
});

test('handleSwipeNavigation with text file advances and rewinds pages', () => {
    let nextCalled = false;
    let prevCalled = false;
    let renderCalled = false;

    const config = {
        currentFile: { name: 'test.txt' },
        pageModeRadio: { checked: true },
        textState: { pages: ['page 1', 'page 2', 'page 3'] },
        nextTextPage: () => { nextCalled = true; return true; },
        prevTextPage: () => { prevCalled = true; return true; },
        renderTextPage: () => { renderCalled = true; }
    };

    handleSwipeNavigation('left', config);
    assert.equal(nextCalled, true, 'swiping left advances text page');
    assert.equal(renderCalled, true, 're-renders text page');

    renderCalled = false;
    handleSwipeNavigation('right', config);
    assert.equal(prevCalled, true, 'swiping right goes to previous text page');
    assert.equal(renderCalled, true, 're-renders text page');
});

test('handleSwipeNavigation with PDF file updates currentPageIndex', () => {
    let newIndex = 0;
    const config = {
        currentFile: { name: 'test.pdf' },
        pageModeRadio: { checked: true },
        pages: [{}, {}, {}, {}],
        currentPageIndex: 0,
        setCurrentPageIndex: (idx) => { newIndex = idx; config.currentPageIndex = idx; }
    };

    handleSwipeNavigation('left', config);
    assert.equal(newIndex, 1, 'swiping left advances PDF page');

    handleSwipeNavigation('right', config);
    assert.equal(newIndex, 0, 'swiping right rewinds PDF page');
});

test('handleSwipeNavigation does nothing when not in page mode or no file loaded', () => {
    let called = false;
    const config = {
        currentFile: null,
        pageModeRadio: { checked: true },
        nextGPPage: () => { called = true; }
    };
    handleSwipeNavigation('left', config);
    assert.equal(called, false, 'no file loaded');

    config.currentFile = { name: 'test.gp' };
    config.pageModeRadio.checked = false;
    handleSwipeNavigation('left', config);
    assert.equal(called, false, 'not in page mode');
});

test('setupTapClickNavigation detects horizontal swipe left and right', () => {
    const output = createMockElement();
    let navigatedAction = null;

    const config = {
        output,
        currentFile: { name: 'test.gp' },
        pageModeRadio: { checked: true },
        gpState: { canvases: [{}] },
        nextGPPage: () => { navigatedAction = 'NEXT'; return true; },
        prevGPPage: () => { navigatedAction = 'PREV'; return true; },
        renderGPPage: () => {}
    };

    setupTapClickNavigation(output, () => config);

    // 1. Swipe left (start at 600, move to 400 -> dx = -200)
    output.dispatchEvent({
        type: 'touchstart',
        touches: [{ clientX: 600, clientY: 300 }]
    });
    output.dispatchEvent({
        type: 'touchmove',
        touches: [{ clientX: 400, clientY: 300 }],
        cancelable: true,
        preventDefault: () => {}
    });
    output.dispatchEvent({
        type: 'touchend',
        changedTouches: [{ clientX: 400, clientY: 300 }]
    });

    assert.equal(navigatedAction, 'NEXT', 'swipe left triggers NEXT');

    // 2. Swipe right (start at 300, move to 500 -> dx = +200)
    navigatedAction = null;
    output.dispatchEvent({
        type: 'touchstart',
        touches: [{ clientX: 300, clientY: 300 }]
    });
    output.dispatchEvent({
        type: 'touchmove',
        touches: [{ clientX: 500, clientY: 300 }],
        cancelable: true,
        preventDefault: () => {}
    });
    output.dispatchEvent({
        type: 'touchend',
        changedTouches: [{ clientX: 500, clientY: 300 }]
    });

    assert.equal(navigatedAction, 'PREV', 'swipe right triggers PREV');
});

test('setupTapClickNavigation ignores vertical swipes and short drags', () => {
    const output = createMockElement();
    let navigatedAction = null;

    const config = {
        output,
        currentFile: { name: 'test.gp' },
        pageModeRadio: { checked: true },
        gpState: { canvases: [{}] },
        nextGPPage: () => { navigatedAction = 'NEXT'; return true; },
        prevGPPage: () => { navigatedAction = 'PREV'; return true; },
        renderGPPage: () => {}
    };

    setupTapClickNavigation(output, () => config);

    // Vertical swipe (dy = 200, dx = 10)
    output.dispatchEvent({
        type: 'touchstart',
        touches: [{ clientX: 300, clientY: 200 }]
    });
    output.dispatchEvent({
        type: 'touchmove',
        touches: [{ clientX: 310, clientY: 400 }],
        cancelable: true,
        preventDefault: () => {}
    });
    output.dispatchEvent({
        type: 'touchend',
        changedTouches: [{ clientX: 310, clientY: 400 }]
    });
    assert.equal(navigatedAction, null, 'vertical swipe is ignored');

    // Short drag (dx = 15)
    output.dispatchEvent({
        type: 'touchstart',
        touches: [{ clientX: 300, clientY: 300 }]
    });
    output.dispatchEvent({
        type: 'touchmove',
        touches: [{ clientX: 315, clientY: 300 }],
        cancelable: true,
        preventDefault: () => {}
    });
    output.dispatchEvent({
        type: 'touchend',
        changedTouches: [{ clientX: 315, clientY: 300 }]
    });
    assert.equal(navigatedAction, null, 'short drag below threshold is ignored');
});

test('setupTapClickNavigation navigates on left/right screen taps', () => {
    const output = createMockElement({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
    let navigatedAction = null;

    const config = {
        output,
        currentFile: { name: 'test.gp' },
        pageModeRadio: { checked: true },
        gpState: { canvases: [{}] },
        nextGPPage: () => { navigatedAction = 'NEXT'; return true; },
        prevGPPage: () => { navigatedAction = 'PREV'; return true; },
        renderGPPage: () => {}
    };

    setupTapClickNavigation(output, () => config);

    // Click right half (clientX = 750, midX = 500)
    output.dispatchEvent({
        type: 'click',
        clientX: 750,
        clientY: 400,
        target: output
    });
    assert.equal(navigatedAction, 'NEXT', 'tap on right side of screen navigates NEXT');

    // Click left half (clientX = 250, midX = 500)
    navigatedAction = null;
    output.dispatchEvent({
        type: 'click',
        clientX: 250,
        clientY: 400,
        target: output
    });
    assert.equal(navigatedAction, 'PREV', 'tap on left side of screen navigates PREV');
});
