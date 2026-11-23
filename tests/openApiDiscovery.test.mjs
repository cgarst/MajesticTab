// Run with: node --test tests/openApiDiscovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    serviceDescLink, parseSpec, resolveRef, loadSpec, clearSpecCache, asyncMapping, findOperation, authOf,
    buildTemplate, suggestSource, discoverFromAddress
} from '../src/urlImport/openApiDiscovery.js';

const text = readFileSync(new URL('./jobService.openapi.json', import.meta.url), 'utf8');
const spec = parseSpec(text);
const HOST = 'http://svc.test:8080';

const reply = (body, { ok = true, status = 200, link = '' } = {}) => ({
    ok, status, text: async () => body, headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) }
});

test('the Link header names the description', () => {
    assert.equal(serviceDescLink('</openapi.json>; rel="service-desc"; type="application/json"', `${HOST}/api/fetch?q=x`), `${HOST}/openapi.json`);
    assert.equal(serviceDescLink('<https://x.test/a>; rel="next", </spec>; rel="service-desc"', `${HOST}/`), `${HOST}/spec`);
    assert.equal(serviceDescLink('</a>; rel="next"', `${HOST}/`), '');
    assert.equal(serviceDescLink(null, `${HOST}/`), '');
});

test('a description must be OpenAPI 3 JSON of sane size', () => {
    assert.throws(() => parseSpec('nope'), /not JSON/);
    assert.throws(() => parseSpec('{"openapi":"2.0","paths":{}}'), /not an OpenAPI 3/);
    assert.throws(() => parseSpec('{"openapi":"3.1.0"}'), /not an OpenAPI 3/);
    assert.throws(() => parseSpec(' '.repeat(600 * 1024)), /too large/);
});

test('only local references are followed', () => {
    assert.equal(resolveRef(spec, { $ref: '#/components/securitySchemes/tokenQuery' }).name, 'token');
    assert.equal(resolveRef(spec, { $ref: 'http://other.test/x.json#/a' }), undefined);
    const loop = { components: { a: { $ref: '#/components/b' }, b: { $ref: '#/components/a' } } };
    assert.equal(resolveRef(loop, { $ref: '#/components/a' }), undefined);
});

test('the start operation maps the job and its progress', () => {
    const found = findOperation(spec, `${HOST}/api/fetch?q=x&first=1`);
    assert.equal(found.path, '/api/fetch');
    const { mapping, error } = asyncMapping(found.operation);
    assert.equal(error, undefined);
    assert.equal(mapping.statusUrl, '/status_url');
    assert.deepEqual(mapping.states.done, ['done']);
    assert.equal(mapping.progress.percent, '/progress/percent');
    assert.equal(mapping.result, '/file_url');
});

test('an incomplete mapping says what is missing', () => {
    assert.match(asyncMapping({ 'x-async-job': { state: '/s', states: {}, result: '/r' } }).error, /statusUrl/);
    assert.match(asyncMapping({ 'x-async-job': { statusUrl: '/u', state: '/s', states: { pending: [], running: [], done: ['d'] }, result: '/r' } }).error, /failed/);
    assert.match(asyncMapping({ 'x-async-job': { statusUrl: 'u', state: '/s', states: {}, result: '/r' } }).error, /statusUrl/);
    assert.match(asyncMapping({}).error, /does not describe a job/);
});

test('an address behind a path prefix still matches', () => {
    assert.equal(findOperation(spec, `${HOST}/proxy/gp/api/fetch?q=x`).prefix, '/proxy/gp');
    assert.equal(findOperation(spec, `${HOST}/nothing/here`), null);
});

test('access: a token only in the query, and what to strip', () => {
    const fetchOp = findOperation(spec, `${HOST}/api/fetch`).operation;
    const access = authOf(spec, fetchOp);
    assert.equal(access.required, true);
    assert.equal(access.queryName, 'token');
    assert.equal('bearer' in access, false);
    assert.deepEqual([...access.strip].sort(), ['sig', 'token']);
    assert.equal(authOf(spec, findOperation(spec, `${HOST}/healthz`).operation).required, false);
});

test('the search address comes from the parameters, not from the app', () => {
    const built = buildTemplate(spec, findOperation(spec, `${HOST}/api/fetch`), HOST);
    const url = new URL(built.template);
    assert.equal(url.origin, HOST);
    assert.equal(url.pathname, '/api/fetch');
    assert.equal(url.searchParams.get('q'), '$s');
    assert.equal(url.searchParams.get('first'), '1');
    assert.equal(url.searchParams.get('token'), '$token');
    assert.equal(url.searchParams.has('force'), false);
    assert.deepEqual(built.optional.map((o) => o.name).sort(), ['force', 'format', 'song']);
    assert.deepEqual(built.optional.find((o) => o.name === 'format').values, ['gp', 'mpak']);
});

test('a source is suggested with the service name and token need', () => {
    const found = suggestSource(spec, `${HOST}/openapi.json`);
    assert.equal(found.name, 'Guitar Pro sync service');
    assert.equal(found.needsToken, true);
    assert.match(found.template, /^http:\/\/svc\.test:8080\/api\/fetch\?/);
    assert.match(suggestSource({ openapi: '3.1.0', paths: { '/a': { get: {} } } }, `${HOST}/o`).error, /does not describe/);
});

test('discovery follows the Link header from a host, or reads a pasted description', async () => {
    clearSpecCache();
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/openapi.json')) return reply(text);
        return reply('<html></html>', { link: '</openapi.json>; rel="service-desc"' });
    };
    let found = await discoverFromAddress('svc.test:8080', fetchImpl);
    assert.equal(found.specUrl, 'https://svc.test:8080/openapi.json');
    assert.deepEqual(calls, ['https://svc.test:8080/', 'https://svc.test:8080/openapi.json']);
    clearSpecCache();
    found = await discoverFromAddress(`${HOST}/openapi.json`, async () => reply(text));
    assert.equal(found.spec.info.title, 'Guitar Pro sync service');
    await assert.rejects(discoverFromAddress(HOST, async () => reply('<html></html>')), /not JSON/);
    await assert.rejects(discoverFromAddress(HOST, async () => reply('', { ok: false, status: 502 })), /answered 502/);
});

test('a link to another origin is not followed, and a description is cached', async () => {
    clearSpecCache();
    await assert.rejects(discoverFromAddress(HOST, async () => reply('<html></html>', { link: '<http://evil.test/openapi.json>; rel="service-desc"' })), /not JSON/);
    let n = 0;
    const fetchImpl = async () => { n++; return reply(text); };
    await loadSpec(`${HOST}/openapi.json`, fetchImpl);
    await loadSpec(`${HOST}/openapi.json`, fetchImpl);
    assert.equal(n, 1);
});
