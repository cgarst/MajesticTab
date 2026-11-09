#!/usr/bin/env python3
"""Checks the YouTube video sheet against the player rules (see "The video sheet" in AGENTS.md).

Needs the dev server on :8000 and the debug Edge with the Duo fixture open (see AGENTS.md, Local Dev Server and Debug Edge).
Run it as is for the window's own size, or with CDP_VIEWPORT=390x844 for a phone, CDP_VIEWPORT=1440x900 CDP_MOBILE=0 for desktop.
Each state is asserted: open (the player is at least 200 x 200, on the screen, not covered), the peek (a slice stays on the screen and
the player keeps its full height), the Original panel (opening it pauses the audio and hides the video; play closes it and brings the video back), and close.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))

JS = r"""
(async () => {
  const sheet = await import('/src/ytSheet.js');
  const yt = await import('/src/youtubePlayer.js');
  const nav = await import('/src/utils/navigationUtils.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const info = () => {
    const w = document.getElementById('ytPlayerWrapper').getBoundingClientRect();
    const f = document.getElementById('ytIframe').getBoundingClientRect();
    const cx = w.left + w.width / 2, cy = w.top + w.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return { wrap: [Math.round(w.width), Math.round(w.height)], iframe: [Math.round(f.width), Math.round(f.height)],
             covered: Boolean(top && !document.getElementById('ytPlayerWrapper').contains(top)), state: sheet.getSheetState(),
             visible: sheet.visibleVideoRect() };
  };
  sheet.closeSheet(); sheet.resetPeek();
  yt.jamYouTubeControl.load('aqz-KE-bpKQ', { playing: true });
  await wait(1500);
  out.open = info();
  sheet.setPeek(true); await wait(700);
  out.peek = info();
  sheet.setPeek(false); await wait(700);
  const btn = [...document.querySelectorAll('#mobileYtToggleBtn,#ytToggleBtn')].find((b) => b.getClientRects().length);
  btn.click(); await wait(900);
  out.panel = { sheet: sheet.getSheetState(), playing: yt.playerState.isPlaying, panelOpen: yt.playerState.isOpen };
  nav.handleGlobalPlayPause(); await wait(1200);
  out.afterPlay = { sheet: sheet.getSheetState(), playing: yt.playerState.isPlaying, panelOpen: yt.playerState.isOpen };
  sheet.closeSheet(); await wait(500);
  out.closed = { state: sheet.getSheetState(), h: getComputedStyle(document.documentElement).getPropertyValue('--yt-sheet-h').trim() };
  return out;
})()
"""

def main():
    r = subprocess.run([sys.executable, os.path.join(HERE, 'cdp.py'), 'eval', JS], capture_output=True, text=True)
    if r.returncode:
        print(r.stdout, r.stderr); return 1
    d = json.loads(r.stdout)
    bad = []
    o, k, p, c = d['open'], d['peek'], d['panel'], d['closed']
    if o['state'] != 'open': bad.append(f"playing did not open the sheet: {o['state']}")
    if min(o['wrap']) < 200 or min(o['iframe']) < 200: bad.append(f"player under 200 x 200 when open: {o['wrap']} / {o['iframe']}")
    if o['covered']: bad.append('something covers the player when open')
    if k['state'] != 'peek': bad.append(f"peek state is {k['state']}")
    elif not k['visible'] or k['visible']['height'] < 40: bad.append(f"peek slice too small: {k['visible']}")
    elif k['visible']['fullHeight'] < 200: bad.append(f"the player shrank in the peek: {k['visible']}")
    if p['sheet'] != 'hidden' or p['playing'] or not p['panelOpen']: bad.append(f"opening the Original panel must pause and hide the video: {p}")
    a2 = d['afterPlay']
    if a2['sheet'] != 'open' or not a2['playing'] or a2['panelOpen']: bad.append(f"play must close the panel and bring the video back: {a2}")
    if c['state'] != 'hidden' or c['h'] != '0px': bad.append(f"closing left the sheet: {c}")
    print(json.dumps(d, indent=1))
    print('\nPROBLEMS:\n- ' + '\n- '.join(bad) if bad else '\nNo problems found.')
    return 1 if bad else 0

if __name__ == '__main__':
    sys.exit(main())
