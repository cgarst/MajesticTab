// readerViewMenu.js
// The reader's View menu. Holds the options you change while playing: size, paper tone
// (Auto, Light, Dark, Theme) and the page layout. The controls live in the settings markup
// (#readerViewOptions) with their original ids so the modules that bind to them keep working;
// this file moves that block into the menu and handles open, close and placement.

const $ = (id) => document.getElementById(id);

export function initReaderViewMenu() {
    const toggleBtn = $('viewToggleBtn');
    const menu = $('viewMenu');
    const options = $('readerViewOptions');
    if (!toggleBtn || !menu || !options) return;

    menu.appendChild(options);
    options.classList.add('p-2');

    const isOpen = () => menu.style.display !== 'none';

    function place() {
        const rect = toggleBtn.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 8)}px`;
        menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
    }

    function open() {
        place();
        menu.style.display = '';
        toggleBtn.setAttribute('aria-expanded', 'true');
    }

    function close() {
        if (!isOpen()) return;
        menu.style.display = 'none';
        toggleBtn.setAttribute('aria-expanded', 'false');
    }

    toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isOpen()) close(); else open();
    });
    document.addEventListener('pointerdown', (event) => {
        if (isOpen() && !menu.contains(event.target) && !toggleBtn.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) { close(); toggleBtn.focus(); }
    });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
}
