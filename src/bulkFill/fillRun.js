// fillRun.js
// The automated lane of "Fill in missing tabs": one run over the songs that have no tab, asking every search provider that
// fetches files (in the user's order) for each song, one song at a time (these services download and convert audio), and
// adding what comes back to the library. It never shows a dialog and never waits for a person:
//   - a song a provider has no tab for goes on to the next provider; with none left it is 'missing';
//   - several matches and none plainly the song park the song as 'pick' and the run goes on;
//   - an error that ends the run (no connection, token refused) stops it, with the message; any other error fails that song.
// Songs are asked for one at a time unless `concurrency` says more; enqueue adds a song to the run while it goes.
// States of a song: queued, searching, added, pick, missing, failed. A run keeps no state between sessions except what
// the caller saves from `onChange`. Unit tested in tests/fillRun.test.mjs.

export const DONE_STATES = ['added', 'pick', 'missing', 'failed'];

/**
 * @param {object} deps
 * @param {Array<{id: string, title: string, artist: string}>} deps.songs in the order to walk
 * @param {object[]} deps.sources search providers that fetch, in order
 * @param {(song: object, source: object, options: object) => Promise<object>} deps.fetchOne see fetchForSong.js
 * @param {(file: File, song: object) => Promise<boolean>} deps.attach adds the file to the song; true when it did
 * @param {Set<string>} [deps.remembered] ids of songs an earlier run found nothing for: they start as 'missing' and are skipped until requeued
 * @param {(work: () => Promise<void>) => Promise<void>} [deps.around] runs the work of a run inside something (a hold on auto-sync); the run counts as running, and shows it, before it starts
 * @param {number} [deps.concurrency] how many songs are asked for at once (the rest wait their turn)
 * @param {() => void} [deps.onChange] called whenever anything changes
 */
export function createFillRun({ songs, sources, fetchOne, attach, remembered = new Set(), restored = {}, around = (work) => work(), concurrency = 1, onChange = () => {} }) {
    const items = new Map(songs.map((s) => [s.id, { state: remembered.has(s.id) ? 'missing' : 'queued', label: '', fraction: null, message: '', choose: null, source: null }]));
    // What an earlier session settled (see fillStore.js): a parked pick asks again from the addresses it saved
    for (const [id, saved] of Object.entries(restored)) {
        const item = items.get(id);
        if (!item || !DONE_STATES.includes(saved.state)) continue;
        Object.assign(item, { state: saved.state, label: saved.label || '', message: saved.message || '' });
        if (saved.state === 'pick' && saved.choose) item.choose = { ...saved.choose, addressFor: (value) => saved.choose.addresses?.[value] || '' };
    }
    const run = { running: false, stopped: false, stopping: false, error: '', current: null, controller: null };
    const queue = []; // songs waiting for a turn
    const inflight = new Set(); // the songs being asked for now (at most `concurrency`)
    const only = new Map(); // song id -> the providers to ask for it, when not the run's own (a row's Search)
    const notify = () => { try { onChange(); } catch { /* a listener must not break the run */ } };
    const set = (id, patch) => { Object.assign(items.get(id), patch); notify(); };

    /** One song against every source, in order. Returns when the song is settled. */
    async function settle(song, startAt = 0, address = '', list = only.get(song.id) || sources) {
        let lastError = '';
        for (let i = startAt; i < list.length; i++) {
            const source = list[i];
            if (run.controller.signal.aborted) return;
            set(song.id, { state: 'searching', label: source.name || '', fraction: null, source: source.id });
            let found;
            try {
                found = await fetchOne(song, source, {
                    address: i === startAt ? address : '',
                    signal: run.controller.signal,
                    onProgress: ({ fraction, label }) => set(song.id, { fraction, label: label || source.name || '' })
                });
            } catch (error) {
                if (error?.message === 'Cancelled.' || run.controller.signal.aborted) return;
                if (error?.fatal) throw error;
                lastError = error?.message || 'Could not fetch a tab.';
                continue;
            }
            if (found.kind === 'file') {
                const added = await attach(found.file, song).catch(() => false);
                if (added) { set(song.id, { state: 'added', label: found.file.name, fraction: null, message: '', choose: null }); return; }
                lastError = 'Could not add the file to the library.';
                continue;
            }
            if (found.kind === 'choose') {
                const addresses = {};
                for (const option of found.choose.options || []) { try { addresses[option.value] = found.choose.addressFor(option.value); } catch { /* that option cannot be asked again */ } }
                set(song.id, { state: 'pick', label: '', fraction: null, message: '', choose: { ...found.choose, sourceIndex: i, sourceId: source.id, addresses } });
                return;
            }
            // missing: the next source
        }
        if (run.controller.signal.aborted) return;
        set(song.id, lastError ? { state: 'failed', message: lastError, fraction: null } : { state: 'missing', message: '', fraction: null });
    }

    /** Starts songs from the queue until `concurrency` are in flight. Each one that ends starts the next. */
    function pump() {
        while (run.running && !run.controller.signal.aborted && inflight.size < concurrency && queue.length) {
            const song = queue.shift();
            run.current = song.id;
            const task = settle(song)
                .catch((error) => { if (!run.error) run.error = error?.message || 'The run stopped.'; queue.length = 0; run.controller.abort(); })
                .finally(() => { inflight.delete(task); pump(); });
            inflight.add(task);
        }
    }

    /** Walks the songs not settled yet, or only `ids`. Resolves when the queue is empty, including songs added with enqueue meanwhile. */
    async function start(ids = null) {
        if (run.running) return;
        run.running = true;
        run.stopped = false;
        run.stopping = false;
        run.error = '';
        run.controller = new AbortController();
        // One change for the whole list (a change per song would redraw the page once per song), and it is announced before
        // anything is awaited, so the page shows the run at once
        queue.length = 0;
        for (const song of songs) {
            const item = items.get(song.id);
            if (ids ? !ids.includes(song.id) : DONE_STATES.includes(item.state)) continue;
            item.state = 'queued';
            queue.push(song);
        }
        notify();
        try {
            await around(async () => {
                pump();
                while (inflight.size) await Promise.race(inflight);
            });
        } catch (error) {
            run.error = error?.message || 'The run stopped.';
        } finally {
            run.stopped = run.controller.signal.aborted;
            queue.length = 0;
            for (const item of items.values()) if (item.state === 'searching' || item.state === 'queued') Object.assign(item, { state: 'queued', fraction: null, label: '' });
            run.running = false;
            run.stopping = false;
            run.current = null;
            notify();
        }
    }

    /**
     * Puts one song in the queue to be asked of `list` (the run's own providers when omitted). While a run is going the song
     * waits its turn; otherwise a run of just that song starts. Resolves when the song's turn is over.
     */
    function enqueue(song, list = null) {
        if (!items.has(song.id)) {
            songs.push(song);
            items.set(song.id, { state: 'queued', label: '', fraction: null, message: '', choose: null, source: null });
        } else if (items.get(song.id).state === 'searching' || queue.includes(song)) {
            return Promise.resolve();
        }
        if (list) only.set(song.id, list); else only.delete(song.id);
        Object.assign(items.get(song.id), { state: 'queued', message: '', choose: null, fraction: null, label: '' });
        if (!run.running) return start([song.id]);
        queue.push(song);
        notify();
        pump();
        return Promise.resolve();
    }

    /** Asks again for a parked song with the match a person chose. */
    async function resolvePick(songId, value) {
        const item = items.get(songId);
        const song = songs.find((s) => s.id === songId);
        if (!item?.choose || !song) return;
        const { addressFor, sourceId } = item.choose;
        const list = only.get(songId) || sources;
        const sourceIndex = Math.max(0, list.findIndex((s) => s.id === sourceId));
        run.controller = new AbortController();
        try {
            await settle(song, sourceIndex, addressFor(value), list);
        } catch (error) {
            set(songId, { state: 'failed', message: error?.message || 'Could not fetch a tab.', choose: null });
        }
    }

    /** Puts a song back in the queue (for a retry). */
    function requeue(songId) {
        if (items.has(songId)) set(songId, { state: 'queued', message: '', choose: null, fraction: null, label: '' });
    }

    function stop() {
        if (!run.running) return;
        run.stopping = true;
        run.controller?.abort();
        notify();
    }

    function counts() {
        const n = { queued: 0, searching: 0, added: 0, pick: 0, missing: 0, failed: 0 };
        for (const item of items.values()) n[item.state]++;
        return n;
    }

    return { items, run, only, start, enqueue, stop, resolvePick, requeue, counts };
}
