// guitarMenu.js
// The reader's "Guitar" button and panel: what guitar is in your hands right now. The tab says what it was written
// for; this panel can fit it to the guitar you are holding (strings, tuning, capo). The choice is temporary: it is
// not saved unless you choose "Save for this song", and it resets when the song closes. Your usual guitar (Settings,
// Defaults) is what every song starts on.
// The controls are the original ones from the Song panel (ids kept), moved here by this file.

import { getScoreMaxStringsForMode, formatTuningFromMidi, getInstrumentMode, setDefaultGpStringCount, getDefaultGpStringCount, getEffectiveGpStringCount, getTabStringCountPreference, setTabStringCountPreference } from './tuningUtils.js';
import { getUsualGuitar, setUsualGuitar, getTabAdaptPref, getSongGuitar, setSongGuitar, hasTemporaryAdapt, findAdaptTuning } from './tabAdapter.js';
import { getOverride } from './sessionOverrides.js';
import { showToast } from './toast.js';

import { showPanel, hidePanel, isShown, placePanel } from './readerPanels.js';

const $ = (id) => document.getElementById(id);

function currentScore() {
    return window.gpState?.canvases?.[0]?.api?.score || null;
}

/** "7 strings, Standard" from the file, ignoring any fit applied on top of it. */
function describeWrittenFor(score) {
    if (!score) return '';
    const mode = getInstrumentMode();
    const count = getScoreMaxStringsForMode(score, mode);
    let tuning = null;
    for (const track of score.tracks || []) {
        if (track.isPercussion) continue;
        const staff = (track.staves || []).find((s) => !s.isPercussion && (s._originalTunings || s.stringTuning?.tunings)?.length);
        if (staff) {
            tuning = formatTuningFromMidi(staff._originalTunings || staff.stringTuning.tunings);
            break;
        }
    }
    return `${count} strings${tuning ? `, ${tuning}` : ''}`;
}

/** The string count saved for this song, only when it differs from the Settings default (otherwise it is no change). */
function savedStrings(file) {
    const mode = getInstrumentMode();
    const saved = getTabStringCountPreference(file, mode);
    return saved && saved !== getDefaultGpStringCount(mode) ? saved : null;
}

/** Short state for the button: "Drop D, capo 2" or "7 strings". Empty when the song is on your usual guitar. */
function describeFit(file) {
    const parts = [];
    const adapt = getTabAdaptPref(file);
    if (hasTemporaryAdapt(file) || getSongGuitar(file) !== undefined) {
        if (adapt) {
            const t = findAdaptTuning(adapt.tuningName);
            const capo = currentScore()?._adaptSummary?.capo;
            parts.push(`${t?.shortName || adapt.tuningName}${adapt.method === 'capo' && capo ? `, capo ${capo}` : ''}`);
        } else {
            parts.push('as written');
        }
    }
    const strings = getOverride(file, 'strings');
    const count = strings ? strings.value : savedStrings(file);
    if (count) parts.push(`${count === 'native' ? 'original' : count} strings`);
    return parts.join(', ');
}

/** True when the song has a fit saved on purpose (tuning or strings). */
function hasSavedFit(file) {
    return getSongGuitar(file) !== undefined || Boolean(savedStrings(file));
}

function hasTemporaryFit(file) {
    return hasTemporaryAdapt(file) || Boolean(getOverride(file, 'strings'));
}

export function initGuitarMenu() {
    const btn = $('guitarToggleBtn');
    const menu = $('guitarMenu');
    if (!btn || !menu) return;

    const strings = $('scoreOptionsStringCountSection');
    const adapt = $('scoreOptionsAdaptSection');
    if (!strings || !adapt) return;

    // ---- Contents ----
    const head = document.createElement('div');
    head.className = 'guitar-menu-head';
    head.innerHTML = '<div class="guitar-menu-title">Guitar</div>'
        + '<div class="guitar-menu-sub">What is in your hands right now. Resets when you leave the song, unless you save it for this song.</div>';
    const written = document.createElement('div');
    written.className = 'guitar-menu-written';
    written.innerHTML = '<span class="guitar-menu-label">The tab is written for</span><b id="guitarWrittenFor"></b>';

    const stringsLabel = strings.querySelector('label.form-label');
    if (stringsLabel) stringsLabel.textContent = 'Strings shown';
    strings.querySelector('#scoreCurrentStringsBadge')?.remove();
    const adaptLabel = adapt.querySelector('label.form-label');
    if (adaptLabel) adaptLabel.textContent = 'Fit to my guitar';
    adapt.querySelector('#adaptStateBadge')?.remove();
    adapt.querySelector('label[for="adaptCapoSelect"]')?.replaceChildren('Capo fret');

    const foot = document.createElement('div');
    foot.className = 'guitar-menu-foot';
    foot.innerHTML = '<button type="button" class="btn btn-sm guitar-menu-action" id="guitarSongBtn">Save for this song</button>'
        + '<button type="button" class="btn btn-sm guitar-menu-action" id="guitarUsualBtn">Make this my usual guitar</button>'
        + '<button type="button" class="btn btn-sm guitar-menu-action" id="guitarResetBtn">Reset</button>';

    menu.replaceChildren(head, written, strings, adapt, foot);

    // ---- Open, close, placement ----
    const isOpen = () => isShown(menu);
    const place = () => placePanel(menu, btn);
    function open() {
        refresh();
        showPanel(menu);
        place();
        btn.setAttribute('aria-expanded', 'true');
        window.refreshSlidingPills?.(menu, true);
    }
    function close() {
        if (!isOpen()) return;
        hidePanel(menu);
        btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen()) close(); else open(); });
    document.addEventListener('pointerdown', (e) => { if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { close(); btn.focus(); } });
    window.addEventListener('resize', () => { if (isOpen()) place(); });

    // ---- State ----
    function refresh() {
        const file = window.gpState?.currentFile;
        const score = currentScore();
        const available = Boolean(score) && (strings.style.display !== 'none' || adapt.style.display !== 'none');
        btn.disabled = !available;
        if (!available) { close(); }
        $('guitarWrittenFor').textContent = describeWrittenFor(score);
        const state = file ? describeFit(file) : '';
        const temporary = file ? hasTemporaryFit(file) : false;
        const saved = file ? hasSavedFit(file) : false;
        btn.classList.toggle('is-adapted', Boolean(state));
        btn.title = !state ? 'Guitar: strings, tuning and capo for the guitar in your hands'
            : temporary ? `Guitar: ${state}. Not saved.` : `Guitar: ${state}. Saved for this song.`;
        // One button for the song: save a temporary choice, or forget what was saved
        const songBtn = $('guitarSongBtn');
        songBtn.textContent = !temporary && saved ? 'Forget for this song' : 'Save for this song';
        songBtn.disabled = !temporary && !saved;
        $('guitarResetBtn').disabled = !temporary;
        const usualBtn = $('guitarUsualBtn');
        usualBtn.disabled = !temporary && !saved;
    }
    document.addEventListener('guitar:overrides-changed', refresh);
    new MutationObserver(refresh).observe(strings, { attributes: true, attributeFilter: ['style'] });
    new MutationObserver(refresh).observe(adapt, { attributes: true, attributeFilter: ['style'] });
    refresh();

    $('guitarResetBtn').addEventListener('click', async () => {
        const { resetGuitarFit } = await import('../gpProcessor/gpHandler.js');
        resetGuitarFit();
        refresh();
    });

    // Saves what is in your hands with this song. The next time it opens, it opens on this fit.
    $('guitarSongBtn').addEventListener('click', async () => {
        const file = window.gpState?.currentFile;
        if (!file) return;
        const handler = await import('../gpProcessor/gpHandler.js');
        if (hasTemporaryFit(file)) {
            const adaptOverride = getOverride(file, 'adapt');
            if (adaptOverride !== undefined) setSongGuitar(file, adaptOverride);
            const stringsOverride = getOverride(file, 'strings');
            if (stringsOverride) setTabStringCountPreference(file, stringsOverride.value, stringsOverride.mode);
            // The saved fit now matches what is showing, so the temporary layer can go
            const { setOverride } = await import('./sessionOverrides.js');
            setOverride(file, 'adapt', undefined);
            setOverride(file, 'strings', undefined);
            showToast('Saved for this song. It opens this way next time.', 'success');
        } else {
            handler.forgetSavedGuitar();
            showToast('Forgot the saved fit. This song opens on your usual guitar.', 'info');
        }
        refresh();
    });

    // Writes to Settings, never to the song: the next song opens on this guitar
    $('guitarUsualBtn').addEventListener('click', async () => {
        const file = window.gpState?.currentFile;
        if (!file) return;
        const mode = getInstrumentMode();
        setUsualGuitar(getTabAdaptPref(file));
        setDefaultGpStringCount(getEffectiveGpStringCount(file, mode), mode);
        const { resetGuitarFit, forgetSavedGuitar } = await import('../gpProcessor/gpHandler.js');
        // This song now follows the usual guitar, so drop its own temporary and saved fits
        forgetSavedGuitar();
        resetGuitarFit();
        showToast('Saved as your usual guitar. New songs open on it.', 'success');
        refresh();
    });
}
