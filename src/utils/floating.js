// The dropdown menus (`[data-dropdown-toggle]` + `.dropdown-menu`). Replaces the dropdown script of the Bootstrap bundle,
// which was the only part of it the app still used.
//
// Dropdown markup:   <div class="dropdown"><button data-dropdown-toggle data-dropdown-offset="0,6">…</button>
//                      <ul class="dropdown-menu dropdown-menu-end">…</ul></div>
// Dropdown events (bubble from the toggle): dropdown:show, dropdown:shown, dropdown:hide, dropdown:hidden.

const EDGE = 8;
const ITEM_SELECTOR = '.dropdown-item:not(:disabled):not(.disabled)';

let insetsProvider = null;
const open = new Set();
const shifts = new WeakMap();
let rafId = 0;

/** Lets a screen reserve room at the viewport edge (the phone's bottom bar), so menus flip up instead of sitting under it. */
export function setDropdownViewportInsets(fn) {
  insetsProvider = typeof fn === 'function' ? fn : null;
}

function insets() {
  const base = { top: EDGE, left: EDGE, right: EDGE, bottom: EDGE };
  try {
    const extra = insetsProvider && insetsProvider();
    if (extra) {
      for (const k of Object.keys(base)) if (Number.isFinite(extra[k])) base[k] = Math.max(base[k], extra[k]);
    }
  } catch { /* fall back to the plain edge */ }
  return base;
}

function menuOf(toggle) {
  let el = toggle.nextElementSibling;
  while (el) {
    if (el.classList.contains('dropdown-menu')) return el;
    el = el.nextElementSibling;
  }
  return toggle.parentElement?.querySelector('.dropdown-menu') || null;
}

function toggleOf(menu) {
  const parent = menu.parentElement;
  return parent ? parent.querySelector('[data-dropdown-toggle]') : null;
}

function emit(toggle, name, cancelable = false) {
  const ev = new CustomEvent(`dropdown:${name}`, { bubbles: true, cancelable });
  toggle.dispatchEvent(ev);
  return !ev.defaultPrevented;
}

function offsetOf(toggle) {
  const raw = (toggle.getAttribute('data-dropdown-offset') || '0,2').split(',').map(Number);
  return { skid: Number.isFinite(raw[0]) ? raw[0] : 0, gap: Number.isFinite(raw[1]) ? raw[1] : 2 };
}

/** Place the open menu under (or over) its toggle, inside the viewport. Position is fixed and then corrected by what was
 *  measured, so it holds inside a scroller or a box that contains its fixed descendants. */
function place(toggle, menu) {
  const { skid, gap } = offsetOf(toggle);
  const pad = insets();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const t = toggle.getBoundingClientRect();

  menu.style.position = 'fixed';
  menu.style.inset = '0 auto auto 0';
  menu.style.margin = '0';
  menu.style.transform = 'none';
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;

  let x = (menu.classList.contains('dropdown-menu-end') ? t.right - w : t.left) + skid;
  x = Math.max(pad.left, Math.min(x, vw - pad.right - w));

  const below = t.bottom + gap;
  const above = t.top - gap - h;
  const fitsBelow = below + h <= vh - pad.bottom;
  const fitsAbove = above >= pad.top;
  let y;
  if (fitsBelow || !fitsAbove && vh - pad.bottom - t.bottom >= t.top - pad.top) y = below;
  else y = above;
  y = Math.max(pad.top, Math.min(y, vh - pad.bottom - h));

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  // A box that contains its fixed descendants (a scroller with paint containment) shifts where left/top land. Measure the
  // shift without the opening animation, which scales the box and would skew the reading, and keep it while that plays.
  const playing = menu.getAnimations ? menu.getAnimations().length > 0 : false;
  let shift = shifts.get(menu);
  if (!shift || !playing) {
    const keep = menu.style.animation;
    if (playing) menu.style.animation = 'none';
    const r = menu.getBoundingClientRect();
    if (playing) menu.style.animation = keep;
    shift = { dx: r.left - x, dy: r.top - y };
    shifts.set(menu, shift);
  }
  if (Math.abs(shift.dx) > 0.5) menu.style.left = `${x - shift.dx}px`;
  if (Math.abs(shift.dy) > 0.5) menu.style.top = `${y - shift.dy}px`;
}

function scheduleReplace() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    for (const toggle of open) {
      const menu = menuOf(toggle);
      if (menu) place(toggle, menu);
    }
  });
}

export function showDropdown(toggle) {
  const menu = menuOf(toggle);
  if (!menu || open.has(toggle) || toggle.disabled || toggle.classList.contains('disabled')) return;
  if (!emit(toggle, 'show', true)) return;
  for (const other of [...open]) if (!other.parentElement?.contains(toggle) && !toggle.parentElement?.contains(other)) hideDropdown(other);
  toggle.classList.add('show');
  menu.classList.add('show');
  toggle.setAttribute('aria-expanded', 'true');
  open.add(toggle);
  place(toggle, menu);
  emit(toggle, 'shown');
}

export function hideDropdown(toggle) {
  if (!open.has(toggle)) return;
  if (!emit(toggle, 'hide', true)) return;
  const menu = menuOf(toggle);
  open.delete(toggle);
  if (menu) shifts.delete(menu);
  toggle.classList.remove('show');
  toggle.setAttribute('aria-expanded', 'false');
  if (menu) {
    menu.classList.remove('show');
    for (const prop of ['position', 'inset', 'margin', 'transform', 'left', 'top']) menu.style.removeProperty(prop);
  }
  emit(toggle, 'hidden');
}

/** Close every open dropdown. Returns whether one was open. */
export function hideAllDropdowns() {
  const any = open.size > 0;
  for (const toggle of [...open]) hideDropdown(toggle);
  return any;
}

export function isDropdownOpen() {
  return open.size > 0;
}

function items(menu) {
  return [...menu.querySelectorAll(ITEM_SELECTOR)].filter((el) => el.offsetParent !== null);
}

function onKeydown(e) {
  const inToggle = e.target.closest?.('[data-dropdown-toggle]');
  const inMenu = e.target.closest?.('.dropdown-menu.show');
  if (e.key === 'Escape' && open.size) {
    const toggle = inMenu ? toggleOf(inMenu) : inToggle;
    const target = toggle && open.has(toggle) ? toggle : [...open].pop();
    hideDropdown(target);
    if (toggle) toggle.focus();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (inToggle) {
    e.preventDefault();
    if (!open.has(inToggle)) showDropdown(inToggle);
    const list = items(menuOf(inToggle) || document.body);
    (e.key === 'ArrowUp' ? list[list.length - 1] : list[0])?.focus();
  } else if (inMenu) {
    const list = items(inMenu);
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(e.target);
    const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1);
    list[next].focus();
  }
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

let ready = false;

export function initFloating() {
  if (ready || typeof document === 'undefined') return;
  ready = true;

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest?.('[data-dropdown-toggle]');
    if (toggle) {
      e.preventDefault();
      if (open.has(toggle)) hideDropdown(toggle);
      else showDropdown(toggle);
      return;
    }
    // Any other click closes the open menus, including a click on one of their items
    if (open.size) hideAllDropdowns();
  });
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('keyup', (e) => {
    // Tabbing out of a menu closes it
    if (e.key !== 'Tab' || !open.size) return;
    for (const toggle of [...open]) {
      const root = toggle.parentElement;
      if (root && !root.contains(e.target)) hideDropdown(toggle);
    }
  });
  window.addEventListener('resize', scheduleReplace, { passive: true });
  window.addEventListener('scroll', scheduleReplace, { passive: true, capture: true });
}
