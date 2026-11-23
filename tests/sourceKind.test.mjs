// Run with: node --test tests/sourceKind.test.mjs
// What an address does, read from its service: a job, a search that starts nothing, or a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearSpecCache } from '../src/urlImport/openApiDiscovery.js';
import { classifyAddress, cachedKind, rememberKind, sourceFetchesCached, sourceFetches, SOURCE_KINDS_KEY } from '../src/urlImport/sourceKind.js';

const specText = readFileSync(new URL('./jobService.openapi.json', import.meta.url), 'utf8');
const HOST = 'http://svc.test:8080';
const BOTH = '</openapi.json>; rel="service-desc", </opensearch.xml>; rel="search"; type="application/opensearchdescription+xml"';
const SEARCH_XML = `<OpenSearchDescription><Url type="text/html" template="${HOST}/get?q={searchTerms}"/><Url type="application/json" template="${HOST}/api/fetch?q={searchTerms}&amp;first=1"/></OpenSearchDescription>`;

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const reply = (body, { status = 200, link = '' } = {}) => ({
    ok: status < 400, status, body: { cancel: async () => {} },
    headers: { get: (n) => (n.toLowerCase() === 'link' ? link : null) }, text: async () => body
});
const service = (url) => {
    if (url.endsWith('/openapi.json')) return reply(specText);
    if (url.endsWith('/opensearch.xml')) return reply(SEARCH_XML);
    return reply('<html></html>', { link: BOTH });
};
const classify = (address, fetchImpl = async (url) => service(String(url))) => { clearSpecCache(); return classifyAddress(address, fetchImpl); };

test('the API address starts a job, the web UI address is a page', async () => {
    const job = await classify(`${HOST}/api/fetch?q=$s&first=1&token=$token`);
    assert.deepEqual([job.kind, job.title, job.needsToken], ['job', 'Guitar Pro sync service', true]);
    assert.equal((await classify(`${HOST}/get?q=$s`)).kind, 'page');
    assert.equal((await classify(`${HOST}/get?q=23063&format=gp`)).kind, 'page');
});

test('the search-only address starts nothing and suggests the one that fetches', async () => {
    const found = await classify(`${HOST}/api/search?q=$s`);
    assert.equal(found.kind, 'search');
    assert.equal(found.suggestion, `${HOST}/api/fetch?q=$s&first=1&token=$token`);
});

test('an ordinary site costs one request and is a page', async () => {
    const calls = [];
    const found = await classify('https://search.example/?q=$s+tab', async (url) => { calls.push(String(url)); return reply('<html>', { link: '' }); });
    assert.equal(found.kind, 'page');
    assert.deepEqual(calls, ['https://search.example/']);
});

test('a service that cannot be reached is unknown, not a page', async () => {
    assert.equal((await classify(`${HOST}/api/fetch?q=$s`, async () => { throw new Error('net'); })).kind, 'unknown');
    assert.equal((await classify(`${HOST}/api/fetch?q=$s`, async (url) => (String(url).endsWith('/openapi.json') ? reply('', { status: 502 }) : service(String(url))))).kind, 'unknown');
    assert.equal((await classify('not an address')).kind, 'page');
});

test('a description whose link points at another host is not followed', async () => {
    const found = await classify(`${HOST}/api/fetch?q=$s`, async () => reply('<html>', { link: '<http://evil.test/openapi.json>; rel="service-desc"' }));
    assert.equal(found.kind, 'page');
});

test('the answer is kept on this device and goes stale', () => {
    store.clear();
    assert.equal(cachedKind(`${HOST}/api/fetch?q=$s`), '');
    rememberKind(`${HOST}/api/fetch?q=$s&first=1`, 'job');
    assert.equal(cachedKind(`${HOST}/api/fetch?q=other`), 'job', 'keyed by host and path');
    assert.equal(cachedKind(`${HOST}/get?q=$s`), '');
    rememberKind(`${HOST}/x`, 'unknown');
    assert.equal(cachedKind(`${HOST}/x`), '', 'unknown is never kept');
    const cache = JSON.parse(store.get(SOURCE_KINDS_KEY));
    cache[`${HOST}/api/fetch`].at -= 2 * 24 * 60 * 60 * 1000;
    store.set(SOURCE_KINDS_KEY, JSON.stringify(cache));
    assert.equal(cachedKind(`${HOST}/api/fetch?q=$s`), '');
});

test('a source says it fetches by its own choice, else by what was found', async () => {
    store.clear();
    const source = (extra) => ({ id: 's', urlTemplate: `${HOST}/api/fetch?q=$s`, isSeed: false, ...extra });
    assert.equal(sourceFetchesCached(source()), false, 'unseen is a page');
    assert.equal(sourceFetchesCached(source({ kind: 'api' })), true);
    assert.equal(sourceFetchesCached(source({ isSeed: true, kind: 'api' })), false);
    assert.equal(await sourceFetches(source({ kind: 'page' }), async () => { throw new Error('no request'); }), false);
    clearSpecCache();
    assert.equal(await sourceFetches(source(), async (url) => service(String(url))), true, 'looked up when unknown');
    assert.equal(sourceFetchesCached(source()), true, 'and kept');
    assert.equal(await sourceFetches(source(), async () => { throw new Error('cached: no request'); }), true);
    store.clear();
    assert.equal(await sourceFetches(source(), async () => { throw new Error('net'); }), false);
    assert.equal(cachedKind(source().urlTemplate), '', 'an unreachable service is looked up again next time');
});
