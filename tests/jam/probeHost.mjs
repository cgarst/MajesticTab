// Fake jam client that drives a real MajesticTab host (policy "anyone") and reports what it sees.
// Usage: node tests/jam/probeHost.mjs <host:port> ["tests/Duo No 2 In G Major.gp5"]
// Start the host with: MAJESTICTAB_JAM_AUTOSTART=host:anyone <debug-tools build>
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const addr = process.argv[2] || '127.0.0.1:47813';
const songPath = process.argv[3];
const ws = new WebSocket(`ws://${addr}`);
const now = () => performance.now();
const log = (...a) => console.log(`[${(now() / 1000).toFixed(2)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const send = (type, payload = {}) => ws.send(JSON.stringify({ v: 1, type, seq: ++seq, ...payload }));

const samples = [];
let offset = 0; // host - local
let lastPlay = null;
const beats = [];

ws.onmessage = (ev) => {
    const t2 = now();
    const m = JSON.parse(ev.data);
    if (m.type === 'pong') {
        const rtt = (t2 - m.t0) - (m.t1b - m.t1);
        samples.push({ rtt, off: ((m.t1 - m.t0) + (m.t1b - t2)) / 2 });
        samples.sort((a, b) => a.rtt - b.rtt);
        offset = samples[0].off;
        return;
    }
    if (m.type === 'transport.heartbeat') {
        beats.push(m);
        if (lastPlay) {
            const expected = lastPlay.timeMs + (m.hostTs - lastPlay.startAtHostTs) * (m.speed || 1);
            log(`heartbeat timeMs=${m.timeMs.toFixed(0)} expectedFromSchedule=${expected.toFixed(0)} hostLagMs=${(expected - m.timeMs).toFixed(1)}`);
        }
        return;
    }
    if (m.type === 'transport.play') {
        lastPlay = m;
        log(`PLAY timeMs=${m.timeMs.toFixed(0)} leadMs=${(m.startAtHostTs - m.hostTs).toFixed(0)} speed=${m.speed}`);
        return;
    }
    const brief = { ...m };
    if (brief.state?.song) brief.state = { ...brief.state, song: brief.state.song.title };
    log('<-', JSON.stringify(brief).slice(0, 220));
};

await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
send('hello', { name: 'Probe', protocol: 1, pin: '' });
await sleep(300);
for (let i = 0; i < 10; i++) { send('ping', { id: i, t0: now() }); await sleep(50); }
await sleep(200);
log(`clock: best rtt=${samples[0]?.rtt.toFixed(2)} ms offset=${offset.toFixed(1)}`);

if (songPath) {
    const b64 = readFileSync(songPath).toString('base64');
    log('-> cmd.song.open');
    send('cmd.song.open', { fileName: songPath.split('/').pop(), b64 });
    await sleep(8000);
}
log('-> cmd.transport.play');
send('cmd.transport.play', { timeMs: 0 });
await sleep(5000);
log('-> cmd.transport.seek 20000 (while playing)');
send('cmd.transport.seek', { timeMs: 20000 });
await sleep(3000);
log('-> cmd.transport.speed 0.5');
send('cmd.transport.speed', { speed: 0.5 });
await sleep(3000);
log('-> cmd.transport.pause');
send('cmd.transport.pause');
await sleep(1000);
log('-> cmd.transport.seek 30000 (paused)');
send('cmd.transport.seek', { timeMs: 30000 });
await sleep(1000);
log('-> cmd.transport.speed 1');
send('cmd.transport.speed', { speed: 1 });
await sleep(500);
log('-> cmd.transport.play from paused 30000');
send('cmd.transport.play', {});
await sleep(2500);
send('cmd.transport.pause');
await sleep(500);
log(`heartbeats received: ${beats.length}`);
ws.close();
process.exit(0);
