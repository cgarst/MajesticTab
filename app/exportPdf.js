import { getCurrentFile, getCondensedCanvases, getPdfPages } from './main.js';
import { gpState } from './gpProcessor/gpHandler.js';

async function svgToImage(svgElement, width, height) {
  const svgClone = svgElement.cloneNode(true);
  if (!svgClone.getAttribute('xmlns')) {
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  svgClone.setAttribute('width', width.toString());
  svgClone.setAttribute('height', height.toString());

  // Ensure any dark-mode/theme overrides are cleared so export is always clean light mode
  svgClone.removeAttribute('class');
  svgClone.style.filter = 'none';

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

    let vb = svg.getAttribute('viewBox');
    let vbWidth = 1200;
    let vbHeight = 100;
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(parseFloat);
      if (parts.length >= 4 && parts[2] > 0 && parts[3] > 0) {
        vbWidth = parts[2];
        vbHeight = parts[3];
      }
    }
    const blockHeight = (vbHeight / vbWidth) * CONTENT_WIDTH;

    if (curY + blockHeight > CONTENT_HEIGHT && curPage.length > 0) {
      pages.push(curPage);
      curPage = [];
      curY = 0;
    }
    curPage.push({ svg, blockHeight });
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
        const img = await svgToImage(item.svg, CONTENT_WIDTH, item.blockHeight);
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

