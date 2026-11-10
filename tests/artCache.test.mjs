import test from 'node:test';
import assert from 'node:assert/strict';

// Set up mock CacheStorage and URL methods before importing musicbrainz
class MockResponse {
    constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.statusText = init.statusText || 'OK';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(init.headers || {});
    }
    async blob() {
        return new Blob([this.body || 'fake-image-bytes'], { type: 'image/jpeg' });
    }
    clone() {
        return new MockResponse(this.body, {
            status: this.status,
            statusText: this.statusText,
            headers: this.headers
        });
    }
}

class MockCache {
    constructor() {
        this.store = new Map();
    }
    async match(req) {
        const url = typeof req === 'string' ? req : req.url;
        const res = this.store.get(url);
        return res ? res.clone() : undefined;
    }
    async put(url, response) {
        const key = typeof url === 'string' ? url : url.url;
        this.store.set(key, response.clone());
    }
    async delete(req) {
        const url = typeof req === 'string' ? req : req.url;
        return this.store.delete(url);
    }
    async keys() {
        return Array.from(this.store.keys()).map(url => ({ url }));
    }
}

const mockCacheInstance = new MockCache();
globalThis.caches = {
    async open() {
        return mockCacheInstance;
    },
    async delete() {
        mockCacheInstance.store.clear();
        return true;
    }
};

let blobId = 0;
const revokedBlobs = new Set();
globalThis.URL.createObjectURL = () => {
    return `blob:http://localhost:8000/mock-art-${++blobId}`;
};
globalThis.URL.revokeObjectURL = (url) => {
    revokedBlobs.add(url);
};

// Mock fetch for cover art URLs
globalThis.fetch = async (url) => {
    return new MockResponse('test-image-data', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' }
    });
};

const {
    getCachedArtUrl,
    getSynchronousCachedArtUrl,
    pruneArtCache,
    clearArtCache
} = await import('../src/musicbrainz.js');

test('getSynchronousCachedArtUrl returns raw URL when uncached', () => {
    const raw = 'https://coverartarchive.org/release-group/test-mbid/front-250';
    assert.equal(getSynchronousCachedArtUrl(raw), raw);
});

test('getCachedArtUrl fetches, caches in CacheStorage, and populates synchronous cache', async () => {
    const raw = 'https://coverartarchive.org/release-group/metallica-master-of-puppets/front-250';
    const blobUrl = await getCachedArtUrl(raw);

    assert.ok(blobUrl.startsWith('blob:'));
    // Now synchronous lookup must return the blob URL immediately
    assert.equal(getSynchronousCachedArtUrl(raw), blobUrl);

    // Verify it was stored in persistent CacheStorage with cached-at timestamp header
    const inCache = await mockCacheInstance.match(raw);
    assert.ok(inCache);
    assert.ok(inCache.headers.get('x-majestictab-cached-at'));
});

test('pruneArtCache deletes expired items older than 30 days', async () => {
    const expiredUrl = 'https://coverartarchive.org/release-group/expired-album/front-250';
    const thirtyOneDaysAgo = Date.now() - (31 * 24 * 3600 * 1000);

    const expiredRes = new MockResponse('expired-bytes', {
        headers: { 'x-majestictab-cached-at': String(thirtyOneDaysAgo) }
    });
    await mockCacheInstance.put(expiredUrl, expiredRes);

    // Verify it is in cache before prune
    const beforePrune = await mockCacheInstance.match(expiredUrl);
    assert.ok(beforePrune);

    // Run prune
    await pruneArtCache();

    // The expired item should have been removed from CacheStorage
    const checked = await mockCacheInstance.match(expiredUrl);
    assert.equal(checked, undefined);
});

test('getCachedArtUrl automatically refetches and replaces expired cached art', async () => {
    const expiredUrl = 'https://coverartarchive.org/release-group/expired-refetch-test/front-250';
    const thirtyOneDaysAgo = Date.now() - (31 * 24 * 3600 * 1000);

    const expiredRes = new MockResponse('old-expired-bytes', {
        headers: { 'x-majestictab-cached-at': String(thirtyOneDaysAgo) }
    });
    await mockCacheInstance.put(expiredUrl, expiredRes);

    // Calling getCachedArtUrl should detect the expired entry, remove it, and fetch fresh
    const freshBlob = await getCachedArtUrl(expiredUrl);
    assert.ok(freshBlob.startsWith('blob:'));

    const updated = await mockCacheInstance.match(expiredUrl);
    assert.ok(updated);
    const newTimestamp = Number(updated.headers.get('x-majestictab-cached-at'));
    assert.ok(Date.now() - newTimestamp < 5000);
});

test('clearArtCache wipes memory cache and storage', async () => {
    const raw = 'https://coverartarchive.org/release-group/album-to-clear/front-250';
    await getCachedArtUrl(raw);

    await clearArtCache();

    assert.equal(getSynchronousCachedArtUrl(raw), raw);
    const checked = await mockCacheInstance.match(raw);
    assert.equal(checked, undefined);
});
