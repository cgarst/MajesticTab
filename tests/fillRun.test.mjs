// Run with: node --test tests/fillRun.test.mjs
// The automated lane of Fill in missing tabs: the run over the songs, and the per-song fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { createFillRun } = await import('../src/bulkFill/fillRun.js');
const { fetchTabForSong, confidentChoice } = await import('../src/bulkFill/fetchForSong.js');

const song = (id, title, artist = 'Band') => ({ id, title, artist });
const file = (name) => ({ name });
const SRC = (id) => ({ id, name: id, urlTemplate: `https://${id}.test/api/get?q=$s`, kind: 'api' });

test('each song is fetched and added, one at a time', async () => {
    const order = [];
    let busy = false;
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        fetchOne: async (s) => { assert.equal(busy, false); busy = true; order.push(s.id); await 0; busy = false; return { kind: 'file', file: file(`${s.title}.gp5`) }; },
        attach: async () => true
    });
    await run.start();
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(run.counts(), { queued: 0, searching: 0, added: 2, pick: 0, missing: 0, failed: 0 });
});

test('a source with nothing hands the song to the next one; none left is missing', async () => {
    const asked = [];
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1'), SRC('s2')],
        fetchOne: async (s, source) => { asked.push(`${s.id}:${source.id}`); return source.id === 's2' && s.id === 'a' ? { kind: 'file', file: file('x.gp5') } : { kind: 'missing' }; },
        attach: async () => true
    });
    await run.start();
    assert.deepEqual(asked, ['a:s1', 'a:s2', 'b:s1', 'b:s2']);
    assert.equal(run.items.get('a').state, 'added');
    assert.equal(run.items.get('b').state, 'missing');
});

test('several matches park the song and the run goes on', async () => {
    const choose = { options: [{ label: 'Two', detail: 'Other', value: '1' }], addressFor: (v) => `addr:${v}` };
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        fetchOne: async (s, source, o) => (s.id === 'a' && !o.address ? { kind: 'choose', choose } : { kind: 'file', file: file('x.gp5') }),
        attach: async () => true
    });
    await run.start();
    assert.equal(run.items.get('a').state, 'pick');
    assert.equal(run.items.get('b').state, 'added');
    await run.resolvePick('a', '1');
    assert.equal(run.items.get('a').state, 'added');
});

test('an error that ends the run stops it; an ordinary error fails only that song', async () => {
    const fatal = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        fetchOne: async () => { throw Object.assign(new Error('Lost contact with the service.'), { fatal: true }); },
        attach: async () => true
    });
    await fatal.start();
    assert.equal(fatal.run.error, 'Lost contact with the service.');
    assert.deepEqual(['a', 'b'].map((id) => fatal.items.get(id).state), ['queued', 'queued']);

    const ordinary = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        fetchOne: async (s) => { if (s.id === 'a') throw new Error('The service answered 500.'); return { kind: 'file', file: file('x.gp5') }; },
        attach: async () => true
    });
    await ordinary.start();
    assert.equal(ordinary.items.get('a').state, 'failed');
    assert.equal(ordinary.items.get('a').message, 'The service answered 500.');
    assert.equal(ordinary.items.get('b').state, 'added');
});

test('stopping leaves the rest queued, and a new start continues with them', async () => {
    let run;
    run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two'), song('c', 'Three')],
        sources: [SRC('s1')],
        fetchOne: async (s) => { if (s.id === 'a') run.stop(); return { kind: 'file', file: file('x.gp5') }; },
        attach: async () => true
    });
    await run.start();
    assert.equal(run.run.stopped, true);
    assert.equal(run.items.get('b').state, 'queued');
    run.items.get('a').state = 'added';
    await run.start();
    assert.deepEqual(['b', 'c'].map((id) => run.items.get(id).state), ['added', 'added']);
});

test('a song an earlier run found nothing for is skipped until requeued', async () => {
    const asked = [];
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        remembered: new Set(['a']),
        fetchOne: async (s) => { asked.push(s.id); return { kind: 'file', file: file('x.gp5') }; },
        attach: async () => true
    });
    await run.start();
    assert.deepEqual(asked, ['b']);
    run.requeue('a');
    await run.start();
    assert.deepEqual(asked, ['b', 'a']);
});

test('a file the library refuses fails the song instead of counting it added', async () => {
    const run = createFillRun({ songs: [song('a', 'One')], sources: [SRC('s1')], fetchOne: async () => ({ kind: 'file', file: file('x.gp5') }), attach: async () => false });
    await run.start();
    assert.equal(run.items.get('a').state, 'failed');
});

test('only the one option that is plainly the song is chosen without asking', () => {
    const options = [{ label: 'Pull Me Under', detail: 'Dream Theater', value: '1' }, { label: 'Pull Me Under (live)', detail: 'Dream Theater', value: '2' }];
    assert.equal(confidentChoice(options, song('a', 'Pull Me Under', 'Dream Theater'))?.value, '1');
    assert.equal(confidentChoice(options, song('a', 'Pull Me Under', 'Other Band')), null);
    assert.equal(confidentChoice([options[0], { ...options[0], value: '3' }], song('a', 'Pull Me Under', 'Dream Theater')), null);
});

test('fetchTabForSong: file, job, choice, missing and a failure that ends the run', async () => {
    const s = song('a', 'Pull Me Under', 'Dream Theater');
    const src = SRC('s1');
    const follow = async () => file('job.gp5');
    const ask = (probed) => fetchTabForSong(s, src, { probe: async () => probed, follow });
    assert.equal((await ask({ file: file('f.gp5') })).kind, 'file');
    const viaJob = await ask({ job: { strip: [] } });
    assert.deepEqual([viaJob.kind, viaJob.file.name], ['file', 'job.gp5']);
    assert.equal((await ask(null)).kind, 'missing');
    const lone = { choose: { options: [{ label: 'Pull Me Under', detail: 'Dream Theater', value: 'x' }], addressFor: () => 'https://s1.test/api/get?id=x' } };
    let calls = 0;
    const picked = await fetchTabForSong(s, src, { probe: async () => (calls++ === 0 ? lone : { file: file('p.gp5') }), follow });
    assert.deepEqual([picked.kind, calls], ['file', 2]);
    const unsure = { choose: { options: [{ label: 'Other', detail: 'Dream Theater', value: 'y' }], addressFor: () => 'x' } };
    assert.equal((await ask(unsure)).kind, 'choose');
    const notFound = await fetchTabForSong(s, src, { probe: async () => { throw Object.assign(new Error('no'), { status: 404 }); }, follow });
    assert.equal(notFound.kind, 'missing');
    await assert.rejects(fetchTabForSong(s, src, { probe: async () => { throw Object.assign(new Error('token'), { fatal: true }); }, follow }), { fatal: true });
});

test('the run shows as running, in one change, before it waits on anything', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let changes = 0;
    const songs = Array.from({ length: 500 }, (_, i) => song(`s${i}`, `Song ${i}`));
    const run = createFillRun({
        songs, sources: [SRC('s1')],
        around: async (work) => { await gate; await work(); },
        fetchOne: async () => ({ kind: 'missing' }), attach: async () => true,
        onChange: () => { changes++; }
    });
    const done = run.start();
    assert.equal(run.run.running, true);
    assert.equal(changes, 1, 'one announcement for the whole list, not one per song');
    run.stop();
    assert.equal(run.run.stopping, true);
    release();
    await done;
    assert.equal(run.run.running, false);
    assert.equal(run.run.stopping, false);
});

test('a link the walkthrough is waiting for is taken, and nothing is claimed when it is not waiting', async () => {
    const { setGuideTarget, claimUrlForGuide, claimForGuide } = await import('../src/bulkFill/guideTarget.js');
    assert.equal(await claimUrlForGuide('https://svc.test/tab.gp5'), false);
    const got = [];
    setGuideTarget({ accept: async () => true, acceptUrl: async (a) => { got.push(a); } });
    assert.equal(await claimUrlForGuide('https://svc.test/tab.gp5'), true);
    assert.deepEqual(got, ['https://svc.test/tab.gp5']);
    assert.equal(await claimForGuide({ name: 'x.gp5' }), true);
    setGuideTarget(null);
    assert.equal(await claimUrlForGuide('https://svc.test/tab.gp5'), false);
});

test('a song joins the queue while a run goes, and `concurrency` many are asked for at once', async () => {
    let live = 0; let peak = 0;
    const gates = [];
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two'), song('c', 'Three')],
        sources: [SRC('s1')],
        concurrency: 2,
        fetchOne: async (s) => { live++; peak = Math.max(peak, live); await new Promise((r) => gates.push(r)); live--; return { kind: 'file', file: file(`${s.title}.gp5`) }; },
        attach: async () => true
    });
    const done = run.start();
    await 0; await 0;
    assert.equal(live, 2);
    run.enqueue(song('d', 'Four'));
    assert.equal(run.items.get('d').state, 'queued');
    while (run.run.running) { gates.splice(0).forEach((r) => r()); await new Promise((r) => setTimeout(r, 0)); }
    await done;
    assert.equal(peak, 2);
    assert.equal(run.counts().added, 4);
});

test('enqueue with no run going runs just that song, with its own providers', async () => {
    const asked = [];
    const run = createFillRun({
        songs: [song('a', 'One'), song('b', 'Two')],
        sources: [SRC('s1')],
        fetchOne: async (s, source) => { asked.push(`${s.id}:${source.id}`); return { kind: 'file', file: file('x.gp5') }; },
        attach: async () => true
    });
    await run.enqueue(song('b', 'Two'), [SRC('s2')]);
    assert.deepEqual(asked, ['b:s2']);
    assert.equal(run.items.get('a').state, 'queued');
    assert.equal(run.items.get('b').state, 'added');
});
