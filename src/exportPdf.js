import { getCurrentFile, getCondensedCanvases } from './main.js';
import { getActiveLazy } from './pdfProcessor/lazyPages.js';
import { gpState } from './gpProcessor/gpHandler.js';
import { showToast } from './utils/toast.js';
import { isIOSDevice } from './utils/iosAudioUnlock.js';

let cachedAlphaTabFontCssPromise = null;
async function getAlphaTabFontCss() {
  if (cachedAlphaTabFontCssPromise) return cachedAlphaTabFontCssPromise;
  cachedAlphaTabFontCssPromise = (async () => {
    const rules = [];

    if (typeof document !== 'undefined' && document.styleSheets) {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            const text = rule.cssText || '';
            if (text.includes('alphaTab') && (text.includes('@font-face') || text.includes('font-family'))) {
              rules.push(text);
            }
          }
        } catch (error) {
          // Ignore cross-origin stylesheets and other inaccessible rules.
        }
      }
    }

    let embeddedFont = '';
    try {
      const fontUrl = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff2';
      const response = await fetch(fontUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach(byte => {
          binary += String.fromCharCode(byte);
        });
        embeddedFont = `data:font/woff2;base64,${btoa(binary)}`;
      }
    } catch (error) {
      console.warn('[PDF Export] Could not preload AlphaTab font; falling back to remote URL.', error);
    }

    const src = embeddedFont
      ? `url('${embeddedFont}') format('woff2')`
      : `url('https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff2') format('woff2'), url('https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.woff') format('woff'), url('https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/font/Bravura.otf') format('opentype')`;

    const baseCss = `
        @font-face {
          font-family: 'alphaTab';
          src: ${src};
          font-weight: normal;
          font-style: normal;
        }
        svg, text, tspan, textPath { font-family: 'alphaTab'; }
      `;

    if (rules.length === 0) {
      return baseCss;
    }

    return `${rules.join('\n')}\n${baseCss}`;
  })();
  return cachedAlphaTabFontCssPromise;
}

async function svgToImage(svgElement, width, height, viewBox) {
  const svgClone = svgElement.cloneNode(true);
  if (!svgClone.getAttribute('xmlns')) {
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (viewBox) {
    svgClone.setAttribute('viewBox', viewBox);
  }
  svgClone.setAttribute('width', width.toString());
  svgClone.setAttribute('height', height.toString());

  // Preserve the AlphaTab music-font context. The SVG root itself is not the
  // font-bearing node: SMuFL glyph text elements inherit from the AlphaTab font
  // family and percentage-based font sizes. If the cloned root reverts to the
  // generic SVG/system font, the exported glyphs disappear or render as blank boxes.
  const glyphText = Array.from(svgElement.querySelectorAll('text')).find(text => {
    const style = text.getAttribute('style') || '';
    return /font-size:\s*[\d.]+%/.test(style);
  });
  const rootFontSize = glyphText ? '36px' : '36px';
  svgClone.style.fontSize = rootFontSize;
  svgClone.style.fontFamily = 'alphaTab';
  svgClone.style.lineHeight = 'normal';

  // Keep the AlphaTab font family and font-face definitions in the exported SVG.
  // Embed the Bravura font as a data URI so the export remains self-contained and
  // does not rely on a live network fetch or viewer font fallback when the PDF is opened.
  const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  fontStyle.textContent = await getAlphaTabFontCss();
  svgClone.insertBefore(fontStyle, svgClone.firstChild);

  svgClone.style.filter = 'none';
  svgClone.style.background = 'transparent';

  const xml = new XMLSerializer().serializeToString(svgClone);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();

  await new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
  URL.revokeObjectURL(url);
  return img;
}

/**
 * Renders AlphaTab SVG blocks from a container into a jsPDF A4 document.
 * Returns the jsPDF instance, or null if there are no blocks or if aborted.
 */
export async function renderContainerToPdfDoc(container, { jsPDF = (typeof window !== 'undefined' ? window.jspdf?.jsPDF : null), onProgress, abortSignal } = {}) {
  if (!container) return null;

  const blocks = Array.from(container.querySelectorAll('div.at-surface.at > div'));
  if (blocks.length === 0) return null;

  const A4_WIDTH = 1240;
  const A4_HEIGHT = 1754; // A4 @ ~150 DPI (~1.414 aspect ratio)
  const MARGIN_X = 50;
  const MARGIN_Y = 50;
  const CONTENT_WIDTH = A4_WIDTH - (MARGIN_X * 2);
  const CONTENT_HEIGHT = A4_HEIGHT - (MARGIN_Y * 2);
  const SPACING = 15;

  // Group blocks into A4 pages based on exact height
  const pages = [];
  let curPage = [];
  let curY = 0;

  for (const block of blocks) {
    if (abortSignal?.aborted) return null;
    const svg = block.querySelector('svg');
    if (!svg) continue;

    let minX = 0;
    let minY = 0;
    let vbWidth = 1200;
    let vbHeight = 100;

    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(parseFloat);
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        minX = parts[0];
        minY = parts[1];
        vbWidth = parts[2];
        vbHeight = parts[3];
      }
    } else {
      vbWidth = parseFloat(svg.getAttribute('width')) || block.clientWidth || container.clientWidth || 1200;
      vbHeight = parseFloat(svg.getAttribute('height')) || block.clientHeight || 100;
    }

    const pt = parseFloat(block.style.paddingTop) || 0;
    if (pt > 0 && minY >= 0) {
      minY = -pt;
      vbHeight += pt;
    }

    const viewBoxStr = `${minX} ${minY} ${vbWidth} ${vbHeight}`;
    const blockHeight = (vbHeight / vbWidth) * CONTENT_WIDTH;

    if (curY + blockHeight > CONTENT_HEIGHT && curPage.length > 0) {
      pages.push(curPage);
      curPage = [];
      curY = 0;
    }
    curPage.push({ svg, blockHeight, viewBoxStr });
    curY += blockHeight + SPACING;
  }
  if (curPage.length > 0) {
    pages.push(curPage);
  }

  if (pages.length === 0) return null;

  const PDFClass = jsPDF || (typeof window !== 'undefined' ? window.jspdf?.jsPDF : null);
  if (!PDFClass) throw new Error('jsPDF library not available');
  const pdf = new PDFClass({ unit: 'px', format: 'a4', orientation: 'portrait', compress: true });
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = pdf.internal.pageSize.getHeight();

  for (let p = 0; p < pages.length; p++) {
    if (abortSignal?.aborted) return null;
    const canvas = document.createElement('canvas');
    canvas.width = A4_WIDTH;
    canvas.height = A4_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

    let drawY = MARGIN_Y;
    for (const item of pages[p]) {
      if (abortSignal?.aborted) return null;
      try {
        const img = await svgToImage(item.svg, CONTENT_WIDTH, item.blockHeight, item.viewBoxStr);
        ctx.drawImage(img, MARGIN_X, drawY, CONTENT_WIDTH, item.blockHeight);
      } catch (err) {
        console.error('Error rendering SVG block for PDF export:', err);
      }
      drawY += item.blockHeight + SPACING;
    }

    if (p > 0) {
      pdf.addPage();
    }

    // Without compress the PDF stores raw pixels (about 6.5 MB per page); deflate keeps it lossless and tiny.
    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');

    if (typeof onProgress === 'function') {
      const pct = Math.round(((p + 1) / pages.length) * 100);
      onProgress(pct);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return pdf;
}

export async function exportGPToPDF(jsPDF, progressContainer, progressBar, filename) {
  const container = gpState.canvases[0]?.container;
  if (!container) return false;

  const pdf = await renderContainerToPdfDoc(container, {
    jsPDF,
    onProgress: (pct) => {
      if (progressBar) {
        progressBar.style.width = pct + '%';
        progressBar.textContent = pct + '%';
      }
    }
  });

  if (!pdf) return false;
  const saved = await saveOrSharePdf(pdf, filename);
  return saved;
}

/**
 * Runs a single tab file through the PDF export engine (AlphaTab -> jsPDF for Guitar Pro,
 * native PDF bytes for PDFs, monospace A4 layout for text tabs).
 * Returns Uint8Array of the generated PDF, or null on abort/error.
 */
export async function renderTabFileToPdfBytes(file, { jsPDF = (typeof window !== 'undefined' ? window.jspdf?.jsPDF : null), onProgress, abortSignal } = {}) {
  if (!file) return null;
  if (abortSignal?.aborted) return null;

  const filename = file.name || file.tabName || '';
  const ext = filename.split('.').pop()?.toLowerCase();

  // 1. Guitar Pro tab: render AlphaTab offscreen, then export SVG blocks to jsPDF
  if (['gp', 'gp3', 'gp4', 'gp5', 'gpx'].includes(ext)) {
    let dataToLoad;
    if (typeof FileReader !== 'undefined' && (file instanceof Blob || file instanceof File)) {
      dataToLoad = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } else if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
      dataToLoad = file;
    } else if (typeof file.arrayBuffer === 'function') {
      dataToLoad = new Uint8Array(await file.arrayBuffer());
    } else {
      dataToLoad = file;
    }

    if (abortSignal?.aborted) return null;

    if (typeof document === 'undefined') {
      throw new Error('AlphaTab rendering requires a DOM environment');
    }

    const container = document.createElement('div');
    container.className = 'alphaTabContainer';
    container.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;min-height:1600px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(container);

    let api = null;
    try {
      const { loadGuitarPro } = await import('./gpProcessor/gpProcessor.js');
      api = await loadGuitarPro(dataToLoad, container, { originalFile: file });
      if (abortSignal?.aborted) return null;

      const pdf = await renderContainerToPdfDoc(container, { jsPDF, onProgress, abortSignal });
      if (!pdf || abortSignal?.aborted) return null;

      const arrayBuffer = pdf.output('arraybuffer');
      return new Uint8Array(arrayBuffer);
    } finally {
      try { api?.destroy(); } catch (_) {}
      container.remove();
    }
  }

  // 2. PDF tab: already a PDF document
  if (ext === 'pdf') {
    if (typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (file instanceof Uint8Array) return file;
    if (file instanceof ArrayBuffer) return new Uint8Array(file);
    return null;
  }

  // 3. Text tab: render formatted monospace pages via jsPDF
  if (ext === 'txt') {
    let text = '';
    if (typeof file.text === 'function') {
      text = await file.text();
    } else if (typeof FileReader !== 'undefined' && (file instanceof Blob || file instanceof File)) {
      text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
    }

    const PDFClass = jsPDF || (typeof window !== 'undefined' ? window.jspdf?.jsPDF : null);
    if (!PDFClass) throw new Error('jsPDF library not available');

    const pdf = new PDFClass({ unit: 'pt', format: 'a4', orientation: 'portrait' });
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(9);
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 36;
    const maxLineWidth = pageWidth - margin * 2;
    const lineHeight = 12;
    const maxLinesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight);

    const rawLines = text.split(/\r?\n/);
    const splitLines = [];
    for (const line of rawLines) {
      const wrapped = pdf.splitTextToSize(line, maxLineWidth);
      splitLines.push(...wrapped);
    }

    for (let i = 0; i < splitLines.length; i++) {
      if (abortSignal?.aborted) return null;
      const pageIndex = Math.floor(i / maxLinesPerPage);
      const lineOnPage = i % maxLinesPerPage;
      if (pageIndex > 0 && lineOnPage === 0) {
        pdf.addPage();
      }
      pdf.text(splitLines[i], margin, margin + lineOnPage * lineHeight);
    }

    const arrayBuffer = pdf.output('arraybuffer');
    return new Uint8Array(arrayBuffer);
  }

  return null;
}

async function showIOSSharePrompt(file, filename) {
  return new Promise((resolve) => {
    const existing = document.getElementById('iosPdfShareModal');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'iosPdfShareModal';
    backdrop.className = 'theme-modal-backdrop';
    backdrop.style.display = 'flex';
    backdrop.style.zIndex = '10050';

    backdrop.innerHTML = `
      <div class="theme-modal-card p-4" style="max-width: 420px; width: 90%;">
        <div class="theme-modal-header d-flex align-items-center justify-content-between mb-3">
          <div class="d-flex align-items-center gap-2">
            <i class="bi-file-earmark-pdf text-danger fs-4"></i>
            <h5 class="m-0 fw-bold">Export Ready</h5>
          </div>
          <button type="button" class="brand-btn theme-modal-close-btn p-1" id="iosPdfShareCloseBtn" aria-label="Close">
            <i class="bi-x-lg"></i>
          </button>
        </div>
        <div class="theme-modal-body mb-4">
          <p class="small text-muted mb-2">Your document is ready to save or share:</p>
          <div class="p-2 px-3 rounded bg-black bg-opacity-25 border border-secondary-subtle text-truncate small fw-semibold text-white">
            ${filename}
          </div>
        </div>
        <div class="theme-modal-footer d-flex gap-2 justify-content-end">
          <button type="button" class="btn btn-theme-outline btn-sm px-3" id="iosPdfShareCancelBtn">Cancel</button>
          <button type="button" class="btn btn-theme-primary btn-sm px-3 d-flex align-items-center gap-2" id="iosPdfShareActionBtn">
            <i class="bi-share"></i> Save / Share
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const cleanup = () => {
      backdrop.remove();
    };

    backdrop.querySelector('#iosPdfShareCloseBtn')?.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });
    backdrop.querySelector('#iosPdfShareCancelBtn')?.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    backdrop.querySelector('#iosPdfShareActionBtn')?.addEventListener('click', async () => {
      try {
        if (navigator.share) {
          await navigator.share({
            files: [file],
            title: filename
          });
          cleanup();
          showToast('Document saved successfully.', 'success');
          resolve(true);
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          cleanup();
          resolve(false);
          return;
        }
        console.warn('[PDF Export] Direct share failed:', err);
      }

      try {
        const url = URL.createObjectURL(file);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        cleanup();
        resolve(true);
      } catch (e) {
        cleanup();
        resolve(false);
      }
    });
  });
}

// Desktop shells: a download has no visible destination there, so ask where to save and remember where it went.
// Returns the chosen path, '' when the person cancelled, or null when there is no native dialog (or it failed).
let lastSavedPath = '';
async function saveWithNativeDialog(blob, filename) {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog?.save || !tauri?.fs?.writeFile || /Android/i.test(navigator.userAgent)) return null;
  try {
    const path = await tauri.dialog.save({ defaultPath: filename });
    if (!path) return '';
    await tauri.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    lastSavedPath = path;
    return path;
  } catch (err) {
    console.warn('[Export] Native save failed, falling back to a download:', err);
    return null;
  }
}

function showPdfExported() {
  const path = lastSavedPath;
  lastSavedPath = '';
  if (path) showToast(`Exported to ${path}`, 'success', 9000);
  else showToast('PDF exported successfully.', 'success');
}

async function saveOrSharePdf(pdf, filename) {
  if (isIOSDevice()) {
    const blob = pdf.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: filename
        });
        return true;
      } catch (err) {
        if (err.name === 'AbortError') {
          return false;
        }
        return await showIOSSharePrompt(file, filename);
      }
    } else {
      return await showIOSSharePrompt(file, filename);
    }
  }

  const savedPath = await saveWithNativeDialog(pdf.output('blob'), filename);
  if (savedPath !== null) return savedPath !== '';

  pdf.save(filename);
  return true;
}

async function exportPDFCanvases(canvases, jsPDF, progressContainer, progressBar, filename) {
  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'portrait', compress: true });
  const A4_WIDTH = pdf.internal.pageSize.getWidth();
  const A4_HEIGHT = pdf.internal.pageSize.getHeight();
  let cursorY = 0;

  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i];
    // Long PDFs process their pages on demand: load this one (and free it again once drawn)
    const lazyIndex = canvas._lazy?.index;
    if (lazyIndex != null) await getActiveLazy()?.materialize(lazyIndex);
    const scale = Math.min(A4_WIDTH / canvas.width, A4_HEIGHT / canvas.height);
    const canvasWidth = canvas.width * scale;
    const canvasHeight = canvas.height * scale;

    if (cursorY + canvasHeight > A4_HEIGHT) {
      pdf.addPage();
      cursorY = 0;
    }

    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', (A4_WIDTH - canvasWidth) / 2, cursorY, canvasWidth, canvasHeight, undefined, 'FAST');
    cursorY += canvasHeight;
    if (lazyIndex != null) getActiveLazy()?.release(lazyIndex);

    if (progressBar) {
      const pct = Math.round(((i + 1) / canvases.length) * 100);
      progressBar.style.width = pct + '%';
      progressBar.textContent = pct + '%';
    }

    await new Promise(requestAnimationFrame);
  }

  const saved = await saveOrSharePdf(pdf, filename);
  return saved;
}

export async function exportSourceTabFile() {
  const currentFile = getCurrentFile();
  if (!currentFile) {
    showToast('No tab file is currently opened.', 'warning');
    return false;
  }

  const filename = currentFile.name || (currentFile.songTitle ? `${currentFile.songTitle}.tab` : 'tab_source');
  return exportFileOut(currentFile, filename);
}

/** Exports the open song as a .mtab bundle: the tab plus its recordings, sync points and tuning. */
export async function exportMtabFile() {
  const currentFile = getCurrentFile();
  if (!currentFile) {
    showToast('No tab file is currently opened.', 'warning');
    return false;
  }
  try {
    const { buildMtab } = await import('./mtab.js');
    const { blob, filename } = await buildMtab(currentFile);
    return await exportFileOut(blob, filename);
  } catch (err) {
    console.warn('[Export] Could not build the song file:', err);
    showToast('Could not build the song file.', 'error');
    return false;
  }
}

// Saves a file for the player: the native save dialog, the iOS share prompt, or a download
async function exportFileOut(currentFile, filename) {
  if (isIOSDevice()) {
    const file = new File([currentFile], filename, { type: currentFile.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        showToast(`Exported ${filename}`, 'success');
        return true;
      } catch (err) {
        if (err.name === 'AbortError') return false;
        return await showIOSSharePrompt(file, filename);
      }
    } else {
      return await showIOSSharePrompt(file, filename);
    }
  }

  const savedPath = await saveWithNativeDialog(currentFile, filename);
  if (savedPath !== null) {
    if (savedPath === '') return false;
    lastSavedPath = '';
    showToast(`Exported to ${savedPath}`, 'success', 9000);
    return true;
  }

  const url = URL.createObjectURL(currentFile);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.position = 'fixed';
  a.style.top = '-9999px';
  a.style.left = '-9999px';
  a.style.opacity = '0';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showToast(`Exported ${filename}`, 'success');
  return true;
}

// The platform's own share sheet, where the web view has one (Safari and WKWebView on Apple platforms, Edge and WebView2 on Windows).
// Where it is missing the Share tab row stays hidden.
export function canShareFiles() {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    return navigator.canShare({ files: [new File(['x'], 'tab.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

async function shareFile(file, failureHint) {
  try {
    if (!navigator.canShare({ files: [file] })) {
      showToast(`This device cannot share this kind of file. ${failureHint}`, 'warning');
      return false;
    }
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    console.warn('[Share] Native share failed:', err);
    showToast(`Sharing failed. ${failureHint}`, 'warning');
    return false;
  }
}

/** Shares the open tab as it was opened. */
export async function shareSourceTabFile() {
  const currentFile = getCurrentFile();
  if (!currentFile) {
    showToast('No tab file is currently opened.', 'warning');
    return false;
  }
  const filename = currentFile.name || (currentFile.songTitle ? `${currentFile.songTitle}.tab` : 'tab_source');
  return shareFile(new File([currentFile], filename, { type: currentFile.type || 'application/octet-stream' }), 'Use Export source tab instead.');
}

/** Shares the open song as a .mtab bundle: the tab plus its recordings, sync points and tuning. */
export async function shareMtabFile() {
  const currentFile = getCurrentFile();
  if (!currentFile) {
    showToast('No tab file is currently opened.', 'warning');
    return false;
  }
  try {
    const { buildMtab } = await import('./mtab.js');
    const { blob, filename } = await buildMtab(currentFile);
    return await shareFile(new File([blob], filename, { type: blob.type }), 'Try again, or share the original file.');
  } catch (err) {
    console.warn('[Share] Could not build the song file:', err);
    showToast('Could not build the song file.', 'error');
    return false;
  }
}

export function setupExportPDFButton() {
  const exportBtn = document.getElementById('exportPDFBtn');
  const exportSourceBtn = document.getElementById('exportSourceTabBtn');
  const progressContainer = document.getElementById('exportProgressContainer');
  const progressBar = document.getElementById('exportProgressBar');

  if (exportSourceBtn) {
    exportSourceBtn.addEventListener('click', () => {
      exportSourceTabFile();
    });
  }
  document.getElementById('exportMtabBtn')?.addEventListener('click', () => { exportMtabFile(); });

  if (canShareFiles()) {
    for (const [id, share] of [['shareSourceTabBtn', shareSourceTabFile], ['shareMtabBtn', shareMtabFile]]) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.hidden = false;
      btn.addEventListener('click', () => { share(); });
    }
  }

  if (!exportBtn) return;

  exportBtn.addEventListener('click', async () => {
    const currentFile = getCurrentFile();
    const hasGP = Boolean(gpState.canvases[0]?.container);
    const isPdf = currentFile?.name?.toLowerCase().endsWith('.pdf');
    const condenseCheckbox = document.getElementById('condensePdfMode');
    const isCondensedPdf = isPdf && Boolean(condenseCheckbox?.checked);

    if (!hasGP && !isCondensedPdf) {
      showToast('A Guitar Pro file or condensed PDF is not currently opened.', 'warning');
      return;
    }

    const baseName = currentFile?.name ? currentFile.name.replace(/\.[^/.]+$/, '') : 'MajesticTab';
    const filename = `${baseName}${isCondensedPdf ? '-condensed' : ''}.pdf`;

    if (progressContainer) progressContainer.style.display = 'block';
    if (progressBar) {
      progressBar.style.width = '0%';
      progressBar.textContent = '0%';
    }

    try {
      const { jsPDF } = window.jspdf;
      if (hasGP) {
        const ok = await exportGPToPDF(jsPDF, progressContainer, progressBar, filename);
        if (ok) {
          showPdfExported();
        }
      } else if (isCondensedPdf) {
        const canvases = getCondensedCanvases();
        if (!canvases || canvases.length === 0) {
          showToast('No condensed pages available to export.', 'warning');
          return;
        }
        const ok = await exportPDFCanvases(canvases, jsPDF, progressContainer, progressBar, filename);
        if (ok) {
          showPdfExported();
        }
      }
    } catch (err) {
      console.error('Error during PDF export:', err);
      showToast('An error occurred while generating the PDF.', 'error');
    } finally {
      if (progressContainer) progressContainer.style.display = 'none';
    }
  });
}

