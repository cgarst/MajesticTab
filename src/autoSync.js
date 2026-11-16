// autoSync.js
// Background two-way data sync scheduler and single-flight coordinator.
// Reuses the packSync pipeline (planPackSync / applyPackSync) non-interactively and pauses quietly
// whenever user action is required (auth, folder permission, upgrade, or unusual mass removals).
import { StoreTooNewError } from './storage/storeInfo.js';
import { ConflictError } from './storage/contract.js';

export const AUTO_SYNC_KEY = 'majestictab_auto_sync';
export const DATA_CHANGED_EVENT = 'majestictab:data-changed';
export const STATE_CHANGED_EVENT = 'autoSyncStateChanged';

const MASS_REMOVAL_SHARE = 0.5;
const MASS_REMOVAL_MIN = 5;

function isMassRemovalPlan(plan) {
    const removals = (plan?.items || []).filter((c) => c.action === 'delete-local' || c.action === 'delete-remote').length;
    const total = (plan?.items?.length || 0) + (plan?.unchanged || 0);
    return {
        removals,
        total,
        unusual: removals >= MASS_REMOVAL_MIN && removals / Math.max(1, total) >= MASS_REMOVAL_SHARE,
    };
}

const STARTUP_DELAY_MS = 4000;
const DIRTY_DEBOUNCE_MS = 20000;
const VISIBILITY_COOLDOWN_MS = 120000;
const PERIODIC_INTERVAL_MS = 600000;

export function isAutoSyncEnabled() {
    try { return localStorage.getItem(AUTO_SYNC_KEY) === '1'; } catch (_) { return false; }
}

export function setAutoSyncEnabled(enabled) {
    try { localStorage.setItem(AUTO_SYNC_KEY, enabled ? '1' : '0'); } catch (_) {}
    if (!enabled && defaultController) defaultController.cancelPending();
}

/** Dispatches a lightweight signal when local library, tab, setlist, or sync-point data changes. */
export function notifyDataChanged() {
    try {
        if (typeof globalThis.window?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            globalThis.window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
        }
    } catch (_) {}
}

/**
 * Creates an auto-sync controller with injectable dependencies for unit testing.
 */
export function createAutoSyncController(deps) {
    const {
        isEnabled,
        getTarget: readTarget,
        openStore,
        probeLocation: probe,
        needsUpgrade: checkUpgrade,
        writeStoreInfo: writeInfo,
        createLocalAdapter: makeLocal,
        baselines,
        locationOf: locOf,
        isHybrid,
        planPackSync: planSync,
        applyPackSync: applySync,
        appVersion: readVersion,
        onRememberLocation,
        onPulledChanges,
        onStateChange,
        isOnline = () => true,
        isBusy = () => false,
        now = () => Date.now(),
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        dirtyDebounceMs = DIRTY_DEBOUNCE_MS,
        visibilityCooldownMs = VISIBILITY_COOLDOWN_MS,
        ConflictErrorClass = ConflictError,
        StoreTooNewErrorClass = StoreTooNewError,
    } = deps;

    let state = { status: 'idle', reason: null, detail: null, lastAttemptAt: 0 };
    let inFlight = null;
    let pending = false;
    let dirtyTimer = null;

    const setState = (next) => {
        state = { ...state, ...next };
        onStateChange?.(state);
    };

    const getState = () => ({ ...state });

    const cancelPending = () => {
        pending = false;
        if (dirtyTimer !== null) {
            clearTimeoutFn(dirtyTimer);
            dirtyTimer = null;
        }
        if (state.status !== 'syncing') {
            setState({ status: 'idle', reason: null, detail: null });
        }
    };

    const runWithLock = async (fn) => {
        if (inFlight) return inFlight;
        const p = (async () => {
            try { return await fn(); } finally { inFlight = null; }
        })();
        inFlight = p;
        return p;
    };

    const executeSync = async () => {
        const target = readTarget();
        if (!target) {
            setState({ status: 'paused', reason: 'needs-setup', detail: null });
            return { status: 'paused', reason: 'needs-setup' };
        }
        const lastAttemptAt = now();
        setState({ status: 'syncing', reason: null, detail: null, lastAttemptAt });

        try {
            const opened = await openStore(target);
            if (opened.status !== 'ready') {
                setState({ status: 'paused', reason: opened.status, detail: opened.folderName || null });
                return { status: 'paused', reason: opened.status };
            }
            const { legacy, store } = opened;
            const loc = locOf(target, store);

            const probed = await probe({ legacy, current: store });
            if (checkUpgrade(probed) || probed.partial) {
                setState({ status: 'paused', reason: 'needs-upgrade', detail: null });
                return { status: 'paused', reason: 'needs-upgrade' };
            }
            if (probed.state === 'none') {
                await store.open({ create: true });
                await writeInfo(store, { appVersion: await readVersion() });
            }

            const local = makeLocal();
            const hybrid = isHybrid();
            let plan = await planSync({ store, local, baselines, location: loc, hybrid });

            const mass = isMassRemovalPlan(plan);
            if (mass.unusual) {
                setState({ status: 'paused', reason: 'needs-review', detail: `${mass.removals} of ${mass.total}` });
                return { status: 'paused', reason: 'needs-review' };
            }

            let result;
            try {
                result = await applySync({ store, local, baselines, location: loc, hybrid, plan });
            } catch (err) {
                if (!(err instanceof ConflictErrorClass)) throw err;
                // Another device wrote while we were planning: re-plan once and retry.
                plan = await planSync({ store, local, baselines, location: loc, hybrid });
                const retryMass = isMassRemovalPlan(plan);
                if (retryMass.unusual) {
                    setState({ status: 'paused', reason: 'needs-review', detail: `${retryMass.removals} of ${retryMass.total}` });
                    return { status: 'paused', reason: 'needs-review' };
                }
                result = await applySync({ store, local, baselines, location: loc, hybrid, plan });
            }

            onRememberLocation?.(loc);
            setState({ status: 'idle', reason: null, detail: null });

            const pulled = (result?.downloaded || 0) + (result?.merged || 0) + (result?.deletedLocal || 0);
            if (pulled > 0 || result?.recordsChanged) {
                onPulledChanges?.(result);
            }
            return { status: 'ok', result };
        } catch (err) {
            if (err instanceof StoreTooNewErrorClass) {
                setState({ status: 'paused', reason: 'store-too-new', detail: null });
                return { status: 'paused', reason: 'store-too-new' };
            }
            setState({ status: 'error', reason: 'error', detail: err?.message || 'Sync failed' });
            return { status: 'error', error: err };
        }
    };

    const run = async ({ force = false, reason = 'auto' } = {}) => {
        if (!isEnabled()) return { status: 'skipped', reason: 'disabled' };
        if (inFlight) {
            pending = true;
            return inFlight;
        }
        if (!force && isBusy()) {
            pending = true;
            return { status: 'deferred', reason: 'busy' };
        }
        if (!isOnline()) {
            setState({ status: 'paused', reason: 'offline', detail: null });
            return { status: 'paused', reason: 'offline' };
        }
        if (!force && reason === 'visibility' && state.lastAttemptAt && (now() - state.lastAttemptAt) < visibilityCooldownMs) {
            return { status: 'skipped', reason: 'cooldown' };
        }

        pending = false;
        const res = await runWithLock(executeSync);
        if (pending && isEnabled() && state.status === 'idle') {
            pending = false;
            return run({ force: false, reason: 'pending' });
        }
        return res;
    };

    const markDirty = () => {
        if (!isEnabled()) return;
        if (dirtyTimer !== null) clearTimeoutFn(dirtyTimer);
        dirtyTimer = setTimeoutFn(() => {
            dirtyTimer = null;
            return run({ reason: 'dirty' });
        }, dirtyDebounceMs);
    };

    const clearPause = () => {
        if (state.status === 'paused' || state.status === 'error') {
            setState({ status: 'idle', reason: null, detail: null });
        }
    };

    return {
        run,
        markDirty,
        cancelPending,
        clearPause,
        getState,
        isRunning: () => Boolean(inFlight),
        runExclusive: runWithLock,
    };
}

let defaultController = null;
let initialized = false;

function isBrowserBusy() {
    try {
        if (document.getElementById('syncModal')?.style.display === 'block') return true;
        if (document.getElementById('audioSyncModal')?.style.display === 'block') return true;
        if (document.body?.classList.contains('is-playing')) return true;
    } catch (_) {}
    return false;
}

function getController() {
    if (defaultController) return defaultController;
    // Lazy-load browser-coupled storage/provider modules so autoSync.js stays Node-safe and light at startup.
    let cached = null;
    const load = () => (cached ??= Promise.all([
        import('./storage/packSync.js'),
        import('./storage/upgrade.js'),
        import('./storage/storeInfo.js'),
        import('./packSyncLocal.js'),
        import('./syncBackend.js'),
    ]).then(([packSync, upgrade, storeInfo, localMod, backend]) => ({
        packSync, upgrade, storeInfo, localMod, backend,
    })));
    const getTargetSync = () => {
        try { return localStorage.getItem('majestictab_preferred_storage') || ''; } catch (_) { return ''; }
    };
    defaultController = createAutoSyncController({
        isEnabled: isAutoSyncEnabled,
        getTarget: () => getTargetSync() || true,
        openStore: async () => {
            const { backend } = await load();
            const target = backend.getTarget();
            if (!target) return { status: 'needs-setup' };
            return backend.openSyncStore(target, { interactive: false });
        },
        probeLocation: async (args) => {
            const { upgrade } = await load();
            const probed = await upgrade.probeLocation(args);
            return { ...probed, _needsUpgrade: upgrade.needsUpgrade(probed) };
        },
        needsUpgrade: (p) => Boolean(p?._needsUpgrade),
        writeStoreInfo: async (s, info) => (await load()).storeInfo.writeStoreInfo(s, info),
        createLocalAdapter: () => null,
        baselines: { get: () => null, set: () => {}, clear: () => {} },
        locationOf: (t, s) => `${t}|${s.location}`,
        isHybrid: () => false,
        planPackSync: async ({ store, location }) => {
            const { packSync, localMod, backend } = await load();
            const target = backend.getTarget();
            const loc = backend.locationOf(target, store);
            return packSync.planPackSync({
                store,
                local: localMod.createLocalAdapter(),
                baselines: localMod.localBaselines,
                location: loc || location,
                hybrid: localMod.isHybridSyncEnabled(),
            });
        },
        applyPackSync: async ({ store, location }) => {
            const { packSync, localMod, backend } = await load();
            const target = backend.getTarget();
            const loc = backend.locationOf(target, store);
            const res = await packSync.applyPackSync({
                store,
                local: localMod.createLocalAdapter(),
                baselines: localMod.localBaselines,
                location: loc || location,
                hybrid: localMod.isHybridSyncEnabled(),
            });
            backend.rememberLocation(loc);
            return res;
        },
        appVersion: async () => (await load()).backend.appVersion(),
        onRememberLocation: () => {},
        isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
        isBusy: isBrowserBusy,
        onStateChange: (state) => {
            try {
                window.dispatchEvent(new CustomEvent(STATE_CHANGED_EVENT, { detail: state }));
            } catch (_) {}
        },
        onPulledChanges: () => {
            try {
                window.dispatchEvent(new CustomEvent('libraryDataChanged'));
                window.dispatchEvent(new CustomEvent('library:refresh'));
            } catch (_) {}
        },
    });
    return defaultController;
}

export function getAutoSyncState() {
    return getController().getState();
}

export function isSyncRunning() {
    return getController().isRunning();
}

export function runWithSyncLock(fn) {
    return getController().runExclusive(fn);
}

export function onManualSyncComplete() {
    getController().clearPause();
}

export function triggerAutoSync(opts = {}) {
    return getController().run(opts);
}

export function markSyncDirty() {
    return getController().markDirty();
}

export function initAutoSync() {
    const ctrl = getController();
    if (initialized) return ctrl;
    initialized = true;

    const onLocalChange = () => {
        if (!ctrl.isRunning()) ctrl.markDirty();
    };
    window.addEventListener(DATA_CHANGED_EVENT, onLocalChange);
    window.addEventListener('libraryDataChanged', onLocalChange);

    window.addEventListener('online', () => {
        const s = ctrl.getState();
        if (s.status === 'paused' && (s.reason === 'offline' || s.reason === 'error')) {
            ctrl.clearPause();
            ctrl.run({ force: true, reason: 'online' });
        } else if (s.status === 'error') {
            ctrl.clearPause();
            ctrl.run({ force: true, reason: 'online' });
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            ctrl.run({ reason: 'visibility' });
        }
    });

    window.addEventListener('googleAuthSuccess', () => {
        const s = ctrl.getState();
        if (s.status === 'paused' && s.reason === 'needs-auth') {
            ctrl.clearPause();
            ctrl.run({ force: true, reason: 'auth' });
        }
    });

    setTimeout(() => {
        if (document.visibilityState !== 'hidden') ctrl.run({ reason: 'startup' });
    }, STARTUP_DELAY_MS);

    setInterval(() => {
        if (document.visibilityState === 'visible') ctrl.run({ reason: 'periodic' });
    }, PERIODIC_INTERVAL_MS);

    return ctrl;
}
