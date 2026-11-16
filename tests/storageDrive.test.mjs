// tests/storageDrive.test.mjs
// The Google Drive adapter against a fake Drive over real HTTP: the shared conformance suite, then what is particular to
// Drive: duplicate names, lookups that ignore case, folders created by two devices at once, and pruning of empty folders.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createDriveStore } from '../src/storage/driveStore.js';
import { ConflictError } from '../src/storage/contract.js';
import { runConformance } from './storage/conformance.mjs';
import { startFakeDrive } from './storage/fakeDriveServer.mjs';

const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function makeStore() {
    const server = await startFakeDrive();
    servers.push(server);
    const store = createDriveStore({ fetch: server.fetch });
    await store.open({ create: true });
    return { store, server };
}
const names = (server) => [...server.items.values()].map((f) => f.name).sort();

runConformance('drive', async () => (await makeStore()).store);

test('drive: the store root and folders are real Drive folders, and empty folders are pruned after a delete', async () => {
    const { store, server } = await makeStore();
    await store.write('packs/a/score/s.gp', new Uint8Array([1]));
    assert.deepEqual(names(server), ['MajesticTab Library', 'a', 'packs', 's.gp', 'score']);
    await store.delete('packs/a/score/s.gp');
    assert.deepEqual(names(server), ['MajesticTab Library']);
    await store.write('packs/a/score/s.gp', new Uint8Array([2]));
    assert.deepEqual([...await store.read('packs/a/score/s.gp')], [2]);
});

test('drive: open without create is false until the root folder exists', async () => {
    const server = await startFakeDrive();
    servers.push(server);
    assert.equal(await createDriveStore({ fetch: server.fetch }).open({ create: false }), false);
    await createDriveStore({ fetch: server.fetch }).open({ create: true });
    assert.equal(await createDriveStore({ fetch: server.fetch }).open({ create: false }), true);
});

test('drive: a second device creating the same folder and file at once ends with one of each', async () => {
    const { store, server } = await makeStore();
    const other = createDriveStore({ fetch: server.fetch });
    await other.open({ create: false });
    await Promise.all([store.write('packs/p/manifest.json', new Uint8Array([1])), other.write('packs/p/manifest.json', new Uint8Array([2]))]);
    assert.equal(names(server).filter((n) => n === 'packs').length, 1);
    assert.equal(names(server).filter((n) => n === 'manifest.json').length, 1);
    assert.equal((await store.list('packs/')).length, 1);
});

test('drive: create-only loses to a file another device already made, even when Drive shows two', async () => {
    const { store, server } = await makeStore();
    await store.write('a.bin', new Uint8Array([1]));
    await assert.rejects(() => store.write('a.bin', new Uint8Array([2]), { ifVersion: null }), ConflictError);
    // a duplicate that is already there: the oldest is the file, and a delete removes both
    const root = [...server.items.values()].find((f) => f.name === 'MajesticTab Library');
    server.make('a.bin', 'application/octet-stream', [root.id], Buffer.from([9]));
    assert.deepEqual([...await store.read('a.bin')], [1]);
    assert.equal(await store.delete('a.bin'), true);
    assert.equal(await store.stat('a.bin'), null);
});

test('drive: a folder another device removed is recreated on the next write', async () => {
    const { store, server } = await makeStore();
    await store.write('x/y.bin', new Uint8Array([1]));
    const folder = [...server.items.values()].find((f) => f.name === 'x');
    server.items.delete([...server.items.values()].find((f) => f.name === 'y.bin').id);
    server.items.delete(folder.id);
    await store.write('x/y.bin', new Uint8Array([2]));
    assert.deepEqual([...await store.read('x/y.bin')], [2]);
});

test('drive: a name that differs only in case is refused, since Drive would find the other one', async () => {
    const { store } = await makeStore();
    await store.write('Dir/File.bin', new Uint8Array([1]));
    await assert.rejects(() => store.write('dir/file.bin', new Uint8Array([2])), ConflictError);
    await assert.rejects(() => store.write('Dir/file.bin', new Uint8Array([2])), ConflictError);
});
