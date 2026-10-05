import { getCurrentFile, getCondensedCanvases, getPdfPages } from './main.js';
import { gpState } from './gpProcessor/gpHandler.js';

async function getAlphaTabFontCss() {
  const rules = [];

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

async function exportGPToPDF(jsPDF, progressContainer, progressBar, filename) {
  const container = gpState.canvases[0]?.container;
  if (!container) return false;

  const blocks = Array.from(container.querySelectorAll('div.at-surface.at > div'));
  if (blocks.length === 0) return false;

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

  if (pages.length === 0) return false;

  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'portrait' });
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = pdf.internal.pageSize.getHeight();

  for (let p = 0; p < pages.length; p++) {
    const canvas = document.createElement('canvas');
    canvas.width = A4_WIDTH;
    canvas.height = A4_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);

    let drawY = MARGIN_Y;
    for (const item of pages[p]) {
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

    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);

    if (progressBar) {
      const pct = Math.round(((p + 1) / pages.length) * 100);
      progressBar.style.width = pct + '%';
      progressBar.textContent = pct + '%';
    }

    await new Promise(requestAnimationFrame);
  }

  pdf.save(filename);
  return true;
}

async function exportPDFCanvases(canvases, jsPDF, progressContainer, progressBar, filename) {
  const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'portrait' });
  const A4_WIDTH = pdf.internal.pageSize.getWidth();
  const A4_HEIGHT = pdf.internal.pageSize.getHeight();
  let cursorY = 0;

  for (let i = 0; i < canvases.length; i++) {
    const canvas = canvases[i];
    const scale = Math.min(A4_WIDTH / canvas.width, A4_HEIGHT / canvas.height);
    const canvasWidth = canvas.width * scale;
    const canvasHeight = canvas.height * scale;

    if (cursorY + canvasHeight > A4_HEIGHT) {
      pdf.addPage();
      cursorY = 0;
    }

    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', (A4_WIDTH - canvasWidth) / 2, cursorY, canvasWidth, canvasHeight);
    cursorY += canvasHeight;

    if (progressBar) {
      const pct = Math.round(((i + 1) / canvases.length) * 100);
      progressBar.style.width = pct + '%';
      progressBar.textContent = pct + '%';
    }

    await new Promise(requestAnimationFrame);
  }

  pdf.save(filename);
  return true;
}

export function setupExportPDFButton() {
  const exportBtn = document.getElementById('exportPDFBtn');
  const progressContainer = document.getElementById('exportProgressContainer');
  const progressBar = document.getElementById('exportProgressBar');

  if (!exportBtn) return;

  exportBtn.addEventListener('click', async () => {
    const currentFile = getCurrentFile();
    const condensedCanvases = getCondensedCanvases();
    const pdfPages = getPdfPages();
    const hasGP = Boolean(gpState.canvases[0]?.container);
    const hasPDF = (condensedCanvases && condensedCanvases.length > 0) || (pdfPages && pdfPages.length > 0);

    if (!hasGP && !hasPDF) {
      alert('A supported PDF or Guitar Pro file is not currently opened.');
      return;
    }

    const baseName = currentFile?.name ? currentFile.name.replace(/\.[^/.]+$/, '') : 'MajesticTab';
    const filename = `${baseName}.pdf`;

    if (progressContainer) progressContainer.style.display = 'block';
    if (progressBar) {
      progressBar.style.width = '0%';
      progressBar.textContent = '0%';
    }

    try {
      const { jsPDF } = window.jspdf;
      if (hasGP) {
        await exportGPToPDF(jsPDF, progressContainer, progressBar, filename);
      } else if (hasPDF) {
        const canvasesToExport = (condensedCanvases && condensedCanvases.length > 0) ? condensedCanvases : pdfPages;
        await exportPDFCanvases(canvasesToExport, jsPDF, progressContainer, progressBar, filename);
      }
    } catch (err) {
      console.error('Error during PDF export:', err);
      alert('An error occurred while generating the PDF.');
    } finally {
      if (progressContainer) progressContainer.style.display = 'none';
    }
  });
}

