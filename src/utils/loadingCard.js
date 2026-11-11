// In-view loading card shown over #output while a score loads (see .loading-card in style.css).
// Each show() returns a token; a stale load can't hide or update the card of a newer one.
// Shown immediately (a timer-based delay would fire late: score rendering keeps the main thread busy), and once
// shown it stays at least MIN_VISIBLE_MS to avoid a flash. #output is faded out for the whole load so no blank
// paper ever shows.
import { getSynchronousCachedArtUrl } from '../musicbrainz.js';

const MIN_VISIBLE_MS = 400;
const BLANK_PIXEL = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3C/svg%3E';

let currentToken = 0;
let hideTimer = 0;
let shownAt = 0;
let activeCoverUrl = null;

const byId = (id) => document.getElementById(id);

function applyCover(token, coverEl, rawCoverUrl) {
    if (!rawCoverUrl) {
        activeCoverUrl = null;
        coverEl.removeAttribute('src');
        coverEl.hidden = true;
        return;
    }

    const coverUrl = (typeof getSynchronousCachedArtUrl === 'function' ? getSynchronousCachedArtUrl(rawCoverUrl) : null) || rawCoverUrl;

    // If the exact same cover is already active and decoded in the element, keep it visible
    if (activeCoverUrl === coverUrl && coverEl.src && !coverEl.hidden && coverEl.complete && coverEl.naturalWidth > 0) {
        return;
    }

    activeCoverUrl = coverUrl;

    // Immediately clear stale artwork from any previous tab so it does not linger
    // while the new image fetches or decodes. The blank pixel maintains the 56x56 footprint
    // and themed background (var(--s3)) to prevent layout shift.
    coverEl.src = BLANK_PIXEL;
    coverEl.hidden = false;

    if (typeof Image === 'undefined') {
        coverEl.src = coverUrl;
        return;
    }

    const img = new Image();
    img.src = coverUrl;

    const commit = () => {
        if (token !== currentToken || activeCoverUrl !== coverUrl) return;
        coverEl.src = coverUrl;
        coverEl.hidden = false;
    };

    const fail = () => {
        if (token !== currentToken || activeCoverUrl !== coverUrl) return;
        coverEl.removeAttribute('src');
        coverEl.hidden = true;
        activeCoverUrl = null;
    };

    if (typeof img.decode === 'function') {
        img.decode().then(commit).catch(() => {
            if (img.complete && img.naturalWidth > 0) {
                commit();
            } else {
                fail();
            }
        });
    } else {
        img.onload = commit;
        img.onerror = fail;
    }
}

function setIdentity(token, { title, subtitle, coverUrl }) {
    const titleEl = byId('loadingCardTitle');
    const subtitleEl = byId('loadingCardSubtitle');
    const coverEl = byId('loadingCardCover');
    if (titleEl && title !== undefined) titleEl.textContent = title || 'Loading';
    if (subtitleEl && subtitle !== undefined) subtitleEl.textContent = subtitle || '';
    if (coverEl && coverUrl !== undefined) {
        applyCover(token, coverEl, coverUrl);
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
    setIdentity(token, { title, subtitle, coverUrl: coverUrl || '' });
    setLoadingProgress(token, 0, stage);
    reveal();
    return token;
}

/** Update the identity shown (e.g. once the score has parsed and its real title is known). */
export function setLoadingIdentity(token, identity) {
    if (token !== currentToken) return;
    setIdentity(token, identity);
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
        const coverEl = byId('loadingCardCover');
        if (coverEl) {
            coverEl.removeAttribute('src');
            coverEl.hidden = true;
        }
        activeCoverUrl = null;
    };
    const visibleFor = performance.now() - shownAt;
    if (card?.classList.contains('is-visible') && visibleFor < MIN_VISIBLE_MS) {
        hideTimer = setTimeout(finish, MIN_VISIBLE_MS - visibleFor);
    } else {
        finish();
    }
}
