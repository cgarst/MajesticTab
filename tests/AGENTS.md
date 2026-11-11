# Test procedures

Read when running the app, driving it over CDP or debugging.

## Local dev server and debug Edge

Serve from the project root, then open the app with a fixture via `?test=<filename>` (auto-loads from `tests/`, bypassing the file picker):

```bash
python3 -m http.server 8000
/Applications/Microsoft\ Edge.app/Contents/MacOS/Microsoft\ Edge \
  --remote-debugging-port=9333 --user-data-dir=/tmp/edge-debug \
  "http://localhost:8000/src/?test=Duo%20No%202%20In%20G%20Major.gp5" >/dev/null 2>&1 &
```

Ports 9222/9223 are often held by `adb` forwards (`lsof -i :<port>`), and if a normal Edge is already running the flags are ignored, so quit it first. Stop with `pkill -f /tmp/edge-debug`.

Never put a `.gp*` file or tab PDF in the served repo root to test a download. Serve it from a second directory on another port (see Repository Content Rules).

Fixtures: `Duo No 2 In G Major.gp5`, `Haken - 1985.gp5` and `nightterror.gp5` (large GP5), `octavarium.gp3` (GP3). Add new cases to `tests/`.

## Testing with a `.mtab` song bundle

`?test=` does not open `.mtab` files. To test with a bundle (for example one the user points at, such as in `~/Documents`), serve a copy from a directory outside the repo with CORS on another port, then call `openMtab` from the page through `tests/cdp.py`. A plain `python3 -m http.server` sends no CORS header, so write a small handler that adds `Access-Control-Allow-Origin: *` (keep it in the scratchpad, not the repo):

```bash
mkdir -p $SCRATCH/fx && cp "/path/to/song.mtab" $SCRATCH/fx/song.mtab
python3 $SCRATCH/corsserve.py $SCRATCH/fx 8001 &     # SimpleHTTPRequestHandler + the CORS header; check `lsof -i :8001` for a stale server first
python3 tests/cdp.py eval "(() => { window.__r='pending'; (async()=>{ try {
  const b = await (await fetch('http://localhost:8001/song.mtab')).blob();
  const m = await import('/src/mtab.js');
  await m.openMtab(new File([b], 'song.mtab'));
  await new Promise(r => setTimeout(r, 3500));
  window.__r = 'opened';
} catch (e) { window.__r = 'ERR ' + e.message } })(); return 1 })()"
python3 tests/cdp.py eval "window.__r"                # eval does not await: poll the global
```

`openMtab` loads the tab and attaches the bundle's recordings, but the song has no `librarySongId`. To test audio that the bulk import attached, seed it as the import does: `saveAudioFile(...)` then `attachLibraryAudio({ id, artist, title }, meta.id, 'original')` (`src/audioSync/libraryAudio.js`), reload and open the bundle again. A bundle is a copyrighted tab: keep the extracted `.gp` and the bundle out of the repo.

## Debugging workflow

- **Reproduce first:** script the user's literal steps (e.g. scroll, then click, then read cursor/tick state) and confirm it fails before editing. Re-run after the fix. No speculative fixes.
- **Use `tests/cdp.py`, not one-off websocket scripts.** Batch several probes into one `eval`. Set `CDP_PORT` if not 9333.
  ```bash
  python3 tests/cdp.py reload
  python3 tests/cdp.py logs                # reload and print console output/exceptions
  python3 tests/cdp.py eval "(() => ({ tick: window.gpState.canvases[0].api.tickPosition }))()"
  python3 tests/cdp.py screenshot /tmp/shot.png
  ```
  Wait for the `[GP Mode Switch] Page mode rendered` log before screenshotting. Screenshots are at device pixel ratio (2x on Retina).
- **Do not grep `build/`** (Rust/Android binaries and large artifacts); restrict searches to `src/`.
- **Stop after two failed approaches:** re-read the code path and compare its assumptions against the library's actual behavior instead of probing minified code.
- **Ignore known noise:** `Unchecked runtime.lastError`, `Tracking Prevention blocked access to storage for cdn.*`, and `AlphaTab container was invisible while autosizing`.
