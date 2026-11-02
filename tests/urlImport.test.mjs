// Run with: node --test tests/urlImport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches, hostAllowed, runUrlSteps, fileNameFor, placeSyncSets, parseWebAddress } from '../src/urlImport/urlImport.js';

const page = 'https://www.example.org/song/12';
const bytes = new Uint8Array([1, 2, 3]);
const serving = (routes, seen = []) => async (url) => {
    seen.push(url);
    if (!(url in routes)) throw new Error(`unexpected fetch ${url}`);
    return routes[url];
};

test('host patterns match exact hosts and whole-label subdomains only', () => {
    assert.ok(!hostMatches('x.cloudfront.net', ''));
    assert.ok(hostAllowed('d1.cloudfront.net', ['example.org', 'd1.cloudfront.net']));
    assert.ok(!hostAllowed('d2.cloudfront.net', ['d1.cloudfront.net']));
});

test('steps are fed responses until a file comes back, with its sync sets', async () => {
    const seen = [];
    const out = await runUrlSteps({
        url: page, hosts: ['cdn.example.net'],
        step: async (url, responses) => {
            if (!responses.length) return { fetch: ['https://www.example.org/state'] };
            if (responses.length === 1) return { fetch: [`https://cdn.example.net/${responses[0]}.json`] };
            return { file: { name: 'a.gp', bytes }, sync: [{ videoId: 'abcdefghijk', barTimesMs: [0, 1000] }] };
        },
        fetchText: serving({ 'https://www.example.org/state': '42', 'https://cdn.example.net/42.json': '{}' }, seen)
    });
    assert.equal(out.file.name, 'a.gp');
    assert.equal(out.sync.length, 1);
    assert.deepEqual(seen, ['https://www.example.org/state', 'https://cdn.example.net/42.json']);
});

test('an undeclared host, plain http and a non-address are refused', async () => {
    const run = (fetchUrl) => runUrlSteps({ url: page, hosts: ['cdn.example.net'], step: async () => ({ fetch: [fetchUrl] }), fetchText: serving({}) });
    await assert.rejects(run('https://evil.example.com/x'), /did not declare/);
    await assert.rejects(run('http://cdn.example.net/x'), /only fetch https/);
    await assert.rejects(run('not a url'), /not a web address/);
});

test('limits: requests per round, rounds, empty file, nothing to do', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://www.example.org/${i}`);
    await assert.rejects(runUrlSteps({ url: page, hosts: [], step: async () => ({ fetch: many }), fetchText: serving({}) }), /limit is/);
    await assert.rejects(runUrlSteps({ url: page, hosts: [], step: async () => ({ fetch: ['https://www.example.org/a'] }), fetchText: serving({ 'https://www.example.org/a': 'x' }) }), /too many steps/);
    await assert.rejects(runUrlSteps({ url: page, hosts: [], step: async () => ({ file: { name: 'a.gp', bytes: new Uint8Array() } }), fetchText: serving({}) }), /empty file/);
    await assert.rejects(runUrlSteps({ url: page, hosts: [], step: async () => ({}), fetchText: serving({}) }), /nothing to fetch/);
});

test('an optional fetch that fails reads as an empty response; a required one aborts', async () => {
    const failing = async () => { throw new Error('404'); };
    const run = (optional) => runUrlSteps({
        url: page, hosts: [],
        step: async (url, responses) => (responses.length ? { file: { name: 'a.gp', bytes }, sync: [{ n: responses[0] }] } : { fetch: ['https://www.example.org/x'], optional }),
        fetchText: failing
    });
    const out = await run(true);
    assert.deepEqual(out.sync, [{ n: '' }]);
    await assert.rejects(run(false), /404/);
});

test('file names come from the header, then the path', () => {
    assert.equal(fileNameFor('https://x.org/a/b.gp5', 'attachment; filename="My Song.gp"'), 'My Song.gp');
    assert.equal(fileNameFor('https://x.org/a/Duo%20No%202.gp5'), 'Duo No 2.gp5');
    assert.equal(fileNameFor('https://x.org/'), 'tab-from-url');
});

test('addresses must be http or https', () => {
    assert.throws(() => parseWebAddress('nope'), /not a web address/);
    assert.throws(() => parseWebAddress('ftp://x.org/a'), /Only http/);
    assert.equal(parseWebAddress(' https://x.org/a ').host, 'x.org');
});

test('sync sets that do not fit are skipped with a reason, the rest are placed', () => {
    const place = (times) => {
        if (times.length !== 2) throw new Error(`has ${times.length} bars, score plays 2`);
        return times.map((timeMs, i) => ({ barIndex: i, timeMs }));
    };
    const { placed, skipped } = placeSyncSets([
        { label: 'Backing', videoId: 'abcdefghijk', barTimesMs: [0, 500] },
        { label: 'Live', videoId: 'lmnopqrstuv', barTimesMs: [0] },
        { label: 'Bad', videoId: 'x', barTimesMs: [0, 1] }
    ], place);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].videoId, 'abcdefghijk');
    assert.equal(skipped.length, 2);
    assert.match(skipped[0], /Live: has 1 bars/);
});
