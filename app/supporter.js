// MajesticTab Supporter: one-time in-app purchase on the App Store and Google Play channels.
// Channels without monetization have everything unlocked and never reach the store code (see channel.js).
// Purchases go through tauri-plugin-iap (StoreKit 2 / Play Billing). There is no server: ownership is read
// from the store on device, and the last answer is cached so a brief store outage doesn't lock features.

import { getFeature, hasSupporter, setSupporterOwned } from './channel.js';
import { showToast } from './utils/toast.js';

const CACHE_KEY = 'majestictab_supporter_cache';
// How long a cached "owned" answer is trusted when the store can't be reached (open question: offline grace).
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const REVALIDATE_MS = 5 * 60 * 1000;
// The one-time nudge: shown after a tab opens, from this launch on, and never again once it has appeared.
const NUDGE_KEY = 'majestictab_supporter_nudge';
const NUDGE_MIN_LAUNCHES = 5;
const NUDGE_DELAY_MS = 2000;
const NUDGE_VISIBLE_MS = 12000;
const PURCHASED = 0;
const PENDING = 2;

const FEATURE_LABELS = {
    themes: 'Finish themes',
    sheetModes: 'Dark, auto and theme tab modes',
    jamHost: 'Hosting a Jam',
    setlists: 'Creating and editing setlists',
    batchExport: 'Batch export',
    customSoundFonts: 'Custom SoundFonts'
};

let lastCheck = 0;
let priceText = '';

function isStoreChannel() {
    return getFeature('monetization') === 'iap' && Boolean(window.__TAURI__?.core?.invoke);
}

function productId() {
    return getFeature('supporterProductId');
}

function iap(command, payload) {
    return window.__TAURI__.core.invoke(`plugin:iap|${command}`, { payload });
}

function readCache() {
    try {
        const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        return cache && typeof cache.checkedAt === 'number' ? cache : null;
    } catch {
        return null;
    }
}

function writeCache(owned) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ owned, checkedAt: Date.now() }));
    } catch {}
}

/** Ask the store whether Supporter is owned (own purchase or Family Sharing) and update the app state. */
export async function checkSupporter() {
    if (!isStoreChannel()) return hasSupporter();
    lastCheck = Date.now();
    try {
        const status = await iap('get_product_status', { productId: productId(), productType: 'inapp' });
        const owned = Boolean(status?.isOwned) && (status.purchaseState === undefined || status.purchaseState === PURCHASED);
        // Play refunds a purchase that isn't acknowledged within three days. A no-op on Apple.
        if (owned && status.isAcknowledged === false && status.purchaseToken) {
            await iap('acknowledge_purchase', { purchaseToken: status.purchaseToken }).catch(() => {});
        }
        writeCache(owned);
        setSupporterOwned(owned);
        return owned;
    } catch (error) {
        console.warn('[Supporter] Store check failed:', error);
        const cache = readCache();
        const owned = Boolean(cache?.owned) && Date.now() - cache.checkedAt < OFFLINE_GRACE_MS;
        setSupporterOwned(owned);
        return owned;
    }
}

async function loadPrice() {
    if (priceText || !isStoreChannel()) return priceText;
    try {
        const { products } = await iap('get_products', { productIds: [productId()], productType: 'inapp' });
        priceText = products?.[0]?.formattedPrice || '';
    } catch (error) {
        console.warn('[Supporter] Could not load the price:', error);
    }
    return priceText;
}

function isCancelled(error) {
    return /cancel/i.test(String(error?.message ?? error));
}

async function purchaseSupporter() {
    const result = await iap('purchase', { productId: productId(), productType: 'inapp' });
    if (result?.purchaseState === PENDING) return 'pending';
    if (result?.purchaseState === PURCHASED && result.isAcknowledged === false && result.purchaseToken) {
        await iap('acknowledge_purchase', { purchaseToken: result.purchaseToken }).catch(() => {});
    }
    return (await checkSupporter()) ? 'owned' : 'none';
}

async function restoreSupporter() {
    await iap('restore_purchases', { productType: 'inapp' });
    return (await checkSupporter()) ? 'owned' : 'none';
}

// Start from the last answer, as soon as anything imports this module, so Supporters don't see the free
// theme or locked controls flash before the store replies.
if (isStoreChannel()) {
    const cache = readCache();
    if (cache?.owned && Date.now() - cache.checkedAt < OFFLINE_GRACE_MS) setSupporterOwned(true);
}

let modal = null;

function ensureModal() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'supporterModal';
    modal.className = 'theme-modal-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'supporterModalTitle');
    modal.style.display = 'none';
    modal.innerHTML = `
      <section class="theme-modal-card" style="max-width: 460px; width: 100%;">
        <header class="theme-modal-header d-flex align-items-center justify-content-between">
          <div class="d-flex align-items-center gap-2">
            <i class="bi-heart-fill text-info fs-5"></i>
            <div>
              <h2 class="h6 mb-0 text-white fw-bold" id="supporterModalTitle">MajesticTab Supporter</h2>
              <div class="small text-white-50" id="supporterModalFeature"></div>
            </div>
          </div>
          <button type="button" class="brand-btn theme-modal-close-btn" id="supporterCloseBtn" aria-label="Close" title="Close">
            <i class="bi-x-lg"></i>
          </button>
        </header>
        <div class="theme-modal-body d-flex flex-column gap-3">
          <p class="small text-white-50 mb-0" id="supporterIntro"></p>
          <ul class="supporter-feature-list small text-white mb-0">
            ${Object.values(FEATURE_LABELS).map((label) => `<li><i class="bi-check2 me-2"></i>${label}</li>`).join('')}
          </ul>
          <div class="small text-white-50" id="supporterStatus" role="status"></div>
        </div>
        <footer class="theme-modal-footer d-flex align-items-center justify-content-between gap-2 flex-wrap">
          <button type="button" class="btn btn-theme-outline btn-sm" id="supporterRestoreBtn">Restore Purchases</button>
          <button type="button" class="btn btn-theme-outline btn-sm" id="supporterManageBtn" hidden>
            <i class="bi-box-arrow-up-right me-1"></i><span id="supporterManageLabel"></span>
          </button>
          <div class="d-flex align-items-center gap-2 flex-shrink-0">
            <button type="button" class="btn btn-theme-outline btn-sm" id="supporterCancelBtn">Not Now</button>
            <button type="button" class="btn btn-theme-primary btn-sm" id="supporterBuyBtn">Unlock</button>
          </div>
        </footer>
      </section>`;
    document.body.appendChild(modal);

    const close = () => { modal.style.display = 'none'; };
    modal.querySelector('#supporterCloseBtn').addEventListener('click', close);
    modal.querySelector('#supporterCancelBtn').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.style.display !== 'none') close();
    });

    const status = modal.querySelector('#supporterStatus');
    const buy = modal.querySelector('#supporterBuyBtn');
    const restore = modal.querySelector('#supporterRestoreBtn');
    const run = async (action, doneMessage) => {
        buy.disabled = restore.disabled = true;
        status.textContent = '';
        try {
            const outcome = await action();
            if (outcome === 'owned') {
                close();
                showToast(doneMessage, 'success');
            } else if (outcome === 'pending') {
                status.textContent = 'Your purchase is pending approval. Supporter unlocks once it completes.';
            } else {
                status.textContent = 'No Supporter purchase was found for this account.';
            }
        } catch (error) {
            if (!isCancelled(error)) status.textContent = 'The purchase could not be completed. Please try again.';
        } finally {
            buy.disabled = restore.disabled = false;
        }
    };
    buy.addEventListener('click', () => run(purchaseSupporter, 'Thank you for supporting MajesticTab!'));
    restore.addEventListener('click', () => run(restoreSupporter, 'Supporter restored.'));
    modal.querySelector('#supporterManageBtn').addEventListener('click', () => openExternal(getFeature('supporterManageUrl')));
    window.addEventListener('supporterchange', (event) => { if (event.detail.owned) close(); });
    return modal;
}

async function openExternal(url) {
    if (!url) return;
    const opener = window.__TAURI__?.opener;
    if (opener?.openUrl) await opener.openUrl(url);
    else window.open(url, '_blank', 'noopener');
}

/** Show the Supporter dialog: the paywall (naming the feature that was tapped), or the thank-you view for owners. */
export async function openPaywall(feature = null) {
    const el = ensureModal();
    const owned = hasSupporter();
    const storeName = getFeature('storeName');
    el.querySelector('#supporterModalFeature').textContent = owned ? 'Thank you for your support' : (FEATURE_LABELS[feature] || 'Unlock the extras');
    el.querySelector('#supporterIntro').textContent = owned
        ? 'You own Supporter. It keeps MajesticTab on this store, and these are unlocked:'
        : 'MajesticTab is free to use. Supporter is a one-time purchase that covers the cost of keeping it on this store, with no subscription. It unlocks:';
    el.querySelector('#supporterStatus').textContent = '';
    const buy = el.querySelector('#supporterBuyBtn');
    buy.hidden = owned;
    buy.textContent = 'Unlock';
    el.querySelector('#supporterCancelBtn').textContent = owned ? 'Close' : 'Not Now';
    el.querySelector('#supporterRestoreBtn').textContent = owned ? 'Refresh Status' : 'Restore Purchases';
    const manage = el.querySelector('#supporterManageBtn');
    manage.hidden = !(owned && getFeature('supporterManageUrl'));
    el.querySelector('#supporterManageLabel').textContent = storeName ? `Manage in ${storeName}` : 'Manage';
    el.style.display = 'flex';
    if (owned) return;
    const price = await loadPrice();
    if (price) buy.textContent = `Unlock for ${price}`;
}

/**
 * Gate for a Supporter feature: true when it is available, otherwise opens the paywall and returns false.
 * Channels without monetization always return true.
 */
export function requireSupporter(feature) {
    if (hasSupporter()) return true;
    openPaywall(feature);
    return false;
}

/** Small lock marker for gated controls. */
export const LOCK_ICON_HTML = '<i class="bi-lock-fill supporter-lock" aria-hidden="true"></i>';

/** The Settings drawer entry (placeholder #supporterDrawerCard): a pitch with Learn More and Restore, or a thank-you row for owners. */
function renderDrawerCard() {
    const card = document.getElementById('supporterDrawerCard');
    if (!card) return;
    card.hidden = false;
    if (hasSupporter()) {
        card.innerHTML = `
          <button type="button" class="supporter-card-owned" data-action="open">
            <i class="bi-heart-fill text-info"></i>
            <span class="flex-grow-1 text-start">Supporter <span class="text-white-50">· Thank you</span></span>
            <i class="bi-chevron-right text-white-50"></i>
          </button>`;
    } else {
        card.innerHTML = `
          <div class="settings-card supporter-card">
            <div class="settings-header-label"><i class="bi-heart-fill text-info"></i> MajesticTab Supporter</div>
            <div class="small text-white-50">One-time purchase, no subscription. Unlocks finish themes, setlists, Jam hosting and more.</div>
            <div class="d-flex align-items-center justify-content-between gap-2">
              <button type="button" class="btn btn-sm theme-control-btn" data-action="open">Learn More</button>
              <button type="button" class="btn btn-link btn-sm p-0 border-0 text-white-50 text-decoration-none" data-action="restore">Restore Purchases</button>
            </div>
          </div>`;
    }
    card.querySelector('[data-action="open"]').addEventListener('click', () => openPaywall());
    card.querySelector('[data-action="restore"]')?.addEventListener('click', async () => {
        await openPaywall();
        modal.querySelector('#supporterRestoreBtn').click();
    });
}

function readNudge() {
    try {
        return { launches: 0, shown: false, ...JSON.parse(localStorage.getItem(NUDGE_KEY) || '{}') };
    } catch {
        return { launches: 0, shown: false };
    }
}

function writeNudge(state) {
    try {
        localStorage.setItem(NUDGE_KEY, JSON.stringify(state));
    } catch {}
}

/** A quiet, one-time toast that points at Supporter. Any way of closing it is final. */
function showNudge() {
    writeNudge({ ...readNudge(), shown: true });
    let container = document.getElementById('themeToastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'themeToastContainer';
        container.className = 'theme-toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'theme-toast theme-toast-info supporter-nudge';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
        <i class="bi-heart-fill text-info theme-toast-icon"></i>
        <div class="theme-toast-message">MajesticTab is free. Supporter is a one-time purchase that keeps it on this store.
          <div class="mt-2"><button type="button" class="btn btn-sm theme-control-btn">Learn More</button></div>
        </div>
        <button type="button" class="theme-toast-close" aria-label="Dismiss">&times;</button>`;
    const dismiss = () => {
        clearTimeout(timer);
        toast.classList.add('theme-toast-hiding');
        setTimeout(() => toast.remove(), 250);
    };
    const timer = setTimeout(dismiss, NUDGE_VISIBLE_MS);
    toast.querySelector('.theme-toast-close').addEventListener('click', dismiss);
    toast.querySelector('.theme-control-btn').addEventListener('click', () => {
        dismiss();
        openPaywall();
    });
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('theme-toast-visible'));
}

/** Offer the nudge after a tab opens, once the store has answered and nothing is playing or being shared. */
function initNudge(storeAnswered) {
    const state = readNudge();
    writeNudge({ ...state, launches: state.launches + 1 });
    if (state.shown || state.launches + 1 < NUDGE_MIN_LAUNCHES) return;
    const onFileLoaded = () => {
        setTimeout(() => {
            if (readNudge().shown || hasSupporter() || !storeAnswered()) return;
            if (document.body.classList.contains('synth-playback-started')) return;
            if (document.getElementById('jamToggleBtn')?.classList.contains('jam-active')) return;
            if (document.querySelector('.theme-modal-backdrop.show, #supporterModal[style*="flex"]')) return;
            window.removeEventListener('majestictab:file-loaded', onFileLoaded);
            showNudge();
        }, NUDGE_DELAY_MS);
    };
    window.addEventListener('majestictab:file-loaded', onFileLoaded);
}

/**
 * Read ownership at launch and again when the app returns to the foreground (refunds, revoked sharing).
 * Resolves once the store has answered, for pages that must decide before showing anything.
 */
export async function initSupporter() {
    if (!isStoreChannel()) return hasSupporter();
    renderDrawerCard();
    window.addEventListener('supporterchange', renderDrawerCard);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > REVALIDATE_MS) checkSupporter();
    });
    // The nudge waits for the store's answer, so owners never see it
    let answered = false;
    initNudge(() => answered);
    return checkSupporter().finally(() => { answered = true; });
}
