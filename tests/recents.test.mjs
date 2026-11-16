import test from 'node:test';
import assert from 'node:assert/strict';

class MockIDBRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}

class MockTransaction {
    constructor(stores) {
        this.stores = stores;
        this.oncomplete = null;
        this.onerror = null;
    }
    objectStore(name) {
        return this.stores[name];
    }
    _finish() {
        queueMicrotask(() => {
            if (this.oncomplete) this.oncomplete();
        });
    }
}

class MockObjectStore {
    constructor(map, txFactory) {
        this.map = map;
        this.txFactory = txFactory;
    }
    get(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = this.map.get(key);
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    put(val) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this.map.set(val.id, val);
            req.result = val.id;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    delete(key) {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this.map.delete(key);
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    clear() {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            this.map.clear();
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
    index() {
        const map = this.map;
        return {
            openCursor(_range, dir) {
                const req = new MockIDBRequest();
                const items = [...map.values()].sort((a, b) =>
                    dir === 'prev' ? (b.openedAt || 0) - (a.openedAt || 0) : (a.openedAt || 0) - (b.openedAt || 0)
                );
                let idx = 0;
                const step = () => {
                    queueMicrotask(() => {
                        if (idx >= items.length) {
                            req.result = null;
                            if (req.onsuccess) req.onsuccess({ target: req });
                            return;
                        }
                        const current = items[idx++];
                        req.result = {
                            value: current,
                            delete() { map.delete(current.id); },
                            continue() { step(); }
                        };
                        if (req.onsuccess) req.onsuccess({ target: req });
                    });
                };
                step();
                return req;
            }
        };
    }
}

const stores = {
    library_songs: new MockObjectStore(new Map()),
    library_collections: new MockObjectStore(new Map()),
    library_recents: new MockObjectStore(new Map()),
    library_setlists: new MockObjectStore(new Map())
};

const mockDb = {
    transaction() {
        const tx = new MockTransaction(stores);
        tx._finish();
        return tx;
    }
};

globalThis.indexedDB = {
    open() {
        const req = new MockIDBRequest();
        queueMicrotask(() => {
            req.result = mockDb;
            if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
    }
};

const { getRecents, MAX_RECENTS_LIMIT } = await import('../src/libraryStore.js');

function seedSongsAndRecents(count) {
    stores.library_songs.map.clear();
    stores.library_recents.map.clear();
    for (let i = 1; i <= count; i++) {
        const songId = `song_${i}`;
        stores.library_songs.map.set(songId, {
            id: songId,
            title: `Song ${i}`,
            artist: 'Artist',
            album: 'Album'
        });
        stores.library_recents.map.set(`rec_${i}`, {
            id: `rec_${i}`,
            librarySongId: songId,
            name: `Song ${i}.gp5`,
            openedAt: i * 1000
        });
    }
}

test('getRecents(1) returns newest item without purging remaining recents', async () => {
    seedSongsAndRecents(5);

    const latest = await getRecents(1);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].id, 'rec_5');

    const all = await getRecents(15);
    assert.equal(all.length, 5);
    assert.deepEqual(all.map(r => r.id), ['rec_5', 'rec_4', 'rec_3', 'rec_2', 'rec_1']);
});

test('getRecents(15) still purges recents beyond MAX_RECENTS_LIMIT', async () => {
    seedSongsAndRecents(MAX_RECENTS_LIMIT + 3);

    const list = await getRecents(MAX_RECENTS_LIMIT);
    assert.equal(list.length, MAX_RECENTS_LIMIT);
    assert.equal(stores.library_recents.map.size, MAX_RECENTS_LIMIT);
});
