// toolsPage.js
// The Tools destination, laid out like the Settings page: a title, a list of tools, and the chosen
// tool rendered in place beside it (below the list on phones). The Chord library, Scales, Circle of fifths, Tuner, Metronome and Jam
// keep their own screens; they are moved into the page instead of opening over it.

const $ = (id) => document.getElementById(id);
let embedded = null; // { id, el }
let refTabHandler = null;

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

/** Close the tool shown in the page and give its screen back to the document. */
export async function releaseEmbeddedTools() {
    if (!embedded) return;
    const { id, el } = embedded;
    embedded = null;
    if (id === 'openfile') {
        el.remove();
        return;
    }
    try {
        if (REFERENCE_TOOLS.includes(id)) (await import('../referenceLibrary.js')).closeReferenceModal();
        else if (id === 'tuner') (await import('../tuner/tuner.js')).closeTunerModal();
        else if (id === 'metronome') (await import('../metronome/metronome.js')).closeMetronomeModal();
        else if (id === 'jam' && el.style.display === 'flex') $('jamToggleBtn')?.click();
    } catch { /* the tool is already gone */ }
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

export function renderToolsPage(container, { tools, escapeHtml }) {
    releaseEmbeddedTools();
    container.innerHTML = `
    <div class="setshell tools-shell" data-pane="list">
      <h1 class="visually-hidden">Tools</h1>
      <div class="sethead" data-tauri-drag-region>
        <button type="button" class="setback btn btn-sm" aria-label="Back to Tools"><i class="bi-chevron-left" aria-hidden="true"></i> <span>Tools</span></button>
        <h2 class="sethead-section" data-tauri-drag-region></h2>
      </div>
      <div class="setwrap" data-pane="list">
        <nav class="setnav" aria-label="Tools">
          ${tools.map((t) => `<button type="button" data-tool="${t.id}" ${t.disabled ? 'disabled aria-disabled="true"' : ''} aria-current="false">
            ${t.icon || ''}<span>${escapeHtml(t.title)}</span><i class="bi-chevron-right chev" aria-hidden="true"></i></button>`).join('')}
        </nav>
        <div class="setpage tool-pane">
          <div class="tool-pane-host"></div>
        </div>
      </div>
    </div>`;
    const shell = container.querySelector('.setshell');
    const wrap = container.querySelector('.setwrap');
    const nav = container.querySelector('.setnav');
    const host = container.querySelector('.tool-pane-host');
    const back = container.querySelector('.setback');
    const sectionTitle = container.querySelector('.sethead-section');
    const wide = () => window.matchMedia('(min-width: 900px)').matches;

    async function select(id) {
        const tool = tools.find((t) => t.id === id);
        if (!tool) return;
        if (tool.open) { await releaseEmbeddedTools(); tool.open(); return; } // not a section: it works on the song
        if (sectionTitle) sectionTitle.textContent = tool.title;
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === id)));
        wrap.dataset.pane = 'page';
        shell.dataset.pane = 'page';
        wrap.dataset.tool = id;
        shell.dataset.tool = id;
        await openTool(id, host);
    }
    // A chord chosen on the circle of fifths opens the Chord library: keep the list in step
    if (refTabHandler) document.removeEventListener('reference-tab', refTabHandler);
    refTabHandler = (e) => {
        if (embedded && REFERENCE_TOOLS.includes(embedded.id) && nav.isConnected) {
            embedded.id = e.detail;
            const t = tools.find((x) => x.id === e.detail);
            if (t && sectionTitle) sectionTitle.textContent = t.title;
            nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === e.detail)));
        }
    };
    document.addEventListener('reference-tab', refTabHandler);
    nav.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tool]');
        if (b && !b.disabled) select(b.dataset.tool);
    });
    back.addEventListener('click', async () => {
        wrap.dataset.pane = 'list';
        shell.dataset.pane = 'list';
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', 'false'));
        await releaseEmbeddedTools();
    });
    // Let the page (title and list) paint first: the chord library draws hundreds of diagrams
    if (wide()) {
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
