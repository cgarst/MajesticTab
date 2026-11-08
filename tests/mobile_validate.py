#!/usr/bin/env python3
"""Phone click-through: visit every screen at phone width and report flashes, pop-in and overflow.

It samples what is on screen every animation frame (the library view, Settings, Tools, modals, anything big that
paints) and, for each step, prints the distinct states the screen went through. A step passes when it only passes
through its start and end states. Anything else is a flash. It also checks each screen for sideways overflow and
page errors, and the first frames of a cold load.

  pip3 install playwright && playwright install chromium     (or use the installed Edge: --channel msedge)
  python3 -m http.server 8000                                 (from the repo root; needs no CORS for this)
  python3 tests/mobile_validate.py [--url http://localhost:8000/src/] [--width 390] [--height 844] [--channel msedge]

For iPhone safe areas, serve the CSS with env(safe-area-inset-*) replaced by fixed pixels (Playwright cannot set
env()). The library is seeded with sample songs through libraryStore.js, so nothing here needs a real tab.
"""
import argparse, asyncio, json, sys
from playwright.async_api import async_playwright

SAMPLER = r"""
(() => {
  window.__fl = []; let last = '';
  const area = (e) => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) return 0;
    const r = e.getBoundingClientRect(); const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)); const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); return (w * h) / (innerWidth * innerHeight); };
  const name = (e) => e.id ? '#' + e.id : '.' + (String(e.className).split(' ')[0] || e.tagName.toLowerCase());
  const tick = () => {
    if (document.body) {
      const parts = [];
      const content = document.getElementById('libraryModalContent');
      const settings = document.getElementById('fileMenu');
      const settingsOpen = settings && settings.classList.contains('show');
      if (settingsOpen) {
        parts.push('settings'); // the Settings page covers whatever is beneath it
      } else if (document.body.classList.contains('library-view-active')) {
        const view = content && ['.tools-shell', '.setlists-view', '.tunings-view', '.open-file-view', '.collection-root-view'].find((s) => content.querySelector(s));
        parts.push('lib:' + (view || 'empty'));
      } else parts.push('reader');
      for (const e of document.querySelectorAll('.theme-modal-backdrop, .offcanvas, .modal, .controls-page, [role=dialog]')) { if (area(e) > 0.15) parts.push('overlay:' + name(e)); }
      for (const e of document.body.children) { if (['SCRIPT','STYLE','LINK','NAV','DIV'].includes(e.tagName) && e.id && /Modal|Menu|Page/.test(e.id) && area(e) > 0.15 && e.id !== 'libraryPage' && e.id !== 'fileMenu') parts.push('body:' + name(e)); }
      const k = [...new Set(parts)].join(' + ');
      window.__cur = k;
      if (k !== last) { last = k; window.__fl.push([Math.round(performance.now()), k]); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""

SEED = """
async () => {
  const m = await import('/src/libraryStore.js');
  const arts = ['Haken', 'Dream Theater', 'Opeth', 'Tool', 'Porcupine Tree'];
  let n = 0;
  for (const a of arts) for (let al = 0; al < 2; al++) for (let t = 0; t < 4; t++) {
    await m.saveSongToLibrary({ title: `Song ${n} of ${a}`, artist: a, album: `Album ${al} ${a}`, year: 2010 + al, trackNumber: t + 1, tunings: ['E A D G B E'], stringCount: 6, pinned: n % 7 === 0, tabOptions: [] });
    n++;
  }
  return n;
}
"""

OVERFLOW = "() => { const d = document.documentElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed' && !e.closest('[style*=\"overflow\"], .ref-chip-row, #topBar, svg, .offcanvas, #fileMenu')) { bad.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0])); if (bad.length > 3) break; } } return { scrollW: d.scrollWidth, innerW: innerWidth, bad }; }"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://localhost:8000/src/')
    ap.add_argument('--width', type=int, default=390)
    ap.add_argument('--height', type=int, default=844)
    ap.add_argument('--channel', default=None)
    a = ap.parse_args()
    problems = []
    async with async_playwright() as p:
        b = await p.chromium.launch(channel=a.channel) if a.channel else await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': a.width, 'height': a.height}, device_scale_factor=2, is_mobile=True, has_touch=True)
        await ctx.add_init_script(SAMPLER)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
        await pg.goto(a.url); await pg.wait_for_timeout(1500)
        await pg.evaluate(SEED)
        # Cold load, with a library
        await pg.evaluate('window.__fl = []')
        await pg.reload(); await pg.wait_for_timeout(2500)
        seq = [k for _, k in await pg.evaluate('window.__fl')]
        print('cold load:', ' -> '.join(dict.fromkeys(seq)))
        for k in seq:
            if 'overlay' in k or 'body:' in k:
                problems.append(f'cold load paints {k}')

        async def step(label, action, expect_end):
            await pg.evaluate('window.__fl = []')
            start = await pg.evaluate('window.__cur')
            await action()
            await pg.wait_for_timeout(900)
            states = [start]
            for _, k in await pg.evaluate('window.__fl'):
                if k != states[-1]: states.append(k)
            ok = len(states) <= 2 and expect_end in states[-1]
            ov = await pg.evaluate(OVERFLOW)
            if ov['scrollW'] > ov['innerW'] + 1: ok = False; problems.append(f'{label}: page scrolls sideways ({ov})')
            print(('ok   ' if ok else 'FLASH'), label, '::', ' -> '.join(states))
            if not ok and len(states) > 2: problems.append(f'{label}: passed through {states}')

        tap = lambda sel: (lambda: pg.tap(sel))
        nav = lambda t: f'#libraryBottomNav [data-lib-tab={t}]'
        S = '#libraryNavSettingsBtn'
        await step('Library -> Settings', tap(S), 'settings')
        await step('Settings -> Tools', tap(nav('tools')), 'tools-shell')
        await step('Tools -> Settings', tap(S), 'settings')
        await step('Settings -> Setlists', tap(nav('setlists')), 'setlists-view')
        await step('Setlists -> Library', tap(nav('library')), 'collection-root-view')
        # Tunings is a Browse by row inside Library, not a rail or tab-bar destination
        await step('Library -> Tunings', tap('#libTuningsGroupBtn'), 'tunings-view')
        await step('Tunings -> Settings', tap(S), 'settings')
        await step('Settings -> Library', tap(nav('library')), 'collection-root-view')
        await step('Library -> Tools', tap(nav('tools')), 'tools-shell')
        await step('Tools -> Library', tap(nav('library')), 'collection-root-view')
        await step('Library -> Pinned songs', lambda: pg.tap('text=Pinned songs'), 'collection-root-view')
        await step('Pinned -> back', lambda: pg.tap('.in-view-back-btn'), 'collection-root-view')
        await step('Library -> artist', lambda: pg.tap('.artist-card >> nth=0'), 'collection-root-view')
        await step('artist -> back', lambda: pg.tap('.in-view-back-btn >> nth=0'), 'collection-root-view')
        # Search: normal search field
        box = await pg.evaluate("(() => { const r = document.querySelector('.library-search-bar').getBoundingClientRect(); return [r.width, r.height]; })()")
        print('search field:', box)
        if box[0] < 120 or box[1] < 40: problems.append(f'search field is {box}, under expected dimensions')
        # Every Settings section
        await pg.tap(S); await pg.wait_for_timeout(500)
        n = await pg.evaluate("document.querySelectorAll('#fileMenu .setnav button').length")
        for i in range(n):
            label = await pg.evaluate(f"document.querySelectorAll('#fileMenu .setnav button')[{i}].textContent.trim()")
            await step(f'Settings page: {label}', lambda i=i: pg.evaluate(f"document.querySelectorAll('#fileMenu .setnav button')[{i}].click()"), 'settings')
            await step(f'Settings page {label} -> back', lambda: pg.tap('#fileMenu .setback'), 'settings')
        await b.close()
    print('\npage errors:', errs or 'none')
    print('\nPROBLEMS:' if problems else '\nNo problems found.')
    for x in problems: print(' -', x)
    return 1 if problems else 0

sys.exit(asyncio.run(main()))
