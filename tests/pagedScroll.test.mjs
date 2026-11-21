// Run: node tests/pagedScroll.test.mjs
import assert from 'node:assert/strict';
import { easeOut, createGlide, lineNeedsTurn, isLastLine, PAGE_GLIDE_MS } from '../src/utils/pagedScroll.js';

assert.equal(easeOut(0), 0);
assert.equal(easeOut(1), 1);
assert.ok(easeOut(0.2) > 0.5, 'front-loaded');
for (let i = 1; i <= 20; i++) assert.ok(easeOut(i / 20) >= easeOut((i - 1) / 20));

const g = createGlide();
assert.equal(g.step(0), null);
g.start(100, 400, 1000);
assert.ok(g.active && g.to === 400);
const mid = g.step(1000 + PAGE_GLIDE_MS / 2);
assert.ok(mid > 250 && mid < 400, `mid ${mid}`);
assert.equal(g.step(1000 + PAGE_GLIDE_MS), 400);
assert.ok(!g.active);

const v = { usableTop: 0, usableBottom: 700 };
assert.equal(lineNeedsTurn({ top: 500, bottom: 640, ...v }), false);   // fits
assert.equal(lineNeedsTurn({ top: 600, bottom: 740, ...v }), true);    // runs past the bottom
assert.equal(lineNeedsTurn({ top: -20, bottom: 120, ...v }), true);    // above the top
assert.equal(lineNeedsTurn({ top: 100, bottom: 900, ...v }), false);   // taller than a page: not paged
assert.equal(isLastLine({ bottom: 640, nextBottom: 790, usableBottom: 700 }), true);
assert.equal(isLastLine({ bottom: 480, nextBottom: 630, usableBottom: 700 }), false);
assert.equal(isLastLine({ bottom: 640, nextBottom: null, usableBottom: 700 }), false);
console.log('pagedScroll ok');
