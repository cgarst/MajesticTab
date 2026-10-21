// jamModal.js
// Jam Mode UI: top-bar pill, themed modal (host / client panels) and the control-request card.

import { CONTROL_POLICIES, JAM_SONG_EXTENSIONS } from './jamProtocol.js';
import { jamPlayerControl } from '../gpProcessor/gpPlayer.js';
import { isJamWebGuest } from './jamTransport.js';

// Guests load the app from the host over plain HTTP on the LAN.
const WEB_SCHEME = 'http:';
const QR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js';

const POLICY_LABELS = { host: 'Host only', ask: 'Ask me', anyone: 'Anyone' };
const PEER_STATUS_LABELS = { joined: 'Joined', loading: 'Loading', synced: 'Ready', idle: 'Waiting for song', detached: 'Detached', error: 'Error' };

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function createJamModal(manager, { updateSetting }) {
    const pillBtn = document.getElementById('jamToggleBtn');
    const pillLabel = document.getElementById('jamStatusLabel');
    let discovered = [];
    let discovering = false;
    let tab = 'join';
    let requests = [];
    let starting = false;

    const backdrop = document.createElement('div');
    backdrop.id = 'jamModal';
    backdrop.className = 'theme-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'jamModalTitle');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
      <section class="theme-modal-card jam-modal-card">
        <header class="theme-modal-header">
          <div class="theme-modal-title-group">
            <div class="brand-btn p-2 theme-modal-icon" style="width: 36px; height: 36px;"><i class="bi-people-fill fs-5"></i></div>
            <div class="theme-modal-titles">
              <h2 class="theme-modal-title mb-0 fs-6 fw-bold text-white" id="jamModalTitle">Jam mode</h2>
            </div>
          </div>
          <div class="theme-modal-actions">
            <button type="button" class="brand-btn theme-modal-close-btn p-1 px-2" id="jamModalCloseBtn" aria-label="Close modal"><i class="bi-x-lg"></i></button>
          </div>
        </header>
        <div class="theme-modal-body jam-modal-body" id="jamModalBody"></div>
      </section>`;
    document.body.appendChild(backdrop);
    const body = backdrop.querySelector('#jamModalBody');

    const requestCard = document.createElement('div');
    requestCard.id = 'jamRequestCard';
    requestCard.className = 'jam-request-card';
    requestCard.style.display = 'none';
    document.body.appendChild(requestCard);

    function open() {
        backdrop.classList.add('show');
        backdrop.style.display = 'flex';
        backdrop.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
        render();
    }

    function close() {
        backdrop.classList.remove('show');
        backdrop.style.display = 'none';
        backdrop.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
    }

    const isOpen = () => backdrop.style.display === 'flex';

    // ---- Panels ------------------------------------------------------------

    function switchHtml(id, label, checked) {
        return `<div class="form-check form-switch mb-0">
          <input class="form-check-input theme-switch" type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
          <label class="form-check-label small" for="${id}">${label}</label>
        </div>`;
    }

    // Shared by host and client: each device's speaker latency is compensated on the clients.
    function trimHtml(settings) {
        return `        <div class="jam-field mb-3">
          <label class="jam-label" for="jamTrimRange">Audio latency trim: <span id="jamTrimValue">${settings.trimMs || 0}</span> ms</label>
          <div class="d-flex align-items-center gap-2">
            <button type="button" class="btn btn-sm theme-control-btn" data-jam-trim="-1">-1</button>
            <input type="range" class="flex-grow-1" id="jamTrimRange" min="-1000" max="1000" step="1" value="${settings.trimMs || 0}">
            <button type="button" class="btn btn-sm theme-control-btn" data-jam-trim="1">+1</button>
          </div>
          <div class="jam-help mt-1">Positive values play earlier. Raise it if your audio sounds late, for example with Bluetooth headphones.</div>
        </div>`;
    }

    function webGuestPanel(settings) {
        return `
        <p class="jam-help mb-3">You're joining a Jam hosted at <strong>${esc(location.host)}</strong>. Each device plays the song locally, so keep this tab open and in front.</p>
        <div class="jam-field mb-3">
          <label class="jam-label" for="jamNameInput">Your name</label>
          <input type="text" class="form-control form-control-sm" id="jamNameInput" maxlength="40" value="${esc(settings.name)}">
        </div>
        <div class="jam-field mb-3">
          <label class="jam-label" for="jamJoinPinInput">PIN (if the host set one)</label>
          <input type="text" class="form-control form-control-sm" id="jamJoinPinInput" maxlength="12" inputmode="numeric">
        </div>
        <button type="button" class="btn btn-sm btn-theme-primary" id="jamJoinBtn">Join</button>`;
    }

    function idlePanel(settings) {
        if (isJamWebGuest()) return webGuestPanel(settings);
        return `
        <div class="hud-pill-group jam-tab-group mb-3" role="group" aria-label="Jam role">
          <button type="button" class="btn btn-sm ${tab === 'join' ? 'active' : ''}" data-jam-tab="join">Join a Jam</button>
          <button type="button" class="btn btn-sm ${tab === 'host' ? 'active' : ''}" data-jam-tab="host">Host a Jam</button>
        </div>
        <div class="jam-field mb-3">
          <label class="jam-label" for="jamNameInput">Your name</label>
          <input type="text" class="form-control form-control-sm" id="jamNameInput" maxlength="40" value="${esc(settings.name)}">
        </div>
        ${tab === 'host' ? `
          <div class="jam-field mb-3">
            <label class="jam-label" for="jamPinInput">PIN (optional)</label>
            <input type="text" class="form-control form-control-sm" id="jamPinInput" maxlength="12" inputmode="numeric" value="${esc(settings.pin)}">
          </div>
          <div class="mb-3">${switchHtml('jamAllowWebSwitch', 'Let browsers join (no install needed)', settings.allowWeb !== false)}</div>
          <p class="jam-help mb-3">Other devices on the same Wi-Fi or network can join. Each device plays the song locally (synth or YouTube), so no audio is streamed.</p>
          <button type="button" class="btn btn-sm btn-theme-primary" id="jamStartHostBtn">Start Hosting</button>
        ` : `
          <div class="jam-field mb-3">
            <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
              <span class="jam-label mb-0">Nearby hosts</span>
              <button type="button" class="btn btn-sm theme-control-btn flex-shrink-0" id="jamDiscoverBtn" ${discovering ? 'disabled' : ''}>${discovering ? 'Searching…' : 'Find Hosts'}</button>
            </div>
            <div class="jam-list" id="jamHostList">
              ${discovered.length ? discovered.map((h, i) => `
                <div class="jam-list-row">
                  <div class="jam-row-main"><span class="fw-semibold">${esc(h.name)}</span><span class="jam-help">${esc(h.addr)}:${h.port}</span></div>
                  <button type="button" class="btn btn-sm btn-theme-outline flex-shrink-0 ms-2" data-jam-join-found="${i}">Join</button>
                </div>`).join('') : `<div class="jam-help px-1">${discovering ? 'Looking for hosts…' : 'No hosts found yet.'}</div>`}
            </div>
          </div>
          <div class="jam-field mb-3">
            <label class="jam-label" for="jamAddrInput">Address</label>
            <input type="text" class="form-control form-control-sm" id="jamAddrInput" placeholder="192.168.1.20:47813" value="${esc(settings.lastHost)}">
          </div>
          <div class="jam-field mb-3">
            <label class="jam-label" for="jamJoinPinInput">PIN</label>
            <input type="text" class="form-control form-control-sm" id="jamJoinPinInput" maxlength="12" inputmode="numeric">
          </div>
          <button type="button" class="btn btn-sm btn-theme-primary" id="jamJoinBtn">Join</button>
        `}`;
    }

    function assignmentHtml(roster, session, settings) {
        const tracks = session?.song && (session.song.type || 'gp') === 'gp' ? jamPlayerControl.listTracks() : [];
        if (!tracks.length) return '';
        const people = [{ key: 'host', name: 'You (host)' }, ...roster.map((p) => ({ key: p.id, name: p.name }))];
        const assigned = session.trackAssignments || {};
        return `
        <div class="jam-label">Track assignments</div>
        <div class="d-flex flex-column gap-2 mb-2">
          ${switchHtml('jamAssignedAudioSwitch', 'Only play each person\'s assigned tracks', settings.assignedAudioOnly)}
          ${switchHtml('jamMuteAssignedSwitch', 'Mute assigned tracks for people without assignments', settings.muteAssignedForUnassigned)}
          ${switchHtml('jamAssignedViewSwitch', 'Only show each person\'s assigned tracks', settings.assignedViewOnly)}
        </div>
        <div class="jam-list mb-3">
          ${people.map((person) => `
            <div class="jam-list-row flex-wrap">
              <div class="fw-semibold w-100">${esc(person.name)}</div>
              <div class="d-flex flex-wrap gap-2 w-100 mt-1">
                ${tracks.map((t) => `<button type="button" class="btn btn-sm ${(assigned[person.key] || []).includes(t.index) ? 'btn-theme-primary' : 'btn-theme-outline'}" data-jam-assign="${esc(person.key)}" data-jam-track="${t.index}">${esc(t.name)}</button>`).join('')}
              </div>
            </div>`).join('')}
        </div>
        <div class="jam-help mb-3">People with no assigned track hear and see everything, unless assigned tracks are muted for them. Assignments reset when the song changes.</div>`;
    }

    function hostPanel(settings) {
        const host = manager.getHost();
        const info = manager.getHostInfo();
        const roster = host?.getRoster() || [];
        const session = host?.getSession();
        const addrs = (info?.addresses || []).map((a) => `${a}:${info.port}`);
        const webUrls = info?.web ? (info.addresses || []).map((a) => `${WEB_SCHEME}//${a}:${info.port}/`) : [];
        return `
        <div class="jam-card mb-3">
          <div class="jam-label">Share this address</div>
          <div class="fw-semibold jam-address">${addrs.length ? addrs.map(esc).join('<br>') : esc(`port ${info?.port ?? ''}`)}</div>
          ${settings.pin ? `<div class="jam-help mt-1">PIN: ${esc(settings.pin)}</div>` : ''}
          ${webUrls.length ? `<div class="jam-label mt-3">Or open in any browser</div>
          <div class="fw-semibold jam-address">${webUrls.map(esc).join('<br>')}</div>
          <div class="jam-qr mt-2" id="jamQr" data-url="${esc(webUrls[0])}" aria-label="QR code for ${esc(webUrls[0])}"></div>` : ''}
          ${session?.song ? `<div class="jam-help ${webUrls.length ? 'mt-3' : 'mt-1'}">Song: ${esc(session.song.title)}</div>` : '<div class="jam-help ${webUrls.length ? 'mt-3' : 'mt-1'}">Open a Guitar Pro, PDF or text file to share it with everyone. YouTube playback is shared too.</div>'}
        </div>
        <div class="jam-field mb-3">
          <label class="jam-label" for="jamPolicySelect">Who can control</label>
          <select class="form-select form-select-sm" id="jamPolicySelect">
            ${CONTROL_POLICIES.map((p) => `<option value="${p}" ${session?.policy === p ? 'selected' : ''}>${POLICY_LABELS[p]}</option>`).join('')}
          </select>
        </div>
        <div class="d-flex flex-column gap-2 mb-3">
          ${switchHtml('jamMuteGuestsSwitch', 'Mute audio on guests', settings.muteGuests)}
          ${switchHtml('jamWaitSwitch', 'Wait for everyone before playing', settings.waitForEveryone)}
          <div class="d-flex align-items-center gap-2">
            <label class="jam-label mb-0" for="jamLeadInput">Lead time (ms, 0 = auto)</label>
            <input type="number" class="form-control form-control-sm jam-number-input" id="jamLeadInput" min="0" max="400" step="10" value="${settings.leadOverrideMs || 0}">
          </div>
        </div>
        ${trimHtml(settings)}
        ${assignmentHtml(roster, session, settings)}
        <div class="jam-label">Players (${roster.length}/8)</div>
        <div class="jam-list mb-3">
          ${roster.length ? roster.map((p) => {
            const isController = session?.controllerId === p.id;
            return `<div class="jam-list-row">
              <div class="jam-row-main">
                <span class="fw-semibold">${esc(p.name)}${isController ? ' <span class="jam-badge">Controller</span>' : ''}</span>
                <span class="jam-help">${p.ready ? 'Ready' : esc(PEER_STATUS_LABELS[p.status] || 'Loading')} · RTT ${Math.round(p.rttMs || 0)} ms${p.driftMs === null || p.driftMs === undefined ? '' : ` · drift ${p.driftMs} ms`}${p.ytDriftMs === null || p.ytDriftMs === undefined ? '' : ` · YouTube drift ${p.ytDriftMs} ms`}</span>
              </div>
              <div class="d-flex gap-2 flex-shrink-0 ms-2">
                <button type="button" class="btn btn-sm btn-theme-outline" data-jam-control="${esc(p.id)}">${isController ? 'Take Back' : 'Hand Over'}</button>
                <button type="button" class="btn btn-sm btn-theme-danger" data-jam-kick="${esc(p.id)}">Kick</button>
              </div>
            </div>`;
          }).join('') : '<div class="jam-help px-1">Nobody has joined yet.</div>'}
        </div>
        <button type="button" class="btn btn-sm btn-theme-danger" id="jamStopHostBtn">Stop Hosting</button>`;
    }

    function clientPanel(settings) {
        const client = manager.getClient();
        const st = client?.getStatus() || {};
        const connected = st.connected;
        const stateText = !connected ? 'Reconnecting…'
            : st.loading ? 'Loading song…'
            : !st.following ? 'Detached'
            : st.song && !st.songLoaded ? 'Different song'
            : st.synced ? 'In sync' : 'Syncing clock…';
        return `
        <div class="jam-card mb-3">
          <div class="fw-semibold">${connected ? `Connected to ${esc(st.hostName)}` : 'Connection lost'}</div>
          <div class="jam-help mt-1">${esc(stateText)}${connected ? ` · RTT ${Math.round(st.rttMs || 0)} ms` : ''}${st.driftMs === null || st.driftMs === undefined ? '' : ` · drift ${Math.round(st.driftMs)} ms`}${st.ytDriftMs === null || st.ytDriftMs === undefined ? '' : ` · YouTube drift ${st.ytDriftMs} ms`}</div>
          ${st.song ? `<div class="jam-help mt-1">Song: ${esc(st.song.title)}</div>` : ''}
        </div>
        <div class="d-flex flex-wrap gap-2 mb-3">
          <button type="button" class="btn btn-sm ${st.following ? 'btn-theme-outline' : 'btn-theme-primary'}" id="jamFollowBtn">${st.following ? 'Detach' : 'Rejoin Host'}</button>
          ${st.controllerId && st.canControl && st.policy !== 'anyone'
            ? '<button type="button" class="btn btn-sm btn-theme-outline" id="jamReleaseBtn">Release Control</button>'
            : (st.policy === 'anyone' ? '' : '<button type="button" class="btn btn-sm btn-theme-outline" id="jamRequestBtn">Request Control</button>')}
          ${st.canControl ? '<button type="button" class="btn btn-sm btn-theme-outline" id="jamShareSongBtn">Share a Song</button>' : ''}
          ${connected && st.songLoaded ? '<button type="button" class="btn btn-sm btn-theme-outline" id="jamSaveSongBtn">Save to Library</button>' : ''}
        </div>
        ${trimHtml(settings)}
        <div class="d-flex flex-column gap-2 mb-3">
          ${switchHtml('jamSmoothSwitch', 'Smooth drift correction', settings.smoothDrift !== false)}
          ${switchHtml('jamAlwaysSaveSwitch', 'Always save jam songs to my library', settings.alwaysSaveSongs)}
        </div>
        <button type="button" class="btn btn-sm btn-theme-danger" id="jamLeaveBtn">Leave</button>`;
    }

    function render() {
        updatePill();
        if (!isOpen()) return;
        const settings = manager.getSettings();
        const role = manager.getRole();
        // Preserve focus / typed values across re-renders triggered by status ticks.
        const active = document.activeElement;
        if (role === 'off') {
            if (active && backdrop.contains(active) && active.tagName === 'INPUT' && body.querySelector('#jamAddrInput')) {
                // Don't clobber the form while typing.
                if (body.dataset.role === 'off') return;
            }
            body.innerHTML = idlePanel(settings);
        } else if (role === 'host') {
            if (active && backdrop.contains(active) && ['INPUT', 'SELECT'].includes(active.tagName) && body.dataset.role === 'host') return;
            body.innerHTML = hostPanel(settings);
            drawQr();
        } else {
            if (active && backdrop.contains(active) && active.tagName === 'INPUT' && body.dataset.role === 'client') return;
            body.innerHTML = clientPanel(settings);
        }
        body.dataset.role = role;
    }

    let qrLoading = null;
    function loadQrLib() {
        if (globalThis.qrcode) return Promise.resolve();
        qrLoading ??= new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = QR_SCRIPT_URL;
            script.onload = resolve;
            script.onerror = () => { qrLoading = null; reject(new Error('QR library unavailable')); };
            document.head.appendChild(script);
        });
        return qrLoading;
    }

    async function drawQr() {
        const el = body.querySelector('#jamQr');
        if (!el) return;
        try {
            await loadQrLib();
            const qr = globalThis.qrcode(0, 'M');
            qr.addData(el.dataset.url);
            qr.make();
            el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        } catch (_) {
            el.remove();
        }
    }

    function updatePill() {
        if (!pillBtn || !pillLabel) return;
        const role = manager.getRole();
        let text = isJamWebGuest() ? 'Join the jam' : 'Host or join on your network';
        let cls = '';
        if (role === 'host') {
            const n = manager.getHost()?.getRoster().length || 0;
            text = starting ? 'Starting…' : `Hosting · ${n}`;
            cls = 'jam-active';
        } else if (role === 'client') {
            const st = manager.getClient()?.getStatus() || {};
            if (!st.connected) text = 'Reconnecting…';
            else {
                const drift = st.driftMs;
                text = st.loading ? 'Loading…' : !st.following ? 'Detached' : !st.synced ? 'Syncing…' : (drift !== null && drift !== undefined && Math.abs(drift) > 60 ? 'Out of sync' : 'In sync');
                if (st.canControl) text += ' · Control';
                text += ` · ${Math.round(st.rttMs || 0)} ms`;
            }
            cls = 'jam-active';
        }
        pillLabel.textContent = text;
        pillBtn.classList.toggle('jam-active', Boolean(cls));
        pillBtn.title = role === 'off' ? 'Jam mode (play together)' : `Jam mode: ${text}`;
    }

    function setRequests(list) {
        requests = list;
        if (!requests.length) {
            requestCard.style.display = 'none';
            requestCard.innerHTML = '';
            return;
        }
        requestCard.innerHTML = requests.map((r) => `
          <div class="jam-request-row">
            <span class="small"><strong>${esc(r.name)}</strong> wants control${r.reason ? `: ${esc(r.reason)}` : ''}</span>
            <div class="d-flex gap-2 flex-shrink-0">
              <button type="button" class="btn btn-sm btn-theme-primary" data-jam-allow="${esc(r.id)}">Allow</button>
              <button type="button" class="btn btn-sm btn-theme-outline" data-jam-deny="${esc(r.id)}">Deny</button>
            </div>
          </div>`).join('');
        requestCard.style.display = 'flex';
    }

    function setStarting(on) {
        starting = on;
        updatePill();
    }

    // ---- Events ------------------------------------------------------------

    async function runDiscover() {
        discovering = true;
        render();
        try { discovered = await manager.discover(2500); } catch (_) { discovered = []; }
        discovering = false;
        body.dataset.role = '';
        render();
    }

    body.addEventListener('click', async (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        const settings = manager.getSettings();
        if (t.dataset.jamTab) { tab = t.dataset.jamTab; body.dataset.role = ''; render(); return; }
        if (t.id === 'jamDiscoverBtn') { runDiscover(); return; }
        if (t.dataset.jamJoinFound !== undefined) {
            const h = discovered[Number(t.dataset.jamJoinFound)];
            const pin = body.querySelector('#jamJoinPinInput')?.value || '';
            if (h) { await manager.join(`${h.addr}:${h.port}`, pin); body.dataset.role = ''; render(); }
            return;
        }
        if (t.id === 'jamJoinBtn') {
            const addr = isJamWebGuest() ? location.host : body.querySelector('#jamAddrInput')?.value.trim();
            const pin = body.querySelector('#jamJoinPinInput')?.value.trim();
            if (addr) { await manager.join(addr, pin); body.dataset.role = ''; render(); }
            return;
        }
        if (t.id === 'jamStartHostBtn') {
            await manager.startHosting();
            body.dataset.role = '';
            render();
            return;
        }
        if (t.id === 'jamStopHostBtn') { await manager.stopHosting(); body.dataset.role = ''; render(); return; }
        if (t.id === 'jamLeaveBtn') { await manager.leave(); body.dataset.role = ''; render(); return; }
        const host = manager.getHost();
        const client = manager.getClient();
        if (t.dataset.jamAssign) {
            const key = t.dataset.jamAssign;
            const idx = Number(t.dataset.jamTrack);
            const cur = host?.getSession().trackAssignments?.[key] || [];
            host?.setTrackAssignment(key, cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx].sort((a, b) => a - b));
            body.dataset.role = '';
            render();
            return;
        }
        if (t.dataset.jamKick) { host?.kick(t.dataset.jamKick); return; }
        if (t.dataset.jamControl) {
            const session = host?.getSession();
            if (session?.controllerId === t.dataset.jamControl) host.revokeControl();
            else host?.grantControl(t.dataset.jamControl);
            body.dataset.role = '';
            render();
            return;
        }
        if (t.id === 'jamFollowBtn') {
            const st = client?.getStatus();
            if (st?.following) client.setFollowing(false); else client?.rejoin();
            body.dataset.role = '';
            render();
            return;
        }
        if (t.id === 'jamRequestBtn') { client?.requestControl(); return; }
        if (t.id === 'jamReleaseBtn') { client?.releaseControl(); return; }
        if (t.id === 'jamSaveSongBtn') {
            const saved = client?.saveCurrentSongToLibrary();
            const toastMod = await import('../utils/toast.js');
            toastMod.showToast(saved ? 'Song saved to your library.' : 'This song is already in your library.', saved ? 'success' : 'info');
            return;
        }
        if (t.id === 'jamShareSongBtn') {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = JAM_SONG_EXTENSIONS.map((ext) => `.${ext}`).join(',');
            input.onchange = () => { if (input.files?.[0]) client?.openSongAsController(input.files[0]); };
            input.click();
            return;
        }
        if (t.dataset.jamTrim) {
            const next = Math.max(-1000, Math.min(1000, (settings.trimMs || 0) + Number(t.dataset.jamTrim)));
            updateSetting('trimMs', next);
            body.querySelector('#jamTrimRange').value = String(next);
            body.querySelector('#jamTrimValue').textContent = String(next);
        }
    });

    body.addEventListener('input', (e) => {
        if (e.target.id === 'jamTrimRange') {
            const v = Number(e.target.value);
            updateSetting('trimMs', v);
            body.querySelector('#jamTrimValue').textContent = String(v);
        }
        if (e.target.id === 'jamNameInput') updateSetting('name', e.target.value.trim() || 'MajesticTab');
        if (e.target.id === 'jamPinInput') updateSetting('pin', e.target.value.trim());
        if (e.target.id === 'jamLeadInput') updateSetting('leadOverrideMs', Math.max(0, Math.min(400, Number(e.target.value) || 0)));
    });

    body.addEventListener('change', (e) => {
        const id = e.target.id;
        if (id === 'jamPolicySelect') { manager.getHost()?.setPolicy(e.target.value); updateSetting('policy', e.target.value); }
        if (id === 'jamMuteGuestsSwitch') { manager.getHost()?.setMuteGuests(e.target.checked); updateSetting('muteGuests', e.target.checked); }
        if (id === 'jamAssignedAudioSwitch') { manager.getHost()?.updateTracks({ assignedAudioOnly: e.target.checked }); updateSetting('assignedAudioOnly', e.target.checked); }
        if (id === 'jamMuteAssignedSwitch') { manager.getHost()?.updateTracks({ muteAssignedForUnassigned: e.target.checked }); updateSetting('muteAssignedForUnassigned', e.target.checked); }
        if (id === 'jamAssignedViewSwitch') { manager.getHost()?.updateTracks({ assignedViewOnly: e.target.checked }); updateSetting('assignedViewOnly', e.target.checked); }
        if (id === 'jamAllowWebSwitch') updateSetting('allowWeb', e.target.checked);
        if (id === 'jamWaitSwitch') updateSetting('waitForEveryone', e.target.checked);
        if (id === 'jamSmoothSwitch') updateSetting('smoothDrift', e.target.checked);
        if (id === 'jamAlwaysSaveSwitch') updateSetting('alwaysSaveSongs', e.target.checked);
    });

    requestCard.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        const host = manager.getHost();
        if (t.dataset.jamAllow) host?.resolveRequest(t.dataset.jamAllow, true);
        if (t.dataset.jamDeny) host?.resolveRequest(t.dataset.jamDeny, false);
    });

    pillBtn?.addEventListener('click', () => (isOpen() ? close() : open()));
    backdrop.querySelector('#jamModalCloseBtn').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

    return { open, close, render, setRequests, setStarting };
}
