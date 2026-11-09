// pointerFocus.js
// The progress bars (the bar ruler, the recording bar, the page strip) are focusable sliders, so the arrow keys can move
// them after a press. A press focuses them, and the next key (Space is playback, never the slider's) would then make the
// browser draw its keyboard focus ring. The ring is for people who Tabbed to the bar: a press marks the focus as coming
// from the pointer (`data-pointer-focus`, which design.css reads), and Tab or leaving the bar clears the mark.

const SLIDER = '[role="slider"][tabindex]';

document.addEventListener('pointerdown', (e) => {
    const slider = e.target.closest?.(SLIDER);
    if (slider) slider.dataset.pointerFocus = '1';
}, true);

document.addEventListener('focusout', (e) => {
    if (e.target?.dataset?.pointerFocus) delete e.target.dataset.pointerFocus;
}, true);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') document.querySelectorAll('[data-pointer-focus]').forEach((el) => delete el.dataset.pointerFocus);
}, true);
