/**
 * MajesticTab Theme Engine
 * Ported from concerts with 8 iconic guitar-inspired themes.
 * Default theme: 'Slate Blue'
 * Sheet appearance: Auto / Light / Dark / Theme (all in one row)
 */


export const THEMES = [
  {
    id: 'Slate Blue',
    name: 'Slate Blue',
    subtitle: 'Charcoal Flame Top, Slate and Copper',
    gradient: 'linear-gradient(135deg, #8db4f2, #1e2636)',
    bg: '#1e2636',
    accent: '#8db4f2',
    secondary: '#f0a850',
    colorway: ['#8db4f2', '#f0a850', '#8fb0e8', '#b0bfda', '#d98f3a', '#6f93cf']
  },
  {
    id: 'Mystic Dream',
    name: 'Mystic Dream',
    subtitle: 'ChromaFlair Chameleon (Purple / Emerald / Obsidian)',
    gradient: 'linear-gradient(135deg, #9333ea 0%, #06b6d4 50%, #10b981 100%)',
    bg: '#150f2e',
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
    bg: '#1f120c',
    accent: '#f97316',
    secondary: '#ef4444',
    colorway: ['#f97316', '#fbbf24', '#ef4444', '#f59e0b', '#ea580c', '#facc15']
  },
  {
    id: 'Purple Nebula',
    name: 'Purple Nebula',
    subtitle: 'Galactic Violet & Magenta',
    gradient: 'linear-gradient(135deg, #c026d3, #7c3aed)',
    bg: '#1c0f26',
    accent: '#c026d3',
    secondary: '#7c3aed',
    colorway: ['#c026d3', '#7c3aed', '#d946ef', '#8b5cf6', '#e879f9', '#ec4899']
  },
  {
    id: 'Red Nebula',
    name: 'Red Nebula',
    subtitle: 'Galactic Crimson & Slate',
    gradient: 'linear-gradient(135deg, #e11d48, #475569)',
    bg: '#230d10',
    accent: '#e11d48',
    secondary: '#475569',
    colorway: ['#e11d48', '#94a3b8', '#f43f5e', '#64748b', '#cbd5e1', '#be123c']
  },
  {
    id: 'Snow White',
    name: 'Snow White',
    subtitle: 'Bright Arctic Light Mode',
    gradient: 'linear-gradient(135deg, #ffffff 0%, #e2e8f0 55%, #334155 100%)',
    bg: '#ffffff',
    accent: '#334155',
    secondary: '#64748b',
    colorway: ['#ffffff', '#f1f5f9', '#cbd5e1', '#64748b', '#334155', '#0f172a']
  }
];

const STORAGE_THEME_KEY = 'majestictab_theme';
const STORAGE_SHEET_MODE_KEY = 'majestictab_sheet_mode';

const DEFAULT_THEME_ID = 'Slate Blue';

/** The saved theme, or the default. */
export function getCurrentTheme() {
  try {
    return localStorage.getItem(STORAGE_THEME_KEY) ||
           document.documentElement.getAttribute('data-theme') ||
           DEFAULT_THEME_ID;
  } catch (e) {
    return DEFAULT_THEME_ID;
  }
}

/** The saved sheet mode, or the light sheet. */
export function getSheetMode() {
  return getSavedSheetMode();
}

function getSavedSheetMode() {
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

/** User choice of sheet mode. */
export function setSheetMode(mode) {
  try {
    localStorage.setItem(STORAGE_SHEET_MODE_KEY, mode);
  } catch (e) {}
  applySheetAppearance();
  return true;
}

/** User choice of theme. */
export function setTheme(themeName) {
  const themeObj = THEMES.find(t => t.id === themeName) || THEMES[0];
  try {
    localStorage.setItem(STORAGE_THEME_KEY, themeObj.id);
  } catch (e) {}
  applyTheme(themeObj.id);
  return true;
}

/** Re-apply the saved theme and sheet mode without saving anything (restores). */
export function refreshAppearance() {
  applyTheme(getCurrentTheme());
  applySheetAppearance();
}

function applyTheme(themeName) {
  const themeObj = THEMES.find(t => t.id === themeName) || THEMES[0];
  const validThemeId = themeObj.id;

  document.documentElement.setAttribute('data-theme', validThemeId);
  document.body.setAttribute('data-theme', validThemeId);

  // Update browser meta theme color
  let metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.setAttribute('name', 'theme-color');
    document.head.appendChild(metaThemeColor);
  }
  metaThemeColor.setAttribute('content', themeObj.bg);

  // Android: the system bars are transparent over the window, so tell the shell the colour and icon contrast.
  try {
    const bgHex = /^#[0-9a-f]{6}$/i.test(themeObj.bg || '') ? themeObj.bg : '#06050a';
    const [r, g, b] = [1, 3, 5].map(i => parseInt(bgHex.slice(i, i + 2), 16));
    const isLight = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
    if (window.AndroidImmersive && window.AndroidImmersive.setSystemBars) {
      window.AndroidImmersive.setSystemBars(bgHex, isLight);
    }
  } catch (e) {}

  // Update drawer swatch & label
  const drawerSwatch = document.getElementById('drawerThemeSwatch');
  const drawerLabel = document.getElementById('drawerThemeName');

  if (drawerSwatch) drawerSwatch.style.background = themeObj.gradient;
  if (drawerLabel) drawerLabel.innerText = themeObj.name;

  renderThemeModalGrid(validThemeId);
}

export function renderThemeModalGrid(activeThemeId = getCurrentTheme()) {
  const grid = document.getElementById('themeModalGrid');
  if (!grid) return;

  grid.className = 'fin';
  grid.innerHTML = THEMES.map(t => {
    const isActive = t.id === activeThemeId;
    const f0 = t.bg || '#06050a';
    const fInk = t.id === 'Snow White' ? '#0f172a' : '#f8fafc';
    const c1 = t.accent || '#9333ea';
    const c2 = t.secondary || '#10b981';

    return `
      <button type="button" class="fin-tile" data-theme-id="${t.id}" aria-pressed="${isActive ? 'true' : 'false'}" style="--f0:${f0};--f-ink:${fInk}">
        <span class="bands"><i style="background:${c1}"></i><i style="background:${c2}"></i></span>
        <span class="nm">${t.name}</span>
      </button>
    `;
  }).join('');

  // Attach click listeners to tiles
  grid.querySelectorAll('[data-theme-id]').forEach(tile => {
    tile.addEventListener('click', () => {
      const id = tile.getAttribute('data-theme-id');
      if (id) {
        setTheme(id);
      }
    });
  });
}

export function initTheming() {
  refreshAppearance();
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
}
