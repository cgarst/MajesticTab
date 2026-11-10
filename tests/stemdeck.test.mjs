// Run: node tests/stemdeck.test.mjs
// The Backing tracks tool: the address a person types, which songs can be sent, how they are grouped into jobs, and
// the StemDeck client against a stand-in for its API.
import assert from 'node:assert/strict';
import {
    parseAddress, isLoopback, isDesktopShell, nativeLoopbackScan, uploadName, getStemDeckAddress, hasStemDeckSupport,
    findLocalStemDeck, createStemDeckClient, NO_GUITAR_STEMS, DEFAULT_PORT
} from '../src/stemdeck/stemdeckClient.js';
import { listBackingCandidates, planJobs, backingFileName, slotFileKey } from '../src/stemdeck/backingCandidates.js';
import { stemdeckIntroText, stemdeckHelpText } from '../src/stemdeck/stemdeckTool.js';

// --- Address ---
assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: DEFAULT_PORT, address: `192.168.1.20:${DEFAULT_PORT}` });
assert.equal(parseAddress(' http://My-Mac.local:52124/library ').address, 'my-mac.local:52124');
assert.deepEqual(parseAddress('https://192.168.1.20:8443'), { error: 'https' });
for (const bad of ['', 'a b', '1.2.3.4:99999', 'ftp://x', 'host:', '-x', 'user@host:80']) assert.equal(parseAddress(bad).error, 'invalid', bad);
assert.ok(isLoopback('127.0.0.1') && isLoopback('localhost') && !isLoopback('192.168.1.20'));

const store = (init = {}) => ({ data: { ...init }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } });
const desktop = { __TAURI__: { http: { fetch() {} }, dialog: { open() {} } } };
const phone = { __TAURI__: { http: { fetch() {} } } };
assert.equal(getStemDeckAddress(store()), '', 'nothing entered: a desktop app looks by itself');
assert.equal(getStemDeckAddress(store({ stemdeck_address: '192.168.1.20:9000' })), '192.168.1.20:9000');
assert.equal(getStemDeckAddress(store({ stemdeck_address: 'junk address' })), '');
assert.ok(hasStemDeckSupport(desktop) && hasStemDeckSupport(phone) && !hasStemDeckSupport({}), 'native apps only');
assert.ok(isDesktopShell(desktop) && !isDesktopShell(phone));
{
    const calls = [];
    const win = { __TAURI__: { dialog: { open() {} }, core: { invoke: (c, a) => { calls.push([c, a]); return Promise.resolve([]); } } } };
    await nativeLoopbackScan(win)(1024, 65535);
    assert.deepEqual(calls, [['loopback_open_ports', { from: 1024, to: 65535 }]]);
    assert.equal(nativeLoopbackScan(phone), null, 'phones cannot scan, they are given an address');
}

assert.equal(uploadName('Song.MP3', 'audio/mpeg'), 'Song.MP3');
assert.equal(uploadName('take 1', 'audio/mp4'), 'take 1.m4a');
assert.equal(uploadName('a/b.webm', 'audio/webm'), 'a_b.webm');
assert.equal(backingFileName('Song.mp3', 'flac'), 'Song (no guitar).flac');

// --- Candidates ---
const file = (id, songKeys, extra = {}) => ({ id, name: `${id}.mp3`, size: 1000, durationMs: 60000, songKeys, ...extra });
{
    const files = [
        file('gen', ['B - Two'], { generatedFrom: { tool: 'stemdeck', sourceId: 'b1' } }),
        file('b1', ['B - Two']),
        file('a2', ['A - One']),
        file('a1', ['A - One']),
        file('shared', ['C - Three', 'D - Four']),
        file('onlyBacking', ['E - Five'])
    ];
    const s = store({
        [slotFileKey('A - One', 'original')]: 'a1',
        [slotFileKey('B - Two', 'backing')]: 'gen',
        [slotFileKey('E - Five', 'backing')]: 'onlyBacking',
        [slotFileKey('D - Four', 'backing')]: 'missing-file'
    });
    const c = listBackingCandidates(files, s);
    assert.deepEqual(c.map((x) => [x.songKey, x.source.id, x.backingId]), [
        ['A - One', 'a1', null],          // the file chosen as Original, not the newest
        ['B - Two', 'b1', 'gen'],         // never the backing track itself
        ['C - Three', 'shared', null],
        ['D - Four', 'shared', null]      // a backing pointer to a file that is gone does not count
    ], 'a song with only a backing file has nothing to send');

    const all = new Set(c.map((x) => x.songKey));
    const jobs = planJobs(c, all, false);
    assert.deepEqual(jobs.map((j) => [j.source.id, j.songs.map((x) => x.songKey)]), [['a1', ['A - One']], ['shared', ['C - Three', 'D - Four']]],
        'songs with a backing track are left out by default, and a shared file is sent once');
    assert.equal(planJobs(c, all, true).length, 3);
    assert.equal(planJobs(c, new Set(['B - Two']), true)[0].songs[0].backingId, 'gen');
    assert.equal(planJobs(c, new Set(), true).length, 0);
}

// --- Client ---
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
{
    const calls = [];
    const states = [{ status: 'queued', progress: 0, stage: 'Queued' }, { status: 'separating', progress: 0.4, stage: 'Separating 40%' }, { status: 'done', progress: 1, stage: 'Done' }];
    const fetchImpl = async (url, init = {}) => {
        calls.push([init.method || 'GET', url]);
        if (url.endsWith('/api/health')) return json({ name: 'StemDeck', version: '0.20.0', demucs_device: 'mps' });
        if (url.endsWith('/api/jobs') && init.method === 'POST') {
            assert.equal(init.body.get('stems'), JSON.stringify(NO_GUITAR_STEMS));
            assert.equal(init.body.get('file').name, 'Song.mp3');
            return json({ job_id: 'abc123abc123' });
        }
        if (url.endsWith('/api/jobs/abc123abc123')) return json(states.shift());
        if (url.includes('/mixdown.flac?')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        return json({ detail: 'nope' }, 404);
    };
    const client = createStemDeckClient({ address: '192.168.1.20:9000', fetchImpl, pollMs: 1 });
    assert.deepEqual(await client.health(), { version: '0.20.0', device: 'mps' });
    const id = await client.submit({ name: 'Song.mp3', type: 'audio/mpeg', data: new ArrayBuffer(8) });
    const seen = [];
    await client.waitForJob(id, { onProgress: (p) => seen.push(p.stage) });
    assert.deepEqual(seen, ['Queued', 'Separating 40%', 'Done']);
    const mix = await client.downloadMix(id);
    assert.equal(mix.data.byteLength, 3);
    assert.equal(mix.type, 'audio/flac');
    assert.ok(calls.every(([, url]) => url.startsWith('http://192.168.1.20:9000/api/')));
    assert.ok(calls.at(-1)[1].endsWith('mixdown.flac?stems=vocals,drums,bass,piano,other&gains=1,1,1,1,1'), 'no guitar in the mix');
}
{
    // Refusals carry StemDeck's own words; a failed job, a closed network and a stranger on the port are told apart
    const reply = (r) => createStemDeckClient({ address: '127.0.0.1:9000', pollMs: 1, fetchImpl: async () => r });
    await assert.rejects(reply(json({ detail: 'File is 25 min — limit is 20 min' }, 422)).submit({ name: 'a.mp3', data: new ArrayBuffer(1) }), /limit is 20 min/);
    await assert.rejects(reply(json({ status: 'error', error: 'demucs failed' })).waitForJob('x'), /demucs failed/);
    await assert.rejects(reply(json({}, 403)).health(), (e) => e.code === 'network-off');
    await assert.rejects(reply(json({ name: 'Other' })).health(), (e) => e.code === 'not-stemdeck');
    const down = createStemDeckClient({ address: '127.0.0.1:9000', fetchImpl: async () => { throw new TypeError('refused'); } });
    await assert.rejects(down.health(), (e) => e.code === 'unreachable' && /port 9000/.test(e.message));
    // Cancelling stops the wait
    const ctrl = new AbortController();
    const waiting = reply(json({ status: 'separating', progress: 0.1, stage: 'Separating 10%' })).waitForJob('x', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    await assert.rejects(waiting, (e) => e.code === 'cancelled');
    assert.throws(() => createStemDeckClient({ address: 'https://x:8443' }), (e) => e.code === 'address');
}
// --- Finding StemDeck on this computer ---
{
    // Listeners on 3000 (a dev server), 52961 (StemDeck, which moved off its default port) and 8443 (its https listener)
    const asked = [];
    const fetchImpl = async (url) => {
        asked.push(url);
        const port = Number(/:(\d+)\/api/.exec(url)[1]);
        if (port === 52961) return json({ name: 'StemDeck', version: '0.20.0', demucs_device: 'mps' });
        if (port === 3000) return json({ name: 'something else' });
        throw new TypeError('refused');
    };
    const scanned = [];
    const scan = async (from, to) => { scanned.push([from, to]); return [3000, 8443, 52961]; };
    const hit = await findLocalStemDeck({ fetchImpl, scan });
    assert.equal(hit.address, '127.0.0.1:52961');
    assert.deepEqual(scanned, [[1024, 65535]]);
    assert.ok(asked[0].includes(`:${DEFAULT_PORT}/`), 'its default port is tried before any scan');
    assert.ok(!asked.slice(1).some((u) => u.includes(`:${DEFAULT_PORT}/`)), 'and not asked twice');

    // Now remembered: no scan, one question
    asked.length = 0; scanned.length = 0;
    assert.equal((await findLocalStemDeck({ fetchImpl, scan })).address, '127.0.0.1:52961');
    assert.equal(scanned.length, 0);
    assert.equal(asked.length, 1);

    // A saved local address that has gone stale is tried, then the scan runs
    const stale = await findLocalStemDeck({ preferred: ['127.0.0.1:41000'], fetchImpl: async (u) => (u.includes(':61000/') ? json({ name: 'StemDeck', version: '1' }) : Promise.reject(new TypeError('refused'))), scan: async () => [61000] });
    assert.equal(stale.address, '127.0.0.1:61000');

    // Not running: nothing found, no error
    assert.equal(await findLocalStemDeck({ fetchImpl: async () => { throw new TypeError('refused'); }, scan: async () => [3000] }), null);
    // No scan (a phone): only this computer's known places, never a remote address
    const phoneAsked = [];
    await findLocalStemDeck({ preferred: ['192.168.1.20:9000'], fetchImpl: async (u) => { phoneAsked.push(u); throw new TypeError('x'); } });
    assert.ok(phoneAsked.length && phoneAsked.every((u) => u.startsWith('http://127.0.0.1:')));
}
// --- Dynamic wording: desktop ('this computer') vs mobile ('your computer') ---
{
    const desktopIntro = stemdeckIntroText({ desktop: true, local: true });
    assert.ok(desktopIntro.includes('this computer'), 'desktop intro should say this computer');
    assert.ok(!desktopIntro.includes('your computer'), 'desktop intro should not say your computer');

    const phoneIntro = stemdeckIntroText({ desktop: false, local: false });
    assert.ok(phoneIntro.includes('your computer'), 'mobile intro should say your computer');
    assert.ok(!phoneIntro.includes('this computer'), 'mobile intro should not say this computer');

    const desktopHelpDown = stemdeckHelpText({ desktop: true, conn: { kind: 'down' }, local: true });
    assert.ok(desktopHelpDown.includes('this computer'));

    const phoneHelpDown = stemdeckHelpText({ desktop: false, conn: { kind: 'down' }, local: false });
    assert.ok(phoneHelpDown.includes('your computer'));

    // Whenever StemDeck was not found, the person is told where its port is shown
    for (const [desktop, local] of [[true, true], [true, false], [false, false]]) {
        const text = stemdeckHelpText({ desktop, conn: { kind: 'down' }, local });
        assert.ok(/Settings, Network page/.test(text) && /Port/.test(text), `port location named (${desktop}, ${local})`);
        assert.ok(text.includes(`:${DEFAULT_PORT}`), 'with an example address');
    }
    assert.ok(/Settings, Network/.test(stemdeckHelpText({ desktop: false, conn: { kind: 'down', code: 'invalid' }, local: false })));

    const phoneHelpUnset = stemdeckHelpText({ desktop: false, conn: { kind: 'unset' }, local: false });
    assert.ok(phoneHelpUnset.includes('your computer'));
}

console.log('stemdeck tests passed');
