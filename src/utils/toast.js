// toast.js
// Theme-consistent toast notification system for MajesticTab (works seamlessly in browser and native Tauri apps).

let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer || !document.body.contains(toastContainer)) {
        toastContainer = document.getElementById('themeToastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'themeToastContainer';
            toastContainer.className = 'theme-toast-container';
            toastContainer.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastContainer);
        }
    }
    return toastContainer;
}

function hideToastEl(toast) {
    if (!toast || toast.classList.contains('theme-toast-hiding')) return;
    if (toast._dismissTimer) {
        clearTimeout(toast._dismissTimer);
        toast._dismissTimer = null;
    }
    toast.classList.add('theme-toast-hiding');
    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
}

/**
 * Dismiss an active toast by id.
 * @param {string} id
 */
export function dismissToast(id) {
    if (typeof document === 'undefined' || !id) return;
    const container = document.getElementById('themeToastContainer');
    const existing = container?.querySelector(`[data-toast-id="${id}"]`);
    if (existing) hideToastEl(existing);
}

/**
 * Show a themed notification toast
 * @param {string} message - Notification text
 * @param {'info'|'success'|'warning'|'error'} [type='info'] - Toast style
 * @param {number} [duration=3500] - Duration in ms before auto-dismiss (<= 0 keeps it until dismissed)
 * @param {string|null} [id] - Reuse a toast with the same id
 * @param {{label: string, onClick: Function}|null} [action] - Optional button, such as Undo; it dismisses the toast
 */
export function showToast(message, type = 'info', duration = 3500, id = null, action = null) {
    if (typeof document === 'undefined' || !message) return;

    const container = ensureToastContainer();

    if (id) {
        const existing = container.querySelector(`[data-toast-id="${id}"]`);
        if (existing) {
            existing.className = `theme-toast theme-toast-${type} theme-toast-visible`;
            existing.setAttribute('role', type === 'error' ? 'alert' : 'status');
            const msgEl = existing.querySelector('.theme-toast-message');
            if (msgEl) msgEl.textContent = message;
            const prevAction = existing.querySelector('.theme-toast-action');
            if (prevAction) prevAction.remove();
            if (action?.label) {
                const actionBtn = document.createElement('button');
                actionBtn.type = 'button';
                actionBtn.className = 'theme-toast-action';
                actionBtn.textContent = action.label;
                actionBtn.addEventListener('click', () => {
                    hideToastEl(existing);
                    try { action.onClick?.(); } catch (e) { console.error('[Toast] action failed:', e); }
                });
                existing.insertBefore(actionBtn, existing.querySelector('.theme-toast-close'));
            }
            if (existing._dismissTimer) {
                clearTimeout(existing._dismissTimer);
                existing._dismissTimer = null;
            }
            if (duration > 0) {
                existing._dismissTimer = setTimeout(() => hideToastEl(existing), duration);
            }
            return;
        }
    }

    const toast = document.createElement('div');
    toast.className = `theme-toast theme-toast-${type}`;
    if (id) toast.dataset.toastId = id;

    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    toast.innerHTML = `
        <span class="theme-toast-dot" aria-hidden="true"></span>
        <div class="theme-toast-message">${escapeHtml(message)}</div>
        ${action?.label ? `<button type="button" class="theme-toast-action">${escapeHtml(action.label)}</button>` : ''}
        <button type="button" class="theme-toast-close" aria-label="Dismiss">&times;</button>
    `;

    const closeBtn = toast.querySelector('.theme-toast-close');
    const dismiss = () => {
        if (toast.classList.contains('theme-toast-hiding')) return;
        toast.classList.add('theme-toast-hiding');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 250);
    };

    closeBtn?.addEventListener('click', dismiss);
    toast.querySelector('.theme-toast-action')?.addEventListener('click', () => {
        dismiss();
        try { action.onClick?.(); } catch (e) { console.error('[Toast] action failed:', e); }
    });

    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => {
        toast.classList.add('theme-toast-visible');
    });

    if (duration > 0) {
        toast._dismissTimer = setTimeout(dismiss, duration);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
