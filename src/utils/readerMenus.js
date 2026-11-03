// View, Practice, Song, Guitar and Tools are one set: opening one closes the others.
// Each menu keeps its own open/close logic and reports its state on its button's aria-expanded,
// so this only watches those buttons and presses the one that is still open.
const IDS = ['viewToggleBtn', 'practiceToggleBtn', 'songToggleBtn', 'guitarToggleBtn', 'toolsToggleBtn'];

export function initReaderMenus() {
    const buttons = IDS.map((id) => document.getElementById(id)).filter(Boolean);
    buttons.forEach((btn) => {
        new MutationObserver(() => {
            if (btn.getAttribute('aria-expanded') !== 'true') return;
            buttons.forEach((other) => {
                if (other !== btn && other.getAttribute('aria-expanded') === 'true') other.click();
            });
        }).observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
    });
}
