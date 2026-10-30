# Fake jam host: drives a real MajesticTab client and logs its song.ready / status (drift) reports.
# Usage: python3 tests/jam/fake_host.py "tests/Duo No 2 In G Major.gp5" [port] [transport|nudge]
# Join with: MAJESTICTAB_JAM_AUTOSTART=join:<this-mac-ip>:<port> <debug-tools build>, or the Jam modal.
import asyncio, base64, json, sys, time
import websockets

SONG = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 47900
MODE = sys.argv[3] if len(sys.argv) > 3 else "transport"  # or "nudge"
data = open(SONG, 'rb').read()
import hashlib
song = {"id": hashlib.sha256(data).hexdigest(), "title": "Duo No 2 In G Major", "fileName": SONG.split('/')[-1], "size": len(data), "type": "gp"}

def now():
    return time.monotonic() * 1000

T0 = now()
def log(*a):
    print(f"[{(now() - T0) / 1000:6.2f}]", *a, flush=True)

seq = 0
def msg(type_, **kw):
    global seq
    seq += 1
    return json.dumps({"v": 1, "type": type_, "seq": seq, "hostTs": now(), **kw})

class Clock:
    playing = False
    base_ms = 0.0
    start_at = 0.0
    speed = 1.0
    def pos(self):
        if not self.playing:
            return self.base_ms
        return self.base_ms + max(0.0, now() - self.start_at) * self.speed

clock = Clock()

async def handler(ws):
    hello = json.loads(await ws.recv())
    log("hello", hello.get("name"))
    await ws.send(json.dumps({"v": 1, "type": "welcome", "clientId": "cTEST", "hostName": "FakeHost", "hostTs": now()}))
    await ws.send(msg("session.state", state={"song": song, "transport": {"playing": False, "timeMs": 0, "speed": 1, "loop": {"enabled": False, "startMeasure": 1, "endMeasure": 33}}, "controllerId": None, "policy": "host"}))
    ready = asyncio.Event()

    async def reader():
        async for raw in ws:
            t1 = now()
            m = json.loads(raw)
            t = m.get("type")
            if t == "ping":
                await ws.send(json.dumps({"v": 1, "type": "pong", "id": m.get("id"), "t0": m.get("t0"), "t1": t1, "t1b": now()}))
            elif t == "song.request":
                log("song.request")
                await ws.send(msg("song.data", songId=song["id"], fileName=song["fileName"], b64=base64.b64encode(data).decode()))
            elif t == "song.ready":
                log("song.ready loadMs", m.get("loadMs"))
                ready.set()
            elif t == "status":
                log(f"status state={m.get('state')} rtt={m.get('rttMs')} driftMs={m.get('driftMs')} raw={m.get('rawDriftMs')} speedFactor={m.get('speedFactor')} nudgeWorks={m.get('nudgeWorks')} startLag={m.get('startLagMs')}")
            else:
                log("<-", raw[:200])

    async def heartbeats():
        while True:
            await asyncio.sleep(0.5)
            if clock.playing:
                await ws.send(msg("transport.heartbeat", timeMs=clock.pos(), playing=True, speed=clock.speed))

    async def nudge_script():
        # Host clock jumps 60 ms ahead; the client should catch up by nudging, not hard-seeking.
        await ready.wait()
        await asyncio.sleep(1)
        clock.base_ms, clock.start_at, clock.playing = 0, now() + 150, True
        log("-> play 0")
        await ws.send(msg("transport.play", timeMs=0, startAtHostTs=clock.start_at, speed=1.0))
        await asyncio.sleep(5)
        for speed in (1.0, 0.5):
            if speed != clock.speed:
                cur = clock.pos()
                clock.base_ms, clock.start_at, clock.speed = cur, now(), speed
                log(f"-> speed {speed}")
                await ws.send(msg("transport.speed", speed=speed))
                await asyncio.sleep(5)
            clock.base_ms += 60
            log(f"== host jumps +60 ms at speed {speed}")
            await asyncio.sleep(12)
        clock.base_ms = clock.pos(); clock.playing = False
        await ws.send(msg("transport.pause", timeMs=clock.base_ms))
        log("done")

    async def script():
        if MODE == "nudge":
            return await nudge_script()
        await ready.wait()
        await asyncio.sleep(1)
        async def play(at_ms, lead=150):
            clock.base_ms, clock.start_at, clock.playing = at_ms, now() + lead, True
            log(f"-> play {at_ms}")
            await ws.send(msg("transport.play", timeMs=at_ms, startAtHostTs=clock.start_at, speed=clock.speed))
        await play(0)
        await asyncio.sleep(10)
        await play(20000)
        await asyncio.sleep(8)
        cur = clock.pos()
        clock.base_ms, clock.start_at, clock.speed = cur, now(), 0.5
        log("-> speed 0.5")
        await ws.send(msg("transport.speed", speed=0.5))
        await asyncio.sleep(8)
        clock.base_ms = clock.pos(); clock.playing = False
        log("-> pause", round(clock.base_ms))
        await ws.send(msg("transport.pause", timeMs=clock.base_ms))
        await asyncio.sleep(3)
        log("done")

    tasks = [asyncio.create_task(c) for c in (reader(), heartbeats())]
    await script()
    for t in tasks:
        t.cancel()

async def main():
    async with websockets.serve(handler, "0.0.0.0", PORT):
        log("listening", PORT)
        await asyncio.sleep(70)

asyncio.run(main())
