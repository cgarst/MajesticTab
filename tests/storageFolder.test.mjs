// Run with: node --test tests/storageFolder.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBrowserFolderStore, createNativeFolderStore } from '../src/storage/folderStore.js';
import { runConformance } from './storage/conformance.mjs';
import { FakeDirHandle, nodeTauriFs } from './storage/fakes.mjs';

runConformance('browser folder store', async () => {
    const s = createBrowserFolderStore(new FakeDirHandle('Backups'));
    await s.open({ create: true });
    return s;
});

const tmpRoots = [];
runConformance('native folder store (real disk)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-store-'));
    tmpRoots.push(dir);
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs });
    await s.open({ create: true });
    return s;
});

test('native store: open without create is false until created, partial files never show in list', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-store-'));
    tmpRoots.push(dir);
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs });
    assert.equal(await s.open({ create: false }), false);
    await s.open({ create: true });
    await fsp.writeFile(path.join(dir, 'MajesticTab Library', 'x.bin.part'), 'half');
    assert.deepEqual(await s.list(), []);
});

test('native store: a failed write leaves no .part file and keeps the old bytes', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-store-'));
    tmpRoots.push(dir);
    let failRename = false;
    const fs = { ...nodeTauriFs, rename: async (a, b) => { if (failRename) throw new Error('disk full'); return nodeTauriFs.rename(a, b); } };
    const s = createNativeFolderStore(dir, { fs });
    await s.open({ create: true });
    await s.write('a.bin', new Uint8Array([1]));
    failRename = true;
    await assert.rejects(() => s.write('a.bin', new Uint8Array([2])), /disk full/);
    assert.deepEqual([...await s.read('a.bin')], [1]);
    assert.deepEqual(await fsp.readdir(path.join(dir, 'MajesticTab Library')), ['a.bin']);
});

test('native store: empty folders are pruned after the last delete', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-store-'));
    tmpRoots.push(dir);
    const s = createNativeFolderStore(dir, { fs: nodeTauriFs });
    await s.open({ create: true });
    await s.write('packs/a/score/x.gp', new Uint8Array([1]));
    await s.delete('packs/a/score/x.gp');
    assert.deepEqual(await fsp.readdir(path.join(dir, 'MajesticTab Library')), []);
});

test.after(async () => { for (const d of tmpRoots) await fsp.rm(d, { recursive: true, force: true }); });
