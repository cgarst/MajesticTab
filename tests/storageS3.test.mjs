// tests/storageS3.test.mjs
// The S3 adapter against a fake S3 server over real HTTP, through the shared conformance suite, plus the parts only S3
// has: pagination, a server without conditional writes, and keys under a configured prefix.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createS3Store } from '../src/storage/s3Store.js';
import { ConflictError } from '../src/storage/contract.js';
import { runConformance } from './storage/conformance.mjs';
import { startFakeS3 } from './storage/fakeS3Server.mjs';

const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function makeStore(serverOptions, storeOptions) {
    const server = await startFakeS3(serverOptions);
    servers.push(server);
    const config = { endpoint: server.endpoint, bucket: server.bucket, region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'my/prefix', pathStyle: true };
    const store = createS3Store(config, storeOptions);
    await store.open({ create: true });
    return { store, server };
}

runConformance('s3', async () => (await makeStore()).store);
runConformance('s3 without conditional writes', async () => (await makeStore({ conditional: false })).store);

test('s3: keys live under prefix/MajesticTab Library/ and listings page through every object', async () => {
    const { store, server } = await makeStore();
    for (let i = 0; i < 7; i++) await store.write(`packs/p${i}/manifest.json`, new Uint8Array([i]));
    assert.ok([...server.objects.keys()].every((k) => k.startsWith('my/prefix/MajesticTab Library/packs/')));
    assert.equal((await store.list('packs/')).length, 7);
    assert.equal(server.log.filter((l) => l.includes('list-type')).length >= 4, true, 'a page size of 2 needs several list calls');
});

test('s3: open without create sees nothing until something is written', async () => {
    const { store } = await makeStore();
    // makeStore opened with create; a fresh store on the same empty bucket is absent
    const server = await startFakeS3();
    servers.push(server);
    const empty = createS3Store({ endpoint: server.endpoint, bucket: server.bucket, accessKeyId: 'a', secretAccessKey: 's', pathStyle: true });
    assert.equal(await empty.open({ create: false }), false);
    await empty.write('store.json', new Uint8Array([1]));
    assert.equal(await empty.open({ create: false }), true);
    assert.ok(store);
});

test('s3: a server that rejects conditional headers is detected once and the store falls back to checking first', async () => {
    const { store, server } = await makeStore({ conditional: false });
    assert.equal(store.capabilities.conditionalWrite, true);
    const { version } = await store.write('a.bin', new Uint8Array([1]));
    await store.write('a.bin', new Uint8Array([2]), { ifVersion: version });
    assert.equal(store.capabilities.conditionalWrite, false);
    await assert.rejects(() => store.write('a.bin', new Uint8Array([3]), { ifVersion: version }), ConflictError);
    assert.deepEqual([...server.objects.get('my/prefix/MajesticTab Library/a.bin').bytes], [2]);
});
