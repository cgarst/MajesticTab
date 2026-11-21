// Show or hide the cursor over the notes (Guitar Pro cursor, text reading marker, PDF marker) in every layout.
// One stored value, set from View and from Settings > Defaults; the two controls follow each other.
const KEY = 'showScoreCursor';

export function getShowScoreCursor() {
    return localStorage.getItem(KEY) !== 'false';
}

function sync() {
    const show = getShowScoreCursor();
    document.body.classList.toggle('cursor-off', !show);
    document.querySelectorAll('input[name="scoreCursorRadio"], input[name="scoreCursorDefaultRadio"]').forEach((r) => {
        r.checked = r.value === (show ? 'show' : 'hide');
    });
}

export function setShowScoreCursor(show) {
    localStorage.setItem(KEY, show ? 'true' : 'false');
    sync();
}

export function initScoreCursor() {
    sync();
    document.querySelectorAll('input[name="scoreCursorRadio"], input[name="scoreCursorDefaultRadio"]').forEach((r) => {
        r.addEventListener('change', () => { if (r.checked) setShowScoreCursor(r.value === 'show'); });
    });
}
