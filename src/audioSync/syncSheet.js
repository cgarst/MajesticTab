// audioSync/syncSheet.js
// The Sync sheet: the one place to line a recording up with the score. The dock's status action opens it, and it
// holds every way to get or fix sync for the recording that is playing: tap along, edit the points, use another
// recording's sync (another video or file of this song, another tab, or for a backing track the original's), import.
// It drives the existing machinery (tap mode, the point editor, borrowing) rather than copying it, so their guards
// (TV, Jam guest) stay in one place.

import { openModal, closeModal } from '../gpProcessor/mixerPanel.js';
import { getSongKey, getVideoInfo, getSiblingSyncedVideos } from '../soundPlayer.js';
import { borrowableRecords } from './borrowSync.js';
import { SYNC_CHANGED_EVENT, isSyncSharedFromOriginal, setSyncSharedFromOriginal, loadRecord, saveRecord, listPdfRecordsForMedia } from './syncStore.js';
import { inferBarSyncFromPdf } from './inferBarSync.js';
import { showToast } from '../utils/toast.js';
import { getSyncRow } from './audioSyncUi.js';
import { getActiveSlot } from './realAudioController.js';
import { openCopySyncedVideoModal } from './syncedVideosModal.js';
import { PROBLEM_TEXT } from './audioSyncEditor.js';
import { buildTimelineModel } from './timelineModel.js';
import { buildScoreTimeline, playedBarsFromLookup, TICKS_PER_QUARTER } from './scorePositions.js';
import { getMidiTickLookup } from '../gpProcessor/gpPlayer.js';
import { getAudioFile } from './audioFileStore.js';
import { decodeOnsets } from './onsets.js';
import { getRecordingMeta } from './recordingMeta.js';
import { stemSetName } from './stemSet.js';

const MODAL = 'syncSheetModal';
const $ = (id) => document.getElementById(id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** The sync state in words; the dock bar and the sheet say the same thing. */
export function syncStateText(count, summary, fromHost = false) {
    if (!count) return 'Not mapped';
    const state = summary.flaggedBar ? `Check bar ${summary.flaggedBar}` : summary.full ? 'Mapped' : 'Partly mapped';
    return fromHost ? `${state} · from the host` : state;
}

/**
 * How well the points cover the score: `{ full, flaggedBar, flagKind, gapBars }`. A bar with no point drifts and a
 * flagged point looks late against the sound. Without a loaded score there is nothing to judge, so it says nothing.
 */
export function describeSync(points) {
    const summary = { full: false, flaggedBar: null, flagKind: null, gapBars: 0 };
    if (!points.length) return summary;
    try {
        const api = window.gpApi;
        const lookup = api && getMidiTickLookup(api);
        const played = lookup ? playedBarsFromLookup(lookup) : [];
        if (played.length) {
            const view = buildTimelineModel({ timeline: buildScoreTimeline(played), points, axis: 'bars' });
            const flagged = view.markers.find((m) => m.flag);
            summary.full = view.gaps.length === 0;
            summary.flaggedBar = flagged ? flagged.barIndex + 1 : null;
            summary.flagKind = flagged ? flagged.flag : null;
            summary.gapBars = view.gaps.reduce((sum, g) => sum + (g.bars || 0), 0);
        }
    } catch { /* the bar still shows the point count */ }
    return summary;
}

/** A recording's name for the sheet's title line. */
export const recordingName = (media) => (media.kind === 'local' ? (stemSetName(getRecordingMeta(getSongKey(), media)) || media.name || 'Audio file') : (getVideoInfo(media.videoId)?.title || 'YouTube video'));

/** What is wrong, as sentences, when something is: a point to check, or bars with no point. */
function problemLines(summary) {
    const lines = [];
    if (summary.flaggedBar) lines.push(`Bar ${summary.flaggedBar}: ${PROBLEM_TEXT[summary.flagKind] || 'its point looks out of place'}.`);
    if (summary.gapBars) lines.push(`${plural(summary.gapBars, 'bar has', 'bars have')} no point, so the cursor drifts there.`);
    return lines;
}

let current = null; // { prefix, read } of the open sheet
let pickerOpen = false;
let armedKey = null;
let armTimer = 0;
let siblings = [];

const disarm = () => { clearTimeout(armTimer); armedKey = null; };

/** Closes the sheet, then runs `fn` once it is gone (a modal that opens while this one closes would lose its scroll lock). */
function handOff(fn) {
    closeModal(MODAL);
    if (reducedMotion()) fn(); else setTimeout(fn, 170);
}

const recordName = (r) => recordingName(r.media);

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

function row(label, sub, onPress, { pressed = null, armed = false } = {}) {
    const b = el('button', `sync-sheet-row${armed ? ' is-armed' : ''}`);
    b.type = 'button';
    b.append(el('span', 'sync-sheet-row-label', label));
    if (sub) b.append(el('span', 'sync-sheet-row-sub', sub));
    if (pressed !== null) b.setAttribute('aria-expanded', pressed ? 'true' : 'false');
    b.addEventListener('click', onPress);
    return b;
}

function collectScoreNoteTimes(score, timeline, maxBars = 16) {
    const times = [];
    const tracks = score?.tracks;
    if (!Array.isArray(tracks) || !timeline?.bars?.length) return times;
    for (const bar of timeline.bars.slice(0, maxBars)) {
        for (const track of tracks) {
            const staffBar = track?.staves?.[0]?.bars?.[bar.barIndex];
            if (!staffBar?.voices?.length) continue;
            for (const voice of staffBar.voices) {
                for (const beat of voice.beats || []) {
                    if (beat.isRest) continue;
                    const tick = bar.startTick + (beat.playbackStart || 0);
                    let seg = bar.segments[0];
                    for (const s of bar.segments) {
                        if (s.tick <= tick) seg = s;
                    }
                    times.push(seg.ms + (tick - seg.tick) * 60000 / (seg.tempo * TICKS_PER_QUARTER));
                }
            }
        }
    }
    times.sort((a, b) => a - b);
    const deduped = [];
    for (const t of times) {
        if (!deduped.length || t - deduped[deduped.length - 1] >= 30) deduped.push(t);
    }
    return deduped;
}

function findPdfInference(songKey, media) {
    try {
        const pdfRecords = listPdfRecordsForMedia(songKey, media);
        if (!pdfRecords.length) return null;
        const api = window.gpApi;
        const lookup = api && getMidiTickLookup(api);
        const played = lookup ? playedBarsFromLookup(lookup) : [];
        if (!played.length) return null;
        const timeline = buildScoreTimeline(played);
        for (const rec of pdfRecords) {
            const inferred = inferBarSyncFromPdf(timeline, rec.points);
            if (inferred) return { inferred, timeline, pdfPoints: rec.points, score: api.score };
        }
    } catch { /* ignore */ }
    return null;
}

function render() {
    if (!current) return;
    const { prefix, name, read } = current;
    const { points, summary, fromHost, media, origin } = read();
    const body = $('syncSheetBody');
    const has = points.length > 0;
    $('syncSheetSub').textContent = name();
    body.replaceChildren();

    const status = el('p', 'sync-sheet-status', syncStateText(points.length, summary, fromHost));
    status.setAttribute('role', 'status');
    body.append(status);
    for (const line of problemLines(summary)) body.append(el('p', 'sync-sheet-note', line));
    if (origin) {
        const from = origin.fromAudioId ? (origin.fromAudioName || 'an audio file')
            : origin.fromVideoId ? (getVideoInfo(origin.fromVideoId)?.title || 'a video')
                : (origin.fromTabName || 'another tab');
        body.append(el('p', 'sync-sheet-note', `Copied from ${from}.`));
    }

    const tap = el('button', 'btn btn-theme-primary sync-sheet-primary', has ? 'Tap along again' : 'Tap along');
    tap.type = 'button';
    tap.addEventListener('click', () => handOff(() => $(`${prefix}SyncTapBtn`)?.click()));
    body.append(tap);

    const list = el('div', 'sync-sheet-list');
    if (has) list.append(row('Edit points', 'Nudge, shift or delete points', () => handOff(() => $(`${prefix}SyncEditBtn`)?.click())));

    const songKey = getSongKey();
    if (!has && media && songKey) {
        const found = findPdfInference(songKey, media);
        if (found) {
            list.append(row('Infer from PDF map', found.inferred.fit.text, async () => {
                let result = found.inferred;
                if (media.kind === 'local' && media.audioId) {
                    try {
                        const file = await getAudioFile(media.audioId);
                        const buf = file?.data ? (file.data.arrayBuffer ? await file.data.arrayBuffer() : file.data) : null;
                        const audioOnsets = buf ? await decodeOnsets(buf) : null;
                        const noteScoreTimesMs = collectScoreNoteTimes(found.score, found.timeline);
                        if (audioOnsets?.times?.length && noteScoreTimesMs.length) {
                            result = inferBarSyncFromPdf(found.timeline, found.pdfPoints, { audioOnsets, noteScoreTimesMs }) || result;
                        }
                    } catch { /* fall back to layout/tempo inference */ }
                }
                const saved = saveRecord(songKey, media, result.points, undefined, undefined, 'bar');
                if (!saved) { showToast('Could not save the inferred map points', 'error'); return; }
                window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
                closeModal(MODAL);
                showToast(`Inferred ${result.fit.placed} of ${result.fit.total} bars from PDF map`, 'success');
            }));
        }
    }
    const others = media ? borrowableRecords(songKey, media) : [];
    if (others.length) {
        list.append(row('Use another recording’s map', 'Another video or file of this song', () => { pickerOpen = !pickerOpen; disarm(); render(); $('syncSheetBody')?.querySelector('[aria-expanded]')?.focus(); }, { pressed: pickerOpen }));
        if (pickerOpen) {
            const picker = el('div', 'sync-sheet-picker');
            picker.setAttribute('role', 'group');
            picker.setAttribute('aria-label', 'Use the map of');
            for (const r of others) {
                const key = `${r.media.kind}:${r.media.audioId || r.media.videoId}`;
                const isArmed = armedKey === key;
                picker.append(row(
                    isArmed ? `Replace ${plural(points.length, 'sync point', 'sync points')}?` : recordName(r),
                    `${r.media.kind === 'local' ? (stemSetName(getRecordingMeta(getSongKey(), r.media)) ? 'Stem set' : 'Audio file') : 'YouTube video'} · ${plural(r.points.length, 'point', 'points')}`,
                    () => {
                        // Points that are already there take a second press: they would be replaced
                        if (has && armedKey !== key) { disarm(); armedKey = key; armTimer = setTimeout(() => { armedKey = null; render(); }, 4000); render(); return; }
                        disarm();
                        handOff(() => getSyncRow(prefix)?.borrowFrom(r, { replace: has }));
                    },
                    { armed: isArmed }
                ));
            }
            list.append(picker);
        }
    }
    if (siblings.length) list.append(row('Use another tab’s map', 'A video mapped in another tab of this song', () => handOff(() => openCopySyncedVideoModal())));

    if (getActiveSlot() === 'backing' && songKey) {
        const shared = isSyncSharedFromOriginal(songKey);
        const sw = row('Use the original recording’s map', shared ? 'On: the backing track follows the original’s points' : 'Off', () => {
            setSyncSharedFromOriginal(songKey, !shared);
            window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
        });
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', shared ? 'true' : 'false');
        list.append(sw);
    }

    list.append(row('Import points…', 'From a file or an address', () => handOff(() => {
        $(`${prefix}SyncEditBtn`)?.click();
        const panel = $('syncImportPanel');
        if (panel?.hidden) $('syncImportToggleBtn')?.click();
    })));
    body.append(list);
}

let wired = false;
function wire() {
    if (wired) return;
    wired = true;
    const modal = $(MODAL);
    $('syncSheetCloseBtn')?.addEventListener('click', () => closeModal(MODAL));
    modal?.addEventListener('click', (e) => { if (e.target === modal) closeModal(MODAL); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal?.classList.contains('show')) closeModal(MODAL);
    });
    // Edits made elsewhere (the editor, tap mode, a copy) change what the sheet shows
    window.addEventListener(SYNC_CHANGED_EVENT, () => { if (modal?.classList.contains('show')) render(); });
}

/**
 * Opens the sheet for the recording that is playing.
 * @param {object} opts
 * @param {string} opts.prefix 'yt' or 'af': which panel's sync controls the sheet drives
 * @param {() => string} opts.name the recording's name
 * @param {() => { points: object[], summary: object, fromHost: boolean, media: object|null, origin: object|null }} opts.read the current state
 */
export function openSyncSheet(opts) {
    wire();
    current = opts;
    pickerOpen = false;
    disarm();
    siblings = [];
    render();
    openModal(MODAL);
    $('syncSheetBody')?.querySelector('.sync-sheet-primary')?.focus();
    getSiblingSyncedVideos().then((s) => {
        if (current !== opts) return;
        siblings = s || [];
        if (siblings.length && $(MODAL)?.classList.contains('show')) render();
    }).catch(() => {});
}

/** Opens the sheet for a recording of this song right after tap mode: its points as they are now, and what still needs fixing. */
export function openSyncSheetFor({ media }) {
    const prefix = media.kind === 'youtube' ? 'yt' : 'af';
    openSyncSheet({
        prefix,
        name: () => recordingName(media),
        read: () => {
            const record = loadRecord(getSongKey(), media);
            const points = record?.points || [];
            return { points, summary: describeSync(points), fromHost: false, media, origin: record?.media?.origin || null };
        }
    });
}
