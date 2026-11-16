import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoSyncController } from '../src/autoSync.js';
import { ConflictError } from '../src/storage/contract.js';
import { StoreTooNewError } from '../src/storage/storeInfo.js';

function makeDeps(overrides = {}) {
    const calls = {
        plan: 0,
        apply: 0,
        writeInfo: 0,
        remembered: [],
        pulled: [],
        states: [],
    };
    const store = { location: 'bucket/lib', open: async () => {} };
    const deps = {
        isEnabled: () => true,
        getTarget: () => 's3',
        openStore: async () => ({ status: 'ready', legacy: {}, store }),
        probeLocation: async () => ({ state: 'current' }),
        needsUpgrade: () => false,
        writeStoreInfo: async () => { calls.writeInfo++; },
        createLocalAdapter: () => ({}),
        baselines: {},
        locationOf: (t, s) => `${t}|${s.location}`,
        isHybrid: () => false,
        planPackSync: async () => {
            calls.plan++;
            return { items: [], unchanged: 10, firstSync: false };
        },
        applyPackSync: async () => {
            calls.apply++;
            return { downloaded: 0, uploaded: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 };
        },
        appVersion: async () => '1.0.0',
        onRememberLocation: (loc) => calls.remembered.push(loc),
        onPulledChanges: (res) => calls.pulled.push(res),
        onStateChange: (s) => calls.states.push({ ...s }),
        isOnline: () => true,
        isBusy: () => false,
        now: () => 100000,
        ConflictErrorClass: ConflictError,
        StoreTooNewErrorClass: StoreTooNewError,
        ...overrides,
    };
    return { deps, calls, store };
}

test('skips when auto-sync is disabled', async () => {
    const { deps, calls } = makeDeps({ isEnabled: () => false });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'disabled');
    assert.equal(calls.plan, 0);
});

test('pauses with needs-setup when no target is configured', async () => {
    const { deps } = makeDeps({ getTarget: () => null });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'paused');
    assert.equal(res.reason, 'needs-setup');
    assert.equal(ctrl.getState().status, 'paused');
});

test('pauses with offline when navigator is offline', async () => {
    const { deps, calls } = makeDeps({ isOnline: () => false });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'paused');
    assert.equal(res.reason, 'offline');
    assert.equal(calls.plan, 0);
});

test('pauses without prompting when backend needs auth or permission', async () => {
    const { deps, calls } = makeDeps({
        openStore: async () => ({ status: 'needs-auth' }),
    });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'paused');
    assert.equal(res.reason, 'needs-auth');
    assert.equal(calls.plan, 0);
});

test('pauses when store needs upgrade or is too new', async () => {
    const { deps } = makeDeps({ needsUpgrade: () => true });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'paused');
    assert.equal(res.reason, 'needs-upgrade');

    const { deps: depsNew } = makeDeps({
        planPackSync: async () => { throw new StoreTooNewError('2.0.0', '1.0.0'); },
    });
    const ctrlNew = createAutoSyncController(depsNew);
    const resNew = await ctrlNew.run();
    assert.equal(resNew.status, 'paused');
    assert.equal(resNew.reason, 'store-too-new');
});

test('aborts and pauses with needs-review on mass removal plan', async () => {
    const { deps, calls } = makeDeps({
        planPackSync: async () => {
            calls.plan++;
            return {
                unchanged: 2,
                items: Array.from({ length: 6 }, (_, i) => ({ action: 'delete-local', name: `Song ${i}` })),
            };
        },
    });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'paused');
    assert.equal(res.reason, 'needs-review');
    assert.equal(calls.apply, 0);
    assert.equal(ctrl.getState().detail, '6 of 8');
});

test('initializes empty store, applies sync, and notifies on pulled changes', async () => {
    let openedCreate = false;
    const store = {
        location: 'bucket/lib',
        open: async (opts) => { if (opts?.create) openedCreate = true; },
    };
    const { deps, calls } = makeDeps({
        openStore: async () => ({ status: 'ready', legacy: {}, store }),
        probeLocation: async () => ({ state: 'none' }),
        applyPackSync: async () => {
            calls.apply++;
            return { downloaded: 2, uploaded: 0, merged: 0, deletedLocal: 0, deletedRemote: 0 };
        },
    });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'ok');
    assert.equal(openedCreate, true);
    assert.equal(calls.writeInfo, 1);
    assert.deepEqual(calls.remembered, ['s3|bucket/lib']);
    assert.equal(calls.pulled.length, 1);
    assert.equal(ctrl.getState().status, 'idle');
});

test('retries once on ConflictError', async () => {
    const { deps, calls } = makeDeps({
        applyPackSync: async () => {
            calls.apply++;
            if (calls.apply === 1) throw new ConflictError('stale');
            return { downloaded: 0, uploaded: 1, merged: 0, deletedLocal: 0, deletedRemote: 0 };
        },
    });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run();
    assert.equal(res.status, 'ok');
    assert.equal(calls.plan, 2);
    assert.equal(calls.apply, 2);
});

test('defers when busy and respects visibility cooldown', async () => {
    let clock = 100000;
    let busy = true;
    const { deps, calls } = makeDeps({
        isBusy: () => busy,
        now: () => clock,
        visibilityCooldownMs: 60000,
    });
    const ctrl = createAutoSyncController(deps);
    const deferred = await ctrl.run({ reason: 'auto' });
    assert.equal(deferred.status, 'deferred');
    assert.equal(calls.plan, 0);

    busy = false;
    const first = await ctrl.run({ reason: 'visibility' });
    assert.equal(first.status, 'ok');
    assert.equal(calls.plan, 1);

    clock += 10000;
    const cooled = await ctrl.run({ reason: 'visibility' });
    assert.equal(cooled.status, 'skipped');
    assert.equal(cooled.reason, 'cooldown');
    assert.equal(calls.plan, 1);
});

test('markDirty debounces multiple edits into one sync', async () => {
    let scheduledFn = null;
    let cleared = 0;
    let nextId = 1;
    const { deps, calls } = makeDeps({
        setTimeoutFn: (fn) => { scheduledFn = fn; return nextId++; },
        clearTimeoutFn: () => { cleared++; },
    });
    const ctrl = createAutoSyncController(deps);
    ctrl.markDirty();
    ctrl.markDirty();
    ctrl.markDirty();
    assert.equal(cleared, 2);
    assert.equal(calls.plan, 0);
    await scheduledFn();
    assert.equal(calls.plan, 1);
});

test('forwards applyPackSync progress into state and clears on idle', async () => {
    const snapshots = [];
    const { deps } = makeDeps({
        onStateChange: (s) => snapshots.push({ status: s.status, progress: s.progress }),
        applyPackSync: async ({ onProgress }) => {
            onProgress?.({ current: 1, total: 3 });
            onProgress?.({ current: 2, total: 3 });
            return { downloaded: 0, merged: 0, deletedLocal: 0 };
        },
    });
    const ctrl = createAutoSyncController(deps);
    const res = await ctrl.run({ force: true });
    assert.equal(res.status, 'ok');
    assert.deepEqual(snapshots, [
        { status: 'syncing', progress: null },
        { status: 'syncing', progress: { current: 1, total: 3 } },
        { status: 'syncing', progress: { current: 2, total: 3 } },
        { status: 'idle', progress: null },
    ]);
});
