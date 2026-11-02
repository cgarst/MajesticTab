// settingsPanel.js
// Settings is a regular page (like Tools and Setlists), not a drawer. This is its open/close
// controller: it shows and hides #fileMenu in place, with no slide or backdrop.
// Events (bubbling, on #fileMenu): 'settings:show', 'settings:shown', 'settings:hidden'.

const getEl = () => document.getElementById('fileMenu');
let wired = false;

function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('[data-settings-close]')) hide();
        else if (e.target.closest?.('[data-settings-toggle]')) toggle();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen() && !document.body.classList.contains('modal-open')) hide();
    });
}

export function isOpen() {
    return !!getEl()?.classList.contains('show');
}

export function show() {
    const el = getEl();
    wire();
    if (!el || isOpen()) return;
    el.dispatchEvent(new CustomEvent('settings:show', { bubbles: true }));
    document.body.classList.add('settings-as-page');
    el.classList.add('show');
    el.removeAttribute('aria-hidden');
    el.dispatchEvent(new CustomEvent('settings:shown', { bubbles: true }));
}

export function hide() {
    const el = getEl();
    if (!el || !isOpen()) return;
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('settings-as-page');
    document.activeElement?.blur?.();
    el.dispatchEvent(new CustomEvent('settings:hidden', { bubbles: true }));
}

export function toggle() {
    isOpen() ? hide() : show();
}

export const settingsPanel = { show, hide, toggle, isOpen };
