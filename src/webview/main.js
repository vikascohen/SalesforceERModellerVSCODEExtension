// Runs INSIDE the webview's isolated browser context. Owns the DSL
// editor, the SVG canvas, and all messaging with the extension host
// (acquireVsCodeApi()) for anything needing real filesystem or
// Salesforce CLI access, neither of which a webview can do itself.

const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';

const editor = document.getElementById('dslEditor');
const canvas = document.getElementById('canvas');
const statusText = document.getElementById('statusText');
const importBtn = document.getElementById('importBtn');
const importNames = document.getElementById('importNames');
const openBtn = document.getElementById('openBtn');
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const exportMermaidBtn = document.getElementById('exportMermaidBtn');
const exportDrawioBtn = document.getElementById('exportDrawioBtn');
const focusToggle = document.getElementById('focusToggle');

let parseEr, buildErGeometry, buildMermaidErDiagram, buildDrawioXml;
let renderTimer = null;
let lastModel = null;
let dirty = false;
let focusedEntity = null;

// Ported directly from diagramStudio.js's injectDefs() -- generic SVG
// marker-building with no LWC dependency to begin with, so this is a
// faithful copy, not a reimplementation.
function injectDefs(defsEl) {
    if (!defsEl || defsEl.childElementCount > 0) return;
    [
        { id: 'er-arrow', w: 10, h: 10, rx: 8, ry: 3, d: 'M0,0 L8,3 L0,6', fill: 'none', stroke: 'context-stroke' },
        { id: 'er-diamond', w: 14, h: 10, rx: 12, ry: 3, d: 'M0,3 L6,0 L12,3 L6,6 Z', fill: 'context-stroke', stroke: null },
        { id: 'er-diamond-open', w: 14, h: 10, rx: 12, ry: 3, d: 'M0,3 L6,0 L12,3 L6,6 Z', fill: 'none', stroke: 'context-stroke' }
    ].forEach(({ id, w, h, rx, ry, d, fill, stroke }) => {
        const m = document.createElementNS(SVG_NS, 'marker');
        m.setAttribute('id', id); m.setAttribute('markerWidth', w); m.setAttribute('markerHeight', h);
        m.setAttribute('refX', rx); m.setAttribute('refY', ry); m.setAttribute('orient', 'auto');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d); path.setAttribute('fill', fill);
        if (stroke) path.setAttribute('stroke', stroke);
        m.appendChild(path); defsEl.appendChild(m);
    });
}

async function init() {
    // window.__LOGIC_URI__ is set by an inline script in index.html --
    // a webview's asWebviewUri() result isn't known until the extension
    // host renders the HTML, so a static import path can't reference it;
    // this loads it as a dynamic import instead.
    const logic = await import(window.__LOGIC_URI__);
    parseEr = logic.parseEr;
    buildErGeometry = logic.buildErGeometry;
    buildMermaidErDiagram = logic.buildMermaidErDiagram;
    buildDrawioXml = logic.buildDrawioXml;

    editor.addEventListener('input', () => { markDirty(); scheduleRender(); });
    importBtn.addEventListener('click', doImport);
    importNames.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
    openBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestOpen' }));
    saveBtn.addEventListener('click', doSave);
    saveAsBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestSaveAs', text: editor.value }));
    exportMermaidBtn.addEventListener('click', doExportMermaid);
    exportDrawioBtn.addEventListener('click', doExportDrawio);
    focusToggle.addEventListener('change', () => { focusedEntity = null; render(); });
    canvas.addEventListener('click', onCanvasClick);

    window.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === 's') { e.preventDefault(); doSave(); }
        if (e.key === 'Escape' && focusedEntity) { focusedEntity = null; render(); }
    });

    window.addEventListener('message', handleExtensionMessage);
    vscode.postMessage({ type: 'ready' });

    render();
}

function markDirty() {
    if (!dirty) {
        dirty = true;
        vscode.postMessage({ type: 'dirtyChanged', dirty: true });
    }
}

function doSave() {
    vscode.postMessage({ type: 'requestSave', text: editor.value });
}

function doImport() {
    const raw = importNames.value.trim();
    if (!raw) { setStatus('Enter one or more object API names first.', true); return; }
    const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
    setStatus('Describing ' + names.join(', ') + '...');
    vscode.postMessage({ type: 'importFromOrg', names });
}

function doExportMermaid() {
    if (!lastModel) { setStatus('Nothing to export yet.', true); return; }
    const mermaid = buildMermaidErDiagram(lastModel);
    vscode.postMessage({ type: 'exportMermaidToClipboard', text: mermaid });
}

function doExportDrawio() {
    if (!lastModel) { setStatus('Nothing to export yet.', true); return; }
    const geo = buildErGeometry(lastModel, {}, {}, {});
    const xml = buildDrawioXml(lastModel, geo.boxes);
    vscode.postMessage({ type: 'exportDrawioToFile', text: xml });
}

function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
}

function render() {
    const text = editor.value;
    if (!text.trim()) {
        canvas.innerHTML = '';
        lastModel = null;
        setStatus('');
        return;
    }
    try {
        const model = parseEr(text);
        lastModel = model;
        const geo = buildErGeometry(model, {}, {}, {});
        drawGeometry(geo);
        setStatus('');
    } catch (e) {
        setStatus(e.message || String(e), true);
    }
}

function onCanvasClick(e) {
    const g = e.target.closest('[data-entity]');
    const name = g ? g.getAttribute('data-entity') : null;
    if (!focusToggle.checked) return;
    focusedEntity = name === focusedEntity ? null : name;
    render();
}

function drawGeometry(geo) {
    canvas.setAttribute('width', String(geo.svgWidth));
    canvas.setAttribute('height', String(geo.svgHeight));
    canvas.innerHTML = '';

    const defs = document.createElementNS(SVG_NS, 'defs');
    canvas.appendChild(defs);
    injectDefs(defs);

    const focusActive = focusToggle.checked && focusedEntity;
    const relatedToFocus = new Set();
    if (focusActive) {
        relatedToFocus.add(focusedEntity);
        geo.connectors.forEach((c) => {
            if (c.childEntity === focusedEntity) relatedToFocus.add(c.parentEntity);
            if (c.parentEntity === focusedEntity) relatedToFocus.add(c.childEntity);
        });
    }

    geo.connectors.forEach((c) => {
        const dimmed = focusActive && !(relatedToFocus.has(c.childEntity) && relatedToFocus.has(c.parentEntity));
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', c.d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', c.stroke);
        path.setAttribute('stroke-width', String(c.strokeWidth));
        path.setAttribute('stroke-dasharray', c.dashArray);
        path.setAttribute('marker-end', c.markerEnd);
        path.setAttribute('opacity', dimmed ? '0.15' : '1');
        canvas.appendChild(path);

        [[c.cardStartX, c.cardStartY, c.cardStartText], [c.cardEndX, c.cardEndY, c.cardEndText]].forEach(([x, y, t]) => {
            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('x', String(x));
            label.setAttribute('y', String(y));
            label.setAttribute('font-size', '10');
            label.setAttribute('fill', c.stroke);
            label.setAttribute('opacity', dimmed ? '0.15' : '1');
            label.textContent = t;
            canvas.appendChild(label);
        });
    });

    geo.boxes.forEach((b) => {
        const dimmed = focusActive && !relatedToFocus.has(b.name);
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('data-entity', b.name);
        g.setAttribute('opacity', dimmed ? '0.2' : '1');
        g.style.cursor = focusToggle.checked ? 'pointer' : 'default';

        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(b.x));
        rect.setAttribute('y', String(b.y));
        rect.setAttribute('width', String(b.width));
        rect.setAttribute('height', String(b.height));
        rect.setAttribute('fill', 'var(--vscode-editor-background)');
        rect.setAttribute('stroke', 'var(--vscode-panel-border)');
        g.appendChild(rect);

        const headerHeight = 26;
        const header = document.createElementNS(SVG_NS, 'rect');
        header.setAttribute('x', String(b.x));
        header.setAttribute('y', String(b.y));
        header.setAttribute('width', String(b.width));
        header.setAttribute('height', String(headerHeight));
        header.setAttribute('fill', b.headerFill);
        g.appendChild(header);

        const title = document.createElementNS(SVG_NS, 'text');
        title.setAttribute('x', String(b.x + 8));
        title.setAttribute('y', String(b.y + 18));
        title.setAttribute('fill', '#ffffff');
        title.setAttribute('font-weight', 'bold');
        title.setAttribute('font-size', '12');
        title.textContent = b.name;
        g.appendChild(title);

        b.fields.forEach((f) => {
            let marker = '';
            let color = 'var(--vscode-descriptionForeground)';
            let fontStyle = 'normal';
            if (f.isPrimaryKey) { marker = '\u2217 '; color = '#d4a72c'; }
            else if (f.isRollupSummary) { marker = '\u03A3 '; color = '#0d9488'; }
            else if (f.isRelationship) { marker = '\u007E '; color = '#7b5ea7'; fontStyle = 'italic'; }

            const row = document.createElementNS(SVG_NS, 'text');
            row.setAttribute('x', String(b.x + 10));
            row.setAttribute('y', String(f.rowY));
            row.setAttribute('fill', color);
            row.setAttribute('font-size', '11');
            row.setAttribute('font-style', fontStyle);
            row.textContent = marker + f.text;
            g.appendChild(row);
        });

        if (b.hiddenCount > 0) {
            const more = document.createElementNS(SVG_NS, 'text');
            more.setAttribute('x', String(b.x + 10));
            more.setAttribute('y', String(b.y + b.height - 6));
            more.setAttribute('fill', 'var(--vscode-descriptionForeground)');
            more.setAttribute('font-size', '10');
            more.setAttribute('font-style', 'italic');
            more.textContent = `+${b.hiddenCount} more (resize to see)`;
            g.appendChild(more);
        }

        canvas.appendChild(g);
    });
}

function handleExtensionMessage(event) {
    const msg = event.data;
    if (msg.type === 'appendDsl') {
        editor.value = editor.value.trim() ? editor.value.trimEnd() + '\n\n' + msg.dsl : msg.dsl;
        markDirty();
        render();
        setStatus('Imported.');
    } else if (msg.type === 'loadDsl') {
        editor.value = msg.dsl;
        dirty = false;
        render();
        setStatus('Opened.');
    } else if (msg.type === 'importError') {
        setStatus(msg.message, true);
    } else if (msg.type === 'saved') {
        dirty = false;
        setStatus('Saved.');
    } else if (msg.type === 'orgChanged') {
        setStatus(msg.org ? `Connected: ${msg.org.alias || msg.org.username}` : 'No org selected.');
    }
}

function setStatus(text, isError) {
    statusText.textContent = text;
    statusText.style.color = isError ? 'var(--vscode-errorForeground)' : '';
}

init();
