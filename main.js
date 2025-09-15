import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { setupGoogleDriveButton } from './googleDrive.js';
import { setupExportPDFButton } from './exportPdf.js';

// At the end of DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  setupExportPDFButton(condensedCanvases);
});

// --- ELEMENTS ---
const pdfInput = document.getElementById('pdfFile');
const debugMode = document.getElementById('debugMode');
const originalMode = document.getElementById('originalMode');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const pageIndicator = document.getElementById('pageIndicator');
const navButtons = document.getElementById('navButtons');
const modeButtons = document.getElementById('modeButtons');
const pageModeRadio = document.getElementById('pageModeRadio');
const continuousModeRadio = document.getElementById('continuousModeRadio');
const output = document.getElementById('output');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const darkModeToggle = document.getElementById('darkModeToggle');
const advanceOnePageToggle = document.getElementById('advanceOnePageToggle');

let condensedCanvases = [];
let pages = [];
let currentPageIndex = 0;
let currentFile = null;
let currentProcessing = { aborted: false };
let pagesPerView = 1;
const PAGE_PADDING = 10;

// --- OFFCANVAS MENU ---
const fileMenuEl = document.getElementById('fileMenu');
const fileMenu = new bootstrap.Offcanvas(fileMenuEl);

// Open menu on app load
window.addEventListener('DOMContentLoaded', () => {
  fileMenu.show();
  navButtons.style.display = 'flex';
  modeButtons.style.display = 'flex';

  // Load Dark Mode preference
  const darkModeSaved = localStorage.getItem('darkMode');
  if (darkModeSaved === 'true') {
    darkModeToggle.checked = true;
    document.body.classList.add('dark-mode');
  }

  // Load Advance One Page preference
  const advanceOnePageSaved = localStorage.getItem('advanceOnePage');
  if (advanceOnePageSaved === 'true') {
    advanceOnePageToggle.checked = true;
  }
});

// --- PAGE LAYOUT ---
function layoutPages() {
  pages = [];
  const pageHeight = window.innerHeight - 80 - PAGE_PADDING;
  const pageWidth = window.innerWidth - 40;
  pagesPerView = window.innerWidth > window.innerHeight ? 2 : 1;

  let currentPage = [];
  let usedHeight = 0;

  condensedCanvases.forEach(c => {
    let scale = pageWidth / c.width / pagesPerView;
    let scaledHeight = c.height * scale;
    if (scaledHeight > pageHeight) {
      scale = pageHeight / c.height;
      scaledHeight = pageHeight;
    }
    if (usedHeight + scaledHeight > pageHeight) {
      if (currentPage.length) pages.push(currentPage);
      currentPage = [];
      usedHeight = 0;
    }
    currentPage.push({ canvas: c, scale });
    usedHeight += scaledHeight;
  });

  if (currentPage.length) pages.push(currentPage);
  if (currentPageIndex >= pages.length) currentPageIndex = 0;
  renderPage();
}

function renderPage() {
  output.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'pageContainer';

  for (let i = 0; i < pagesPerView; i++) {
    const pageSet = pages[currentPageIndex + i];
    if (!pageSet) break;

    const wrapper = document.createElement('div');
    wrapper.className = 'pageWrapper';
    wrapper.style.width = `${(window.innerWidth - 40) / pagesPerView}px`;
    wrapper.style.height = `${window.innerHeight - 80}px`;
    wrapper.style.paddingTop = `${PAGE_PADDING}px`;

    pageSet.forEach(item => {
      const c = item.canvas;
      c.style.width = `${c.width * item.scale}px`;
      c.style.height = `${c.height * item.scale}px`;
      wrapper.appendChild(c);
    });

    const pnum = document.createElement('div');
    pnum.className = 'pageNumber';
    pnum.textContent = `${currentPageIndex + i + 1}/${pages.length}`;
    wrapper.appendChild(pnum);

    container.appendChild(wrapper);
  }

  output.appendChild(container);
  pageIndicator.textContent = `${currentPageIndex + 1}/${pages.length}`;
}

// --- CONTINUOUS MODE SCROLL TRACKING ---
let continuousScrollHandler = null;

function updateContinuousPageIndicator() {
  if (!continuousModeRadio.checked) return; // only show percentage in continuous mode

  const scrollTop = output.scrollTop;
  const totalHeight = output.scrollHeight - output.clientHeight;
  const percent = totalHeight > 0 ? Math.floor((scrollTop / totalHeight) * 100) : 100;

  pageIndicator.textContent = `${percent}%`;
}

function enableContinuousScrollTracking() {
  if (continuousScrollHandler) return;
  continuousScrollHandler = () => updateContinuousPageIndicator();
  output.addEventListener('scroll', continuousScrollHandler);
}

function disableContinuousScrollTracking() {
  if (!continuousScrollHandler) return;
  output.removeEventListener('scroll', continuousScrollHandler);
  continuousScrollHandler = null;
}

// --- CONTINUOUS MODE ---
function switchToContinuous() {
  disableContinuousScrollTracking();
  output.style.overflowY = 'auto';
  output.innerHTML = '';

  condensedCanvases.forEach(c => {
    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.textAlign = 'center';
    const scale = output.clientWidth / c.width;
    c.style.width = `${c.width * scale}px`;
    c.style.height = 'auto';
    wrapper.appendChild(c);
    output.appendChild(wrapper);
  });

  // Get the navbar height dynamically
  const navbar = document.querySelector('.navbar');
  const navbarHeight = navbar ? navbar.offsetHeight : 0;

  // Scroll so the first canvas starts below the navbar
  const firstCanvasIndex = currentPageIndex * pagesPerView;
  const targetCanvas = condensedCanvases[firstCanvasIndex];
  if (targetCanvas) {
    output.scrollTo({
      top: targetCanvas.offsetTop - navbarHeight,
      behavior: 'auto'
    });
  }

  enableContinuousScrollTracking();
  updateContinuousPageIndicator();
}

// --- PAGE MODE ---
function switchToPageMode() {
  disableContinuousScrollTracking();
  output.style.overflowY = 'hidden';

  let scrollTop = output.scrollTop;
  let pageIndex = 0;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i][0].canvas.offsetTop <= scrollTop + 10) pageIndex = i;
  }
  currentPageIndex = pageIndex;
  layoutPages();
}

// --- NAVIGATION HELPER ---
function getPageStep() {
  if (pagesPerView === 2 && !advanceOnePageToggle.checked) return 2;
  return 1;
}

// --- NAVIGATION ---
prevBtn.addEventListener('click', () => {
  if (pageModeRadio.checked) {
    const step = getPageStep();
    currentPageIndex = Math.max(0, currentPageIndex - step);
    renderPage();
  } else {
    const scrollTop = output.scrollTop;
    for (let i = condensedCanvases.length - 1; i >= 0; i--) {
      if (condensedCanvases[i].offsetTop < scrollTop - 10) {
        output.scrollTo({ top: condensedCanvases[i].offsetTop, behavior: 'smooth' });
        break;
      }
    }
  }
});

nextBtn.addEventListener('click', () => {
  if (pageModeRadio.checked) {
    const step = getPageStep();
    currentPageIndex = Math.min(pages.length - 1, currentPageIndex + step);
    renderPage();
  } else {
    const scrollTop = output.scrollTop;
    for (let i = 0; i < condensedCanvases.length; i++) {
      if (condensedCanvases[i].offsetTop > scrollTop + 10) {
        output.scrollTo({ top: condensedCanvases[i].offsetTop, behavior: 'smooth' });
        break;
      }
    }
  }
});

// --- MODE TOGGLE ---
pageModeRadio.addEventListener('change', () => {
  if (pageModeRadio.checked) {
    switchToPageMode();
    output.focus();
  }
});

continuousModeRadio.addEventListener('change', () => {
  if (continuousModeRadio.checked) {
    switchToContinuous();
    output.focus();
  }
});

// --- RESIZE HANDLER ---
window.addEventListener('resize', () => {
  if (pageModeRadio.checked) layoutPages();
  else switchToContinuous();
});

// --- KEYBOARD NAVIGATION ---
window.addEventListener('keydown', (e) => {
  // Only handle keys if a PDF is loaded
  if (!currentFile) return;

  const nextPageKeys = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
  const prevPageKeys = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Enter'];

  // Check if focus is inside an input or textarea to avoid hijacking typing
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;

  if (pageModeRadio.checked) {
    const step = getPageStep();

    if (nextPageKeys.includes(e.key)) {
      e.preventDefault(); // prevent scrolling/menu only when handling PDF
      currentPageIndex = Math.min(pages.length - 1, currentPageIndex + step);
      renderPage();
    } else if (prevPageKeys.includes(e.key)) {
      e.preventDefault();
      currentPageIndex = Math.max(0, currentPageIndex - step);
      renderPage();
    }
  } else if (continuousModeRadio.checked) {
    const scrollTop = output.scrollTop;

    if (prevPageKeys.includes(e.key)) {
      e.preventDefault();
      for (let i = condensedCanvases.length - 1; i >= 0; i--) {
        if (condensedCanvases[i].offsetTop < scrollTop - 10) {
          output.scrollTo({ top: condensedCanvases[i].offsetTop, behavior: 'smooth' });
          break;
        }
      }
    } else if (nextPageKeys.includes(e.key)) {
      e.preventDefault();
      for (let i = 0; i < condensedCanvases.length; i++) {
        if (condensedCanvases[i].offsetTop > scrollTop + 10) {
          output.scrollTo({ top: condensedCanvases[i].offsetTop, behavior: 'smooth' });
          break;
        }
      }
    }
  }
});

// --- TAP NAVIGATION ---
output.addEventListener('click', (e) => {
  if (!pageModeRadio.checked) return;

  const outputRect = output.getBoundingClientRect();
  if (e.clientY < outputRect.top) return;

  const pageContainers = output.querySelectorAll('.pageWrapper');
  for (let i = 0; i < pageContainers.length; i++) {
    const rect = pageContainers[i].getBoundingClientRect();
    if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
      const clickX = e.clientX;
      const midX = rect.left + rect.width / 2;
      const step = getPageStep();

      if (clickX < midX) {
        currentPageIndex = Math.max(0, currentPageIndex - step);
      } else {
        currentPageIndex = Math.min(pages.length - 1, currentPageIndex + step);
      }
      renderPage();
      break;
    }
  }
});

// --- LOAD PDF ---
async function loadPDF(file) {
  if (currentProcessing) currentProcessing.aborted = true;
  currentProcessing = { aborted: false };
  currentFile = file;
  condensedCanvases.length = 0;
  pages = [];
  currentPageIndex = 0;
  output.innerHTML = '';

  navButtons.style.display = 'flex';
  modeButtons.style.display = 'flex';

  await processPDF(file, {
    debugMode,
    originalMode,
    progressContainer,
    progressBar,
    condensedCanvases,
    abortSignal: currentProcessing,
    onCanvasRendered: () => {
      if (currentProcessing.aborted) return;
      if (pageModeRadio.checked) layoutPages();
      else switchToContinuous();
    }
  });
}

// --- FILE INPUT ---
pdfInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (file) {
    fileMenu.hide();
    await loadPDF(file);
  }
});

// --- DEBUG MODE TOGGLE ---
debugMode.addEventListener('change', async () => {
  if (debugMode.checked && originalMode.checked) {
    // Disable Original Mode if Debug is enabled
    originalMode.checked = false;
  }
  if (currentFile) await loadPDF(currentFile);
});

// --- ORIGINAL MODE TOGGLE ---
originalMode.addEventListener('change', async () => {
  if (originalMode.checked && debugMode.checked) {
    // Disable Debug Mode if Original Mode is enabled
    debugMode.checked = false;
  }
  if (currentFile) await loadPDF(currentFile);
});

// --- GOOGLE DRIVE ---
setupGoogleDriveButton();

// --- DARK MODE ---
darkModeToggle.addEventListener('change', () => {
  if (darkModeToggle.checked) {
    document.body.classList.add('dark-mode');
    localStorage.setItem('darkMode', 'true');
  } else {
    document.body.classList.remove('dark-mode');
    localStorage.setItem('darkMode', 'false');
  }
});

// --- ADVANCE ONE PAGE TOGGLE ---
advanceOnePageToggle.addEventListener('change', () => {
  localStorage.setItem('advanceOnePage', advanceOnePageToggle.checked ? 'true' : 'false');
});
