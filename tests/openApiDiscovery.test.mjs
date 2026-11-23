// Run with: node --test tests/openApiDiscovery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    serviceDescLink, searchDescLink, choicesOf, readChoices, choiceAddress, linkAddress, parseOpenSearch, parseSpec, resolveRef, loadSpec, clearSpecCache, asyncMapping, findOperation, authOf,
    buildTemplate, suggestSource, discoverFromAddress
} from '../src/urlImport/openApiDiscovery.js';

const text = readFileSync(new URL('./jobService.openapi.json', import.meta.url), 'utf8');
const spec = parseSpec(text);
const HOST = 'http://svc.test:8080';

const reply = (body, { ok = true, status = 200, link = '' } = {}) => ({
    ok, status, text: async () => body, headers: { get: (name) => (name.toLowerCase() === 'link' ? link : null) }
});

test('the Link header names the description', () => {
    assert.equal(serviceDescLink('</openapi.json>; rel="service-desc"; type="application/json"', `${HOST}/api/get?q=x`), `${HOST}/openapi.json`);
    assert.equal(serviceDescLink('<https://x.test/a>; rel="next", </spec>; rel="service-desc"', `${HOST}/`), `${HOST}/spec`);
    assert.equal(serviceDescLink('</a>; rel="next"', `${HOST}/`), '');
    assert.equal(serviceDescLink(null, `${HOST}/`), '');
    const both = '</openapi.json>; rel="service-desc", </opensearch.xml>; rel="search"; type="application/opensearchdescription+xml"';
    assert.equal(searchDescLink(both, `${HOST}/api/get`), `${HOST}/opensearch.xml`);
    assert.equal(serviceDescLink(both, `${HOST}/api/get`), `${HOST}/openapi.json`);
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
    const found = findOperation(spec, `${HOST}/api/get?q=x&first=1`);
    assert.equal(found.path, '/api/get');
    const { mapping, error } = asyncMapping(found.operation);
    assert.equal(error, undefined);
    assert.equal(mapping.statusLink, 'status');
    assert.equal(mapping.resultLink, 'file');
    assert.deepEqual(mapping.states.done, ['done']);
    assert.equal(mapping.progress.percent, '/progress/percent');
});

test('the standard links of the job response give the status and file addresses', () => {
    const found = findOperation(spec, `${HOST}/api/get?q=x`);
    const body = { id: 'j 1', status: 'queued' };
    assert.equal(linkAddress(spec, found, 'status', body, HOST), `${HOST}/api/job?id=j%201`);
    assert.equal(linkAddress(spec, found, 'file', body, HOST), `${HOST}/api/job/file?id=j%201`);
    assert.equal(linkAddress(spec, found, 'status', {}, HOST), '', 'the body lacks the id');
    assert.equal(linkAddress(spec, found, 'nope', body, HOST), '');
    const behind = findOperation(spec, `${HOST}/proxy/gp/api/get?q=x`);
    assert.equal(linkAddress(spec, behind, 'status', body, HOST), `${HOST}/proxy/gp/api/job?id=j%201`);
    const other = JSON.parse(text);
    other.components.links.JobStatus.parameters.id = '$request.query.q';
    assert.equal(linkAddress(other, findOperation(other, `${HOST}/api/get`), 'status', body, HOST), '', 'only a response body expression is understood');
});

test('a 409 that lists matches says how to read and answer them', () => {
    const found = findOperation(spec, `${HOST}/api/get?q=bourree+bach`);
    const choices = choicesOf(spec, found.operation, 409);
    assert.deepEqual([choices.items, choices.label, choices.detail, choices.value, choices.parameter, choices.replaces], ['/matches', '/title', '/artist', '/song', 'song', 'q']);
    assert.equal(choicesOf(spec, found.operation, 400), null);
    const body = { query: 'bourree bach', matches: [{ song: '320', artist: 'Bach', title: 'Bourree' }, { song: 321, artist: '', title: 'Bourree (live)' }, { artist: 'x' }] };
    assert.deepEqual(readChoices(body, choices), [{ label: 'Bourree', detail: 'Bach', value: '320' }, { label: 'Bourree (live)', detail: '', value: '321' }]);
    assert.deepEqual(readChoices({}, choices), []);
    assert.equal(choiceAddress(`${HOST}/api/get?q=bourree+bach&format=all&token=t`, choices, '320'), `${HOST}/api/get?format=all&token=t&song=320`);
    const broken = JSON.parse(text);
    delete broken.paths['/api/get'].get.responses['409']['x-choices'].value;
    assert.equal(choicesOf(broken, findOperation(broken, `${HOST}/api/get`).operation, 409), null);
});

test('an incomplete mapping says what is missing', () => {
    assert.match(asyncMapping({ 'x-async-job': { state: '/s', states: {}, resultLink: 'file' } }).error, /statusLink/);
    assert.match(asyncMapping({ 'x-async-job': { statusLink: 'status', state: '/s', states: {} } }).error, /resultLink/);
    assert.match(asyncMapping({ 'x-async-job': { statusLink: 's', resultLink: 'f', state: 's', states: {} } }).error, /"state"/);
    assert.match(asyncMapping({ 'x-async-job': { statusLink: 's', resultLink: 'f', state: '/s', states: { pending: [], running: [], done: ['d'] } } }).error, /failed/);
    assert.match(asyncMapping({}).error, /does not describe a job/);
});

test('an address behind a path prefix still matches', () => {
    assert.equal(findOperation(spec, `${HOST}/proxy/gp/api/get?q=x`).prefix, '/proxy/gp');
    assert.equal(findOperation(spec, `${HOST}/nothing/here`), null);
});

test('access: a token only in the query, and what to strip', () => {
    const fetchOp = findOperation(spec, `${HOST}/api/get`).operation;
    const access = authOf(spec, fetchOp);
    assert.equal(access.required, true);
    assert.equal(access.queryName, 'token');
    assert.equal('bearer' in access, false);
    assert.deepEqual([...access.strip].sort(), ['sig', 'token']);
    assert.equal(authOf(spec, findOperation(spec, `${HOST}/healthz`).operation).required, false);
});

const SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Guitar Pro sync</ShortName>
  <Url type="text/html" method="get" template="${HOST}/get?q={searchTerms}"/>
  <Url type="application/json" method="get" template="${HOST}/api/get?q={searchTerms}&amp;first=1"/>
</OpenSearchDescription>`;

test('the OpenSearch description lists a page address and an API address', () => {
    assert.deepEqual(parseOpenSearch(SEARCH_XML), [
        { type: 'text/html', template: `${HOST}/get?q={searchTerms}` },
        { type: 'application/json', template: `${HOST}/api/get?q={searchTerms}&first=1` }
    ]);
    assert.deepEqual(parseOpenSearch('<Url type="x" method="post" template="a"/>'), []);
    assert.throws(() => parseOpenSearch(' '.repeat(600 * 1024)), /too large/);
});

test('the search address comes from the service, with the token slot added', () => {
    const [, api] = parseOpenSearch(SEARCH_XML);
    const built = buildTemplate(spec, findOperation(spec, `${HOST}/api/get`), api.template);
    const url = new URL(built.template.replace('$s', 'S').replace('$token', 'T'));
    assert.equal(url.origin, HOST);
    assert.equal(url.pathname, '/api/get');
    assert.equal(built.template, `${HOST}/api/get?q=$s&first=1&token=$token`);
    assert.deepEqual(built.optional.map((o) => o.name).sort(), ['force', 'format', 'song']);
    assert.deepEqual(built.optional.find((o) => o.name === 'format').values, ['gp', 'mpak', 'band', 'all']);
    assert.equal(buildTemplate(spec, findOperation(spec, `${HOST}/api/get`), `${HOST}/api/get?q=x`), null);
});

test('a source is suggested with the service name and token need', () => {
    const searchUrls = parseOpenSearch(SEARCH_XML);
    const found = suggestSource(spec, `${HOST}/openapi.json`, searchUrls);
    assert.equal(found.name, 'Guitar Pro sync service');
    assert.equal(found.needsToken, true);
    assert.equal(found.template, `${HOST}/api/get?q=$s&first=1&token=$token`);
    const moved = suggestSource(spec, `${HOST}/openapi.json`, [{ type: 'application/json', template: 'http://internal:9/api/get?q={searchTerms}&first=1' }]);
    assert.equal(moved.template, `${HOST}/api/get?q=$s&first=1&token=$token`, 'an address on another host stays on the entered origin');
    assert.match(suggestSource(spec, `${HOST}/openapi.json`, []).error, /OpenSearch/);
    assert.match(suggestSource(spec, `${HOST}/openapi.json`, [{ type: 'text/html', template: `${HOST}/get?q={searchTerms}` }]).error, /OpenSearch/);
    assert.match(suggestSource(spec, `${HOST}/o`, [{ type: 'application/json', template: `${HOST}/nothing?q={searchTerms}` }]).error, /does not describe a way/);
});

test('discovery follows the Link header from a host, or reads a pasted description', async () => {
    clearSpecCache();
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/openapi.json')) return reply(text);
        if (url.endsWith('/opensearch.xml')) return reply(SEARCH_XML.replaceAll(HOST, 'https://svc.test:8080'));
        return reply('<html></html>', { link: '</openapi.json>; rel="service-desc", </opensearch.xml>; rel="search"' });
    };
    let found = await discoverFromAddress('svc.test:8080', fetchImpl);
    assert.equal(found.specUrl, 'https://svc.test:8080/openapi.json');
    assert.deepEqual(calls, ['https://svc.test:8080/', 'https://svc.test:8080/openapi.json', 'https://svc.test:8080/opensearch.xml']);
    assert.equal(found.searchUrls.length, 2);
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
