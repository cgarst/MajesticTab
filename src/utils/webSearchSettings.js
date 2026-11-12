// utils/webSearchSettings.js
// Web search and adblocking settings for native clients (desktop and mobile).
// Manages dynamic adblock toggling/cache upkeep and search provider configuration.

import {
    isDesktopNative,
    getSources,
    saveSources,
    resetToDefaultSources,
    stampSourceChanges,
    renderDownloaderTabs,
    DEFAULT_SOURCES,
    openTabDownloader
} from '../tabDownloader.js';
// @inAppBrowser:begin
import {
    isAdblockEnabled,
    setAdblockEnabled,
    getAdblockStatus
} from '../tabDownloader.js';
// @inAppBrowser:end
import { hasFeature } from '../channel.js';
import { showToast } from './toast.js';

// The downloader opens over the library, not over Settings: step back out of the Settings view first
async function hideSettings() {
    const { handleBack, getActiveLibraryView } = await import('../libraryModal.js');
    if (getActiveLibraryView() === 'settings') await handleBack();
}

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}

function row(title, help, ...controls) {
    const r = el('div', 'srow');
    const text = el('div', 'st');
    text.appendChild(el('b', '', title));
    if (help) text.appendChild(el('span', '', help));
    r.appendChild(text);
    const sc = el('div', 'sc');
    controls.filter(Boolean).forEach((c) => sc.appendChild(c));
    r.appendChild(sc);
    return r;
}

function group(title, ...children) {
    const g = el('div', 'sgroup');
    if (title) g.appendChild(el('h3', '', title));
    const rows = el('div', 'srows');
    children.filter(Boolean).forEach((c) => rows.appendChild(c));
    g.appendChild(rows);
    return g;
}

function note(text) {
    return el('p', 'snote', text);
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return 'never';
    const diff = Math.max(0, Date.now() - timestamp);
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
}

// @inAppBrowser:begin
let updateAdblockDisabledState = null;

function makeAdblockGroup() {
    const sw = el('input', 'form-check-input theme-switch');
    sw.type = 'checkbox';
    sw.checked = isAdblockEnabled();
    sw.setAttribute('aria-label', 'Block ads and trackers');

    const statusSpan = el('span', 'small mt-1 d-block');
    const refreshBtn = el('button', 'btn btn-sm srow-ghost', 'Refresh list');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('aria-label', 'Refresh ad blocking list');

    const updateStatusText = () => {
        const isSystem = localStorage.getItem('majestictab_web_search_browser') === 'system';
        if (isSystem) {
            statusSpan.textContent = 'Only applies when using the in-app browser.';
            refreshBtn.disabled = true;
            sw.disabled = true;
            return;
        }
        sw.disabled = false;
        const status = getAdblockStatus();
        if (!status.enabled) {
            statusSpan.textContent = 'Disabled. When turned on, community rules are downloaded dynamically.';
            refreshBtn.disabled = true;
        } else {
            const countStr = status.count > 0 ? `${status.count.toLocaleString()} domains blocked` : 'Downloading list...';
            const ageStr = status.lastUpdated > 0 ? formatRelativeTime(status.lastUpdated) : 'just now';
            statusSpan.textContent = `${countStr} • Updated ${ageStr}`;
            refreshBtn.disabled = false;
        }
    };

    refreshBtn.addEventListener('click', async () => {
        if (refreshBtn.disabled) return;
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing...';
        try {
            const res = await setAdblockEnabled(true, true);
            showToast(`List updated (${res.count.toLocaleString()} domains)`, 2500);
        } catch {
            showToast('Failed to refresh list', 3000);
        } finally {
            refreshBtn.textContent = 'Refresh list';
            refreshBtn.disabled = false;
            updateStatusText();
        }
    });

    sw.addEventListener('change', async () => {
        if (sw.disabled) return;
        const enabling = sw.checked;
        const status = getAdblockStatus();
        if (enabling && status.count === 0) {
            showToast('Turning on ad blocking (downloading community list)...', 3000);
        }
        refreshBtn.disabled = !enabling;
        try {
            const res = await setAdblockEnabled(enabling);
            if (res.enabled) {
                showToast(`Ad blocking on (${res.count.toLocaleString()} domains)`, 2500);
            } else {
                showToast('Ad blocking off', 2500);
            }
        } catch {
            showToast('Failed to update ad blocking rules', 3000);
        }
        updateStatusText();
    });

    updateStatusText();

    const switchWrap = el('div', 'form-check form-switch mb-0');
    switchWrap.appendChild(sw);

    const controlsWrap = el('div', 'd-flex align-items-center gap-2');
    controlsWrap.appendChild(refreshBtn);
    controlsWrap.appendChild(switchWrap);

    const mainRow = row(
        'Block ads and trackers',
        'Blocks popups, video ads, and fake download buttons using Peter Lowe’s community list.',
        controlsWrap
    );
    mainRow.querySelector('.st')?.appendChild(statusSpan);

    updateAdblockDisabledState = () => {
        const isSystem = localStorage.getItem('majestictab_web_search_browser') === 'system';
        mainRow.classList.toggle('opacity-50', isSystem);
        updateStatusText();
    };

    updateAdblockDisabledState();

    return group('Ad and tracker blocking', mainRow);
}
// @inAppBrowser:end

function makeProvidersGroup() {
    const container = el('div', 'sgroup');
    const heading = el('h3', '', 'Search providers');
    container.appendChild(heading);
    container.appendChild(note('Choose where web search looks for tabs, or configure custom search templates for your web browser.'));

    const listWrap = el('div', 'srows mt-2');
    container.appendChild(listWrap);

    function renderList(openEditorForId = null) {
        listWrap.innerHTML = '';
        const sources = getSources();

        // @inAppBrowser:begin
        // Browser preference (in-app vs system browser)
        const browserPrefKey = 'majestictab_web_search_browser';
        const currentBrowser = localStorage.getItem(browserPrefKey) || 'in-app';
        const browserSeg = el('div', 'hud-pill-group');
        browserSeg.setAttribute('role', 'radiogroup');
        browserSeg.setAttribute('aria-label', 'Open search in');

        const inAppBtn = el('button', 'btn btn-sm' + (currentBrowser !== 'system' ? ' active' : ''));
        inAppBtn.type = 'button';
        inAppBtn.textContent = 'In-app browser';
        inAppBtn.addEventListener('click', () => {
            localStorage.setItem(browserPrefKey, 'in-app');
            try { window.dispatchEvent(new CustomEvent('majestictab-web-search-browser-changed', { detail: 'in-app' })); } catch {}
            inAppBtn.classList.add('active');
            sysBtn.classList.remove('active');
            updateAdblockDisabledState?.();
            updateTestSearchState?.();
        });

        const sysBtn = el('button', 'btn btn-sm' + (currentBrowser === 'system' ? ' active' : ''));
        sysBtn.type = 'button';
        sysBtn.textContent = 'System default browser';
        sysBtn.addEventListener('click', () => {
            localStorage.setItem(browserPrefKey, 'system');
            try { window.dispatchEvent(new CustomEvent('majestictab-web-search-browser-changed', { detail: 'system' })); } catch {}
            sysBtn.classList.add('active');
            inAppBtn.classList.remove('active');
            updateAdblockDisabledState?.();
            updateTestSearchState?.();
        });

        browserSeg.appendChild(inAppBtn);
        browserSeg.appendChild(sysBtn);

        const browserRow = row('Open search in', 'Choose whether web search opens inside MajesticTab or in your default web browser.', browserSeg);
        listWrap.appendChild(browserRow);
        // @inAppBrowser:end

        // Default provider row (dropdown)
        const defaultSelect = el('select', 'form-select form-select-sm');
        defaultSelect.setAttribute('aria-label', 'Default search provider');
        defaultSelect.style.width = 'auto';
        defaultSelect.style.minWidth = '140px';

        sources.forEach((src) => {
            const opt = el('option');
            opt.value = src.id;
            opt.textContent = src.name;
            if (sources[0]?.id === src.id) {
                opt.selected = true;
            }
            defaultSelect.appendChild(opt);
        });

        defaultSelect.addEventListener('change', () => {
            const selectedId = defaultSelect.value;
            if (sources[0]?.id === selectedId) return;
            const idx = sources.findIndex((s) => s.id === selectedId);
            if (idx > 0) {
                const [item] = sources.splice(idx, 1);
                sources.unshift(item);
                stampSourceChanges(sources);
                saveSources(sources);
                renderDownloaderTabs();
                renderList();
            }
        });

        const defaultRow = row('Default search provider', 'Opened first when searching for a tab.', defaultSelect);
        listWrap.appendChild(defaultRow);

        // Individual provider rows
        sources.forEach((src) => {
            const queryLabel = src.queryFormat === 'song_only' ? 'Song name only' : 'Artist and song';
            const helpText = `${src.urlTemplate || 'No URL template'} • ${queryLabel}${src.isSeed ? ' • Built-in' : ''}`;

            const editBtn = el('button', 'btn btn-sm srow-ghost', 'Edit');
            editBtn.type = 'button';
            editBtn.setAttribute('aria-expanded', 'false');

            const itemRow = row(src.name, helpText, editBtn);
            itemRow.classList.add('srow-task');

            const editorSlot = el('div', 'srow-editor-slot');
            editorSlot.hidden = true;

            const buildEditor = () => {
                editorSlot.innerHTML = '';

                // Provider name
                const nameLabel = el('label', 'small text-white-50 mb-1', 'Provider name');
                const nameInput = el('input', 'form-control form-control-sm');
                nameInput.type = 'text';
                nameInput.value = src.name || '';
                nameInput.disabled = Boolean(src.isSeed);
                const nameWrap = el('div');
                nameWrap.appendChild(nameLabel);
                nameWrap.appendChild(nameInput);
                editorSlot.appendChild(nameWrap);

                // URL template
                const urlLabelRow = el('div', 'd-flex align-items-center justify-content-between mb-1');
                urlLabelRow.appendChild(el('label', 'small text-white-50 mb-0', 'Search URL template'));
                if (!src.isSeed && src.defaultUrl) {
                    const resetUrlBtn = el('button', 'btn btn-link btn-sm text-info text-decoration-none p-0', 'Reset URL');
                    resetUrlBtn.type = 'button';
                    resetUrlBtn.addEventListener('click', () => {
                        urlInput.value = src.defaultUrl;
                    });
                    urlLabelRow.appendChild(resetUrlBtn);
                }
                const urlInput = el('input', 'form-control form-control-sm font-monospace');
                urlInput.type = 'text';
                urlInput.value = src.urlTemplate || '';
                urlInput.disabled = Boolean(src.isSeed);
                const urlHint = el('div', 'form-text small text-white-50 mt-1', 'Use <code>$s</code> where search keywords should be inserted.');
                const urlWrap = el('div');
                urlWrap.appendChild(urlLabelRow);
                urlWrap.appendChild(urlInput);
                urlWrap.appendChild(urlHint);
                editorSlot.appendChild(urlWrap);

                // Query format
                const queryLabelEl = el('label', 'small text-white-50 mb-1', 'Search query format');
                const querySelect = el('select', 'form-select form-select-sm');
                const optBoth = el('option', '', 'Artist and song name (e.g. Carulli Duo No 2 In G Major)');
                optBoth.value = 'artist_song';
                const optSong = el('option', '', 'Song name only (e.g. Duo No 2 In G Major)');
                optSong.value = 'song_only';
                querySelect.appendChild(optBoth);
                querySelect.appendChild(optSong);
                querySelect.value = src.queryFormat || 'artist_song';
                const queryWrap = el('div');
                queryWrap.appendChild(queryLabelEl);
                queryWrap.appendChild(querySelect);
                editorSlot.appendChild(queryWrap);

                // Force desktop (mobile only)
                let desktopCheck = null;
                if (!isDesktopNative()) {
                    const desktopWrap = el('div', 'p-2 rounded-2 mt-1');
                    desktopWrap.style.background = 'var(--s1)';
                    const switchDiv = el('div', 'form-check form-switch mb-1');
                    desktopCheck = el('input', 'form-check-input theme-switch');
                    desktopCheck.type = 'checkbox';
                    desktopCheck.id = `desktopSwitch_${src.id}`;
                    desktopCheck.checked = Boolean(src.forceDesktop);
                    const desktopLabel = el('label', 'form-check-label small text-white fw-semibold', 'Force desktop site');
                    desktopLabel.htmlFor = desktopCheck.id;
                    switchDiv.appendChild(desktopCheck);
                    switchDiv.appendChild(desktopLabel);
                    desktopWrap.appendChild(switchDiv);
                    desktopWrap.appendChild(el('div', 'small text-white-50', 'Mobile only. Turn on if this tab site misbehaves on a phone.'));
                    editorSlot.appendChild(desktopWrap);
                }

                // Action buttons footer
                const footer = el('div', 'd-flex align-items-center justify-content-between pt-2 mt-1');
                if (!src.isSeed) {
                    const delBtn = el('button', 'btn btn-theme-danger btn-sm', '<i class="bi-trash me-1"></i>Delete');
                    delBtn.type = 'button';
                    delBtn.addEventListener('click', () => {
                        const all = getSources().filter((s) => s.id !== src.id);
                        stampSourceChanges(all);
                        saveSources(all);
                        renderDownloaderTabs();
                        showToast(`Deleted ${src.name}`, 2500);
                        renderList();
                    });
                    footer.appendChild(delBtn);
                } else {
                    footer.appendChild(el('div'));
                }

                const btnGroup = el('div', 'd-flex align-items-center gap-2');
                const testProviderBtn = el('button', 'btn btn-theme-outline btn-sm', 'Test');
                testProviderBtn.type = 'button';
                testProviderBtn.title = 'Test this provider in the in-app browser';
                testProviderBtn.addEventListener('click', async () => {
                    let uVal = urlInput.value.trim() || src.urlTemplate;
                    if (uVal && !/^https?:\/\//i.test(uVal)) uVal = 'https://' + uVal;
                    const draft = {
                        ...src,
                        name: nameInput.value.trim() || src.name,
                        urlTemplate: uVal,
                        queryFormat: querySelect.value,
                        forceDesktop: desktopCheck ? desktopCheck.checked : src.forceDesktop
                    };
                    const all = getSources();
                    const idx = all.findIndex((s) => s.id === src.id);
                    if (idx !== -1) all[idx] = draft;
                    else all.push(draft);
                    saveSources(all);
                    renderDownloaderTabs();
                    await hideSettings();
                    openTabDownloader({
                        targetSourceId: draft.id,
                        query: draft.queryFormat === 'song_only' ? 'Duo No 2 In G Major' : 'Carulli Duo No 2 In G Major'
                    });
                });

                const cancelBtn = el('button', 'btn btn-theme-outline btn-sm', 'Cancel');
                cancelBtn.type = 'button';
                cancelBtn.addEventListener('click', () => {
                    editorSlot.hidden = true;
                    editBtn.textContent = 'Edit';
                    editBtn.setAttribute('aria-expanded', 'false');
                });

                const saveBtn = el('button', 'btn btn-theme-primary btn-sm', 'Save');
                saveBtn.type = 'button';
                saveBtn.addEventListener('click', () => {
                    const all = getSources();
                    const target = all.find((s) => s.id === src.id);
                    if (target) {
                        if (!target.isSeed) {
                            const trimmedName = nameInput.value.trim();
                            if (trimmedName) target.name = trimmedName;

                            let uVal = urlInput.value.trim();
                            if (uVal && !/^https?:\/\//i.test(uVal)) uVal = 'https://' + uVal;
                            if (uVal) {
                                target.urlTemplate = uVal;
                                if (!target.defaultUrl) target.defaultUrl = uVal;
                            }
                        }
                        target.queryFormat = querySelect.value;
                        if (desktopCheck) target.forceDesktop = desktopCheck.checked;

                        stampSourceChanges(all);
                        saveSources(all);
                        renderDownloaderTabs();
                        showToast('Search provider updated', 2500);
                        renderList();
                    }
                });

                btnGroup.appendChild(cancelBtn);
                btnGroup.appendChild(saveBtn);
                footer.appendChild(btnGroup);
                editorSlot.appendChild(footer);
            };

            editBtn.addEventListener('click', () => {
                const isOpen = !editorSlot.hidden;
                if (isOpen) {
                    editorSlot.hidden = true;
                    editBtn.textContent = 'Edit';
                    editBtn.setAttribute('aria-expanded', 'false');
                } else {
                    buildEditor();
                    editorSlot.hidden = false;
                    editBtn.textContent = 'Close';
                    editBtn.setAttribute('aria-expanded', 'true');
                }
            });

            if (openEditorForId && src.id === openEditorForId) {
                buildEditor();
                editorSlot.hidden = false;
                editBtn.textContent = 'Close';
                editBtn.setAttribute('aria-expanded', 'true');
                setTimeout(() => {
                    const input = editorSlot.querySelector('input');
                    input?.focus();
                    input?.select();
                }, 50);
            }

            listWrap.appendChild(itemRow);
            listWrap.appendChild(editorSlot);
        });

        // Add custom provider row
        const addBtn = el('button', 'btn btn-sm srow-ghost srow-hit', 'Add');
        addBtn.type = 'button';
        addBtn.setAttribute('aria-label', 'Add custom search provider');
        addBtn.addEventListener('click', () => {
            const all = getSources();
            const newId = 'source_' + Date.now();
            const newSrc = {
                id: newId,
                name: 'Custom Source',
                urlTemplate: DEFAULT_SOURCES[0].urlTemplate,
                defaultUrl: '',
                queryFormat: 'artist_song',
                isSeed: false
            };
            all.push(newSrc);
            stampSourceChanges(all);
            saveSources(all);
            renderDownloaderTabs();
            renderList(newId);
        });
        const addRow = row('Add custom search provider', 'Add another tab website or search engine using $s for keywords.', addBtn);
        addRow.classList.add('srow-task');
        listWrap.appendChild(addRow);

        // Reset to defaults row (requires confirmation; no srow-hit overlay)
        const resetBtn = el('button', 'btn btn-sm srow-ghost', 'Reset');
        resetBtn.type = 'button';
        resetBtn.setAttribute('aria-label', 'Reset search providers to defaults');
        let armTimer = null;
        resetBtn.addEventListener('click', () => {
            if (resetBtn.dataset.confirming === 'true') {
                clearTimeout(armTimer);
                resetBtn.dataset.confirming = 'false';
                resetBtn.textContent = 'Reset';
                resetToDefaultSources();
                renderDownloaderTabs();
                showToast('Search providers restored to defaults', 2500);
                renderList();
                return;
            }
            resetBtn.dataset.confirming = 'true';
            resetBtn.textContent = 'Confirm?';
            armTimer = setTimeout(() => {
                if (resetBtn.isConnected && resetBtn.dataset.confirming === 'true') {
                    resetBtn.dataset.confirming = 'false';
                    resetBtn.textContent = 'Reset';
                }
            }, 4000);
        });
        const resetRow = row('Reset search providers', 'Restore default DuckDuckGo and Google providers.', resetBtn);
        listWrap.appendChild(resetRow);
    }

    renderList();
    return container;
}

let updateTestSearchState = null;

function makeTestSearchGroup() {
    const testBtn = el('button', 'btn btn-sm srow-ghost srow-hit', 'Test');
    testBtn.type = 'button';
    testBtn.setAttribute('aria-label', 'Test web search');
    testBtn.addEventListener('click', async () => {
        if (testBtn.disabled) return;
        await hideSettings();
        openTabDownloader({ query: 'Carulli Duo No 2 In G Major' });
    });

    const isSystem = !hasFeature('inAppBrowser') || localStorage.getItem('majestictab_web_search_browser') === 'system';
    const testRow = row('Test web search', isSystem ? 'Only applies when using the in-app browser.' : 'Opens the in-app browser.', testBtn);
    testRow.classList.add('srow-task');

    updateTestSearchState = () => {
        const sys = !hasFeature('inAppBrowser') || localStorage.getItem('majestictab_web_search_browser') === 'system';
        testBtn.disabled = sys;
        testRow.classList.toggle('opacity-50', sys);
        const span = testRow.querySelector('.st span');
        if (span) span.textContent = sys ? 'Only applies when using the in-app browser.' : 'Opens the in-app browser.';
    };

    updateTestSearchState();

    return group('Test', testRow);
}

export function initWebSearchSettings(container) {
    if (!container) return;
    container.innerHTML = '';
    container.appendChild(makeProvidersGroup());
    // @inAppBrowser:begin
    container.appendChild(makeAdblockGroup());
    // @inAppBrowser:end
    container.appendChild(makeTestSearchGroup());
}
