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
          <p class="small text-white-50 mb-0">MajesticTab is free to use. Supporter is a one-time purchase that covers the cost of keeping it on this store, with no subscription. It unlocks:</p>
          <ul class="supporter-feature-list small text-white mb-0">
            ${Object.values(FEATURE_LABELS).map((label) => `<li><i class="bi-check2 me-2"></i>${label}</li>`).join('')}
          </ul>
          <div class="small text-white-50" id="supporterStatus" role="status"></div>
        </div>
        <footer class="theme-modal-footer d-flex align-items-center justify-content-between gap-2 flex-wrap">
          <button type="button" class="btn btn-theme-outline btn-sm" id="supporterRestoreBtn">Restore Purchases</button>
          <div class="d-flex align-items-center gap-2">
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
    window.addEventListener('supporterchange', (event) => { if (event.detail.owned) close(); });
    return modal;
}

/** Show the paywall, naming the feature that was tapped. */
export async function openPaywall(feature = null) {
    const el = ensureModal();
    el.querySelector('#supporterModalFeature').textContent = FEATURE_LABELS[feature] || 'Unlock the extras';
    el.querySelector('#supporterStatus').textContent = '';
    const buy = el.querySelector('#supporterBuyBtn');
    buy.textContent = 'Unlock';
    el.style.display = 'flex';
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

/**
 * Read ownership at launch and again when the app returns to the foreground (refunds, revoked sharing).
 * Resolves once the store has answered, for pages that must decide before showing anything.
 */
export async function initSupporter() {
    if (!isStoreChannel()) return hasSupporter();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - lastCheck > REVALIDATE_MS) checkSupporter();
    });
    return checkSupporter();
}
