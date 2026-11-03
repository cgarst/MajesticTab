// toolsPage.js
// The Tools destination, laid out like the Settings page: a title, a list of tools, and the chosen
// tool rendered in place beside it (below the list on phones). The Chord library, Scales, Circle of fifths, Tuner and Jam
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
        jam: () => $('jamModal')
    }[id]?.() || null;
}

/** Close the tool shown in the page and give its screen back to the document. */
export async function releaseEmbeddedTools() {
    if (!embedded) return;
    const { id, el } = embedded;
    embedded = null;
    try {
        if (REFERENCE_TOOLS.includes(id)) (await import('../referenceLibrary.js')).closeReferenceModal();
        else if (id === 'tuner') (await import('../tuner/tuner.js')).closeTunerModal();
        else if (id === 'jam' && el.style.display === 'flex') $('jamToggleBtn')?.click();
    } catch { /* the tool is already gone */ }
    el.classList.remove('tool-embedded');
    el.style.display = 'none';
    document.body.appendChild(el);
}

async function openTool(id, pane) {
    await releaseEmbeddedTools();
    if (REFERENCE_TOOLS.includes(id)) (await import('../referenceLibrary.js')).openReferenceModal(id);
    else if (id === 'tuner') $('tunerToggleBtn')?.click();
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
    <div class="setshell tools-shell">
      <div class="sethead"><h1>Tools</h1></div>
      <div class="setwrap" data-pane="list">
        <nav class="setnav" aria-label="Tools">
          ${tools.map((t) => `<button type="button" data-tool="${t.id}" ${t.disabled ? 'disabled aria-disabled="true"' : ''} aria-current="false">
            <span>${escapeHtml(t.title)}</span><i class="bi-chevron-right chev" aria-hidden="true"></i></button>`).join('')}
        </nav>
        <div class="setpage tool-pane">
          <button type="button" class="setback btn btn-sm"><i class="bi-chevron-left" aria-hidden="true"></i> Tools</button>
          <div class="tool-pane-host"></div>
        </div>
      </div>
    </div>`;
    const wrap = container.querySelector('.setwrap');
    const nav = container.querySelector('.setnav');
    const host = container.querySelector('.tool-pane-host');
    const wide = () => window.matchMedia('(min-width: 900px)').matches;

    async function select(id) {
        const tool = tools.find((t) => t.id === id);
        if (!tool) return;
        if (tool.open) { await releaseEmbeddedTools(); tool.open(); return; } // not a section: it works on the song
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === id)));
        wrap.dataset.pane = 'page';
        await openTool(id, host);
    }
    // A chord chosen on the circle of fifths opens the Chord library: keep the list in step
    if (refTabHandler) document.removeEventListener('reference-tab', refTabHandler);
    refTabHandler = (e) => {
        if (embedded && REFERENCE_TOOLS.includes(embedded.id) && nav.isConnected) {
            embedded.id = e.detail;
            nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tool === e.detail)));
        }
    };
    document.addEventListener('reference-tab', refTabHandler);
    nav.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tool]');
        if (b && !b.disabled) select(b.dataset.tool);
    });
    container.querySelector('.setback').addEventListener('click', async () => {
        wrap.dataset.pane = 'list';
        nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', 'false'));
        await releaseEmbeddedTools();
    });
    if (wide()) select(tools.find((t) => !t.open && !t.disabled)?.id);
}
