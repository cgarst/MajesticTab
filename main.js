import { processPDF } from './pdfProcessor/pdfProcessor.js';
import { fetchPickedFile, setupDrivePicker } from './googleDrive.js';
import { setupExportPDFButton } from './exportPdf.js';
import { loadGP, renderGPPage, layoutGPPages, renderGPPageMode, gpState, nextGPPage, prevGPPage, scaleGPContainer} from './gpProcessor/gpHandler.js';

// At the end of DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  setupExportPDFButton(condensedCanvases);
});

// --- ELEMENTS ---
const fileInput = document.getElementById('localFile');
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

  // Load Original Mode preference
  const originalModeSaved = localStorage.getItem('originalMode');
  if (originalModeSaved === 'true') {
    originalMode.checked = true;
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
  //console.log('switchToContinuous called', new Error().stack);
  disableContinuousScrollTracking();
  output.style.overflowY = 'auto';

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
  const step = getPageStep();

  if (gpState.gpCanvases[0]) {
    if (pageModeRadio.checked) {
      // --- GP Page Mode ---
      prevGPPage();
      renderGPPage(output, pageModeRadio, continuousModeRadio);
    } else if (continuousModeRadio.checked) {
      // --- GP Continuous Mode ---
      output.scrollBy({ top: -window.innerHeight * 0.9, behavior: 'smooth' });
    }
    return;
  }

  // --- PDF Navigation ---
  if (pageModeRadio.checked) {
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
  const step = getPageStep();

  if (gpState.gpCanvases[0]) {
    if (pageModeRadio.checked) {
      // --- GP Page Mode ---
      nextGPPage();
      renderGPPage(output, pageModeRadio, continuousModeRadio);
    } else if (continuousModeRadio.checked) {
      // --- GP Continuous Mode ---
      output.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
    }
    return;
  }

  // --- PDF Navigation ---
  if (pageModeRadio.checked) {
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
  if (!output) return;

  // Clear display regardless of mode
  output.innerHTML = '';

  if (gpState.gpCanvases[0]?.container) {
    // --- GUITAR PRO ---
    if (pageModeRadio.checked) {
      // --- PAGE MODE ---
      console.log("Switching to GP page mode...");
      // Calculate pages
      const pageHeight = output.clientHeight - 20;
      gpState.gpPages = layoutGPPages(gpState.gpCanvases[0].container, pageHeight);
      // Reset to first page
      gpState.currentGPPageIndex = 0;
      // Render current page(s)
      renderGPPage(output, pageModeRadio, continuousModeRadio);
    } else {
      // --- CONTINUOUS MODE ---
      console.log("Switching to GP continuous mode...");
      renderGPPage(output, pageModeRadio, continuousModeRadio);
    }
  } else {
    // --- PDF ---
    if (pageModeRadio.checked) {
      console.log("Switching to PDF page mode...");
      switchToPageMode();
    } else {
      console.log("Switching to PDF continuous mode...");
      switchToContinuous();
    }
  }

  output.focus();
});


continuousModeRadio.addEventListener('change', () => {
  if (continuousModeRadio.checked) {
    if (gpState.gpCanvases[0]?.container) renderGPPage(output, pageModeRadio, continuousModeRadio);
    else switchToContinuous();
    output.focus();
  }
});

// --- RESIZE HANDLER ---
window.addEventListener('resize', () => {
  if (pageModeRadio.checked) {
    if (gpState.gpCanvases[0]?.container) {
        scaleGPContainer(gpState.gpCanvases[0].container, output);
        layoutGPPages(gpState.gpCanvases[0].container, output);
        renderGPPageMode(output, pagesPerView);
    } else {
        layoutPages();
    }
  } else {
    if (gpState.gpCanvases[0]?.container) {
        renderGPPage(output, pageModeRadio, continuousModeRadio);
    } else {
        switchToContinuous();
    }
  }
});

// --- KEYBOARD NAVIGATION ---
window.addEventListener('keydown', (e) => {
  // Only handle keys if a PDF or GP is loaded
  if (!currentFile) return;

  const nextPageKeys = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
  const prevPageKeys = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Enter'];

  // Avoid hijacking typing in inputs/textareas
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;

  const step = getPageStep();

  // --- GP NAVIGATION ---
  if (gpState.gpCanvases[0]) {
    const isGPPageMode = pageModeRadio.checked;          // your GP page toggle
    const isGPContinuous = !isGPPageMode;                // GP defaults to continuous otherwise

    if (isGPPageMode) {
      // GP page mode
      if (nextPageKeys.includes(e.key)) {
        e.preventDefault();
        gpState.currentGPPageIndex = Math.min(gpState.gpPages.length - 1, gpState.currentGPPageIndex + step);
        renderGPPage(output, pageModeRadio, continuousModeRadio);
      } else if (prevPageKeys.includes(e.key)) {
        e.preventDefault();
        gpState.currentGPPageIndex = Math.max(0, gpState.currentGPPageIndex - step);
        renderGPPage(output, pageModeRadio, continuousModeRadio);
      }
    } else if (isGPContinuous) {
      const scrollAmount = window.innerHeight * 0.9; // same as buttons
      if (prevPageKeys.includes(e.key)) {
        e.preventDefault();
        output.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
      } else if (nextPageKeys.includes(e.key)) {
        e.preventDefault();
        output.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    }

    return; // don’t fall through to PDF
  }

  // --- PDF NAVIGATION ---
  if (pageModeRadio.checked) {
    // PDF page mode
    if (nextPageKeys.includes(e.key)) {
      e.preventDefault();
      currentPageIndex = Math.min(pages.length - 1, currentPageIndex + step);
      renderPage();
    } else if (prevPageKeys.includes(e.key)) {
      e.preventDefault();
      currentPageIndex = Math.max(0, currentPageIndex - step);
      renderPage();
    }
  } else if (continuousModeRadio.checked) {
    // PDF continuous mode
    const scrollTop = output.scrollTop;
    //console.log('Setting scrollTop', { newTop: scrollTop, mode: pageModeRadio.checked ? 'page' : 'continuous' }, new Error().stack);
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
    pageModeRadio,
    continuousModeRadio,
    onCanvasRendered: (canvas) => {
      //console.log('onCanvasRendered', canvas._appended);
      if (currentProcessing.aborted) return;

      if (pageModeRadio.checked) {
        layoutPages();
      } else {
        // Continuous mode: append only new canvases
        if (!canvas._appended) {
          const prevScroll = output.scrollTop;

          const wrapper = document.createElement('div');
          wrapper.style.width = '100%';
          wrapper.style.textAlign = 'center';

          const scale = output.clientWidth / canvas.width;
          canvas.style.width = `${canvas.width * scale}px`;
          canvas.style.height = 'auto';

          wrapper.appendChild(canvas);
          output.appendChild(wrapper);

          canvas._appended = true;

          // restore scrollTop immediately
          //console.log('Setting scrollTop', { newTop: prevScroll, mode: pageModeRadio.checked ? 'page' : 'continuous' }, new Error().stack);
          output.scrollTop = prevScroll;
        }

        updateContinuousPageIndicator();
      }
    }
  });
}

// --- LOCAL FILE INPUT LISTENER ---
fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    await loadFile(file)
});

// --- GOOGLE DRIVE PICKER ---
setupDrivePicker()

// --- FILE LOADING ---
export async function loadFile(file) {
    fileMenu.hide();
    resetView();

    currentFile = file;
    currentProcessing.aborted = true;
    currentProcessing = { aborted: false };
    condensedCanvases = [];
    pages = [];
    currentPageIndex = 0;
    output.innerHTML = '';

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'pdf') {
      await loadPDF(file);
    } else if (['gp', 'gp3', 'gp4', 'gp5', 'gpx'].includes(ext)) {
      // Show progress
      progressContainer.style.display = 'block';
      progressBar.classList.add('indeterminate');
      await loadGP(file, output, pageModeRadio, continuousModeRadio, !originalMode.checked);
      // Hide progress
      progressBar.classList.remove('indeterminate');
      progressContainer.style.display = 'none';
    } else {
      console.warn('Unsupported file type:', ext);
    }
}

// --- DEBUG MODE TOGGLE ---
debugMode.addEventListener('change', async () => {
  if (debugMode.checked && originalMode.checked) {
    // Disable Original Mode if Debug is enabled
    originalMode.checked = false;
  }

  localStorage.setItem('debugMode', debugMode.checked ? 'true' : 'false');

  if (!currentFile) return;
  resetView(); 

  const ext = currentFile.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    await loadPDF(currentFile);
  } else if (['gp', 'gp3', 'gp4', 'gp5', 'gpx'].includes(ext)) {
    // Show progress
    progressContainer.style.display = 'block';
    progressBar.classList.add('indeterminate');
    await loadGP(
      currentFile,
      output,
      pageModeRadio,
      continuousModeRadio,
      !originalMode.checked,
      debugMode.checked
    );
    progressBar.classList.remove('indeterminate');
    progressContainer.style.display = 'none';
  }
});

// --- ORIGINAL MODE TOGGLE ---
originalMode.addEventListener('change', async () => {
  if (!currentFile) return;
  resetView(); 
  if (originalMode.checked && debugMode.checked) {
    // Disable Debug Mode if Original Mode is enabled
    debugMode.checked = false;
  }

  localStorage.setItem('originalMode', originalMode.checked ? 'true' : 'false');

  if (!currentFile) return;

  const ext = currentFile.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    await loadPDF(currentFile);
  } else if (['gp', 'gp3', 'gp4', 'gp5', 'gpx'].includes(ext)) {
    // Show progress
    progressContainer.style.display = 'block';
    progressBar.classList.add('indeterminate');
    await loadGP(currentFile, output, pageModeRadio, continuousModeRadio, !originalMode.checked);
    progressBar.classList.remove('indeterminate');
    progressContainer.style.display = 'none';
  }
});

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

window.addEventListener('resize', () => {
  //console.log('resize event', { pageMode: pageModeRadio.checked });
  if (currentProcessing?.aborted) return;

  if (gpState.gpCanvases[0]?.container) {
    const container = gpState.gpCanvases[0].container;

    const isGPPageMode = pageModeRadio.checked;

    if (isGPPageMode) {
      // --- GP PAGE MODE ---
      scaleGPContainer(container, output); // safe to recalc pages here
      const pageHeight = output.clientHeight - 20;
      gpState.gpPages = layoutGPPages(container, pageHeight);
      renderGPPage(output, pageModeRadio, continuousModeRadio);
    } else {
      // --- GP CONTINUOUS MODE ---
      const container = gpState.gpCanvases[0].container;
      if (!container) return;

      // Preserve scroll position
      const scrollTop = output.scrollTop;

      // Re-render the container for continuous mode
      output.innerHTML = '';
      output.appendChild(container);

      // Scale to fit output width
      const scale = output.clientWidth / container.scrollWidth;
      container.style.transformOrigin = 'top left';
      container.style.transform = `scale(${scale})`;

      // Restore scroll
      output.scrollTop = scrollTop;
    }
  } else {
    // --- PDF ---
    if (pageModeRadio.checked) {
      layoutPages();
    } else {
      // Continuous mode: don't reset scroll, just scale canvases
      const scrollTop = output.scrollTop;
      condensedCanvases.forEach(c => {
        const scale = output.clientWidth / c.width;
        c.style.width = `${c.width * scale}px`;
        c.style.height = 'auto';
      });
      //console.log('Setting scrollTop', { newTop: scrollTop, mode: pageModeRadio.checked ? 'page' : 'continuous' }, new Error().stack);
      output.scrollTop = scrollTop;
      updateContinuousPageIndicator();
    }
  }
});

// --- RESET FUNCTION ---
function resetView() {
  // Abort any ongoing processing
  if (currentProcessing) currentProcessing.aborted = true;

  // Clear PDF state
  condensedCanvases.length = 0;
  pages = [];
  currentPageIndex = 0;

  // Clear GP state
  gpState.gpCanvases = [];
  gpState.gpPages = [];
  gpState.currentGPPageIndex = 0;

  // Clear DOM
  output.innerHTML = '';

  // Reset scroll & indicators
  output.scrollTop = 0;
  pageIndicator.textContent = '';
}
