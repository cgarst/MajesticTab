/**
 * MajesticTab Theme Engine
 * Ported from concerts with 8 iconic guitar finish themes.
 * Default theme: 'Mystic Dream'
 * Sheet appearance: Auto / Light / Dark / Guitar Finish (all in one row)
 */

export const THEMES = [
  {
    id: 'Mystic Dream',
    name: 'Mystic Dream',
    subtitle: 'ChromaFlair Chameleon (Purple / Emerald / Obsidian)',
    gradient: 'linear-gradient(135deg, #9333ea 0%, #06b6d4 50%, #10b981 100%)',
    bg: '#06050a',
    accent: '#a855f7',
    secondary: '#10b981',
    colorway: ['#9333ea', '#10b981', '#06b6d4', '#c084fc', '#34d399', '#7e22ce', '#059669']
  },
  {
    id: 'Blue Pearl',
    name: 'Blue Pearl',
    subtitle: 'Sapphire Pearl Shimmer',
    gradient: 'linear-gradient(135deg, #1d4ed8, #38bdf8)',
    bg: '#060d1f',
    accent: '#2563eb',
    secondary: '#38bdf8',
    colorway: ['#38bdf8', '#2563eb', '#60a5fa', '#0ea5e9', '#818cf8', '#2dd4bf']
  },
  {
    id: 'Cerulean Paradise',
    name: 'Cerulean Paradise',
    subtitle: 'Tropical Azure Flame',
    gradient: 'linear-gradient(135deg, #06b6d4, #0284c7)',
    bg: '#03141a',
    accent: '#06b6d4',
    secondary: '#0284c7',
    colorway: ['#06b6d4', '#0284c7', '#14b8a6', '#22d3ee', '#38bdf8', '#10b981']
  },
  {
    id: 'Dark Side',
    name: 'Dark Side',
    subtitle: 'Pure Monochromatic Blackout',
    gradient: 'linear-gradient(135deg, #a1a1aa, #52525b)',
    bg: '#000000',
    accent: '#a1a1aa',
    secondary: '#52525b',
    colorway: ['#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a']
  },
  {
    id: 'Ember Glow',
    name: 'Ember Glow',
    subtitle: 'Incandescent Magma Burst',
    gradient: 'linear-gradient(135deg, #f97316, #ef4444)',
    bg: '#120804',
    accent: '#f97316',
    secondary: '#ef4444',
    colorway: ['#f97316', '#fbbf24', '#ef4444', '#f59e0b', '#ea580c', '#facc15']
  },
  {
    id: 'Purple Nebula',
    name: 'Purple Nebula',
    subtitle: 'Galactic Violet & Magenta',
    gradient: 'linear-gradient(135deg, #c026d3, #7c3aed)',
    bg: '#0e0616',
    accent: '#c026d3',
    secondary: '#7c3aed',
    colorway: ['#c026d3', '#7c3aed', '#d946ef', '#8b5cf6', '#e879f9', '#ec4899']
  },
  {
    id: 'Red Nebula',
    name: 'Red Nebula',
    subtitle: 'Galactic Crimson & Slate',
    gradient: 'linear-gradient(135deg, #e11d48, #475569)',
    bg: '#100508',
    accent: '#e11d48',
    secondary: '#475569',
    colorway: ['#e11d48', '#94a3b8', '#f43f5e', '#64748b', '#cbd5e1', '#be123c']
  },
  {
    id: 'Red Pearl Burst',
    name: 'Red Pearl Burst',
    subtitle: 'Crimson & Wine Pearl Burst',
    gradient: 'linear-gradient(135deg, #e11d48, #991b1b)',
    bg: '#130507',
    accent: '#e11d48',
    secondary: '#991b1b',
    colorway: ['#e11d48', '#f43f5e', '#be123c', '#fb7185', '#991b1b', '#fda4af']
  }
];

const STORAGE_THEME_KEY = 'majestictab_theme';
const STORAGE_SHEET_MODE_KEY = 'majestictab_sheet_mode';

export function getCurrentTheme() {
  try {
    return localStorage.getItem(STORAGE_THEME_KEY) ||
           document.documentElement.getAttribute('data-theme') ||
           'Mystic Dream';
  } catch (e) {
    return 'Mystic Dream';
  }
}

export function getSheetMode() {
  try {
    let saved = localStorage.getItem(STORAGE_SHEET_MODE_KEY);
    if (!saved) {
      const legacyExtend = localStorage.getItem('majestictab_theme_sheet');
      if (legacyExtend === 'true') {
        saved = 'theme';
        localStorage.setItem(STORAGE_SHEET_MODE_KEY, saved);
      } else {
        const legacyTheme = localStorage.getItem('theme');
        if (legacyTheme === 'dark' || legacyTheme === 'light' || legacyTheme === 'auto') {
          saved = legacyTheme;
          localStorage.setItem(STORAGE_SHEET_MODE_KEY, saved);
        } else {
          saved = 'light';
        }
      }
    }
    return saved || 'light';
  } catch (e) {
    return 'light';
  }
}

export function applySheetAppearance() {
  const sheetMode = getSheetMode();

  let isDarkSheet = false;
  let isThemeSheet = false;

  if (sheetMode === 'theme') {
    isThemeSheet = true;
    isDarkSheet = true;
  } else if (sheetMode === 'dark') {
    isDarkSheet = true;
    isThemeSheet = false;
  } else if (sheetMode === 'light') {
    isDarkSheet = false;
    isThemeSheet = false;
  } else { // 'auto'
    isDarkSheet = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    isThemeSheet = false;
  }

  // Update DOM attributes and classes
  document.documentElement.setAttribute('data-sheet-mode', sheetMode);
  document.documentElement.setAttribute('data-sheet-dark', isDarkSheet ? 'true' : 'false');
  document.documentElement.setAttribute('data-theme-sheet', isThemeSheet ? 'true' : 'false');

  if (isThemeSheet) {
    document.body.classList.add('theme-sheet-active');
    document.body.classList.remove('sheet-mode-dark');
  } else if (isDarkSheet) {
    document.body.classList.add('sheet-mode-dark');
    document.body.classList.remove('theme-sheet-active');
  } else {
    document.body.classList.remove('sheet-mode-dark');
    document.body.classList.remove('theme-sheet-active');
  }

  // Sync UI Radio Buttons across modal & drawer
  const sheetRadios = document.querySelectorAll('input[name="sheetModeRadio"]');
  sheetRadios.forEach(radio => {
    radio.checked = radio.value === sheetMode;
  });
}

export function setSheetMode(mode) {
  try {
    localStorage.setItem(STORAGE_SHEET_MODE_KEY, mode);
  } catch (e) {}
  applySheetAppearance();
}

export function setTheme(themeName) {
  const themeObj = THEMES.find(t => t.id === themeName) || THEMES[0];
  const validThemeId = themeObj.id;

  document.documentElement.setAttribute('data-theme', validThemeId);
  document.body.setAttribute('data-theme', validThemeId);

  try {
    localStorage.setItem(STORAGE_THEME_KEY, validThemeId);
  } catch (e) {}

  // Update browser meta theme color
  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.setAttribute('name', 'theme-color');
    document.head.appendChild(metaThemeColor);
  }
  metaThemeColor.setAttribute('content', themeObj.bg);

  // Update drawer swatch & label
  const modalActiveBadge = document.getElementById('themeModalActiveBadge');
  const drawerSwatch = document.getElementById('drawerThemeSwatch');
  const drawerLabel = document.getElementById('drawerThemeName');

  if (modalActiveBadge) modalActiveBadge.innerText = themeObj.name;
  if (drawerSwatch) drawerSwatch.style.background = themeObj.gradient;
  if (drawerLabel) drawerLabel.innerText = themeObj.name;

  renderThemeModalGrid(validThemeId);
}

export function renderThemeModalGrid(activeThemeId = getCurrentTheme()) {
  const grid = document.getElementById('themeModalGrid');
  if (!grid) return;

  grid.innerHTML = THEMES.map(t => {
    const isActive = t.id === activeThemeId;
    const paletteChips = (t.colorway || []).map(color => `
      <span class="theme-colorway-chip" style="background-color: ${color};" title="${color}"></span>
    `).join('');

    return `
      <div class="theme-card ${isActive ? 'active' : ''}" data-theme-id="${t.id}">
        <div class="theme-card-top">
          <div class="theme-card-identity">
            <span class="theme-card-swatch" style="background: ${t.gradient};"></span>
            <div class="theme-card-text">
              <div class="theme-card-title">${t.name}</div>
              <div class="theme-card-subtitle">${t.subtitle}</div>
            </div>
          </div>
          ${isActive 
            ? `<span class="theme-active-pill"><i class="bi-check-circle-fill me-1"></i> Active</span>` 
            : `<span class="theme-select-hint">Select</span>`
          }
        </div>
        <div class="theme-card-gradient-bar" style="background: ${t.gradient};"></div>
        <div class="theme-card-bottom">
          <span class="theme-palette-label">COLORWAY</span>
          <div class="theme-palette-chips">
            ${paletteChips}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Attach click listeners to cards
  grid.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-theme-id');
      if (id) {
        setTheme(id);
      }
    });
  });
}

export function openThemeModal() {
  const modal = document.getElementById('themeModal');
  if (!modal) return;
  renderThemeModalGrid(getCurrentTheme());
  applySheetAppearance();
  modal.classList.add('show');
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
}

export function closeThemeModal() {
  const modal = document.getElementById('themeModal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.style.display = 'none';
  document.body.classList.remove('modal-open');
}

export function initTheming() {
  const initialTheme = getCurrentTheme();
  setTheme(initialTheme);
  applySheetAppearance();

  // Setup modal close listeners
  const closeBtns = document.querySelectorAll('.theme-modal-close-btn');
  closeBtns.forEach(btn => {
    btn.addEventListener('click', closeThemeModal);
  });

  const modal = document.getElementById('themeModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeThemeModal();
      }
    });
  }

  // Setup top bar trigger
  const topBarBtn = document.getElementById('topBarThemeBtn');
  if (topBarBtn) {
    topBarBtn.addEventListener('click', openThemeModal);
  }

  // Setup sheet mode radio change listeners
  const sheetRadios = document.querySelectorAll('input[name="sheetModeRadio"]');
  sheetRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        setSheetMode(radio.value);
      }
    });
  });

  // Listen for OS/browser color scheme changes when in 'auto' mode
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getSheetMode() === 'auto') {
        applySheetAppearance();
      }
    });
  }

  // ESC to close modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('show')) {
      closeThemeModal();
    }
  });
}
