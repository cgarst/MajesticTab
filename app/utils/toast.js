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
            document.body.appendChild(toastContainer);
        }
    }
    return toastContainer;
}

/**
 * Show a themed notification toast
 * @param {string} message - Notification text
 * @param {'info'|'success'|'warning'|'error'} [type='info'] - Toast style
 * @param {number} [duration=3500] - Duration in ms before auto-dismiss
 */
export function showToast(message, type = 'info', duration = 3500) {
    if (typeof document === 'undefined' || !message) return;

    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `theme-toast theme-toast-${type}`;

    let iconClass = 'bi-info-circle-fill text-info';
    if (type === 'success') iconClass = 'bi-check-circle-fill text-success';
    else if (type === 'warning') iconClass = 'bi-exclamation-triangle-fill text-warning';
    else if (type === 'error') iconClass = 'bi-x-circle-fill text-danger';

    toast.innerHTML = `
        <i class="bi ${iconClass} theme-toast-icon"></i>
        <div class="theme-toast-message">${escapeHtml(message)}</div>
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

    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => {
        toast.classList.add('theme-toast-visible');
    });

    if (duration > 0) {
        setTimeout(dismiss, duration);
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
