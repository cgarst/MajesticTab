// pdfProcessor.js

import { CONFIG } from './config.js';
import { detectStaffGroups } from './staffDetector.js';
import { detectIndividualStaves } from './individualStaffDetector.js';
import { detectDigits } from './digitDetector.js';
import { detectStems } from './stemDetector.js';
import { detectCopyright } from './copyrightDetector.js';
import { detectMargins } from './marginDetector.js';
import { detectLeftMargins } from './leftMarginDetector.js';
import { renderCondensedCanvas } from './condenseRenderer.js';
import { clearOutput, updatePageIndicator } from '../utils/renderUtils.js';
import { updateProgress } from '../utils/fileHandlingUtils.js';

const canvasCache = new WeakMap();

export async function processPDF(file, { debugMode, originalMode, progressContainer, progressBar, condensedCanvases, onCanvasRendered, abortSignal, pageModeRadio, continuousModeRadio }) {
  condensedCanvases.length = 0;
  progressBar.classList.add('indeterminate');
  progressContainer.style.display = 'block';
  
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  // Switch to determinate progress bar now that we know the total pages
  progressBar.classList.remove('indeterminate');
  progressBar.style.width = '0%';

  if (!canvasCache.has(file)) canvasCache.set(file, { debug: [], normal: [], original: [] });
  const fileCache = canvasCache.get(file);
  const cacheKey = debugMode.checked ? 'debug' : (originalMode?.checked ? 'original' : 'normal');
  let copyrightCanvasMemory = null;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    if (abortSignal?.aborted) return;

    // Return cached canvas if exists
    if (fileCache[cacheKey][pageNum - 1]) {
      const cachedCanvas = fileCache[cacheKey][pageNum - 1];
      condensedCanvases.push(cachedCanvas);
      onCanvasRendered(cachedCanvas);
      updateProgress(progressBar, (pageNum / pdf.numPages * 100));
      continue;
    }

    // Render PDF page
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    if (onCanvasRendered) onCanvasRendered(canvas);

    if (originalMode?.checked) {
      // In originalMode, just return the page as-is
      condensedCanvases.push(canvas);
      fileCache[cacheKey][pageNum - 1] = canvas;
      onCanvasRendered(canvas);
      progressBar.style.width = `${(pageNum / pdf.numPages * 100).toFixed(1)}%`;
      continue;
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Detect staff groups & individual staves
    const { staffGroups, groupVerticalRuns } = detectStaffGroups(imageData, canvas.width, canvas.height, CONFIG, debugMode, ctx);
    const stavesByGroup = staffGroups.map(group =>
      detectIndividualStaves(imageData, canvas.width, group, Math.floor(canvas.width * 0.9), CONFIG, debugMode, ctx)
    );

    // Detect digits, stems, notes
    stavesByGroup.forEach(staves => {
      staves.forEach((s, si) => {
        const hasDigits = detectDigits(ctx, imageData.data, canvas.width, canvas.height, s, CONFIG, debugMode);
        let candidateRuns = [], hasStemNotes = false;

        if (CONFIG.FIND_STEMS_IF_NO_DIGITS || hasDigits) {
          const nextStaffTop = si < staves.length - 1 ? staves[si + 1].start : canvas.height;
          candidateRuns = detectStems(ctx, imageData.data, canvas.width, canvas.height, s, nextStaffTop, CONFIG, debugMode);
          hasStemNotes = candidateRuns.length > 0;
        }

        s.hasDigits = hasDigits;
        s.hasStems = hasStemNotes;
        s.hasNotes = CONFIG.USE_STEMS_FOR_DECISION ? hasDigits || hasStemNotes : hasDigits;
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
    const { keptMargins, betweenGroupSections } = detectMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, CONFIG, debugMode);

    if (debugMode?.checked) {
      detectLeftMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, CONFIG, debugMode, false);
    }

    const leftMarginLines = detectLeftMargins(ctx, staffGroups, stavesByGroup, groupVerticalRuns, CONFIG, debugMode, true);

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
        CONFIG,
        debugMode
      });
    } else {
      finalCanvas = canvas;
    }

    condensedCanvases.push(finalCanvas);
    fileCache[cacheKey][pageNum - 1] = finalCanvas;
    onCanvasRendered(finalCanvas);

    updateProgress(progressBar, (pageNum / pdf.numPages * 100));

    // Detect bottom-of-page copyright for first page
    if (pageNum === 1 && !debugMode.checked) {
      try {
        const lastGroupBottom = Math.max(...stavesByGroup.flat().map(s => s.end + CONFIG.EXTRA_BOTTOM_PADDING));
        copyrightCanvasMemory = detectCopyright(ctx, canvas.width, canvas.height, lastGroupBottom);
      } catch (e) {
        console.warn('Copyright detection failed:', e);
      }
    }
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

  progressContainer.style.display = 'none';
}
