// Run with: node --test tests/audioSync/syncSource.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyncSteps } from '../../src/audioSync/importers/syncSource.js';
import { loadFromUrl } from '../../src/audioSync/importers/index.js';

const page = 'https://example.org/page/12';
const serving = (routes, seen = []) => async (url) => {
    seen.push(url);
    if (!(url in routes)) throw new Error(`unexpected fetch ${url}`);
    return routes[url];
};

// A converter that looks up an id, then asks for the data, then hands it back
const twoStep = async (url, responses) => {
    const origin = new URL(url).origin;
    if (!responses.length) return { fetch: [`${origin}/api/latest`] };
    if (responses.length === 1) return { fetch: [`${origin}/api/data/${JSON.parse(responses[0]).id}`] };
    return { text: responses[1] };
};

test('responses are fed back to the step until it returns text', async () => {
    const seen = [];
    const text = await runSyncSteps({
        url: page, step: twoStep,
        fetchText: serving({ 'https://example.org/api/latest': '{"id":9}', 'https://example.org/api/data/9': '[0,1,2]' }, seen)
    });
    assert.equal(text, '[0,1,2]');
    assert.deepEqual(seen, ['https://example.org/api/latest', 'https://example.org/api/data/9']);
});

test('a converter may only fetch https addresses on the given site', async () => {
    const fetchText = serving({});
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['https://evil.example/x'] }), fetchText }), /not the site you gave/);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['http://example.org/x'] }), fetchText }), /https/);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['https://sub.example.org/x'] }), fetchText }), /not the site you gave/);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['nope'] }), fetchText }), /not a web address/);
});

test('rounds, requests per round, empty answers and response size are limited', async () => {
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['https://example.org/a'] }), fetchText: async () => 'x' }), /too many steps/);
    const many = Array.from({ length: 6 }, (_, i) => `https://example.org/${i}`);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: many }), fetchText: async () => 'x' }), /limit is 5/);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({}), fetchText: async () => 'x' }), /nothing to fetch/);
    await assert.rejects(runSyncSteps({ url: page, step: async () => ({ fetch: ['https://example.org/a'] }), fetchText: async () => 'x'.repeat(5_000_001) }), /too large/);
});

test('loadFromUrl uses a found converter, and reads the text it returns', async () => {
    const fetchText = serving({ 'https://example.org/api/latest': '{"id":9}', 'https://example.org/api/data/9': '{"items":[{"points":[0,2.5,5]}]}' });
    const sets = await loadFromUrl(page, fetchText, { findSource: async () => ({ step: twoStep }) });
    assert.deepEqual(sets[0].barTimesMs, [0, 2500, 5000]);
    // with no converter the address itself is read, which here is not data
    await assert.rejects(loadFromUrl(page, serving({ [page]: '<html></html>' }), { findSource: async () => null }), /web page/);
});
