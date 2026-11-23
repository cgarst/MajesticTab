// urlImport/jobProgress.js
// The dialog shown while a service makes a file: a title, what it is doing, a bar, and Cancel.
// The bar is determinate when the service reports a fraction and indeterminate when it does not (styles: design.css).

const ID = 'jobProgressModal';
const CLOSE_MS = 150;

/**
 * @param {{title: string, onCancel: () => void}} options
 * @returns {{update: (state: {fraction: number|null, label: string, state: string}) => void, close: () => void}}
 */
export function showJobProgress({ title, onCancel }) {
    let modal = document.getElementById(ID);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = ID;
        modal.className = 'theme-modal-backdrop';
        document.body.appendChild(modal);
    }
    modal.classList.remove('is-closing');
    modal.innerHTML = `
    <div class="theme-modal-card job-progress-card" role="dialog" aria-modal="true" aria-labelledby="jobProgressTitle">
      <div class="theme-modal-body p-3">
        <h5 class="modal-title fs-6 fw-bold mb-3" id="jobProgressTitle"></h5>
        <div class="job-progress-label small mb-2" id="jobProgressLabel" aria-live="polite"></div>
        <div class="job-progress-bar" id="jobProgressBar" role="progressbar" aria-labelledby="jobProgressLabel" aria-valuemin="0" aria-valuemax="100" data-indeterminate="true">
          <div class="job-progress-fill" id="jobProgressFill"></div>
        </div>
      </div>
      <div class="d-flex justify-content-end gap-2 p-3 pt-0">
        <button type="button" class="btn btn-sm btn-theme-outline px-3" id="jobProgressCancel">Cancel</button>
      </div>
    </div>`;
    modal.querySelector('#jobProgressTitle').textContent = title;
    const label = modal.querySelector('#jobProgressLabel');
    const bar = modal.querySelector('#jobProgressBar');
    const fill = modal.querySelector('#jobProgressFill');
    const cancel = modal.querySelector('#jobProgressCancel');

    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    cancel.addEventListener('click', () => onCancel());
    document.addEventListener('keydown', onKey);
    modal.style.display = 'flex';
    modal.classList.add('show');
    cancel.focus();

    return {
        update({ fraction, label: text, state }) {
            label.textContent = text || (state === 'pending' ? 'Waiting in the queue' : 'Working');
            if (typeof fraction === 'number') {
                const pct = Math.round(fraction * 100);
                bar.removeAttribute('data-indeterminate');
                bar.setAttribute('aria-valuenow', String(pct));
                fill.style.transform = `scaleX(${fraction})`;
            } else {
                bar.setAttribute('data-indeterminate', 'true');
                bar.removeAttribute('aria-valuenow');
                fill.style.transform = '';
            }
        },
        close() {
            document.removeEventListener('keydown', onKey);
            modal.classList.add('is-closing');
            setTimeout(() => {
                if (!modal.classList.contains('is-closing')) return;
                modal.classList.remove('show', 'is-closing');
                modal.style.display = 'none';
            }, CLOSE_MS);
        }
    };
}
