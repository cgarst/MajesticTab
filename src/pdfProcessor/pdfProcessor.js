// pdfProcessor.js

import { CONFIG, createScaledConfig } from './config.js';
import { detectStaffGroups } from './staffDetector.js';
import { detectIndividualStaves } from './individualStaffDetector.js';
import { detectDigits } from './digitDetector.js';
import { detectStems } from './stemDetector.js';
import { detectCopyright } from './copyrightDetector.js';
import { detectMargins } from './marginDetector.js';
import { detectLeftMargins } from './leftMarginDetector.js';
import { renderCondensedCanvas } from './condenseRenderer.js';
import { createLazyPages, disposeActiveLazy, LAZY_MIN_PAGES } from './lazyPages.js';

const canvasCache = new WeakMap();

// Render one PDF page and, unless it is the original-pages view, condense it. Returns the finished canvas, plus the
// bottom-of-page copyright strip when this is page 1 (kept to append at the end).
async function processSinglePage(pdf, pageNum, config, debugMode, originalMode, abortSignal) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: config.SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  if (abortSignal?.aborted) return { canvas: null };

  if (originalMode?.checked) return { canvas };

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Detect staff groups & individual staves
  const { staffGroups, groupVerticalRuns } = detectStaffGroups(imageData, canvas.width, canvas.height, config, debugMode, ctx);
  const stavesByGroup = staffGroups.map(group =>
    detectIndividualStaves(imageData, canvas.width, group, Math.floor(canvas.width * 0.9), config, debugMode, ctx)
  );

  // Detect digits, stems, notes
  stavesByGroup.forEach(staves => {
    staves.forEach((s, si) => {
      const hasDigits = detectDigits(ctx, imageData.data, canvas.width, canvas.height, s, config, debugMode);
      let candidateRuns = [], hasStemNotes = false;

      if (config.FIND_STEMS_IF_NO_DIGITS || hasDigits) {
        const nextStaffTop = si < staves.length - 1 ? staves[si + 1].start : canvas.height;
        candidateRuns = detectStems(ctx, imageData.data, canvas.width, canvas.height, s, nextStaffTop, config, debugMode);
        hasStemNotes = candidateRuns.length > 0;
      }

      s.hasDigits = hasDigits;
      s.hasStems = hasStemNotes;
      s.hasNotes = config.USE_STEMS_FOR_DECISION ? hasDigits || hasStemNotes : hasDigits;
      s.candidateRuns = candidateRuns;

      // small dot for debug
      if (debugMode.checked) {
        ctx.fillStyle = s.hasNotes ? 'green' : 'red';
        ctx.beginPath();
        ctx.arc(canvas.width - 15, (s.start + s.end) / 2, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  });

  // Detect margins and inter-group sections
  const { keptMargins, betweenGroupSections } = detectMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, config, debugMode);

  if (debugMode?.checked) {
    detectLeftMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, config, debugMode, false);
  }

  const leftMarginLines = detectLeftMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, config, debugMode, true);

  // Create condensed canvas
  let finalCanvas;
  if (!debugMode.checked && (keptMargins.length || betweenGroupSections.length)) {
    const trimmedSections = [
      ...keptMargins.map(m => ({ trimTop: m.marginTop, trimBottom: m.marginBottom })),
      ...betweenGroupSections.map(s => ({ trimTop: s.start, trimBottom: s.end }))
    ].sort((a, b) => a.trimTop - b.trimTop);

    finalCanvas = renderCondensedCanvas({
      originalCtx: ctx,
      canvasWidth: canvas.width,
      trimmedSections,
      leftMarginLines,
      CONFIG: config,
      debugMode
    });
  } else {
    finalCanvas = canvas;
  }

  let copyright = null;
  if (pageNum === 1 && !debugMode.checked) {
    try {
      const lastGroupBottom = Math.max(...stavesByGroup.flat().map(s => s.end + config.EXTRA_BOTTOM_PADDING));
      copyright = detectCopyright(ctx, canvas.width, canvas.height, lastGroupBottom);
    } catch (e) {
      console.warn('Copyright detection failed:', e);
    }
  }

  return { canvas: finalCanvas, copyright };
}

/**
 * Read a PDF into `condensedCanvases`.
 *
 * A short page range is processed up front, page by page, and `onCanvasRendered` fires for each canvas. A long one
 * (see LAZY_MIN_PAGES) gets one placeholder canvas per page and only the first page is processed before this resolves;
 * the rest are processed on demand through the returned controller (see lazyPages.js), and `onLazyChange` fires when
 * processed pages changed size so the caller can redo its layout. Resolves to that controller, or null when eager.
 */
export async function processPDF(file, { debugMode, originalMode, onProgress, condensedCanvases, onCanvasRendered, onPdfLoaded, onLazyChange, abortSignal, scale, startPage, endPage }) {
  // Create a scaled config if a custom scale is provided
  const config = scale ? createScaledConfig(scale) : CONFIG;

  // The page loads pdf.min.js from the CDN; name its worker too so parsing never falls back to the main thread
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  disposeActiveLazy();
  condensedCanvases.length = 0;
  onProgress?.(5, 'Reading file…');

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false }).promise;
  if (abortSignal?.aborted) return null;

  if (typeof onPdfLoaded === 'function') {
    onPdfLoaded(pdf);
  }

  const actualStart = Math.max(1, Math.min(pdf.numPages, parseInt(startPage || file.startPage || 1, 10)));
  const actualEnd = Math.max(actualStart, Math.min(pdf.numPages, parseInt(endPage || file.endPage || pdf.numPages, 10)));
  const totalRangePages = actualEnd - actualStart + 1;

  onProgress?.(15, 'Reading pages…');

  if (totalRangePages >= LAZY_MIN_PAGES) {
    return processLazily(pdf, { config, debugMode, originalMode, onProgress, condensedCanvases, onLazyChange, abortSignal, actualStart, totalRangePages });
  }

  if (!canvasCache.has(file)) canvasCache.set(file, { debug: [], normal: [], original: [] });
  const fileCache = canvasCache.get(file);
  const cacheKey = debugMode.checked ? 'debug' : (originalMode?.checked ? 'original' : 'normal');
  let copyrightCanvasMemory = null;

  for (let pageNum = actualStart; pageNum <= actualEnd; pageNum++) {
    if (abortSignal?.aborted) return null;
    // Yield to the event loop so the UI stays responsive
    await new Promise(resolve => setTimeout(resolve, 0));
    if (abortSignal?.aborted) return null;
    const progressPercent = ((pageNum - actualStart + 1) / totalRangePages * 100);

    // Return cached canvas if exists
    if (fileCache[cacheKey][pageNum - 1]) {
      const cachedCanvas = fileCache[cacheKey][pageNum - 1];
      condensedCanvases.push(cachedCanvas);
      onCanvasRendered(cachedCanvas);
      onProgress?.(15 + progressPercent * 0.85, `Reading pages ${pageNum - actualStart + 1} of ${totalRangePages}…`);
      continue;
    }

    const { canvas: finalCanvas, copyright } = await processSinglePage(pdf, pageNum, config, debugMode, originalMode, abortSignal);
    if (abortSignal?.aborted || !finalCanvas) return null;

    condensedCanvases.push(finalCanvas);
    fileCache[cacheKey][pageNum - 1] = finalCanvas;
    onCanvasRendered(finalCanvas);

    onProgress?.(15 + progressPercent * 0.85, `Reading pages ${pageNum - actualStart + 1} of ${totalRangePages}…`);

    if (copyright) copyrightCanvasMemory = copyright;
  }

  // Append copyright canvas at end if it exists and we're not in debug mode
  if (copyrightCanvasMemory && !debugMode.checked) {
    try {
      condensedCanvases.push(copyrightCanvasMemory);
      fileCache[cacheKey].push(copyrightCanvasMemory);
      onCanvasRendered(copyrightCanvasMemory);
    } catch (e) {
      console.warn('Failed to add copyright canvas:', e);
    }
  }
  return null;
}

async function processLazily(pdf, { config, debugMode, originalMode, onProgress, condensedCanvases, onLazyChange, abortSignal, actualStart, totalRangePages }) {
  // One page's size stands in for all of them until each is processed
  const first = await pdf.getPage(actualStart);
  const vp = first.getViewport({ scale: config.SCALE });
  first.cleanup();
  const estimate = { w: Math.round(vp.width), h: Math.round(vp.height) };

  let copyrightCanvasMemory = null;
  const lazy = createLazyPages({
    canvases: condensedCanvases,
    firstPage: actualStart,
    count: totalRangePages,
    estimate,
    onChange: onLazyChange,
    renderPage: async (pageNum) => {
      const { canvas, copyright } = await processSinglePage(pdf, pageNum, config, debugMode, originalMode, abortSignal);
      if (copyright && !copyrightCanvasMemory) copyrightCanvasMemory = copyright;
      if (!canvas) throw new Error('aborted');
      return canvas;
    }
  });

  onProgress?.(30, 'Reading the first page…');
  lazy.setWindow(0, 4, 0);
  await lazy.materialize(0);
  if (abortSignal?.aborted) {
    lazy.dispose();
    return null;
  }

  // The bottom-of-page copyright strip from page 1 goes at the end, as for short files
  if (copyrightCanvasMemory && !debugMode.checked) condensedCanvases.push(copyrightCanvasMemory);
  return lazy;
}

