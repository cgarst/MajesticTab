// stemdeck/stemdeckTool.js
// The Backing tracks page in Tools (native apps only): pick songs that have a local audio file, send each file to
// the StemDeck app (a desktop app finds the one on this computer by itself, whatever port it took; a phone is given
// its address on the network), and save the mix without guitar as the song's Backing track (the same slot the Sound panel's
// Recording | Backing switch reads). One file is sent at a time. The batch belongs to the app, not to
// this page: leaving Tools does not stop it, and the page shows where it is when it is drawn again.

import {
    createStemDeckClient, getStemDeckAddress, setStemDeckAddress, parseAddress, isLoopback, isDesktopShell,
    findLocalStemDeck, nativeLoopbackScan, DEFAULT_PORT, StemDeckError
} from './stemdeckClient.js';
import { listBackingCandidates, planJobs, backingFileName, slotFileKey, slotSourceKey } from './backingCandidates.js';
import { listAudioFiles, getAudioFile, getAudioMeta, saveAudioFile, linkAudioFile, unlinkAudioFile } from '../audioSync/audioFileStore.js';
import { decodePeaks } from '../audioSync/peaks.js';
import { AUDIO_FILES_CHANGED_EVENT } from '../audioSync/audioBackup.js';
import { loadRecord, saveRecord, deleteRecord, setSyncSharedFromOriginal, SYNC_CHANGED_EVENT } from '../audioSync/syncStore.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clock = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const mediaOf = (meta) => ({ kind: 'local', audioId: meta.id, name: meta.name, durationMs: meta.durationMs ?? null, fingerprint: meta.fingerprint });
const readLocal = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };

// --- The batch -----------------------------------------------------------------------------------------------------

// What the page remembers between draws
const view = { includeExisting: false, selected: null }; // selected: Set of song keys, null until the first list
const batch = {
    running: false,
    states: new Map(), // song key -> { kind: 'waiting' | 'working' | 'done' | 'error' | 'cancelled', text }
    done: 0,
    total: 0,
    controller: null,
    summary: ''
};
const listeners = new Set();
const notify = () => listeners.forEach((cb) => { try { cb(); } catch (e) { console.error('[Backing tracks]', e); } });

/** Short readout for the Tools list: where the batch is while it runs. */
export function stemdeckReadout() {
    return batch.running ? `${Math.min(batch.done + 1, batch.total)} of ${batch.total}` : '';
}
// The Tools list only re-reads its readouts after a click, so this one is kept current here, tool open or not
listeners.add(() => {
    const el = document.querySelector('[data-read="stemdeck"]');
    if (el && el.textContent !== stemdeckReadout()) el.textContent = stemdeckReadout();
});

function setState(job, kind, text) {
    for (const s of job.songs) batch.states.set(s.songKey, { kind, text });
    notify();
}

/** Stores the mix and makes it the Backing track of every song in the job. */
async function saveBackingTrack(job, client, jobId, signal) {
    let mix = await client.downloadMix(jobId, { signal });
    let analysed = await decodePeaks(mix.data);
    // A webview that cannot decode FLAC gets the same mix as WAV
    if (!analysed && mix.ext !== 'wav') {
        mix = await client.downloadMix(jobId, { format: 'wav', signal });
        analysed = await decodePeaks(mix.data);
    }
    const { source } = job;
    const meta = await saveAudioFile({
        name: backingFileName(source.name, mix.ext), type: mix.type, data: mix.data, songKey: job.songs[0].songKey,
        durationMs: analysed?.durationMs ?? source.durationMs ?? null, peaks: analysed?.peaks ?? null,
        generatedFrom: { tool: 'stemdeck', sourceId: source.id }
    });
    for (const { songKey, backingId } of job.songs) {
        await linkAudioFile(meta.id, songKey);
        // A backing track this tool made earlier is replaced. One the person added stays among the song's files.
        if (backingId && backingId !== meta.id) {
            const old = await getAudioMeta(backingId);
            if (old?.generatedFrom) {
                await unlinkAudioFile(backingId, songKey);
                deleteRecord(songKey, mediaOf(old));
            }
        }
        writeLocal(slotFileKey(songKey, 'backing'), meta.id);
        writeLocal(slotSourceKey(songKey, 'backing'), 'local');
        // The mix has the timeline of the file it was made from. When that file is the song's Original recording the
        // backing track follows its sync points; otherwise (the Original is a video) it gets a copy of the file's own.
        if (readLocal(slotSourceKey(songKey, 'original')) === 'local') {
            setSyncSharedFromOriginal(songKey, true);
        } else {
            const rec = loadRecord(songKey, mediaOf(source));
            if (rec?.points.length && !loadRecord(songKey, mediaOf(meta))?.points.length) {
                const origin = { fromAudioId: source.id, fromAudioName: source.name, fromSongKey: songKey, copiedAt: Date.now() };
                saveRecord(songKey, { ...mediaOf(meta), origin }, rec.points);
            }
        }
    }
    window.dispatchEvent(new CustomEvent(AUDIO_FILES_CHANGED_EVENT));
    window.dispatchEvent(new CustomEvent(SYNC_CHANGED_EVENT));
}

async function runJob(job, client, signal) {
    let jobId = null;
    try {
        setState(job, 'working', 'Sending');
        let rec = await getAudioFile(job.source.id);
        if (!rec) throw new StemDeckError('The audio file is no longer on this device', 'missing');
        jobId = await client.submit({ name: rec.name, type: rec.type, data: rec.data }, signal);
        rec = null; // the upload is done: do not hold the file while StemDeck works
        await client.waitForJob(jobId, {
            signal,
            onProgress: ({ status, stage }) => setState(job, 'working', status === 'queued' ? 'Waiting in StemDeck' : (stage || 'Working'))
        });
        setState(job, 'working', 'Saving');
        await saveBackingTrack(job, client, jobId, signal);
        setState(job, 'done', 'Backing track added');
        for (const s of job.songs) view.selected?.delete(s.songKey);
        return true;
    } catch (e) {
        if (signal.aborted) {
            if (jobId) client.cancel(jobId);
            setState(job, 'cancelled', 'Cancelled');
        } else {
            console.warn('[Backing tracks] job failed:', e);
            setState(job, 'error', e?.message || 'Could not make the backing track');
        }
        return false;
    }
}

async function startBatch(jobs, client) {
    if (batch.running || !jobs.length) return;
    batch.running = true;
    batch.controller = new AbortController();
    batch.states = new Map();
    batch.done = 0;
    batch.total = jobs.length;
    batch.summary = '';
    for (const job of jobs) setState(job, 'waiting', 'Waiting');
    let made = 0;
    const { signal } = batch.controller;
    for (const job of jobs) {
        if (signal.aborted) { setState(job, 'cancelled', 'Cancelled'); continue; }
        if (await runJob(job, client, signal)) made++;
        batch.done++;
        notify();
    }
    const failed = jobs.length - made;
    batch.summary = signal.aborted
        ? `Cancelled · ${made} of ${jobs.length} made`
        : failed ? `${made} made · ${failed} failed` : `${made} ${made === 1 ? 'backing track' : 'backing tracks'} made`;
    batch.running = false;
    batch.controller = null;
    notify();
}

/** Returns the introductory description text for the backing tracks tool based on platform and connection. */
export function stemdeckIntroText({ desktop, local = false }) {
    if (desktop) {
        const detail = local ? ' Nothing leaves this computer.' : '';
        return `Sends a song’s audio file to the StemDeck app on this computer and saves the mix without guitar as the song’s backing track.${detail} Each song also appears in your StemDeck library.`;
    }
    return 'Sends a song’s audio file over your network to the StemDeck app on your computer and saves the mix without guitar as the song’s backing track. Each song also appears in your StemDeck library.';
}

/**
 * What to do next when StemDeck was not found, dynamic for desktop vs mobile. StemDeck's Settings, Network page shows
 * the port it is running on (not only the one it was asked for), so that is where the person is sent for the port.
 */
export function stemdeckHelpText({ desktop, conn, local = false }) {
    const example = `192.168.1.20:${DEFAULT_PORT}`;
    const portHint = 'The Port field on its Settings, Network page shows the port StemDeck is running on.';
    const network = desktop
        ? `To use StemDeck on another computer: In StemDeck on that computer, open Settings, then Network, and turn on Make StemDeck available on your network. Then enter the computer’s IP address and the Port shown there, such as ${example}.`
        : `In StemDeck on your computer, open Settings, then Network, and turn on Make StemDeck available on your network. Then enter your computer’s IP address and the Port shown there, such as ${example}.`;

    if (conn.code === 'https') return `Use the Port from StemDeck’s Settings, Network page (${DEFAULT_PORT} unless it was changed), not the https address it shows for browsers.`;
    if (conn.code === 'invalid') return `Enter an IP address or a computer name, with the port after a colon, such as ${example}. ${portHint}`;
    if (conn.code === 'network-off' || conn.kind === 'unset') return network;
    if (conn.kind === 'down' && local) return `Open StemDeck on this computer, then check again. If it is open and still not found, enter 127.0.0.1 and the port after a colon, such as 127.0.0.1:${DEFAULT_PORT}. ${portHint} To use StemDeck on another computer, enter its address here.`;
    if (conn.kind === 'down') return desktop
        ? `Check that StemDeck is open and that this computer is on the same network. If it is, the port may differ from ${DEFAULT_PORT}. ${portHint} ${network}`
        : `Check that StemDeck is open on your computer and that this device is on the same network. If it is, the port may differ from ${DEFAULT_PORT}. ${portHint} ${network}`;
    return '';
}

// --- The page ------------------------------------------------------------------------------------------------------

export function renderStemdeckTool(container) {
    let alive = true;
    let candidates = [];
    let loaded = false;
    // conn.address is what the person entered ('' on a desktop app means: look on this computer); conn.found is where
    // StemDeck answered, which is the address the batch uses. conn.kind: 'unset' | 'checking' | 'ok' | 'down'.
    const desktop = isDesktopShell();
    const conn = { kind: 'unset', text: '', code: '', address: getStemDeckAddress(), found: '' };
    const local = () => desktop && (!conn.address || isLoopback(parseAddress(conn.address).host || ''));
    let checkToken = 0;

    container.innerHTML = '<div class="sd-root"></div>';
    const root = container.querySelector('.sd-root');

    // A song the batch has touched stays in the list with its outcome, even once it has a backing track
    const visible = () => candidates.filter((c) => view.includeExisting || !c.backingId || batch.states.has(c.songKey));
    const chosen = () => visible().filter((c) => view.selected.has(c.songKey));

    async function check() {
        const token = ++checkToken;
        conn.code = '';
        conn.found = '';
        if (!conn.address && !desktop) {
            conn.kind = 'unset';
            conn.text = 'Enter the address of your computer that runs StemDeck';
            render();
            return;
        }
        conn.kind = 'checking';
        conn.text = desktop
            ? (local() ? 'Looking for StemDeck on this computer' : 'Looking for StemDeck')
            : 'Looking for StemDeck on your computer';
        render();
        try {
            let info;
            if (local()) {
                // It takes a free port when its own is taken, so this computer is searched, not assumed
                info = await findLocalStemDeck({ preferred: conn.address ? [conn.address] : [], scan: nativeLoopbackScan() });
                if (!info) throw new StemDeckError('StemDeck is not running on this computer', 'unreachable');
                conn.found = info.address;
            } else {
                info = await createStemDeckClient({ address: conn.address }).health();
                conn.found = conn.address;
            }
            if (token !== checkToken) return;
            conn.kind = 'ok';
            const port = local() ? ` on port ${conn.found.split(':')[1]}` : '';
            conn.text = `${info.version ? `StemDeck ${info.version}` : 'StemDeck'} is running${port}`;
        } catch (e) {
            if (token !== checkToken) return;
            conn.kind = 'down';
            conn.code = e?.code || '';
            conn.text = e instanceof StemDeckError ? e.message : 'StemDeck is not answering';
        }
        if (alive) render();
    }

    async function refresh() {
        try {
            candidates = listBackingCandidates(await listAudioFiles(), localStorage);
        } catch (e) {
            console.warn('[Backing tracks] could not list audio files:', e);
            candidates = [];
        }
        loaded = true;
        const known = new Set(candidates.map((c) => c.songKey));
        // First list: every song without a backing track is chosen
        if (!view.selected) view.selected = new Set(candidates.filter((c) => !c.backingId).map((c) => c.songKey));
        else view.selected = new Set([...view.selected].filter((k) => known.has(k)));
        if (alive) render();
    }

    function rowHtml(c) {
        const st = batch.states.get(c.songKey);
        const meta = [c.source.name, c.source.durationMs ? clock(c.source.durationMs) : '', megabytes(c.source.size), c.backingId ? 'Has a backing track' : '']
            .filter(Boolean).join(' · ');
        return `<label class="sd-row">
            <input type="checkbox" class="form-check-input" data-song="${esc(c.songKey)}" ${view.selected.has(c.songKey) ? 'checked' : ''} ${batch.running ? 'disabled' : ''}>
            <span class="sd-row-text"><span class="sd-row-title">${esc(c.songKey)}</span><span class="sd-row-meta">${esc(meta)}</span></span>
            <span class="sd-row-state" data-state-for="${esc(c.songKey)}" data-kind="${st?.kind || ''}">${esc(st?.text || '')}</span>
        </label>`;
    }

    function listHtml() {
        if (!loaded) return '';
        const rows = visible();
        if (!candidates.length) return '<p class="ct-sub sd-empty">No song has a local audio file yet. Add one in a song’s Sound panel, under Original.</p>';
        if (!rows.length) return '<p class="ct-sub sd-empty">Every song with a local audio file already has a backing track.</p>';
        const count = chosen().length;
        return `<div class="sd-listhead">
            <span>${rows.length} ${rows.length === 1 ? 'song' : 'songs'} · ${count} selected</span>
            <span class="sd-listhead-actions">
              <button type="button" class="ct-text" data-act="all" ${batch.running ? 'disabled' : ''}>Select all</button>
              <button type="button" class="ct-text" data-act="none" ${batch.running ? 'disabled' : ''}>Select none</button>
            </span>
          </div>
          <div class="sd-list" role="group" aria-label="Songs to send">${rows.map(rowHtml).join('')}</div>`;
    }

    function actionsHtml() {
        if (batch.running) {
            return `<div class="sd-actions"><span class="sd-progress" role="status">${progressText()}</span>
              <button type="button" class="ct-text" data-act="cancel">Cancel</button></div>`;
        }
        const count = loaded ? planJobs(visible(), view.selected, view.includeExisting).reduce((n, j) => n + j.songs.length, 0) : 0;
        const label = count ? `Make ${count} ${count === 1 ? 'backing track' : 'backing tracks'}` : 'Make backing tracks';
        return `<div class="sd-actions">
            <button type="button" class="btn btn-sm btn-theme-primary" data-act="start" ${count && conn.kind === 'ok' ? '' : 'disabled'}>${label}</button>
            ${batch.summary ? `<span class="sd-progress" role="status">${esc(batch.summary)}</span>` : ''}
          </div>`;
    }

    let drawnRunning = false;
    const progressText = () => `Making backing tracks · ${Math.min(batch.done + 1, batch.total)} of ${batch.total}`;

    /** A job moved on: change the words in place, so focus (on Cancel, say) and scroll stay where they are. */
    function patch() {
        root.querySelectorAll('[data-state-for]').forEach((el) => {
            const st = batch.states.get(el.dataset.stateFor);
            if (el.textContent !== (st?.text || '')) el.textContent = st?.text || '';
            el.dataset.kind = st?.kind || '';
        });
        const progress = root.querySelector('.sd-progress');
        if (progress && progress.textContent !== progressText()) progress.textContent = progressText();
    }

    /** What to do next when StemDeck was not found, said once and only then. */
    function helpHtml() {
        const text = stemdeckHelpText({ desktop, conn, local: local() });
        return text ? `<p class="ct-sub sd-help">${esc(text)}</p>` : '';
    }

    function render() {
        if (!root.isConnected) return;
        drawnRunning = batch.running;
        // Typing in the port field must survive a redraw
        const typing = document.activeElement?.matches?.('.sd-addr-input') ? document.activeElement.value : null;
        const scroll = root.querySelector('.sd-list')?.scrollTop || 0;
        root.innerHTML = `
          <p class="ct-sub">${esc(stemdeckIntroText({ desktop, local: local() }))}</p>
          <div class="sd-conn">
            <label class="sd-addr">StemDeck address <input type="text" class="sd-addr-input" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="80" placeholder="${desktop ? 'This computer' : `192.168.1.20:${DEFAULT_PORT}`}" value="${esc(conn.address)}" ${batch.running ? 'disabled' : ''}></label>
            <button type="button" class="ct-text" data-act="check" ${batch.running ? 'disabled' : ''}>Check again</button>
            <span class="sd-conn-text" data-kind="${conn.kind}" role="status">${esc(conn.text)}</span>
          </div>
          ${helpHtml()}
          <label class="sd-option">
            <input type="checkbox" class="form-check-input" data-act="include" ${view.includeExisting ? 'checked' : ''} ${batch.running ? 'disabled' : ''}>
            <span class="sd-row-text"><span class="sd-row-title">Include songs that already have a backing track</span><span class="sd-row-meta">The new track takes its place</span></span>
          </label>
          ${listHtml()}
          ${actionsHtml()}`;
        const list = root.querySelector('.sd-list');
        if (list) list.scrollTop = scroll;
        if (typing !== null) {
            const input = root.querySelector('.sd-addr-input');
            if (input) { input.value = typing; input.focus(); }
        }
    }

    function applyAddress(input) {
        const parsed = parseAddress(input.value);
        if (parsed.error) {
            // Not saved: the field keeps what was typed so it can be corrected
            checkToken++;
            conn.kind = 'down';
            conn.code = parsed.error;
            conn.text = parsed.error === 'https' ? 'StemDeck is reached over http here' : 'That is not an address';
            render();
            root.querySelector('.sd-addr-input').value = input.value;
            return;
        }
        conn.address = parsed.address;
        setStemDeckAddress(parsed.address);
        check();
    }

    /** An emptied field on a desktop app goes back to looking on this computer. */
    function clearAddress() {
        conn.address = '';
        setStemDeckAddress('');
        check();
    }

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches('.sd-addr-input')) {
            if (!t.value.trim() && desktop) clearAddress(); else applyAddress(t);
            return;
        }
        if (t.dataset.act === 'include') {
            view.includeExisting = t.checked;
            // Turning it on chooses the songs it brings in; turning it off takes them out again
            for (const c of candidates) {
                if (!c.backingId) continue;
                if (t.checked) view.selected.add(c.songKey); else view.selected.delete(c.songKey);
            }
            render();
            return;
        }
        if (t.dataset.song) {
            if (t.checked) view.selected.add(t.dataset.song); else view.selected.delete(t.dataset.song);
            render();
        }
    });
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !e.target.matches('.sd-addr-input')) return;
        e.preventDefault();
        // Leaving the field applies a changed address (the change event); an unchanged one is checked again
        if (e.target.value.trim() === conn.address) check(); else e.target.blur();
    });
    root.addEventListener('click', (e) => {
        const act = e.target.closest('button[data-act]')?.dataset.act;
        if (!act) return;
        if (act === 'check') check();
        else if (act === 'all') { visible().forEach((c) => view.selected.add(c.songKey)); render(); }
        else if (act === 'none') { visible().forEach((c) => view.selected.delete(c.songKey)); render(); }
        else if (act === 'cancel') batch.controller?.abort();
        else if (act === 'start') {
            const jobs = planJobs(visible(), view.selected, view.includeExisting);
            startBatch(jobs, createStemDeckClient({ address: conn.found || conn.address }));
        }
    });

    const onBatch = () => {
        if (!alive) return;
        if (batch.running && drawnRunning) patch();
        else if (batch.running) render();
        else refresh(); // finished: the songs now have backing tracks
    };
    listeners.add(onBatch);
    // A restore or a file added in a song changes what can be sent
    const onFiles = () => { if (alive && !batch.running) refresh(); };
    window.addEventListener(AUDIO_FILES_CHANGED_EVENT, onFiles);

    render();
    refresh();
    check();

    return () => {
        alive = false;
        listeners.delete(onBatch);
        window.removeEventListener(AUDIO_FILES_CHANGED_EVENT, onFiles);
    };
}
