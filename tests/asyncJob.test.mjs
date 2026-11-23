// Run with: node --test tests/asyncJob.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPointer, fractionOf, interpretJob, rebaseUrl, withToken, stripParams, runJob } from '../src/urlImport/asyncJob.js';
import { parseSpec, findOperation, asyncMapping } from '../src/urlImport/openApiDiscovery.js';

const spec = parseSpec(readFileSync(new URL('./jobService.openapi.json', import.meta.url), 'utf8'));
const { mapping } = asyncMapping(findOperation(spec, 'http://svc.test:8080/api/fetch').operation);
const ORIGIN = 'http://svc.test:8080';

test('JSON pointers', () => {
    const doc = { a: { 'b/c': [10, 20], 'd~e': 1 }, '': 7 };
    assert.equal(readPointer(doc, '/a/b~1c/1'), 20);
    assert.equal(readPointer(doc, '/a/d~0e'), 1);
    assert.equal(readPointer(doc, '/a/missing/x'), undefined);
    assert.equal(readPointer(doc, 'a'), undefined);
});

test('the bar value from step and percent', () => {
    assert.equal(fractionOf({ step: 3, steps: 6, percent: 50 }), 2.5 / 6);
    assert.equal(fractionOf({ step: 1, steps: 4 }), 0);
    assert.equal(fractionOf({ percent: 40 }), 0.4);
    assert.equal(fractionOf({ percent: 250 }), 1);
    assert.equal(fractionOf({}), null);
});

test('a job body is read through the service mapping', () => {
    const running = { status: 'running', status_url: '/api/job?id=1', progress: { step: 2, steps: 4, name: 'Audio', percent: null } };
    const read = interpretJob(running, mapping);
    assert.equal(read.state, 'running');
    assert.equal(read.fraction, 0.25);
    assert.equal(read.label, 'Audio');
    assert.equal(interpretJob({ status: 'queued' }, mapping).state, 'pending');
    assert.equal(interpretJob({ status: 'done', file_url: '/f' }, mapping).resultUrl, '/f');
    assert.equal(interpretJob({ status: 'weird' }, mapping).state, 'unknown');
    const other = { ...mapping, state: '/phase', statusUrl: '/links/poll', states: { ...mapping.states, running: ['busy'] } };
    assert.equal(interpretJob({ phase: 'busy', links: { poll: '/p' } }, other).state, 'running');
    assert.equal(interpretJob({ phase: 'busy', links: { poll: '/p' } }, other).statusUrl, '/p');
});

test('addresses stay on the entered origin', () => {
    assert.equal(rebaseUrl('/api/job?id=1', ORIGIN), `${ORIGIN}/api/job?id=1`);
    assert.equal(rebaseUrl('http://internal:9/api/job?id=1&sig=x', ORIGIN), `${ORIGIN}/api/job?id=1&sig=x`);
    assert.equal(rebaseUrl(`${ORIGIN}/a`, ORIGIN), `${ORIGIN}/a`);
});

test('the token goes in the query only, and never into a stored address', () => {
    assert.equal(withToken(`${ORIGIN}/a?id=1`, { token: 't k', queryName: 'token' }), `${ORIGIN}/a?id=1&token=t+k`);
    assert.equal(withToken(`${ORIGIN}/a?token=own`, { token: 'x', queryName: 'token' }), `${ORIGIN}/a?token=own`);
    assert.equal(withToken(`${ORIGIN}/a`, null), `${ORIGIN}/a`);
    assert.equal(withToken(`${ORIGIN}/a`, { token: 'x', queryName: null }), `${ORIGIN}/a`, 'no header fallback');
    assert.equal(stripParams(`${ORIGIN}/a?q=1&token=secret&sig=z`, ['token', 'sig']), `${ORIGIN}/a?q=1`);
});

const body = (status, extra = {}) => ({ id: 'j1', status, status_url: `${ORIGIN}/api/job?id=j1`, ...extra });
const answer = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
const noSleep = async () => {};

test('a job is followed from queued to done, with progress reported', async () => {
    const replies = [
        body('queued'),
        body('running', { progress: { step: 1, steps: 2, name: 'Tab', percent: 50 } }),
        body('running', { progress: { step: 2, steps: 2, name: 'Audio', percent: null } }),
        body('done', { file_url: '/api/job/file?id=j1&sig=abc' })
    ];
    const urls = [];
    const updates = [];
    const result = await runJob({
        first: replies.shift(), mapping, origin: ORIGIN, auth: { token: 'tok', queryName: 'token' }, sleep: noSleep,
        fetchJson: async (url) => { urls.push(url); return answer(replies.shift()); },
        onProgress: (u) => updates.push(u)
    });
    assert.equal(result.resultUrl, `${ORIGIN}/api/job/file?id=j1&sig=abc`);
    assert.deepEqual(urls, Array(3).fill(`${ORIGIN}/api/job?id=j1&token=tok`));
    assert.deepEqual(updates.map((u) => u.state), ['pending', 'running', 'running']);
    assert.deepEqual(updates.map((u) => u.fraction), [null, 0.25, 0.5]);
    assert.equal(updates[1].label, 'Tab');
});

test('a failed job throws the service error', async () => {
    await assert.rejects(runJob({ first: body('failed', { error: 'No audio found' }), mapping, origin: ORIGIN, fetchJson: async () => answer({}), sleep: noSleep }), /No audio found/);
    await assert.rejects(runJob({ first: body('failed'), mapping, origin: ORIGIN, fetchJson: async () => answer({}), sleep: noSleep }), /could not make that file/);
    await assert.rejects(runJob({ first: body('mystery'), mapping, origin: ORIGIN, fetchJson: async () => answer({}), sleep: noSleep }), /does not know/);
});

test('polling survives a hiccup but not repeated failures, a refused token or a lost job', async () => {
    let n = 0;
    const flaky = async () => { n++; if (n === 1) throw new Error('net'); return answer(body('done', { file_url: '/f' })); };
    assert.equal((await runJob({ first: body('queued'), mapping, origin: ORIGIN, fetchJson: flaky, sleep: noSleep })).resultUrl, `${ORIGIN}/f`);
    await assert.rejects(runJob({ first: body('queued'), mapping, origin: ORIGIN, fetchJson: async () => answer({}, 500), sleep: noSleep }), /Lost contact/);
    await assert.rejects(runJob({ first: body('queued'), mapping, origin: ORIGIN, fetchJson: async () => answer({}, 401), sleep: noSleep }), /refused the access token/);
    await assert.rejects(runJob({ first: body('queued'), mapping, origin: ORIGIN, fetchJson: async () => answer({}, 404), sleep: noSleep }), /no longer has that job/);
});

test('cancelling stops the wait', async () => {
    const controller = new AbortController();
    const sleep = async () => { controller.abort(); throw new Error('Cancelled.'); };
    await assert.rejects(runJob({ first: body('queued'), mapping, origin: ORIGIN, fetchJson: async () => answer({}), sleep, signal: controller.signal }), /Cancelled/);
});
