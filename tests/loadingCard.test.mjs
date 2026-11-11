import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal browser DOM mocks for loadingCard
class MockElement {
    constructor(id) {
        this.id = id;
        this.textContent = '';
        this.classList = new Set();
        this.attributes = new Map();
        this.style = {};
        this.hidden = false;
        this.src = '';
        this.complete = true;
        this.naturalWidth = 100;
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k); }
    removeAttribute(k) {
        this.attributes.delete(k);
        if (k === 'src') this.src = '';
    }
}
MockElement.prototype.classList = {
    add(cls) { this._classes.add(cls); },
    remove(cls) { this._classes.delete(cls); },
    contains(cls) { return this._classes.has(cls); }
};

function createDom() {
    const elements = new Map();
    const getOrCreate = (id) => {
        if (!elements.has(id)) {
            const el = new MockElement(id);
            el._classes = new Set();
            el.classList = {
                add: (c) => el._classes.add(c),
                remove: (c) => el._classes.delete(c),
                contains: (c) => el._classes.has(c)
            };
            elements.set(id, el);
        }
        return elements.get(id);
    };

    ['loadingCard', 'loadingCardTitle', 'loadingCardSubtitle', 'loadingCardCover', 'loadingCardTrack', 'loadingCardFill', 'loadingCardStage'].forEach(getOrCreate);

    globalThis.document = {
        getElementById: (id) => elements.get(id) || null
    };
    globalThis.performance = {
        now: () => Date.now()
    };
    return elements;
}

test('loadingCard clears previous tab album art immediately when loading a new file', async () => {
    const elements = createDom();
    const coverEl = elements.get('loadingCardCover');
    const titleEl = elements.get('loadingCardTitle');

    // Mock Image with controlled decode promise
    let decodeResolvers = [];
    globalThis.Image = class {
        constructor() {
            this.src = '';
            this.complete = false;
            this.naturalWidth = 0;
        }
        decode() {
            return new Promise((resolve) => {
                this.complete = true;
                this.naturalWidth = 250;
                decodeResolvers.push(resolve);
            });
        }
    };

    const { showLoadingCard, hideLoadingCard } = await import('../src/utils/loadingCard.js');

    // 1. Load Tab 1 with Cover 1
    const token1 = showLoadingCard(null, {
        title: 'Song 1',
        subtitle: 'Artist 1',
        coverUrl: 'blob:cover-1'
    });

    assert.equal(titleEl.textContent, 'Song 1');
    // While decoding, coverEl has the blank placeholder pixel to avoid showing nothing or shifting layout
    assert.match(coverEl.src, /^data:image\/svg\+xml/);
    assert.equal(coverEl.hidden, false);

    // Resolve decode for Tab 1
    const resolve1 = decodeResolvers.shift();
    assert.ok(resolve1);
    resolve1();
    await new Promise((r) => setTimeout(r, 10));

    // Cover 1 is now active
    assert.equal(coverEl.src, 'blob:cover-1');
    assert.equal(coverEl.hidden, false);

    // 2. Tab 1 finishes and hides (wait for MIN_VISIBLE_MS to elapse)
    await new Promise((r) => setTimeout(r, 450));
    hideLoadingCard(token1, null);
    // After hiding, cover is cleared
    assert.equal(coverEl.src, '');
    assert.equal(coverEl.hidden, true);

    // Simulate coverEl having retained Cover 1's src if hide did not clear it
    coverEl.src = 'blob:cover-1';
    coverEl.hidden = false;

    // 3. Load Tab 2 with Cover 2
    const token2 = showLoadingCard(null, {
        title: 'Song 2',
        subtitle: 'Artist 2',
        coverUrl: 'blob:cover-2'
    });

    assert.equal(titleEl.textContent, 'Song 2');
    // CRITICAL TEST: coverEl must NOT display Tab 1's artwork while Cover 2 decodes!
    assert.notEqual(coverEl.src, 'blob:cover-1', 'Stale artwork from Tab 1 must be cleared immediately');
    assert.match(coverEl.src, /^data:image\/svg\+xml/);
    assert.equal(coverEl.hidden, false);

    // Resolve decode for Tab 2
    const resolve2 = decodeResolvers.shift();
    assert.ok(resolve2);
    resolve2();
    await new Promise((r) => setTimeout(r, 10));

    // Cover 2 is now active
    assert.equal(coverEl.src, 'blob:cover-2');
});

test('loadingCard hides cover element when file has no cover', async () => {
    const elements = createDom();
    const coverEl = elements.get('loadingCardCover');
    coverEl.src = 'blob:old-cover';
    coverEl.hidden = false;

    const { showLoadingCard } = await import('../src/utils/loadingCard.js');

    showLoadingCard(null, {
        title: 'Song No Cover',
        coverUrl: ''
    });

    assert.equal(coverEl.src, '');
    assert.equal(coverEl.hidden, true);
});

test('stale image decode from previous token does not overwrite newer token cover', async () => {
    const elements = createDom();
    const coverEl = elements.get('loadingCardCover');

    let decodeResolvers = [];
    globalThis.Image = class {
        constructor() {
            this.src = '';
            this.complete = false;
            this.naturalWidth = 0;
        }
        decode() {
            return new Promise((resolve) => {
                this.complete = true;
                this.naturalWidth = 250;
                decodeResolvers.push(resolve);
            });
        }
    };

    const { showLoadingCard } = await import('../src/utils/loadingCard.js');

    // Load File A
    showLoadingCard(null, { title: 'File A', coverUrl: 'blob:cover-A' });
    const resolveA = decodeResolvers.shift();

    // Rapidly switch to File B before File A finishes
    showLoadingCard(null, { title: 'File B', coverUrl: 'blob:cover-B' });
    const resolveB = decodeResolvers.shift();

    // Now File A finishes late
    resolveA();
    await new Promise((r) => setTimeout(r, 10));

    // Cover A must NOT have been committed
    assert.notEqual(coverEl.src, 'blob:cover-A');

    // File B finishes
    resolveB();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(coverEl.src, 'blob:cover-B');
});
