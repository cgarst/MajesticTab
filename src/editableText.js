// editableText.js
// A tab entered as text ("Add tab" > "Enter as text") is a plain .txt in the file store, flagged `editableText` on its
// tab option. It reads like any text tab; the Song menu's "Edit text" opens this modal to write it. While the text is
// empty the modal opens by itself when the tab is opened.

import { getCurrentFile, loadFile } from './main.js';
import { saveStoredFile } from './fileStore.js';
import { showToast } from './utils/toast.js';

const isEditable = (f) => Boolean(f && f.editableText && f.fileStoreId && !f.jamTransient);

let modal = null;
let editing = null;

function close() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey, true);
    editing = null;
}

function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
}

async function save() {
    const file = editing;
    if (!file) return;
    const text = document.getElementById('editTextArea').value;
    try {
        const next = new File([text.trim() ? text : '\n'], file.name, { type: 'text/plain' });
        await saveStoredFile(next, file.providerId || 'local', { id: file.fileStoreId, editableText: true });
        // The reader shows the new text with everything else about the tab kept
        Object.assign(next, file);
        close();
        await loadFile(next, { keepMode: true });
    } catch (err) {
        console.warn('Could not save the text:', err);
        showToast('Could not save the text', 'error');
    }
}

export async function openTextEditor(file) {
    if (!isEditable(file)) return;
    modal = modal || document.getElementById('editTextModal');
    if (!modal) return;
    const area = document.getElementById('editTextArea');
    const existing = (await file.text()).replace(/^\n$/, '');
    editing = file;
    area.value = existing;
    modal.style.display = 'flex';
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => area.focus(), 50);
}

export function setupEditableText() {
    const btn = document.getElementById('editTextBtn');
    const refresh = () => { if (btn) btn.style.display = isEditable(getCurrentFile()) ? '' : 'none'; };
    document.addEventListener('scoreoptions:open', refresh);
    btn?.addEventListener('click', () => {
        const file = getCurrentFile();
        if (!isEditable(file)) return;
        document.getElementById('scoreOptionsPanelCloseBtn')?.click();
        openTextEditor(file);
    });
    document.getElementById('editTextSaveBtn')?.addEventListener('click', save);
    document.getElementById('editTextCancelBtn')?.addEventListener('click', close);
    document.getElementById('editTextCloseBtn')?.addEventListener('click', close);
    // Until the text is written, opening the tab opens the editor
    window.addEventListener('majestictab:file-loaded', async (e) => {
        const file = e.detail?.file;
        if (!isEditable(file) || editing) return;
        try {
            if (!(await file.text()).trim()) openTextEditor(file);
        } catch (_) {}
    });
}
