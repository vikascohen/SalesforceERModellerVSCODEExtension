// This file runs INSIDE the webview's isolated browser context, not in the
// extension host. It owns the DSL editor, the SVG canvas, and talking to
// the extension host (acquireVsCodeApi()) for anything that needs real
// filesystem or Salesforce CLI access, neither of which a webview can do
// on its own.

const vscode = acquireVsCodeApi();

const editor = document.getElementById('dslEditor');
const canvas = document.getElementById('canvas');
const statusText = document.getElementById('statusText');
const importBtn = document.getElementById('importBtn');

let parseEr, buildErGeometry;
let renderTimer = null;

async function init() {
    // window.__LOGIC_URI__ is set by an inline script in index.html, since
    // a webview's asWebviewUri() result isn't known until the extension
    // host renders the HTML — a static import path can't reference it
    // directly, so this loads it as a dynamic import instead.
    const logic = await import(window.__LOGIC_URI__);
    parseEr = logic.parseEr;
    buildErGeometry = logic.buildErGeometry;

    editor.addEventListener('input', scheduleRender);
    importBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'importFromOrg' });
    });
    window.addEventListener('message', handleExtensionMessage);

    render();
}

function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
}

function render() {
    const text = editor.value;
    if (!text.trim()) {
        canvas.innerHTML = '';
        setStatus('');
        return;
    }
    try {
        const model = parseEr(text);
        const geo = buildErGeometry(model, {}, {}, {});
        drawGeometry(geo);
        setStatus('');
    } catch (e) {
        setStatus(e.message || String(e), true);
    }
}

// A deliberately plain, unstyled render for this first pass — proving the
// ported parser and geometry engine drive real SVG output inside a
// webview, before any of the original app's theming, drag/drop, or badges
// get layered on top.
function drawGeometry(geo) {
    canvas.setAttribute('width', String(geo.svgWidth));
    canvas.setAttribute('height', String(geo.svgHeight));
    canvas.innerHTML = '';

    const ns = 'http://www.w3.org/2000/svg';

    geo.connectors.forEach((c) => {
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', c.path);
        path.setAttribute('stroke', '#888');
        path.setAttribute('fill', 'none');
        canvas.appendChild(path);
    });

    geo.boxes.forEach((b) => {
        const g = document.createElementNS(ns, 'g');

        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String(b.x));
        rect.setAttribute('y', String(b.y));
        rect.setAttribute('width', String(b.width));
        rect.setAttribute('height', String(b.height));
        rect.setAttribute('fill', 'var(--vscode-editor-background)');
        rect.setAttribute('stroke', 'var(--vscode-panel-border)');
        g.appendChild(rect);

        const title = document.createElementNS(ns, 'text');
        title.setAttribute('x', String(b.x + 8));
        title.setAttribute('y', String(b.y + 18));
        title.setAttribute('fill', 'var(--vscode-foreground)');
        title.setAttribute('font-weight', 'bold');
        title.textContent = b.name;
        g.appendChild(title);

        b.fields.forEach((f, i) => {
            const row = document.createElementNS(ns, 'text');
            row.setAttribute('x', String(b.x + 10));
            row.setAttribute('y', String(b.y + 36 + i * 16));
            row.setAttribute('fill', 'var(--vscode-descriptionForeground)');
            row.setAttribute('font-size', '11');
            row.textContent = f.text;
            g.appendChild(row);
        });

        canvas.appendChild(g);
    });
}

function handleExtensionMessage(event) {
    const msg = event.data;
    if (msg.type === 'appendDsl') {
        editor.value = editor.value.trim()
            ? editor.value.trimEnd() + '\n\n' + msg.dsl
            : msg.dsl;
        render();
    } else if (msg.type === 'importError') {
        setStatus(msg.message, true);
    }
}

function setStatus(text, isError) {
    statusText.textContent = text;
    statusText.style.color = isError ? 'var(--vscode-errorForeground)' : '';
}

init();
