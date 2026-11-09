// WKWebView (the macOS shell) can hand an arrow, Home, End, Page or Delete key to a focused text field as the text of
// the key (the AppKit function-key characters U+F700 to U+F8FF) instead of running the editing command, so the field
// shows a missing-glyph box. Cancel that insertion and do what the key means.
const FUNCTION_KEY = /[-]/;
const MOVES = {
    '': (el) => { const p = el.selectionStart === el.selectionEnd ? Math.max(0, el.selectionStart - 1) : el.selectionStart; el.setSelectionRange(p, p); },
    '': (el) => { const p = el.selectionStart === el.selectionEnd ? Math.min(el.value.length, el.selectionEnd + 1) : el.selectionEnd; el.setSelectionRange(p, p); },
    '': (el) => el.setSelectionRange(0, 0),
    '': (el) => el.setSelectionRange(el.value.length, el.value.length),
    '': (el) => el.setSelectionRange(0, 0),
    '': (el) => el.setSelectionRange(el.value.length, el.value.length),
};

document.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
    if (e.inputType !== 'insertText' || typeof e.data !== 'string' || !FUNCTION_KEY.test(e.data)) return;
    e.preventDefault();
    try { MOVES[e.data]?.(el); } catch { /* input types without a selection */ }
}, true);

// Fallbacks for when the character arrives some other way: move the caret ourselves for a plain Left or Right (the
// browser's own move is what WKWebView gets wrong), and strip the character if it still lands in the value.
const isTextField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search', 'url', 'tel', 'password', ''].includes(el.type)));

document.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const el = e.target;
    if (!isTextField(el)) return;
    e.preventDefault();
    try { MOVES[e.key === 'ArrowLeft' ? '' : ''](el); } catch { /* no selection */ }
}, true);

document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isTextField(el) || !FUNCTION_KEY.test(el.value)) return;
    const at = el.selectionStart;
    const before = el.value.slice(0, at).replace(/[-]/g, '').length;
    el.value = el.value.replace(/[-]/g, '');
    try { el.setSelectionRange(before, before); } catch { /* no selection */ }
}, true);
