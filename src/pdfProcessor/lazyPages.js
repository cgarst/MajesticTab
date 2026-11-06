// lazyPages.js
// On-demand page processing for long PDFs (a whole real book is hundreds of pages). Instead of rendering and condensing
// every page before the reader opens, each page gets a placeholder canvas with an estimated size. The pages near the
// reading position are processed first, in the background, and drawn into their placeholder in place, so the
// `condensedCanvases` array keeps its length and the same canvas objects. Pages far from the reader are released again
// (the canvas keeps its exact size and gets redrawn when the reader comes back).
//
// A canvas that has never been drawn to has no pixel buffer, so 500 placeholders cost almost nothing.

// A page range this long or longer is processed lazily; shorter ones (a song, a short book) are processed up front.
export const LAZY_MIN_PAGES = 24;

// How many processed pages stay in memory around the reading position.
const READY_LIMIT = 24;

let active = null;

export function getActiveLazy() {
  return active;
}

export function disposeActiveLazy() {
  if (active) active.dispose();
  active = null;
}

/** The size a canvas should be laid out at. A lazy canvas keeps its size here even while its pixels are released. */
export function canvasSize(canvas) {
  const l = canvas._lazy;
  return l ? { w: l.w, h: l.h } : { w: canvas.width, h: canvas.height };
}

function fitBox(canvas) {
  const l = canvas._lazy;
  // The pixel buffer can be empty while the page is waiting or released; the CSS ratio keeps the box the right shape.
  if (l && l.w > 0 && l.h > 0) canvas.style.aspectRatio = `${l.w} / ${l.h}`;
}

class LazyPages {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement[]} o.canvases Array to fill with one placeholder per page
   * @param {number} o.firstPage 1-based number of the first page
   * @param {number} o.count Number of pages
   * @param {{w:number,h:number}} o.estimate Size used until a page is processed
   * @param {(pageNum:number)=>Promise<HTMLCanvasElement>} o.renderPage Produces the finished canvas for a page
   * @param {()=>void} [o.onChange] Called when processed pages changed size (the layout needs redoing)
   */
  constructor({ canvases, firstPage, count, estimate, renderPage, onChange }) {
    this.canvases = canvases;
    this.count = count;
    this.renderPage = renderPage;
    this.onChange = onChange;
    this.pages = [];
    this.queue = [];
    this.waiters = new Map();
    this.focus = 0;
    this.from = 0;
    this.to = -1;
    this.running = false;
    this.disposed = false;
    this.resized = false;
    this.observer = null;
    this.visible = new Set();
    this.lazy = true;

    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas');
      c.width = estimate.w;
      c.height = estimate.h;
      c._lazy = { index: i, pageNum: firstPage + i, w: estimate.w, h: estimate.h, state: 'pending', failed: false };
      fitBox(c);
      this.pages.push(c);
      canvases.push(c);
    }
  }

  isReady(i) {
    return this.pages[i]?._lazy.state === 'ready';
  }

  /** Resolves once page `i` (0-based within the range) is drawn. */
  materialize(i) {
    const c = this.pages[i];
    if (!c || this.disposed) return Promise.resolve();
    if (c._lazy.state === 'ready') return Promise.resolve();
    c._lazy.failed = false;
    return new Promise((resolve) => {
      const list = this.waiters.get(i) || [];
      list.push(resolve);
      this.waiters.set(i, list);
      this.queue = [i, ...this.queue.filter((x) => x !== i)];
      this.pump();
    });
  }

  /** Keep pages from..to processed, nearest to `focus` first (looking ahead before looking back). */
  setWindow(from, to, focus = from) {
    if (this.disposed) return;
    this.from = Math.max(0, from);
    this.to = Math.min(this.count - 1, to);
    this.focus = Math.max(0, Math.min(this.count - 1, focus));
    const wanted = [];
    for (let i = this.from; i <= this.to; i++) {
      const l = this.pages[i]._lazy;
      if (l.state === 'pending' && !l.failed) wanted.push(i);
    }
    const dist = (i) => (i >= this.focus ? i - this.focus : this.focus - i + 0.5);
    wanted.sort((a, b) => dist(a) - dist(b));
    const pinned = [...this.waiters.keys()];
    this.queue = [...pinned, ...wanted.filter((i) => !this.waiters.has(i))];
    this.evict();
    this.pump();
  }

  evict() {
    const ready = [];
    for (let i = 0; i < this.count; i++) {
      if (this.pages[i]._lazy.state === 'ready') ready.push(i);
    }
    if (ready.length <= READY_LIMIT) return;
    const outside = ready
      .filter((i) => i < this.from || i > this.to)
      .sort((a, b) => Math.abs(b - this.focus) - Math.abs(a - this.focus));
    let excess = ready.length - READY_LIMIT;
    for (const i of outside) {
      if (excess <= 0) break;
      this.release(i);
      excess--;
    }
  }

  release(i) {
    const c = this.pages[i];
    if (!c || c._lazy.state !== 'ready') return;
    // Never blank a page the reader is looking at
    if (i >= this.from && i <= this.to) return;
    // Zero size frees the pixel buffer; _lazy keeps the layout size and fitBox keeps the box shape
    c.width = 0;
    c.height = 0;
    c._lazy.state = 'pending';
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const i = this.queue.shift();
        const c = this.pages[i];
        if (!c || c._lazy.state !== 'pending') continue;
        c._lazy.state = 'busy';
        let final = null;
        try {
          final = await this.renderPage(c._lazy.pageNum);
          if (this.disposed) return;
          if (final !== c) {
            c.width = final.width;
            c.height = final.height;
            c.getContext('2d').drawImage(final, 0, 0);
            final.width = 0;
            final.height = 0;
          }
          const l = c._lazy;
          if (l.w !== c.width || l.h !== c.height) this.resized = true;
          l.w = c.width;
          l.h = c.height;
          l.state = 'ready';
          fitBox(c);
        } catch (e) {
          console.warn('Page processing failed:', c._lazy.pageNum, e);
          c._lazy.state = 'pending';
          c._lazy.failed = true;
        }
        const waiting = this.waiters.get(i);
        if (waiting) {
          this.waiters.delete(i);
          waiting.forEach((r) => r());
        }
        // Let the reader stay responsive between pages
        await new Promise((r) => setTimeout(r, 0));
        if (!this.queue.length) this.evict();
      }
    } finally {
      this.running = false;
    }
    if (this.resized && !this.disposed) {
      this.resized = false;
      this.onChange?.();
    }
  }

  /** Continuous mode: process the pages on screen and a few either side as the reader scrolls. */
  observe(root) {
    this.unobserve();
    if (typeof IntersectionObserver === 'undefined') {
      this.setWindow(0, this.count - 1, 0);
      return;
    }
    this.visible = new Set();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const idx = e.target._lazy?.index;
        if (idx == null) continue;
        if (e.isIntersecting) this.visible.add(idx);
        else this.visible.delete(idx);
      }
      if (!this.visible.size) return;
      const list = [...this.visible];
      const lo = Math.min(...list);
      const hi = Math.max(...list);
      this.setWindow(lo - 2, hi + 4, lo);
    }, { root, rootMargin: '100% 0px 100% 0px' });
    this.pages.forEach((c) => this.observer.observe(c));
  }

  unobserve() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.visible = new Set();
  }

  dispose() {
    this.disposed = true;
    this.unobserve();
    this.queue = [];
    this.waiters.forEach((list) => list.forEach((r) => r()));
    this.waiters.clear();
    this.pages.forEach((c) => {
      if (c._lazy.state === 'ready') {
        c.width = 0;
        c.height = 0;
      }
    });
    if (active === this) active = null;
  }
}

export function createLazyPages(options) {
  disposeActiveLazy();
  active = new LazyPages(options);
  return active;
}
