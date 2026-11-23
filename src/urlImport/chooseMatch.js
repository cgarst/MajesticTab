// urlImport/chooseMatch.js
// The dialog shown when a service found several matches for the search text and wants one picked: a list of rows
// (title, then the artist as plain grey text) and Cancel. Resolves with the picked value, or null when cancelled.
// Styles: design.css (.match-row).

const ID = 'chooseMatchModal';
const CLOSE_MS = 150;

/**
 * @param {{title: string, query: string, options: {label: string, detail: string, value: string}[]}} choose from probeAddress
 * @returns {Promise<string|null>}
 */
export function chooseMatch({ title, query, options }) {
    return new Promise((resolve) => {
        let modal = document.getElementById(ID);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = ID;
            modal.className = 'theme-modal-backdrop';
            document.body.appendChild(modal);
        }
        modal.classList.remove('is-closing');
        modal.innerHTML = `
    <div class="theme-modal-card match-card" role="dialog" aria-modal="true" aria-labelledby="chooseMatchTitle">
      <div class="p-3 pb-2">
        <h5 class="modal-title fs-6 fw-bold mb-1" id="chooseMatchTitle">Pick a song</h5>
        <div class="small match-sub" id="chooseMatchSub"></div>
      </div>
      <div class="match-list" role="list"></div>
      <div class="d-flex justify-content-end gap-2 p-3">
        <button type="button" class="btn btn-sm btn-theme-outline px-3" id="chooseMatchCancel">Cancel</button>
      </div>
    </div>`;
        modal.querySelector('#chooseMatchSub').textContent = query
            ? `${title ? title + ' found' : 'Found'} several matches for “${query}”.`
            : `${title ? title + ' found' : 'Found'} several matches.`;
        const list = modal.querySelector('.match-list');
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey);
            modal.classList.add('is-closing');
            setTimeout(() => {
                if (!modal.classList.contains('is-closing')) return;
                modal.classList.remove('show', 'is-closing');
                modal.style.display = 'none';
            }, CLOSE_MS);
            resolve(value);
        };
        const onKey = (e) => { if (e.key === 'Escape') finish(null); };
        for (const option of options) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'match-row';
            row.setAttribute('role', 'listitem');
            const name = document.createElement('span');
            name.className = 'match-title';
            name.textContent = option.label;
            row.appendChild(name);
            if (option.detail) {
                const detail = document.createElement('span');
                detail.className = 'match-detail';
                detail.textContent = option.detail;
                row.appendChild(detail);
            }
            row.addEventListener('click', () => finish(option.value));
            list.appendChild(row);
        }
        modal.querySelector('#chooseMatchCancel').addEventListener('click', () => finish(null));
        document.addEventListener('keydown', onKey);
        modal.style.display = 'flex';
        modal.classList.add('show');
        list.querySelector('.match-row')?.focus();
    });
}
