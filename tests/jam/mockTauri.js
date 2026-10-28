// Browser stand-in for the Rust jam transport: two tabs talk over a BroadcastChannel.
(() => {
  window.__jamMockLog = [];
  // `?jamMock=host|client`, or window.__jamMockRole set by an init script (the store screenshot tool does)
  const role = new URLSearchParams(location.search).get('jamMock') || window.__jamMockRole;
  if (!role) return;
  const offset = role === 'client' ? 123456.789 : 0; // distinct "device" clocks
  const now = () => performance.timeOrigin + performance.now() + offset;
  const ch = new BroadcastChannel('jam-mock');
  const listeners = {};
  const emit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb({ payload }));
  const clientId = 'cMOCK';
  let hosting = false, connected = false, locked = false, lastSongId = null;
  const post = (m) => setTimeout(() => ch.postMessage(m), 3); // a little network delay
  ch.onmessage = ({ data }) => {
    if (data.to === 'host' && hosting) {
      if (data.kind === 'hello') {
        // Like jam.rs: locked, only someone presenting the id this host issued gets back in.
        if (locked && data.resume !== clientId) {
          post({ to: 'client', kind: 'rejected', reason: 'locked' });
          return;
        }
        post({ to: 'client', msg: JSON.stringify({ v: 1, type: 'welcome', clientId, hostName: 'MockHost', hostTs: now() }) });
        emit('jam-peers-changed', { event: 'joined', id: clientId, name: data.name, count: 1 });
        return;
      }
      const v = JSON.parse(data.msg);
      if (v.type === 'ping') {
        const t1 = now();
        post({ to: 'client', msg: JSON.stringify({ v: 1, type: 'pong', id: v.id, t0: v.t0, t1, t1b: now() }) });
        return;
      }
      v.rxTs = now();
      emit('jam-message', { from: clientId, msg: JSON.stringify(v) });
    } else if (data.to === 'client' && data.kind === 'rejected' && connected) {
      emit('jam-message', { from: 'host', msg: JSON.stringify({ v: 1, type: 'reject', reason: data.reason }) });
      emit('jam-connection-state', { state: 'disconnected', reason: `reject:${data.reason}` });
    } else if (data.to === 'client' && data.kind === 'drop' && connected) {
      emit('jam-connection-state', { state: 'disconnected', reason: 'closed' }); // a dropped socket, for reconnect tests
    } else if (data.to === 'client' && connected) {
      const v = JSON.parse(data.msg);
      v.rxTs = now();
      if (v.type === 'welcome') emit('jam-connection-state', { state: 'connected', reason: '' });
      emit('jam-message', { from: 'host', msg: JSON.stringify(v) });
    }
  };
  const cmds = {
    jam_now_ms: () => now(),
    jam_debug_autostart: () => null,
    jam_local_addresses: () => ['127.0.0.1'],
    jam_host_start: () => { hosting = true; return { port: 47900, addresses: ['192.168.1.254'] }; },
    jam_host_stop: () => { hosting = false; },
    jam_host_send: ({ msg }) => {
      try { const v = JSON.parse(msg); if (v.type === 'song.open') lastSongId = v.song?.id; } catch (_) {}
      post({ to: 'client', msg });
    },
    jam_host_kick: () => {},
    jam_host_set_locked: ({ locked: on }) => { locked = Boolean(on); window.__jamMockLog.push({ cmd: 'set_locked', locked }); },
    jam_discover: () => [],
    jam_client_connect: ({ name, resume }) => { connected = true; window.__jamMockLog.push({ cmd: 'connect', name, resume }); post({ to: 'host', kind: 'hello', name, resume }); },
    jam_client_send: ({ msg }) => {
      const v = JSON.parse(msg);
      if (v.type === 'ping') v.t0 = now();
      post({ to: 'host', msg: JSON.stringify(v) });
    },
    jam_client_disconnect: () => { connected = false; },
    jam_keep_awake: () => {}
  };
  // Fake players for screenshots and demos: they appear in the host's roster without a second window.
  window.__jamMock = {
    join: (id, name) => emit('jam-peers-changed', { event: 'joined', id, name, count: 1 }),
    leave: (id, name = '') => emit('jam-peers-changed', { event: 'left', id, name, count: 0 }),
    send: (from, message) => emit('jam-message', { from, msg: JSON.stringify({ v: 1, seq: 0, rxTs: now(), ...message }) }),
    // A player that has the song loaded and is in sync, as the roster would show it
    sync: (id, { rttMs = 8, driftMs = 3 } = {}) => {
      window.__jamMock.send(id, { type: 'song.ready', songId: lastSongId });
      window.__jamMock.send(id, { type: 'status', rttMs, driftMs, state: 'synced' });
    }
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (cmds[cmd]) return cmds[cmd](args || {}); throw new Error('mock: no ' + cmd); } },
    event: { listen: async (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {}; }, emit: async () => {} }
  };
})();
