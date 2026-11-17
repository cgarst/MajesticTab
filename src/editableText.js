// editableText.js
// A tab entered as text ("Add tab" > "Enter as text") is a plain .txt in the file store, flagged `editableText` on its
// tab option. It reads like any text tab; the Song menu's "Edit text" opens this modal to write it. While the text is
// empty the modal opens by itself when the tab is opened.

import { getCurrentFile, loadFile, refreshTextTab } from './main.js';
import { saveStoredFile } from './fileStore.js';
import { showToast } from './utils/toast.js';
import { buildStaff, insertBlockEdit, chordEdit, addBar, staffKey, SECTIONS, CHORD_ROOTS, CHORD_QUALITIES } from './textProcessor/textEditing.js';

const isEditable = (f) => Boolean(f && f.editableText && f.fileStoreId && !f.jamTransient);

let modal = null;
let editing = null;
let chordRoot = 'C';
let openTool = null;

const area = () => document.getElementById('editTextArea');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Edits go through the browser's own insert so Undo keeps working
function replaceRange(from, to, text) {
    const el = area();
    el.focus({ preventScroll: true });
    el.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) el.setRangeText(text, from, to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function insertBlock(block) {
    const el = area();
    const { at, text } = insertBlockEdit(el.value, el.selectionStart, block);
    replaceRange(at, at, text);
}

function showPanel(tool) {
    const panel = document.getElementById('editTextPanel');
    openTool = openTool === tool ? null : tool;
    document.querySelectorAll('#editTextTools [aria-expanded]').forEach((b) => {
        b.setAttribute('aria-expanded', String(b.dataset.tool === openTool));
    });
    if (!openTool) { panel.hidden = true; return; }
    if (openTool === 'section') {
        panel.innerHTML = `<div class="edit-text-row">${SECTIONS.map((s) => `<button type="button" class="edit-text-chip" data-section="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    } else {
        panel.innerHTML = `
          <div class="edit-text-row" role="group" aria-label="Root note">${CHORD_ROOTS.map((r) => `<button type="button" class="edit-text-chip" data-root="${r}" aria-pressed="${r === chordRoot}">${r}</button>`).join('')}</div>
          <div class="edit-text-row" role="group" aria-label="Chord type">${CHORD_QUALITIES.map(([q, label]) => `<button type="button" class="edit-text-chip" data-quality="${esc(q)}">${esc(label)}</button>`).join('')}</div>`;
    }
    panel.hidden = false;
}

function onTool(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const el = area();
    if (btn.dataset.tool === 'staff') insertBlock(buildStaff(editing?.preferredStringCount || editing?.songStringCount || 6));
    else if (btn.dataset.tool === 'bar') {
        const r = addBar(el.value, el.selectionStart);
        if (r) {
            replaceRange(0, el.value.length, r.value);
            el.setSelectionRange(r.caret, r.caret);
        } else showToast('Put the cursor in a staff to add a bar', 'info');
    } else if (btn.dataset.tool) showPanel(btn.dataset.tool);
    else if (btn.dataset.section) { insertBlock(`[${btn.dataset.section}]`); showPanel(openTool); }
    else if (btn.dataset.root) {
        chordRoot = btn.dataset.root;
        document.querySelectorAll('#editTextPanel [data-root]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.root === chordRoot)));
    } else if (btn.dataset.quality !== undefined) {
        const r = chordEdit(el.value, el.selectionStart, el.selectionEnd, `${chordRoot}${btn.dataset.quality}`);
        replaceRange(r.at, r.to, r.text);
    }
}

// Typing on a staff overwrites the dash under the cursor, so the columns stay lined up
function onBeforeInput(e) {
    if (e.isComposing || (e.inputType !== 'insertText' && e.inputType !== 'deleteContentBackward')) return;
    const el = e.target;
    if (el.selectionStart !== el.selectionEnd) return;
    const ch = e.inputType === 'insertText' ? e.data : 'Backspace';
    if (!ch || (ch.length !== 1 && ch !== 'Backspace')) return;
    const r = staffKey(el.value, el.selectionStart, ch);
    if (!r) return;
    e.preventDefault();
    if (r.replace) replaceRange(...r.replace);
    el.setSelectionRange(r.caret, r.caret);
}

function close() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKey, true);
    editing = null;
    openTool = null;
    const panel = document.getElementById('editTextPanel');
    if (panel) panel.hidden = true;
    document.querySelectorAll('#editTextTools [aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
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
        // The tab's recorded hash described the old text; a stale one stops a pack of the new text matching this tab
        if (file.librarySongId && file.tabId) {
            try { (await import('./libraryStore.js')).updateTabOptionOnSong(file.librarySongId, file.tabId, { sha256: null }).catch(() => {}); } catch (_) {}
        }
        // The reader shows the new text with everything else about the tab kept
        Object.assign(next, file);
        close();
        // Only the text is redrawn: the player, the recording and the reader's place stay as they are
        if (!(await refreshTextTab(next))) await loadFile(next, { keepMode: true });
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
    // The tools never take focus from the text, so the cursor and the phone keyboard stay where they are
    for (const id of ['editTextTools', 'editTextPanel']) {
        const box = document.getElementById(id);
        box?.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
        box?.addEventListener('click', onTool);
    }
    area()?.addEventListener('beforeinput', onBeforeInput);
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
