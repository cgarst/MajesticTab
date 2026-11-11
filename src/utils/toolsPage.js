// toolsPage.js
// The Tools destination: a title, a list of tools grouped by purpose with a readout of real state on the right of a row,
// and the chosen tool rendered on a stage beside it (replacing the list on phones). The Chord library, Scales, Circle of fifths, Tuner, Metronome and Jam
// keep their own screens; they are moved into the page instead of opening over it. Classical tab, Open file and Backing
// tracks (native apps only) are drawn straight into the page.

const $ = (id) => document.getElementById(id);
let embedded = null; // { id, el }
let refTabHandler = null;
let pendingTool = null;
let readObservers = [];
let resumeTool = null; // the tool that was open when the reader took the screen

/** The next Tools page that is drawn opens on this tool (used by the library search to land in Classical tab). */
export function openToolOnNextRender(id) { pendingTool = id; }

// Chords, Scales and Circle of fifths are three tools on one screen, which opens on the tool chosen
const REFERENCE_TOOLS = ['chords', 'scales', 'circle'];

function hostOf(id) {
    if (REFERENCE_TOOLS.includes(id)) id = 'reference';
    return {
        reference: () => $('referenceModal'),
        tuner: () => $('tunerModal'),
        metronome: () => $('metronomeModal'),
        jam: () => $('jamModal')
    }[id]?.() || null;
}

/** A tool was open when the reader took the screen: back should return to it. */
export function hasResumeTool() { return !!resumeTool; }

/** The player left Tools on purpose: the next visit starts at the list again. */
export function forgetResume() {
    resumeTool = null;
    import('../classtab/classtabTool.js').then((m) => m.forgetClasstabView()).catch(() => {});
}

/** Close the tool shown in the page and give its screen back to the document. */
export async function releaseEmbeddedTools(keep = false) {
    if (keep && embedded) resumeTool = embedded.id;
    if (!embedded) return;
    const { id, el, dispose } = embedded;
    embedded = null;
    if (id === 'openfile' || id === 'classtab' || id === 'stemdeck' || id === 'bulkexport' || id === 'missingtabs' || id === 'bulkimport') {
        dispose?.(keep);
        el.remove();
        return;
    }
    try {
        if (REFERENCE_TOOLS.includes(id)) (await import('../referenceLibrary.js')).closeReferenceModal();
        else if (id === 'tuner') (await import('../tuner/tuner.js')).closeTunerModal();
        else if (id === 'metronome') (await import('../metronome/metronome.js')).closeMetronomeModal();
        else if (id === 'jam' && el.style.display === 'flex') $('jamToggleBtn')?.click();
    } catch { /* the tool is already gone */ }
    // The tool was opened again while the closers above were loading: its screen is in use, leave it
    if (embedded?.el === el) return;
    el.classList.remove('tool-embedded');
    el.style.display = 'none';
    document.body.appendChild(el);
}

async function openTool(id, pane) {
    await releaseEmbeddedTools();
    if (id === 'openfile') {
        const { renderOpenFileView } = await import('../openFileModal.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded openfile-tool-embedded';
        renderOpenFileView(el, {
            onBack: () => {
                const back = pane.closest('.setshell')?.querySelector('.setback');
                back?.click();
            }
        });
        pane.appendChild(el);
        embedded = { id, el };
        return;
    }
    if (id === 'classtab') {
        const { renderClasstabTool } = await import('../classtab/classtabTool.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded classtab-tool-embedded';
        pane.appendChild(el);
        embedded = { id, el, dispose: renderClasstabTool(el) };
        return;
    }
    if (id === 'stemdeck') {
        const { renderStemdeckTool } = await import('../stemdeck/stemdeckTool.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded stemdeck-tool-embedded';
        pane.appendChild(el);
        embedded = { id, el, dispose: renderStemdeckTool(el) };
        return;
    }
    if (id === 'bulkexport') {
        const { renderBulkExportTool } = await import('../bulkExport/bulkExportTool.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded bulkexport-tool-embedded';
        pane.appendChild(el);
        embedded = { id, el, dispose: renderBulkExportTool(el) };
        return;
    }
    if (id === 'bulkimport') {
        const { renderBulkImportTool } = await import('../bulkImport/bulkImportTool.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded bulkimport-tool-embedded';
        pane.appendChild(el);
        embedded = { id, el, dispose: renderBulkImportTool(el) };
        return;
    }
    if (id === 'missingtabs') {
        const { renderMissingTabsTool } = await import('../bulkFill/missingTabsTool.js');
        const el = document.createElement('div');
        el.className = 'tool-embedded missingtabs-tool-embedded';
        pane.appendChild(el);
        embedded = { id, el, dispose: renderMissingTabsTool(el) };
        return;
    }
    if (REFERENCE_TOOLS.includes(id)) (await import('../referenceLibrary.js')).openReferenceModal(id);
    else if (id === 'tuner') $('tunerToggleBtn')?.click();
    else if (id === 'metronome') $('metronomeToggleBtn')?.click();
    else if (id === 'jam') { if ($('jamModal')?.style.display !== 'flex') $('jamToggleBtn')?.click(); }
    const el = hostOf(id);
    if (!el) return;
    el.classList.add('tool-embedded');
    pane.appendChild(el);
    // Embedded, it is a page, not a dialog
    document.body.classList.remove('modal-open');
    embedded = { id, el };
}

/** Tools in the order given, split into runs that share a group (the gap between runs is the only separator). */
function groupTools(tools) {
    const out = [];
    for (const t of tools) {
        const g = out.find((x) => x[0].group === t.group);
        if (g) g.push(t); else out.push([t]);
    }
    return out;
}

export function renderToolsPage(container, { tools, escapeHtml }) {
    // resumeTool stays until the player leaves Tools on purpose (forgetResume), so a second draw cannot lose it
    if (!pendingTool && resumeTool) pendingTool = resumeTool;
    releaseEmbeddedTools();
    container.innerHTML = `
    <div class="setshell tools-shell" data-pane="list">
      <h1 class="set-title">Tools</h1>
      <div class="sethead" data-tauri-drag-region>
        <button type="button" class="setback btn btn-sm" aria-label="Back to Tools"><i class="bi-chevron-left" aria-hidden="true"></i> <span>Tools</span></button>
        <h2 class="sethead-section" data-tauri-drag-region></h2>
      </div>
      <div class="setwrap" data-pane="list">
        <nav class="setnav" aria-label="Tools">
          ${groupTools(tools).map((g) => `<div class="setgroup" role="group">${g.map((t) => `<button type="button" data-tool="${t.id}" ${t.disabled ? 'disabled aria-disabled="true"' : ''} aria-current="false">
            <span class="tool-name">${escapeHtml(t.title)}</span><span class="tool-read" data-read="${t.id}">${escapeHtml(t.readout?.() || '')}</span><i class="bi-chevron-right chev" aria-hidden="true"></i></button>`).join('')}</div>`).join('')}
        </nav>
        <div class="setpage tool-pane">
          <h2 class="tool-stage-title"></h2>
          <div class="tool-pane-host"></div>
        </div>
      </div>
    </div>`;
    const shell = container.querySelector('.setshell');
    const wrap = container.querySelector('.setwrap');
    const nav = container.querySelector('.setnav');
    const host = container.querySelector('.tool-pane-host');
    const back = container.querySelector('.setback');
    const sectionTitles = container.querySelectorAll('.sethead-section, .tool-stage-title');
    const setTitle = (text) => sectionTitles.forEach((el) => { el.textContent = text; });
    const wide = () => window.matchMedia('(min-width: 900px)').matches;

    async function select(id) {
        const tool = tools.find((t) => t.id === id);
        if (!tool) return;
        if (tool.open) { await releaseEmbeddedTools(); tool.open(); return; } // not a section: it works on the song
        if (id !== resumeTool) forgetResume();
        setTitle(tool.title);
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === id)));
        wrap.dataset.pane = 'page';
        shell.dataset.pane = 'page';
        wrap.dataset.tool = id;
        shell.dataset.tool = id;
        await openTool(id, host);
        refreshReadouts();
        if (id === 'classtab' || id === 'bulkexport') import('./urlRouter.js').then((m) => m.updateUrl(id)).catch(() => {});
        else if (REFERENCE_TOOLS.includes(id)) import('./urlRouter.js').then((m) => m.updateUrl('reference', id)).catch(() => {});
    }
    // Readouts follow real state: re-read them when a tool's own readout element changes, after any click or change inside the
    // open tool, and whenever the tool changes
    const refreshReadouts = () => nav.querySelectorAll('[data-read]').forEach((el) => {
        const t = tools.find((x) => x.id === el.dataset.read);
        const text = t?.readout?.() || '';
        if (el.textContent !== text) el.textContent = text;
    });
    readObservers.forEach((o) => o.disconnect());
    readObservers = [];
    tools.forEach((t) => (t.watch || []).forEach((id) => {
        const src = $(id);
        if (!src) return;
        const o = new MutationObserver(refreshReadouts);
        o.observe(src, { childList: true, characterData: true, subtree: true });
        readObservers.push(o);
    }));
    ['click', 'change', 'input'].forEach((type) => host.addEventListener(type, () => setTimeout(refreshReadouts, 0)));
    // A chord chosen on the circle of fifths opens the Chord library: keep the list in step
    if (refTabHandler) document.removeEventListener('reference-tab', refTabHandler);
    refTabHandler = (e) => {
        if (embedded && REFERENCE_TOOLS.includes(embedded.id) && nav.isConnected) {
            embedded.id = e.detail;
            const t = tools.find((x) => x.id === e.detail);
            if (t) setTitle(t.title);
            nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === e.detail)));
        }
    };
    document.addEventListener('reference-tab', refTabHandler);
    nav.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tool]');
        if (b && !b.disabled) select(b.dataset.tool);
    });
    back.addEventListener('click', async () => {
        forgetResume();
        wrap.dataset.pane = 'list';
        shell.dataset.pane = 'list';
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', 'false'));
        await releaseEmbeddedTools();
        refreshReadouts();
        import('./urlRouter.js').then((m) => m.updateUrl('tools')).catch(() => {});
    });
    // Let the page (title and list) paint first: the chord library draws hundreds of diagrams
    if (pendingTool) {
        const id = pendingTool;
        pendingTool = null;
        requestAnimationFrame(() => setTimeout(() => { if (nav.isConnected && !embedded) select(id); }, 0));
    } else if (wide()) {
        const first = tools.find((t) => !t.open && !t.disabled)?.id;
        requestAnimationFrame(() => setTimeout(() => { if (nav.isConnected && !embedded) select(first); }, 0));
    }
    window.matchMedia('(min-width: 900px)').addEventListener?.('change', (e) => {
        if (e.matches && wrap.dataset.pane === 'list') {
            const first = tools.find((t) => !t.open && !t.disabled)?.id;
            if (!embedded && first) select(first);
        }
    });
}
