// Run with: node --test tests/storageMtbackup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeBackup, openBackup, backupKind, blobSource, BACKUP_VERSION } from '../src/storage/mtbackup.js';
import { toLibraryDoc, toProfileDoc } from '../src/storage/libraryDocs.js';
import { buildMpak, concatParts, openMpak, sha256 } from '../src/mpak/core/index.js';
import { MpakError } from '../src/mpak/core/index.js';

const enc = new TextEncoder();
async function pack(id, audioSize = 0) {
    const score = enc.encode(`tab ${id}`);
    const audio = new Uint8Array(audioSize).map((_, i) => i % 251);
    const manifest = { format: 'mpak', version: 1, id, song: { title: id, artist: 'A' }, scores: [{ id: 'main', path: 'score/a.gp5', format: 'gp5', sha256: await sha256(score), size: score.length }] };
    const files = { 'score/a.gp5': score };
    if (audioSize) {
        manifest.recordings = [{ id: 'r1', role: 'original', sources: [{ type: 'file', path: 'audio/a.bin', size: audioSize, sha256: await sha256(audio) }] }];
        files['audio/a.bin'] = audio;
    }
    return new Blob([await concatParts((await buildMpak(manifest, files)).parts)]);
}
const records = (n) => ({ collections: [{ id: 'default', name: 'Library' }], songs: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Song ${i}`, tabOptions: [{ id: 't' }] })), recents: [], setlists: [] });

test('a backup holds real packs that open in place, plus the library and profile', async () => {
    const recs = records(2);
    const blob = await writeBackup({
        libraryDoc: toLibraryDoc(recs), profileDoc: toProfileDoc({ settings: { theme: 'dark' } }), now: 1700000000000, appVersion: '9',
        packs: [{ packId: 's0', songId: 's0', data: await pack('s0', 50000) }, { packId: 's1', data: await pack('s1') }],
        soundFonts: [{ id: 'f1', name: 'Piano.sf2', addedAt: 5, data: new Uint8Array([1, 2, 3]) }],
        classtab: [{ id: 'c1', name: 'classtab.zip', data: new Uint8Array([4, 5]) }],
    });
    const b = await openBackup(blobSource(blob));
    assert.equal(b.header.version, BACKUP_VERSION);
    assert.equal(b.header.summary.songs, 2);
    assert.equal(b.header.summary.packs, 2);
    assert.deepEqual(b.missing, []);
    assert.deepEqual(b.packs.map((p) => p.path), ['packs/s0.mpak', 'packs/s1.mpak']);
    // the pack is opened by the ordinary mpak reader, from a range of the backup file
    const opened = await openMpak(await b.packSource(b.packs[0]));
    assert.deepEqual(opened.warnings, []);
    assert.equal(opened.manifest.id, 's0');
    assert.equal((await opened.file('audio/a.bin')).length, 50000);
    assert.deepEqual([...await b.read(b.soundFonts[0])], [1, 2, 3]);
    assert.deepEqual([...await b.read(b.classtab[0])], [4, 5]);
    assert.equal(b.header.profile.settings.theme, 'dark');
});

test('every pack in the archive is stored, so a pack can be taken out byte for byte', async () => {
    const p = await pack('s0', 1000);
    const blob = await writeBackup({ libraryDoc: toLibraryDoc(records(1)), profileDoc: toProfileDoc({}), packs: [{ packId: 's0', data: p }] });
    const b = await openBackup(blobSource(blob));
    const src = await b.packSource(b.packs[0]);
    assert.deepEqual(await src.read(0, src.size), new Uint8Array(await p.arrayBuffer()));
});

test('more songs than one pack may hold entries is fine', async () => {
    const n = 1500;
    const tiny = new Uint8Array([1]);
    const blob = await writeBackup({
        libraryDoc: toLibraryDoc(records(n)), profileDoc: toProfileDoc({}),
        packs: Array.from({ length: n }, (_, i) => ({ packId: `s${i}`, data: tiny })),
    });
    const b = await openBackup(blobSource(blob));
    assert.equal(b.packs.length, n);
});

test('file names that would collide or are unsafe are made unique and safe', async () => {
    const blob = await writeBackup({
        libraryDoc: toLibraryDoc(records(0)), profileDoc: toProfileDoc({}),
        soundFonts: [{ id: 'a', name: '../evil/Piano.sf2', data: new Uint8Array([1]) }, { id: 'b', name: 'piano.SF2', data: new Uint8Array([2]) }],
    });
    const b = await openBackup(blobSource(blob));
    const paths = b.soundFonts.map((f) => f.path);
    assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, 2);
    assert.ok(paths.every((p) => /^soundfonts\/[A-Za-z0-9._-]+$/.test(p)), paths.join());
});

test('a backup that names a pack the archive lacks opens, lists what is missing and offers the rest', async () => {
    const { zipParts } = await import('../src/mpak/core/index.js');
    const header = {
        format: 'majestictab_backup', version: 3, library: toLibraryDoc(records(2)), profile: toProfileDoc({}),
        packs: [{ packId: 's0', path: 'packs/s0.mpak', size: 1 }, { packId: 'ghost', path: 'packs/ghost.mpak', size: 1 }],
    };
    const zip = new Blob([await concatParts((await zipParts([
        { name: 'backup.json', data: enc.encode(JSON.stringify(header)) }, { name: 'packs/s0.mpak', data: new Uint8Array([1]), store: true },
    ])).parts)]);
    const b = await openBackup(blobSource(zip));
    assert.deepEqual(b.missing, ['packs/ghost.mpak']);
    assert.deepEqual(b.packs.map((p) => p.packId), ['s0']);
});

test('refuses what is not a backup, a newer backup, and an old-format header', async () => {
    const plain = new Blob([enc.encode('hello')]);
    await assert.rejects(() => openBackup(blobSource(plain)), MpakError);
    const mk = async (header) => {
        const { zipParts } = await import('../src/mpak/core/index.js');
        return new Blob([await concatParts((await zipParts([{ name: 'backup.json', data: enc.encode(JSON.stringify(header)) }])).parts)]);
    };
    const lib = toLibraryDoc(records(0));
    await assert.rejects(async () => openBackup(blobSource(await mk({ format: 'majestictab_backup', version: 4, library: lib }))), /newer version/);
    await assert.rejects(async () => openBackup(blobSource(await mk({ format: 'majestictab_backup', version: 2, library: lib }))), /older format/);
    await assert.rejects(async () => openBackup(blobSource(await mk({ format: 'other', version: 3 }))), /not a MajesticTab backup/);
});

test('backupKind tells the new ZIP from the older single JSON document', () => {
    assert.equal(backupKind(new Uint8Array([0x50, 0x4b, 3, 4])), 'zip');
    assert.equal(backupKind(enc.encode('{"app":"MajesticTab"')), 'json');
    assert.equal(backupKind(enc.encode('﻿ \n{"app"')), 'json');
    assert.equal(backupKind(enc.encode('hello')), null);
});

test('a pack that is a Blob goes into the backup as a slice of it, not as bytes read into the page', async () => {
    const big = await pack('s0', 3 * 1024 * 1024 + 123); // past the 1 MB read size
    const sliced = [];
    const realSlice = big.slice.bind(big);
    big.slice = (...args) => { sliced.push(args); return realSlice(...args); };
    const blob = await writeBackup({ libraryDoc: toLibraryDoc(records(1)), profileDoc: toProfileDoc({}), packs: [{ packId: 's0', data: big }] });
    // one slice for the whole pack (plus the reads that check it), not one per megabyte copied into memory
    assert.ok(sliced.some(([a, b]) => a === 0 && b === big.size), 'the pack was handed on whole');
    const b = await openBackup(blobSource(blob));
    const src = await b.packSource(b.packs[0]);
    assert.deepEqual(await src.read(0, src.size), new Uint8Array(await big.arrayBuffer()));
});
