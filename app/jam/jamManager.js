// jamManager.js
// Jam Mode role state machine (off | host | client), connection lifecycle and glue between
// the Rust transport, the host / client adapters and the UI.

import { isJamSupported, isJamWebGuest, jam, listenJamEvents, calibrateNow, setMulticastEnabled } from './jamTransport.js';
import { createHostAdapter } from './jamHostAdapter.js';
import { requireSupporter } from '../supporter.js';
import { createClientAdapter } from './jamClientAdapter.js';
import { createJamModal } from './jamModal.js';
import { guestNameFromUserAgent } from './jamRoster.js';
import { loadSetting, saveSetting, primeAudio, setScreenWakeLock } from './jamCommon.js';
import { showToast } from '../utils/toast.js';

const settings = {
    // A browser guest has no app name to show, so the host sees which kind of device it is
    name: loadSetting('name', isJamWebGuest() ? guestNameFromUserAgent(navigator.userAgent, navigator.maxTouchPoints) : 'MajesticTab'),
    pin: loadSetting('pin', ''),
    policy: loadSetting('policy', 'ask'),
    muteGuests: loadSetting('muteGuests', false),
    assignedAudioMode: loadSetting('assignedAudioMode', loadSetting('assignedAudioOnly', false) ? 'assigned' : 'all'),
    assignedViewOnly: loadSetting('assignedViewOnly', false),
    listeningHears: loadSetting('listeningHears', loadSetting('muteAssignedForUnassigned', false) ? 'backing' : 'all'),
    waitForEveryone: loadSetting('waitForEveryone', true),
    leadOverrideMs: loadSetting('leadOverrideMs', 0),
    trimMs: loadSetting('trimMs', 0),
    smoothDrift: loadSetting('smoothDrift', true),
    alwaysSaveSongs: loadSetting('alwaysSaveSongs', false),
    lastHost: loadSetting('lastHost', '')
};

export function updateJamSetting(key, value) {
    settings[key] = value;
    saveSetting(key, value);
}

const RECONNECT_MAX_MS = 15000;

export function initJamMode({ loadFile, getCurrentFile, recordFileToRecents }) {
    const pill = document.getElementById('jamPill');
    if (!isJamSupported()) {
        pill?.remove();
        return null;
    }
    if (pill) pill.style.display = '';

    let role = 'off';
    let hostInfo = null;
    let hostAdapter = null;
    let clientAdapter = null;
    let reconnect = { addr: null, pin: null, attempt: 0, timer: null, enabled: false };
    let modal = null;

    const toast = (message, type = 'info', duration = 3500, id = null) => showToast(message, type, duration, id);

    const refresh = () => modal?.render();

    function startHostAdapter() {
        hostAdapter = createHostAdapter({
            loadFile,
            getSettings: () => settings,
            ui: {
                toast,
                onRosterChange: () => refresh(),
                onRequestsChanged: (list) => modal?.setRequests(list),
                onStarting: (on) => modal?.setStarting(on)
            }
        });
    }

    function startClientAdapter() {
        clientAdapter = createClientAdapter({
            loadFile,
            getCurrentFile,
            recordFileToRecents,
            getSettings: () => settings,
            ui: {
                toast,
                onStatus: () => refresh(),
                // The host named this player: use it from now on, including the next time they join
                onRenamed: (name) => {
                    if (name === settings.name) return;
                    updateJamSetting('name', name);
                    toast(`The host named you ${name}`, 'info');
                    refresh();
                }
            }
        });
    }

    const api = {
        getRole: () => role,
        getSettings: () => settings,
        getHostInfo: () => hostInfo,
        getHost: () => hostAdapter,
        getClient: () => clientAdapter,

        async startHosting() {
            if (role !== 'off') return;
            // Joining is free; hosting is a Supporter feature. Every way of starting a session comes through here.
            if (!requireSupporter('jamHost')) return;
            primeAudio();
            setMulticastEnabled(true);
            try {
                await calibrateNow();
                hostInfo = await jam.hostStart(settings.name, settings.pin, null);
            } catch (e) {
                setMulticastEnabled(false);
                toast(`Could not start hosting: ${e}`, 'error');
                return;
            }
            role = 'host';
            setScreenWakeLock(true);
            startHostAdapter();
            hostAdapter.start(getCurrentFile?.());
            refresh();
        },

        async stopHosting() {
            if (role !== 'host') return;
            hostAdapter?.stop();
            hostAdapter = null;
            hostInfo = null;
            role = 'off';
            try { await jam.hostStop(); } catch (_) {}
            setMulticastEnabled(false);
            setScreenWakeLock(false);
            refresh();
        },

        async join(addr, pin) {
            if (role !== 'off') return;
            primeAudio();
            reconnect = { addr, pin, attempt: 0, timer: null, enabled: true };
            role = 'client';
            setScreenWakeLock(true);
            startClientAdapter();
            clientAdapter.start();
            try {
                await calibrateNow();
                await jam.clientConnect(addr, pin, settings.name);
                updateJamSetting('lastHost', addr);
            } catch (e) {
                toast(String(e), 'error');
                api.leave();
                return;
            }
            refresh();
        },

        async leave() {
            reconnect.enabled = false;
            clearTimeout(reconnect.timer);
            try { await jam.clientDisconnect(); } catch (_) {}
            setMulticastEnabled(false);
            setScreenWakeLock(false);
            clientAdapter?.stop();
            clientAdapter = null;
            role = 'off';
            refresh();
        },

        async discover(ms) {
            setMulticastEnabled(true);
            try {
                return await jam.discover(ms);
            } finally {
                if (role === 'off') setMulticastEnabled(false);
            }
        },
        localAddresses: () => jam.localAddresses()
    };

    function scheduleReconnect() {
        if (!reconnect.enabled || role !== 'client') return;
        const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** reconnect.attempt);
        reconnect.attempt += 1;
        clearTimeout(reconnect.timer);
        reconnect.timer = setTimeout(async () => {
            if (!reconnect.enabled || role !== 'client') return;
            try {
                await jam.clientConnect(reconnect.addr, reconnect.pin, settings.name);
            } catch (_) {
                scheduleReconnect();
            }
        }, delay);
        refresh();
    }

    listenJamEvents({
        onMessage: (from, msg) => {
            if (role === 'host') hostAdapter?.handleMessage(from, msg);
            else if (role === 'client') {
                if (msg.type === 'welcome') reconnect.attempt = 0;
                clientAdapter?.handleMessage(from, msg);
            }
        },
        onPeers: (info) => {
            if (role === 'host') hostAdapter?.handlePeers(info);
        },
        onConnection: (info) => {
            if (role !== 'client') return;
            if (info.state === 'disconnected') {
                const rejected = String(info.reason || '').startsWith('reject:');
                if (rejected) {
                    api.leave();
                } else if (info.reason !== 'local') {
                    clientAdapter?.connectionLost();
                    toast('Lost connection to the host. Reconnecting…', 'warning', 3000, 'jam-reconnect');
                    scheduleReconnect();
                }
            }
            refresh();
        }
    }).catch((e) => console.warn('[Jam] event listeners unavailable:', e));

    // iOS suspends sockets in the background; rejoin on foreground.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && role === 'client' && reconnect.enabled && !clientAdapter?.getStatus().connected) {
            reconnect.attempt = 0;
            scheduleReconnect();
        }
    });

    modal = createJamModal(api, { updateSetting: updateJamSetting });
    // A browser that opened the host's link is here to join: go straight in, no modal.
    // If joining fails (e.g. a PIN is required), fall back to the modal so they can retry.
    if (isJamWebGuest()) api.join(location.host, '').then(() => { if (role === 'off') modal.open(); });

    jam.debugAutostart().then((value) => {
        if (!value) return;
        const [mode, ...rest] = value.split(':');
        console.info('[Jam] debug autostart:', value);
        if (mode === 'host') {
            if (rest[0]) settings.policy = rest[0];
            api.startHosting();
        } else if (mode === 'join' && rest.length) {
            api.join(rest.join(':'), '');
        }
    }).catch(() => {});
    return api;
}
