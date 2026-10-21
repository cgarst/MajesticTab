// Browser stand-in for the Rust jam transport: two tabs talk over a BroadcastChannel.
(() => {
  const role = new URLSearchParams(location.search).get('jamMock');
  if (!role) return;
  const offset = role === 'client' ? 123456.789 : 0; // distinct "device" clocks
  const now = () => performance.timeOrigin + performance.now() + offset;
  const ch = new BroadcastChannel('jam-mock');
  const listeners = {};
  const emit = (ev, payload) => (listeners[ev] || []).forEach((cb) => cb({ payload }));
  const clientId = 'cMOCK';
  let hosting = false, connected = false;
  const post = (m) => setTimeout(() => ch.postMessage(m), 3); // a little network delay
  ch.onmessage = ({ data }) => {
    if (data.to === 'host' && hosting) {
      if (data.kind === 'hello') {
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
    jam_host_start: () => { hosting = true; return { port: 47900, addresses: ['192.168.1.254'], web: true }; },
    jam_host_stop: () => { hosting = false; },
    jam_host_send: ({ msg }) => post({ to: 'client', msg }),
    jam_host_kick: () => {},
    jam_discover: () => [],
    jam_client_connect: ({ name }) => { connected = true; post({ to: 'host', kind: 'hello', name }); },
    jam_client_send: ({ msg }) => {
      const v = JSON.parse(msg);
      if (v.type === 'ping') v.t0 = now();
      post({ to: 'host', msg: JSON.stringify(v) });
    },
    jam_client_disconnect: () => { connected = false; },
    jam_keep_awake: () => {}
  };
  window.__jamMockLog = [];
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (cmds[cmd]) return cmds[cmd](args || {}); throw new Error('mock: no ' + cmd); } },
    event: { listen: async (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {}; }, emit: async () => {} }
  };
})();
