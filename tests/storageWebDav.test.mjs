// tests/storageWebDav.test.mjs
// The WebDAV adapter against a fake WebDAV server over real HTTP: the shared conformance suite on a case-sensitive and a
// case-insensitive server, a server that sends no ETags, and the folder behaviour only WebDAV has.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createWebDavStore } from '../src/storage/webdavStore.js';
import { ConflictError } from '../src/storage/contract.js';
import { runConformance } from './storage/conformance.mjs';
import { startFakeDav } from './storage/fakeDavServer.mjs';

const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function makeStore(serverOptions, config = {}) {
    const server = await startFakeDav(serverOptions);
    servers.push(server);
    const store = createWebDavStore({ url: server.url, username: 'u', password: 'p', folder: 'music', ...config });
    await store.open({ create: true });
    return { store, server };
}

runConformance('webdav', async () => (await makeStore()).store);
runConformance('webdav, case-insensitive server', async () => (await makeStore({ caseInsensitive: true })).store);

test('webdav: a server without ETags still gives versions, from the modified time and size (second resolution)', async () => {
    const { store } = await makeStore({ etags: false });
    const { version } = await store.write('a.bin', new Uint8Array([1, 2]));
    assert.match(version, /^\d+:2$/);
    assert.equal((await store.stat('a.bin')).version, version);
    assert.deepEqual([...await store.read('a.bin')], [1, 2]);
});

test('webdav: files land under folder/MajesticTab Library and empty folders are pruned after a delete', async () => {
    const { store, server } = await makeStore();
    await store.write('packs/a/score/s.gp', new Uint8Array([1]));
    assert.ok(server.files.has('music/MajesticTab Library/packs/a/score/s.gp'));
    await store.delete('packs/a/score/s.gp');
    assert.ok(!server.dirs.has('music/MajesticTab Library/packs'), 'empty folders were left behind');
    assert.ok(server.dirs.has('music/MajesticTab Library'), 'the store root must stay');
});

test('webdav: open without create is false until the folder exists', async () => {
    const server = await startFakeDav();
    servers.push(server);
    const store = createWebDavStore({ url: server.url, folder: '' });
    assert.equal(await store.open({ create: false }), false);
    assert.equal(await store.open({ create: true }), true);
    const again = createWebDavStore({ url: server.url, folder: '' });
    assert.equal(await again.open({ create: false }), true);
});

test('webdav: a case-insensitive server refuses a name that differs only in case', async () => {
    const { store, server } = await makeStore({ caseInsensitive: true });
    await store.write('Packs/A.bin', new Uint8Array([1]));
    await assert.rejects(() => store.write('packs/a.bin', new Uint8Array([2])), ConflictError);
    assert.equal(server.files.size, 1);
});
