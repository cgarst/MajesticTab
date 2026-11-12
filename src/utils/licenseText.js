// Fills a license <details> in the About screen with its bundled text the first time it opens.
// The native builds ship the texts under vendor/licenses; the plain web build does not, so the fetch can fail.
export function initLicenseText() {
    document.addEventListener('toggle', async (event) => {
        const details = event.target;
        if (!(details instanceof HTMLDetailsElement) || !details.open) return;
        const src = details.dataset.licenseSrc;
        const out = details.querySelector('.license-expander-text');
        if (!src || !out || out.dataset.loaded) return;
        out.dataset.loaded = '1';
        try {
            const res = await fetch(src);
            if (!res.ok) throw new Error(String(res.status));
            out.textContent = await res.text();
        } catch {
            delete out.dataset.loaded;
            out.textContent = 'The license text is not bundled in this build. It is in the project repository linked above.';
        }
    }, true);
}
