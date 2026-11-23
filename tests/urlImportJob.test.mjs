// Run with: node --test tests/urlImportJob.test.mjs
// The address probe against a stand-in service: it answers a job only because its own description says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearSpecCache } from '../src/urlImport/openApiDiscovery.js';

const specText = readFileSync(new URL('./jobService.openapi.json', import.meta.url), 'utf8');
const HOST = 'http://svc.test:8080';
const LINK = '</openapi.json>; rel="service-desc"; type="application/json"';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const respond = (body, { status = 200, type = 'application/json', link = LINK } = {}) => ({
    ok: status < 400, status, body: { cancel: async () => {} },
    headers: { get: (n) => ({ link, 'content-type': type }[n.toLowerCase()] ?? null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer
});

const job = { id: 'j1', status: 'queued', status_url: `${HOST}/api/job?id=j1` };
let calls;
function serve(handler) {
    calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), headers: init?.headers || {} }); return handler(String(url), init); };
    clearSpecCache();
}
const { probeAddress } = await import('../src/urlImport/openFromUrl.js');

test('an address the description marks as a job is followed as one', async () => {
    serve((url) => (url.endsWith('/openapi.json') ? respond(specText, { link: '' }) : respond(job, { status: 202 })));
    const found = await probeAddress(`${HOST}/api/get?q=a+b&first=1&token=secret`);
    assert.equal(found.job.first.id, 'j1');
    assert.equal(found.job.title, 'Guitar Pro sync service');
    assert.deepEqual(found.job.auth, { token: 'secret', queryName: 'token' });
    assert.equal(found.job.origin, HOST);
    assert.ok(found.job.strip.includes('token'));
    assert.equal(calls.length, 2);
});

test('JSON without a description link is not a job: there is no fallback', async () => {
    serve(() => respond(job, { link: '' }));
    assert.equal(await probeAddress(`${HOST}/api/get?q=x`), null);
    assert.equal(calls.length, 1);
});

test('a description that does not list the address makes no job', async () => {
    serve((url) => (url.endsWith('/openapi.json') ? respond(specText, { link: '' }) : respond(job)));
    assert.equal(await probeAddress(`${HOST}/other/path`), null);
});

test('a description with an incomplete job mapping is an error that says so', async () => {
    const broken = JSON.parse(specText);
    delete broken.paths['/api/get'].get['x-async-job'].resultLink;
    serve((url) => (url.endsWith('/openapi.json') ? respond(JSON.stringify(broken), { link: '' }) : respond(job)));
    await assert.rejects(probeAddress(`${HOST}/api/get?q=x`), /missing "resultLink"/);
});

test('a refused token on a service that describes itself asks for the token', async () => {
    serve(() => respond({ error: 'no' }, { status: 401 }));
    await assert.rejects(probeAddress(`${HOST}/api/get?q=x`), /needs an access token/);
    serve(() => respond('<html>', { status: 401, link: '' }));
    assert.equal(await probeAddress(`${HOST}/api/get?q=x`), null);
});

test('an HTML page is not a job and is not read', async () => {
    serve(() => respond('<html></html>', { type: 'text/html' }));
    assert.equal(await probeAddress(`${HOST}/`), null);
    assert.equal(calls.length, 1);
});

test('a service that asks for a token anywhere but the query gets none sent', async () => {
    const bearerOnly = JSON.parse(specText);
    bearerOnly.paths['/api/get'].get.security = [{ tokenBearer: [] }];
    bearerOnly.components.securitySchemes.tokenBearer = { type: 'http', scheme: 'bearer' };
    serve((url) => (url.endsWith('/openapi.json') ? respond(JSON.stringify(bearerOnly), { link: '' }) : respond(job)));
    const found = await probeAddress(`${HOST}/api/get?q=x&token=abc`);
    assert.equal(found.job.auth, null);
    assert.ok(calls.every((c) => !c.headers.Authorization), 'no Authorization header is ever sent');
});

test('a source address gets its device-only token, or loses the token parameter', async () => {
    const { applySourceToken, setSourceToken, SOURCE_TOKENS_KEY } = await import('../src/webSearch.js');
    const src = { id: 's1' };
    const template = `${HOST}/api/get?q=a+b&first=1&token=$token`;
    assert.equal(applySourceToken(template, src), `${HOST}/api/get?q=a+b&first=1`);
    assert.equal(applySourceToken(`${HOST}/f?token=$token&q=x`, src), `${HOST}/f?q=x`);
    assert.equal(applySourceToken(`${HOST}/f?q=x`, src), `${HOST}/f?q=x`);
    setSourceToken('s1', 'a&b');
    assert.equal(applySourceToken(template, src), `${HOST}/api/get?q=a+b&first=1&token=a%26b`);
    assert.match(store.get(SOURCE_TOKENS_KEY), /a&b/);
    setSourceToken('s1', '');
    assert.equal(store.get(SOURCE_TOKENS_KEY), '{}');
});

test('the default provider decides whether a search fetches a file or opens a browser tab', async () => {
    const { defaultSourceFetches, SOURCES_STORAGE_KEY, DEFAULT_SOURCES } = await import('../src/webSearch.js');
    const seeds = DEFAULT_SOURCES.map((d) => ({ ...d }));
    const service = { id: 'source_1', name: 'Service', urlTemplate: `${HOST}/api/get?q=$s`, defaultUrl: '', queryFormat: 'artist_song', kind: 'api', isSeed: false };
    store.set(SOURCES_STORAGE_KEY, JSON.stringify([...seeds, service]));
    store.set('majestictab_tab_sources_duckduckgo_first', '1');
    assert.equal(defaultSourceFetches(), false, 'a search engine is first');
    store.set(SOURCES_STORAGE_KEY, JSON.stringify([service, ...seeds]));
    assert.equal(defaultSourceFetches(), true, 'the service is first');
});

const ambiguous = { error: 'Search text matched these songs; nothing was started.', query: 'bourree bach', matches: [{ song: '320', artist: 'Bach', title: 'Bourree' }, { song: '321', artist: 'Bach', title: 'Bourree (live)' }] };
const described = (url) => (url.endsWith('/openapi.json') ? respond(specText, { link: '' }) : null);

test('several matches become a list to pick from, and picking gives the address to ask again', async () => {
    serve((url) => described(url) || respond(ambiguous, { status: 409 }));
    const found = await probeAddress(`${HOST}/api/get?q=bourree+bach&format=all&token=t`);
    assert.equal(found.choose.title, 'Guitar Pro sync service');
    assert.equal(found.choose.query, 'bourree bach');
    assert.deepEqual(found.choose.options, [{ label: 'Bourree', detail: 'Bach', value: '320' }, { label: 'Bourree (live)', detail: 'Bach', value: '321' }]);
    assert.equal(found.choose.addressFor('321'), `${HOST}/api/get?format=all&token=t&song=321`);
});

test('another refusal of a described job address says what the service said', async () => {
    serve((url) => described(url) || respond({ error: 'format must be gp, mpak, band or all.' }, { status: 400 }));
    await assert.rejects(probeAddress(`${HOST}/api/get?q=1&format=wav`), /format must be gp/);
    serve((url) => described(url) || respond('boom', { status: 502 }));
    await assert.rejects(probeAddress(`${HOST}/api/get?q=1`), /answered 502/);
    serve((url) => described(url) || respond(ambiguous, { status: 409 }));
    assert.equal(await probeAddress(`${HOST}/get?q=x`), null, 'an address the description does not list is a page');
});

test('an error from a host with no description is left to the browser', async () => {
    serve(() => respond(ambiguous, { status: 409, link: '' }));
    assert.equal(await probeAddress(`${HOST}/api/get?q=x`), null);
});
