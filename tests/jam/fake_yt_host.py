# Fake jam host for YouTube sync: shares a song (any type, sent in parts) and drives a virtual
# YouTube timeline, logging the client's song.ready and status (ytDriftMs) reports.
# Usage: python3 tests/jam/fake_yt_host.py tests/Keystone.pdf [port] [videoId]
# Join from the Jam modal at <this-mac-ip>:<port>.
# With CDP_PORT set (e.g. an adb-forwarded Android WebView), also samples the client's actual
# video position and logs it against the host timeline (error bound = half the CDP round trip).
import asyncio, base64, hashlib, json, os, sys, time, urllib.request
import websockets

SONG = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 47900
VIDEO = sys.argv[3] if len(sys.argv) > 3 else "M7lc1UVf-VE"
CHUNK = 512 * 1024
data = open(SONG, 'rb').read()
name = SONG.split('/')[-1]
ext = name.rsplit('.', 1)[-1].lower()
song = {"id": hashlib.sha256(data).hexdigest(), "title": name.rsplit('.', 1)[0], "fileName": name,
        "size": len(data), "type": "gp" if ext.startswith("gp") else ext}

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

class Video:
    video_id = None
    playing = False
    base_sec = 0.0
    at = 0.0
    def pos(self):
        return self.base_sec + ((now() - self.at) / 1000 if self.playing else 0)
    def state(self):
        return {"videoId": self.video_id, "playing": self.playing, "timeSec": round(self.pos(), 3), "rate": 1}

yt = Video()
finished = asyncio.Event()

PROBE = "(async()=>{const m=await import(new URL('youtubePlayer.js', document.baseURI).href); const c=await import(new URL('jam/jamCommon.js', document.baseURI).href); const s=m.jamYouTubeControl.snapshot(); return {t:s.timeSec, playing:s.playing, buffering:s.buffering, outMs:c.estimateOutputLatencyMs()+(c.loadSetting('trimMs',0)||0)}})()"

async def cdp_sampler():
    port = os.environ.get("CDP_PORT")
    if not port:
        return
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
    url = next(t["webSocketDebuggerUrl"] for t in targets if t.get("type") == "page")
    async with websockets.connect(url, max_size=None) as cdp:
        n = 0
        while True:
            await asyncio.sleep(2)
            if not yt.playing:
                continue
            n += 1
            t_send = now()
            await cdp.send(json.dumps({"id": n, "method": "Runtime.evaluate", "params": {"expression": PROBE, "returnByValue": True, "awaitPromise": True}}))
            while True:
                r = json.loads(await cdp.recv())
                if r.get("id") == n:
                    break
            t_recv = now()
            v = r.get("result", {}).get("result", {}).get("value")
            if not v or not v.get("playing") or v.get("buffering"):
                log(f"cdp client not playing: {v}")
                continue
            # The client deliberately runs ahead of the host by its output latency (host sends none).
            host_mid = yt.base_sec + ((t_send + t_recv) / 2 - yt.at) / 1000
            err = (v["t"] - host_mid) * 1000 - v["outMs"]
            log(f"cdp actual offset {err:+.0f} ms (+-{(t_recv - t_send) / 2:.0f}, client output latency {v['outMs']:.0f} ms)")

async def handler(ws):
    hello = json.loads(await ws.recv())
    log("hello", hello.get("name"))
    await ws.send(json.dumps({"v": 1, "type": "welcome", "clientId": "cTEST", "hostName": "FakeYtHost", "hostTs": now()}))
    await ws.send(msg("session.state", state={"song": song, "transport": {"playing": False, "timeMs": 0, "speed": 1}, "youtube": yt.state(), "controllerId": None, "policy": "host"}))
    ready = asyncio.Event()

    async def send_song():
        b64 = base64.b64encode(data).decode()
        parts = [b64[i:i + CHUNK] for i in range(0, len(b64), CHUNK)] or [""]
        for i, p in enumerate(parts):
            await ws.send(msg("song.data", songId=song["id"], fileName=name, part=i, parts=len(parts), b64=p))
        log(f"song.data sent in {len(parts)} parts")

    async def reader():
        async for raw in ws:
            t1 = now()
            m = json.loads(raw)
            t = m.get("type")
            if t == "ping":
                await ws.send(json.dumps({"v": 1, "type": "pong", "id": m.get("id"), "t0": m.get("t0"), "t1": t1, "t1b": now()}))
            elif t == "song.request":
                asyncio.create_task(send_song())
            elif t == "song.ready":
                log("song.ready loadMs", m.get("loadMs"))
                ready.set()
            elif t == "status":
                log(f"status state={m.get('state')} rtt={m.get('rttMs')} ytDriftMs={m.get('ytDriftMs')}  (host video {yt.pos():.2f}s {'playing' if yt.playing else 'paused'})")
            else:
                log("<-", raw[:200])

    async def heartbeats():
        while True:
            await asyncio.sleep(1)
            if yt.playing:
                await ws.send(msg("yt.state", yt=yt.state()))

    async def change(**kw):
        cur = yt.pos()
        yt.base_sec, yt.at = kw.pop("time", cur), now()
        for k, v in kw.items():
            setattr(yt, k, v)
        log(f"-> {yt.state()}")
        await ws.send(msg("yt.state", yt=yt.state()))

    async def script():
        await ready.wait()
        await asyncio.sleep(2)
        await change(video_id=VIDEO, playing=True, time=10.0)
        await asyncio.sleep(20)
        await change(time=60.0)
        await asyncio.sleep(12)
        await change(playing=False)
        await asyncio.sleep(5)
        await change(playing=True)
        await asyncio.sleep(15)
        await change(playing=False)
        await asyncio.sleep(3)
        log("done")

    tasks = [asyncio.create_task(c) for c in (reader(), heartbeats(), cdp_sampler())]
    await script()
    for t in tasks:
        t.cancel()
    finished.set()

async def main():
    async with websockets.serve(handler, "0.0.0.0", PORT, max_size=None):
        log("listening", PORT)
        await finished.wait()

asyncio.run(main())
