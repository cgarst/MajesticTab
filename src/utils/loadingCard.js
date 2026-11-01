// In-view loading card shown over #output while a score loads (see .loading-card in style.css).
// Each show() returns a token; a stale load can't hide or update the card of a newer one.
// Shown immediately (a timer-based delay would fire late: score rendering keeps the main thread busy), and once
// shown it stays at least MIN_VISIBLE_MS to avoid a flash. #output is faded out for the whole load so no blank
// paper ever shows.
const MIN_VISIBLE_MS = 400;

let currentToken = 0;
let hideTimer = 0;
let shownAt = 0;

const byId = (id) => document.getElementById(id);

function setIdentity({ title, subtitle, coverUrl }) {
    const titleEl = byId('loadingCardTitle');
    const subtitleEl = byId('loadingCardSubtitle');
    const coverEl = byId('loadingCardCover');
    if (titleEl && title !== undefined) titleEl.textContent = title || 'Loading';
    if (subtitleEl && subtitle !== undefined) subtitleEl.textContent = subtitle || '';
    if (coverEl && coverUrl !== undefined) {
        if (coverUrl) {
            coverEl.onerror = () => { coverEl.hidden = true; };
            coverEl.src = coverUrl;
            coverEl.hidden = false;
        } else {
            coverEl.removeAttribute('src');
            coverEl.hidden = true;
        }
    }
}

function reveal() {
    const card = byId('loadingCard');
    if (!card) return;
    shownAt = performance.now();
    card.classList.add('is-visible');
    card.setAttribute('aria-hidden', 'false');
}

/**
 * @param {HTMLElement} output the #output element, faded out until the load ends
 * @param {{title?: string, subtitle?: string, coverUrl?: string, stage?: string}} identity
 */
export function showLoadingCard(output, { title, subtitle, coverUrl, stage = '' } = {}) {
    const token = ++currentToken;
    clearTimeout(hideTimer);
    output?.classList.add('is-loading');
    setIdentity({ title, subtitle, coverUrl: coverUrl || '' });
    setLoadingProgress(token, 0, stage);
    reveal();
    return token;
}

/** Update the identity shown (e.g. once the score has parsed and its real title is known). */
export function setLoadingIdentity(token, identity) {
    if (token !== currentToken) return;
    setIdentity(identity);
}

export function setLoadingProgress(token, percent, stage) {
    if (token !== currentToken) return;
    const fill = byId('loadingCardFill');
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    fill.style.width = `${pct}%`;
    byId('loadingCardTrack')?.setAttribute('aria-valuenow', String(pct));
    const stageEl = byId('loadingCardStage');
    if (stage !== undefined && stageEl) stageEl.textContent = stage;
}

export function hideLoadingCard(token, output) {
    if (token !== currentToken) return;
    const card = byId('loadingCard');
    const finish = () => {
        if (token !== currentToken) return;
        card?.classList.remove('is-visible');
        card?.setAttribute('aria-hidden', 'true');
        output?.classList.remove('is-loading');
    };
    const visibleFor = performance.now() - shownAt;
    if (card?.classList.contains('is-visible') && visibleFor < MIN_VISIBLE_MS) {
        hideTimer = setTimeout(finish, MIN_VISIBLE_MS - visibleFor);
    } else {
        finish();
    }
}
