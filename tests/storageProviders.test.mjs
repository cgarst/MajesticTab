// tests/storageProviders.test.mjs
// createProviderStore: a provider with no saved connection gives null, a saved one gives a contract store.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { createProviderStore, STORAGE_PROVIDERS } = await import('../src/storageProviders.js');

test('S3 and WebDAV with nothing saved give null (the others need a browser or the app to probe)', async () => {
    for (const p of ['s3', 'webdav']) assert.equal(await createProviderStore(p), null, p);
});

test('saved S3 and WebDAV settings give stores with the full contract', async () => {
    mem.set('majestictab_s3_config', JSON.stringify({ bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', prefix: 'x' }));
    mem.set('majestictab_webdav_config', JSON.stringify({ url: 'https://dav.example.invalid/files/me', username: 'u', password: 'p', folder: '' }));
    for (const p of ['s3', 'webdav']) {
        const store = await createProviderStore(p);
        for (const fn of ['open', 'list', 'stat', 'read', 'write', 'delete']) assert.equal(typeof store[fn], 'function', `${p}.${fn}`);
        assert.ok(store.label && store.location && store.capabilities);
    }
});

test('an unknown provider is an error, and the list names every provider the factory builds', async () => {
    await assert.rejects(() => createProviderStore('dropbox'), /Unknown storage provider/);
    assert.deepEqual([...STORAGE_PROVIDERS].sort(), ['google-drive', 'icloud', 'local', 's3', 'webdav']);
});
