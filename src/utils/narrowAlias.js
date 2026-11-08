// narrowAlias.js
// The portrait phone reader's rules sit in "@media (max-width: 640px)" blocks, and a media query only sees the window.
// An iPhone Duo folded with the crease across (tabletop) is 669 points wide but wants that same chrome: the five words
// as the bottom row, the strip, and the phone sheets. Rather than copy those blocks, this restates them once, under
// the tabletop root, using CSS nesting: the same rules, the same specificity (":where" adds none), switched on by
// html.duo-tabletop instead of by the window width. Reader only; the library keeps its own layout.

const NARROW = /^\(\s*max-width:\s*640px\s*\)$/;
let installed = false;

function collect(rules, out) {
    for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
            if (NARROW.test(rule.conditionText.trim())) {
                for (const inner of rule.cssRules) {
                    // Nested @media and style rules restate fine; @keyframes and @font-face do not nest
                    if (inner instanceof CSSStyleRule || inner instanceof CSSMediaRule) out.push(inner.cssText);
                }
            } else {
                collect(rule.cssRules, out);
            }
        }
    }
}

function install() {
    if (installed) return;
    installed = true;
    const css = [];
    for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; } // a cross-origin sheet is unreadable and not ours
        collect(rules, css);
    }
    if (!css.length) return;
    const style = document.createElement('style');
    style.id = 'duoNarrowAlias';
    style.textContent = `:where(html.duo-tabletop:has(body:not(.library-view-active))) {\n${css.join('\n')}\n}`;
    document.head.appendChild(style);
}

export function initNarrowAlias() {
    window.addEventListener('foldchange', (event) => {
        if (event.detail?.pose === 'tabletop') install();
    });
}
