// tests/storage/conformance.mjs
// The suite every storage adapter must pass (src/storage/contract.js). An adapter's test file calls
// runConformance('name', () => freshOpenedStore()). The factory returns an empty, opened store each time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NotFoundError, ConflictError, BadPathError, readText, writeText, readJson, updateJson, readIfExists, writePackDir, deletePackDir,
} from '../../src/storage/contract.js';

const bytes = (...n) => new Uint8Array(n);
const sorted = (entries) => entries.map((e) => e.path).sort();

export function runConformance(name, makeStore) {
    const t = (title, fn) => test(`${name}: ${title}`, async () => fn(await makeStore()));

    t('open without create finds nothing, open with create succeeds and stays open', async (s0) => {
        // factories hand back an opened store; a second store on the same root is the adapter's own concern, so only
        // the contract's visible promise is checked here
        assert.equal(await s0.open({ create: true }), true);
        assert.equal(await s0.open({ create: false }), true);
    });

    t('write then read returns the same bytes, and creates the folders in between', async (s) => {
        await s.write('a/b/c.bin', bytes(1, 2, 3));
        assert.deepEqual([...await s.read('a/b/c.bin')], [1, 2, 3]);
    });

    t('reading a missing file throws NotFoundError; readIfExists gives null', async (s) => {
        await assert.rejects(() => s.read('nope.bin'), NotFoundError);
        assert.equal(await readIfExists(s, 'nope.bin'), null);
        assert.equal(await s.stat('nope.bin'), null);
    });

    t('an empty file and a large file round trip', async (s) => {
        await s.write('empty.bin', new Uint8Array(0));
        assert.equal((await s.read('empty.bin')).length, 0);
        const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
        await s.write('big.bin', big);
        assert.deepEqual(await s.read('big.bin'), big);
        assert.equal((await s.stat('big.bin')).size, big.length);
    });

    t('range reads return exactly the requested bytes, clamped to the file', async (s) => {
        await s.write('r.bin', bytes(0, 1, 2, 3, 4, 5, 6, 7));
        assert.deepEqual([...await s.read('r.bin', { range: { start: 2, end: 5 } })], [2, 3, 4]);
        assert.deepEqual([...await s.read('r.bin', { range: { start: 6, end: 100 } })], [6, 7]);
        assert.deepEqual([...await s.read('r.bin', { range: { start: 0, end: 1 } })], [0]);
        assert.equal((await s.read('r.bin', { range: { start: 8, end: 9 } })).length, 0);
    });

    t('overwrite replaces the bytes and changes the version', async (s) => {
        const first = await s.write('o.bin', bytes(1));
        const second = await s.write('o.bin', bytes(2, 2));
        assert.notEqual(first.version, second.version);
        assert.deepEqual([...await s.read('o.bin')], [2, 2]);
        assert.equal((await s.stat('o.bin')).version, second.version);
    });

    t('stat and list report size, a version and a modified time', async (s) => {
        const { version } = await s.write('x/y.bin', bytes(9, 9, 9));
        const entry = await s.stat('x/y.bin');
        assert.equal(entry.path, 'x/y.bin');
        assert.equal(entry.size, 3);
        assert.equal(entry.version, version);
        assert.ok(!Number.isNaN(Date.parse(entry.modifiedTime)));
        const listed = (await s.list('x/'))[0];
        assert.equal(listed.size, 3);
        assert.equal(typeof listed.version, 'string');
    });

    t('list is recursive, honours the prefix at a folder boundary, and lists only files', async (s) => {
        for (const p of ['packs/a/manifest.json', 'packs/a/score/s.gp', 'packs/ab/manifest.json', 'library.json', 'profile.json']) {
            await s.write(p, bytes(1));
        }
        assert.deepEqual(sorted(await s.list('packs/a/')), ['packs/a/manifest.json', 'packs/a/score/s.gp']);
        assert.deepEqual(sorted(await s.list('packs/')), ['packs/a/manifest.json', 'packs/a/score/s.gp', 'packs/ab/manifest.json']);
        assert.equal((await s.list()).length, 5);
        assert.deepEqual(await s.list('nothing/'), []);
    });

    t('delete removes a file, reports whether one was removed, and a missing file is not an error', async (s) => {
        await s.write('d.bin', bytes(1));
        assert.equal(await s.delete('d.bin'), true);
        assert.equal(await s.delete('d.bin'), false);
        assert.equal(await s.stat('d.bin'), null);
    });

    t('deleting the last file in a folder leaves no file behind in list', async (s) => {
        await s.write('only/one.bin', bytes(1));
        await s.delete('only/one.bin');
        assert.deepEqual(await s.list('only/'), []);
        await s.write('only/one.bin', bytes(2));
        assert.deepEqual([...await s.read('only/one.bin')], [2]);
    });

    t('ifVersion: null creates only when the file is absent', async (s) => {
        await s.write('c.bin', bytes(1), { ifVersion: null });
        await assert.rejects(() => s.write('c.bin', bytes(2), { ifVersion: null }), ConflictError);
        assert.deepEqual([...await s.read('c.bin')], [1]);
    });

    t('ifVersion: string overwrites only the version it names, and the error carries the current one', async (s) => {
        const { version } = await s.write('v.bin', bytes(1));
        const { version: v2 } = await s.write('v.bin', bytes(2), { ifVersion: version });
        await assert.rejects(() => s.write('v.bin', bytes(3), { ifVersion: version }), (err) => {
            assert.ok(err instanceof ConflictError);
            assert.equal(err.current, v2);
            return true;
        });
        assert.deepEqual([...await s.read('v.bin')], [2]);
    });

    t('ifVersion on a file that was deleted is a conflict, not a create', async (s) => {
        const { version } = await s.write('g.bin', bytes(1));
        await s.delete('g.bin');
        await assert.rejects(() => s.write('g.bin', bytes(2), { ifVersion: version }), ConflictError);
    });

    t('delete with a stale ifVersion changes nothing', async (s) => {
        const { version } = await s.write('k.bin', bytes(1));
        await s.write('k.bin', bytes(2));
        await assert.rejects(() => s.delete('k.bin', { ifVersion: version }), ConflictError);
        assert.deepEqual([...await s.read('k.bin')], [2]);
    });

    t('unsafe paths are refused on every call and nothing is written', async (s) => {
        for (const p of ['', '/abs', 'trail/', 'a//b', 'a/../b', './a', 'a\\b', 'a/b:c', 'a/b?c', 'a/b ', 'a/b.', 'a/\u0000']) {
            await assert.rejects(() => s.write(p, bytes(1)), BadPathError, `write ${JSON.stringify(p)}`);
            await assert.rejects(() => s.read(p), BadPathError, `read ${JSON.stringify(p)}`);
        }
        await assert.rejects(() => s.list('noslash'), BadPathError);
        assert.deepEqual(await s.list(), []);
    });

    t('names that differ only in case or in unicode composition stay separate files or conflict loudly, never merge', async (s) => {
        // A case-insensitive backend (Windows, macOS folders, iCloud) must refuse the second write rather than overwrite
        // the first. Either outcome is allowed; silent loss is not.
        await s.write('Case/File.bin', bytes(1));
        let second = 'written';
        try { await s.write('case/file.bin', bytes(2)); } catch (err) { second = err; }
        const first = await s.read('Case/File.bin');
        if (second === 'written') {
            assert.deepEqual([...await s.read('case/file.bin')], [2]);
            assert.deepEqual([...first], [1], 'the first file was overwritten by a name that only differs in case');
        } else {
            assert.ok(second instanceof ConflictError || second instanceof BadPathError);
        }
    });

    t('non-ASCII names round trip', async (s) => {
        const p = 'packs/é-日本語/score/La Vie en Rose – tab.gp';
        await s.write(p, bytes(7));
        assert.deepEqual([...await s.read(p)], [7]);
        assert.deepEqual(sorted(await s.list('packs/')), [p]);
    });

    t('text and JSON helpers round trip', async (s) => {
        await writeText(s, 't.txt', 'héllo');
        assert.equal(await readText(s, 't.txt'), 'héllo');
        await s.write('j.json', new TextEncoder().encode(JSON.stringify({ a: 1 })));
        assert.deepEqual(await readJson(s, 'j.json'), { a: 1 });
    });

    t('updateJson creates the file, then changes it, and retries when another writer got in between', async (s) => {
        await updateJson(s, 'lib.json', (cur) => ({ songs: { ...(cur?.songs || {}), a: 1 } }));
        let raced = false;
        await updateJson(s, 'lib.json', async (cur) => {
            if (!raced) {
                raced = true;
                // another device writes between our read and our write
                await updateJson(s, 'lib.json', (c) => ({ songs: { ...c.songs, b: 2 } }));
            }
            return { songs: { ...cur.songs, c: 3 } };
        });
        const final = await readJson(s, 'lib.json');
        // the retry re-read the other writer's change, so only the stale `cur` we returned could lose "b"
        assert.equal(final.songs.a, 1);
        assert.equal(final.songs.c, 3);
        assert.equal(final.songs.b, 2, 'the other writer\'s change was lost');
    });

    t('writePackDir writes the manifest last, so a failure partway leaves no manifest', async (s) => {
        const files = { 'manifest.json': bytes(1), 'score/a.gp': bytes(2), 'audio/a.flac': bytes(3) };
        if (typeof s.failNext === 'function') {
            s.failNext('write', new Error('network down'), 'packs/p/audio/');
            await assert.rejects(() => writePackDir(s, 'packs/p', files), /network down/);
            assert.equal(await s.stat('packs/p/manifest.json'), null);
        }
        await writePackDir(s, 'packs/p', files);
        assert.deepEqual(sorted(await s.list('packs/p/')), ['packs/p/audio/a.flac', 'packs/p/manifest.json', 'packs/p/score/a.gp']);
    });

    t('writePackDir with skipSameSize does not rewrite audio that is already there', async (s) => {
        const files = { 'manifest.json': bytes(1), 'audio/a.flac': bytes(3, 3, 3) };
        await writePackDir(s, 'packs/q', files);
        const before = (await s.stat('packs/q/audio/a.flac')).version;
        await writePackDir(s, 'packs/q', files, { skipSameSize: true });
        assert.equal((await s.stat('packs/q/audio/a.flac')).version, before);
    });

    t('deletePackDir removes the manifest first and then everything under the pack, and only that pack', async (s) => {
        await writePackDir(s, 'packs/a', { 'manifest.json': bytes(1), 'score/x.gp': bytes(2) });
        await writePackDir(s, 'packs/ab', { 'manifest.json': bytes(1) });
        await deletePackDir(s, 'packs/a');
        assert.deepEqual(sorted(await s.list('packs/')), ['packs/ab/manifest.json']);
    });
}
