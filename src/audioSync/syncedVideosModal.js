// audioSync/syncedVideosModal.js
// Management dialogs for a tab's synced videos:
// 1. Manage Synced Videos: view synced videos for the active tab, with multi-select deletion of videos and associated points.
// 2. Copy Synced Video: pick a synced video + sync points from another tab file of this song and copy it to this tab, recording origin.

import {
    getSongKey,
    getSyncedVideos,
    getSiblingSyncedVideos,
    copySyncedVideoFromSibling,
    deleteSyncedVideos,
    playerState
} from '../youtubePlayer.js';
import { openModal, closeModal } from '../gpProcessor/mixerPanel.js';
import { showToast } from '../utils/toast.js';

const escapeHtml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let initialized = false;
let selectedDeleteIds = new Set();
let selectedCopyVideoId = null;
let deleteConfirmPending = false;

function resetDeleteState() {
    selectedDeleteIds.clear();
    deleteConfirmPending = false;
    updateDeleteButton();
}

function updateDeleteButton() {
    const btn = document.getElementById('manageSyncedDeleteBtn');
    const selectAll = document.getElementById('manageSyncedSelectAll');
    const countEl = document.getElementById('manageSyncedSelectionCount');
    const listEl = document.getElementById('manageSyncedList');
    const allChecks = listEl ? listEl.querySelectorAll('.manage-synced-item-check') : [];

    const total = allChecks.length;
    const selectedCount = selectedDeleteIds.size;

    if (countEl) {
        countEl.textContent = `${selectedCount} of ${total} selected`;
    }

    if (selectAll) {
        selectAll.checked = total > 0 && selectedCount === total;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
    }

    if (btn) {
        btn.disabled = selectedCount === 0;
        if (deleteConfirmPending) {
            btn.textContent = `Confirm delete (${selectedCount})`;
            btn.classList.add('is-confirming');
        } else {
            btn.textContent = selectedCount > 0 ? `Delete selected (${selectedCount})` : 'Delete selected';
            btn.classList.remove('is-confirming');
        }
    }
}

export function openManageSyncedVideosModal() {
    const listEl = document.getElementById('manageSyncedList');
    const emptyEl = document.getElementById('manageSyncedEmpty');
    const toolbarEl = document.getElementById('manageSyncedToolbar');
    const subTitle = document.getElementById('manageSyncedModalSub');
    const copyBtn = document.getElementById('manageSyncedCopyBtn');
    if (!listEl) return;

    resetDeleteState();

    const currentTab = playerState.tabName || playerState.filename || 'this tab';
    if (subTitle) {
        subTitle.textContent = `Synced videos for ${currentTab}`;
    }

    const videos = getSyncedVideos();
    listEl.textContent = '';

    if (videos.length === 0) {
        if (emptyEl) emptyEl.hidden = false;
        if (toolbarEl) toolbarEl.hidden = true;
    } else {
        if (emptyEl) emptyEl.hidden = true;
        if (toolbarEl) toolbarEl.hidden = false;

        videos.forEach(v => {
            const same = videos.filter(o => o.kind === v.kind);
            const name = v.kind.charAt(0).toUpperCase() + v.kind.slice(1) + (same.length > 1 ? ` ${same.indexOf(v) + 1}` : '');
            const isCurrent = v.videoId === playerState.currentVideoId;

            let originText = '';
            if (v.origin) {
                const fromName = v.origin.fromTabName || v.origin.fromSongKey || 'another tab';
                const siteText = v.origin.fromSourceWebsite ? ` · Source: ${v.origin.fromSourceWebsite}` : '';
                originText = `Copied from tab: <b>${escapeHtml(fromName)}</b>${escapeHtml(siteText)}`;
            } else if (playerState.sourceWebsite) {
                originText = `Original tab sync · Source: ${escapeHtml(playerState.sourceWebsite)}`;
            } else {
                originText = 'Original sync for this tab';
            }

            const row = document.createElement('div');
            row.className = 'synced-video-row';
            row.setAttribute('role', 'listitem');
            row.innerHTML = `
                <div class="form-check mb-0 flex-shrink-0">
                    <input type="checkbox" class="form-check-input manage-synced-item-check" data-video-id="${escapeHtml(v.videoId)}" aria-label="Select ${escapeHtml(name)}">
                </div>
                <div class="flex-grow-1 min-w-0">
                    <div class="d-flex align-items-center gap-2">
                        <span class="fw-semibold text-white">${escapeHtml(name)}</span>
                        <span class="text-white-50 small">· ${v.count} sync points</span>
                        ${isCurrent ? '<span class="badge bg-secondary small py-0 px-1">active</span>' : ''}
                    </div>
                    <div class="small text-muted text-truncate mt-1">${originText}</div>
                </div>
                <a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-theme-icon text-muted flex-shrink-0" title="Watch on YouTube" aria-label="Watch on YouTube">
                    <i class="bi-box-arrow-up-right"></i>
                </a>
            `;

            const check = row.querySelector('.manage-synced-item-check');
            check.addEventListener('change', () => {
                if (check.checked) selectedDeleteIds.add(v.videoId);
                else selectedDeleteIds.delete(v.videoId);
                deleteConfirmPending = false;
                row.classList.toggle('is-selected', check.checked);
                updateDeleteButton();
            });

            row.addEventListener('click', (e) => {
                if (e.target.closest('a') || e.target.closest('input')) return;
                check.checked = !check.checked;
                check.dispatchEvent(new Event('change'));
            });

            listEl.appendChild(row);
        });
    }

    // Check sibling tabs availability for copy button
    getSiblingSyncedVideos().then(siblings => {
        if (copyBtn) {
            copyBtn.hidden = siblings.length === 0;
        }
    }).catch(() => {});

    updateDeleteButton();
    openModal('manageSyncedVideosModal');
}

export async function openCopySyncedVideoModal() {
    const listEl = document.getElementById('copySyncedList');
    const emptyEl = document.getElementById('copySyncedEmpty');
    const confirmBtn = document.getElementById('copySyncedConfirmBtn');
    if (!listEl) return;

    selectedCopyVideoId = null;
    if (confirmBtn) confirmBtn.disabled = true;
    listEl.textContent = '';

    const siblings = await getSiblingSyncedVideos();

    if (siblings.length === 0) {
        if (emptyEl) emptyEl.hidden = false;
    } else {
        if (emptyEl) emptyEl.hidden = true;

        siblings.forEach(v => {
            const same = siblings.filter(o => o.kind === v.kind);
            const name = v.kind.charAt(0).toUpperCase() + v.kind.slice(1) + (same.length > 1 ? ` ${same.indexOf(v) + 1}` : '');

            const siteText = v.originSourceWebsite ? ` · Source: ${escapeHtml(v.originSourceWebsite)}` : '';
            const originText = `From tab: <b class="text-white">${escapeHtml(v.originTabName)}</b>${siteText}`;

            const row = document.createElement('div');
            row.className = 'synced-video-row';
            row.setAttribute('role', 'listitem');
            row.innerHTML = `
                <div class="form-check mb-0 flex-shrink-0">
                    <input type="radio" name="copySyncedItemRadio" class="form-check-input copy-synced-item-radio" value="${escapeHtml(v.videoId)}" aria-label="Select ${escapeHtml(name)}">
                </div>
                <div class="flex-grow-1 min-w-0">
                    <div class="d-flex align-items-center gap-2">
                        <span class="fw-semibold text-white">${escapeHtml(name)}</span>
                        <span class="text-white-50 small">· ${v.count} sync points</span>
                    </div>
                    <div class="small text-muted text-truncate mt-1">${originText}</div>
                </div>
                <a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-theme-icon text-muted flex-shrink-0" title="Watch on YouTube" aria-label="Watch on YouTube">
                    <i class="bi-box-arrow-up-right"></i>
                </a>
            `;

            const radio = row.querySelector('.copy-synced-item-radio');
            radio.addEventListener('change', () => {
                selectedCopyVideoId = v.videoId;
                if (confirmBtn) confirmBtn.disabled = false;
                listEl.querySelectorAll('.synced-video-row').forEach(r => r.classList.remove('is-selected'));
                row.classList.add('is-selected');
            });

            row.addEventListener('click', (e) => {
                if (e.target.closest('a') || e.target.closest('input')) return;
                radio.checked = true;
                radio.dispatchEvent(new Event('change'));
            });

            listEl.appendChild(row);
        });
    }

    openModal('copySyncedVideoModal');
}

export function initSyncedVideosModals() {
    if (initialized) return;
    initialized = true;

    // Trigger button on YouTube panel
    document.getElementById('ytManageSyncedBtn')?.addEventListener('click', () => {
        openManageSyncedVideosModal();
    });

    document.getElementById('ytCopyFromOtherTabBtn')?.addEventListener('click', () => {
        openCopySyncedVideoModal();
    });

    // Close buttons
    document.getElementById('manageSyncedVideosModalCloseBtn')?.addEventListener('click', () => {
        closeModal('manageSyncedVideosModal');
    });
    document.getElementById('copySyncedVideoModalCloseBtn')?.addEventListener('click', () => {
        closeModal('copySyncedVideoModal');
    });
    document.getElementById('copySyncedCancelBtn')?.addEventListener('click', () => {
        closeModal('copySyncedVideoModal');
    });

    // Manage modal: Select All toggle
    document.getElementById('manageSyncedSelectAll')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        const listEl = document.getElementById('manageSyncedList');
        if (!listEl) return;

        selectedDeleteIds.clear();
        deleteConfirmPending = false;

        listEl.querySelectorAll('.manage-synced-item-check').forEach(chk => {
            chk.checked = checked;
            const vid = chk.dataset.videoId;
            if (checked && vid) selectedDeleteIds.add(vid);
            chk.closest('.synced-video-row')?.classList.toggle('is-selected', checked);
        });

        updateDeleteButton();
    });

    // Manage modal: Copy from another tab button
    document.getElementById('manageSyncedCopyBtn')?.addEventListener('click', () => {
        closeModal('manageSyncedVideosModal');
        openCopySyncedVideoModal();
    });

    // Manage modal: Delete button (with 2-step confirmation)
    document.getElementById('manageSyncedDeleteBtn')?.addEventListener('click', () => {
        if (!selectedDeleteIds.size) return;

        if (!deleteConfirmPending) {
            deleteConfirmPending = true;
            updateDeleteButton();
            return;
        }

        // Confirmed deletion
        const toDelete = Array.from(selectedDeleteIds);
        const count = deleteSyncedVideos(toDelete);
        showToast(`Deleted ${count} synced video${count === 1 ? '' : 's'} and sync points.`, 'success');
        resetDeleteState();

        const remaining = getSyncedVideos();
        if (remaining.length === 0) {
            closeModal('manageSyncedVideosModal');
        } else {
            openManageSyncedVideosModal();
        }
    });

    // Copy modal: Confirm button
    document.getElementById('copySyncedConfirmBtn')?.addEventListener('click', async () => {
        if (!selectedCopyVideoId) return;

        const siblings = await getSiblingSyncedVideos();
        const target = siblings.find(v => v.videoId === selectedCopyVideoId);
        if (!target) return;

        const success = copySyncedVideoFromSibling(target);
        if (success) {
            showToast(`Copied sync points from "${target.originTabName}".`, 'success');
            closeModal('copySyncedVideoModal');
        } else {
            showToast('Could not copy sync points.', 'error');
        }
    });

    // Escape and backdrop dismissal
    const manageModal = document.getElementById('manageSyncedVideosModal');
    if (manageModal) {
        manageModal.addEventListener('click', (e) => {
            if (e.target === manageModal) closeModal('manageSyncedVideosModal');
        });
    }
    const copyModal = document.getElementById('copySyncedVideoModal');
    if (copyModal) {
        copyModal.addEventListener('click', (e) => {
            if (e.target === copyModal) closeModal('copySyncedVideoModal');
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (manageModal?.classList.contains('show')) closeModal('manageSyncedVideosModal');
            if (copyModal?.classList.contains('show')) closeModal('copySyncedVideoModal');
        }
    });
}
