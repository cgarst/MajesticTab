// One "Edit recordings…" toggle for the recordings list: it puts Move (to the other part) and Remove beside every audio file and every video.
// The button is shared; each list reports whether it has rows, and re-renders on REC_REMOVE_MODE_EVENT.

export const REC_REMOVE_MODE_EVENT = 'rec-remove-mode-changed';

const present = { files: false, videos: false };
let bound = false;

const button = () => document.getElementById('recRemoveBtn');

export function isRemoveMode() {
    return button()?.getAttribute('aria-pressed') === 'true';
}

function refresh() {
    const btn = button();
    if (!btn) return;
    const any = present.files || present.videos;
    btn.hidden = !any;
    if (!any) btn.setAttribute('aria-pressed', 'false');
    btn.textContent = isRemoveMode() ? 'Done' : 'Edit recordings…';
}

/** A list reports whether it has any rows to remove. */
export function setRecordingsPresent(kind, has) {
    present[kind] = Boolean(has);
    const btn = button();
    if (btn && !bound) {
        bound = true;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.setAttribute('aria-pressed', isRemoveMode() ? 'false' : 'true');
            refresh();
            window.dispatchEvent(new CustomEvent(REC_REMOVE_MODE_EVENT));
        });
    }
    const wasOn = isRemoveMode();
    refresh();
    if (wasOn && !isRemoveMode()) window.dispatchEvent(new CustomEvent(REC_REMOVE_MODE_EVENT));
}
