// Runs INSIDE the webview's isolated browser context. Owns the DSL
// editor, the SVG canvas, and all messaging with the extension host
// (acquireVsCodeApi()) for anything needing real filesystem or
// Salesforce CLI access, neither of which a webview can do itself.

import { currentSearchTerm, filterObjectNames, appendNameToInput } from './paletteFilter.js';
import { detectDslContext } from './dslIntellisense.js';
import { buildFieldMarkerSuffix } from './fieldMarkers.js';

const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';

const editor = document.getElementById('dslEditor');
const canvas = document.getElementById('canvas');
const statusText = document.getElementById('statusText');
const importBtn = document.getElementById('importBtn');
const importNames = document.getElementById('importNames');
const suggestDropdown = document.getElementById('suggestDropdown');
const dslSuggestDropdown = document.getElementById('dslSuggestDropdown');
const dictionaryToggleBtn = document.getElementById('dictionaryToggleBtn');
const dictionaryPanel = document.getElementById('dictionaryPanel');
const dictionarySearch = document.getElementById('dictionarySearch');
const dictionaryObjectList = document.getElementById('dictionaryObjectList');
const dictionaryDetailTitle = document.getElementById('dictionaryDetailTitle');
const dictionaryUsageBtn = document.getElementById('dictionaryUsageBtn');
const dictionaryExportBtn = document.getElementById('dictionaryExportBtn');
const dictionaryCloseBtn = document.getElementById('dictionaryCloseBtn');
const dictionaryTableWrap = document.getElementById('dictionaryTableWrap');
const heatmapToggle = document.getElementById('heatmapToggle');
const sharingViewToggle = document.getElementById('sharingViewToggle');
const hoverCard = document.getElementById('hoverCard');
const openBtn = document.getElementById('openBtn');
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const exportMermaidBtn = document.getElementById('exportMermaidBtn');
const exportDrawioBtn = document.getElementById('exportDrawioBtn');
const focusToggle = document.getElementById('focusToggle');

let parseEr, buildErGeometry, buildMermaidErDiagram, buildDrawioXml, splitFieldList;
let renderTimer = null;
let lastModel = null;
let dirty = false;
let focusedEntity = null;
let allObjectNames = [];

// DSL editor intellisense state — separate from the import-panel's own
// object-name autocomplete (suggestDropdown/allObjectNames above, which
// this reuses for context 2's object-name suggestions rather than
// duplicating that fetch).
let objectFieldsCache = {};   // lowercased entity name -> field[]
let objectFieldsFetching = {}; // lowercased entity name -> true while a request is in flight
let dslSuggestItems = [];
let dslReplaceStart = 0;
let dslReplaceEnd = 0;
let charWidthCache = {};

// Data Dictionary state
let dictionarySelectedObject = null;
let dictionaryRow = null; // { apiName, label, isCustom, fields: [...] }
let dictionaryUsagePending = false;

// Sharing View / Heatmap state — lowercased entity name -> data
let sharingModels = {};
let recordCounts = {};

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
    splitFieldList = logic.splitFieldList;

    editor.addEventListener('input', () => { markDirty(); scheduleRender(); updateDslSuggestions(); });
    editor.addEventListener('click', () => updateDslSuggestions());
    editor.addEventListener('keydown', handleDslEditorKeyDown);
    editor.addEventListener('scroll', () => { dslSuggestDropdown.hidden = true; });
    document.addEventListener('click', (e) => {
        if (e.target !== editor && !dslSuggestDropdown.contains(e.target)) {
            dslSuggestDropdown.hidden = true;
        }
    });
    importBtn.addEventListener('click', doImport);
    importNames.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
    importNames.addEventListener('input', renderSuggestions);
    importNames.addEventListener('focus', () => {
        if (allObjectNames.length === 0) vscode.postMessage({ type: 'requestObjectList' });
        renderSuggestions();
    });
    document.addEventListener('click', (e) => {
        if (e.target !== importNames && !suggestDropdown.contains(e.target)) {
            suggestDropdown.hidden = true;
        }
    });
    openBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestOpen' }));
    dictionaryToggleBtn.addEventListener('click', openDictionary);
    dictionaryCloseBtn.addEventListener('click', closeDictionary);
    dictionarySearch.addEventListener('input', renderDictionaryObjectList);
    dictionaryUsageBtn.addEventListener('click', requestCalculateUsage);
    dictionaryExportBtn.addEventListener('click', exportDictionaryToExcel);
    heatmapToggle.addEventListener('change', () => { requestSharingAndHeatmapData(); scheduleRender(); });
    sharingViewToggle.addEventListener('change', () => { requestSharingAndHeatmapData(); scheduleRender(); });
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

function renderSuggestions() {
    const term = currentSearchTerm(importNames.value);
    const matches = filterObjectNames(allObjectNames, term);
    if (matches.length === 0) {
        suggestDropdown.hidden = true;
        return;
    }
    suggestDropdown.innerHTML = '';
    matches.forEach((name) => {
        const item = document.createElement('div');
        item.className = 'suggest-item';
        item.textContent = name;
        item.addEventListener('click', () => {
            importNames.value = appendNameToInput(importNames.value, name);
            suggestDropdown.hidden = true;
            importNames.focus();
        });
        suggestDropdown.appendChild(item);
    });
    suggestDropdown.hidden = false;
}

// ── DSL editor intellisense ──
// Ported from the LWC's own detectDslContext/computeDslSuggestStyle —
// see dslIntellisense.js for the two real bugs already found and fixed
// there, preserved intact in this port rather than re-derived.

function requestFieldsForEntity(entityName) {
    const key = entityName.toLowerCase();
    if (objectFieldsCache[key] || objectFieldsFetching[key]) return;
    objectFieldsFetching[key] = true;
    vscode.postMessage({ type: 'requestFieldsForEntity', entityName });
}

function updateDslSuggestions() {
    const caret = editor.selectionStart;
    const text = editor.value;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const linePrefix = text.substring(lineStart, caret);

    const ctx = detectDslContext(linePrefix, text, lineStart, {
        allObjectNames,
        getCachedFields: (entityLower) => objectFieldsCache[entityLower],
        requestFieldsIfMissing: requestFieldsForEntity,
        buildFieldMarkerSuffix,
        splitFieldList
    });

    if (!ctx || !ctx.items || !ctx.items.length) {
        dslSuggestDropdown.hidden = true;
        dslSuggestItems = [];
        return;
    }
    dslSuggestItems = ctx.items;
    dslReplaceStart = ctx.replaceStart;
    dslReplaceEnd = caret;
    renderDslSuggestionsDropdown();
}

function measureCharWidth(font) {
    if (charWidthCache[font] != null) return charWidthCache[font];
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    ctx.font = font;
    const w = ctx.measureText('0').width || 7;
    charWidthCache[font] = w;
    return w;
}

// Pixel position for the dropdown, anchored just under the caret. The
// editor uses white-space: pre (no line wrapping, horizontal scroll
// instead — see style.css), so every DSL line is exactly one visual row,
// meaning caret position is plain monospace-grid arithmetic rather than
// needing a full mirror-element measurement, matching the original LWC
// editor's own approach exactly.
function computeDslSuggestStyle(textareaEl, caret) {
    const cs = getComputedStyle(textareaEl);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const charWidth = measureCharWidth(font);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;

    const before = textareaEl.value.substring(0, caret);
    const row = (before.match(/\n/g) || []).length;
    const col = caret - before.lastIndexOf('\n') - 1;

    // offsetLeft/offsetTop are relative to the nearest positioned
    // ancestor — .dsl-editor-wrap has position: relative for exactly
    // this reason, so these are already relative to the right container.
    const rawX = textareaEl.offsetLeft + padLeft + col * charWidth - textareaEl.scrollLeft;
    const rawY = textareaEl.offsetTop + padTop + (row + 1) * lineHeight - textareaEl.scrollTop;

    const DSL_SUGGEST_WIDTH = 220;
    const maxLeft = Math.max(4, textareaEl.offsetWidth - DSL_SUGGEST_WIDTH - 20);
    const x = Math.min(Math.max(4, rawX), maxLeft);
    const y = Math.max(4, rawY);

    return `left:${Math.round(x)}px; top:${Math.round(y)}px; width:${DSL_SUGGEST_WIDTH}px;`;
}

function renderDslSuggestionsDropdown() {
    dslSuggestDropdown.innerHTML = '';
    dslSuggestItems.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'suggest-item';
        el.dataset.index = String(idx);

        const label = document.createElement('span');
        label.className = 'dsl-suggest-label';
        label.textContent = item.label;
        el.appendChild(label);

        if (item.detail) {
            const detail = document.createElement('span');
            detail.className = 'dsl-suggest-detail';
            detail.textContent = item.detail;
            el.appendChild(detail);
        }

        el.addEventListener('click', () => applyDslSuggestion(idx));
        dslSuggestDropdown.appendChild(el);
    });
    dslSuggestDropdown.style.cssText = computeDslSuggestStyle(editor, editor.selectionStart);
    dslSuggestDropdown.hidden = false;
}

function applyDslSuggestion(idx) {
    const item = dslSuggestItems[idx];
    if (!item) return;

    const before = editor.value.substring(0, dslReplaceStart);
    const after = editor.value.substring(dslReplaceEnd);
    const insert = item.insertText + (item.appendText || '');
    const next = before + insert + after;
    const caretPos = before.length + insert.length;

    editor.value = next;
    editor.selectionStart = caretPos;
    editor.selectionEnd = caretPos;
    editor.focus();

    markDirty();
    scheduleRender();
    dslSuggestDropdown.hidden = true;
    dslSuggestItems = [];

    // Re-check immediately after inserting — e.g. picking a relationship
    // field name should immediately offer the arrow context next,
    // matching the LWC's own re-entrant call after applying a suggestion.
    updateDslSuggestions();
}

function handleDslEditorKeyDown(e) {
    if (!dslSuggestDropdown.hidden && dslSuggestItems.length > 0) {
        if (e.key === 'Escape') {
            e.preventDefault();
            dslSuggestDropdown.hidden = true;
            dslSuggestItems = [];
            return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            applyDslSuggestion(0);
            return;
        }
    }
    if (e.key === 'Tab') {
        // Tab with no suggestion open: insert 2 spaces instead of
        // jumping focus away from the editor.
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const next = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.value = next;
        editor.selectionStart = start + 2;
        editor.selectionEnd = start + 2;
        markDirty();
        scheduleRender();
    }
}

// ── Data Dictionary ──

function openDictionary() {
    dictionaryPanel.hidden = false;
    if (allObjectNames.length === 0) vscode.postMessage({ type: 'requestObjectList' });
    renderDictionaryObjectList();
}

function closeDictionary() {
    dictionaryPanel.hidden = true;
}

function renderDictionaryObjectList() {
    const term = dictionarySearch.value.trim().toLowerCase();
    const matches = term
        ? allObjectNames.filter((n) => n.toLowerCase().includes(term))
        : allObjectNames;
    dictionaryObjectList.innerHTML = '';
    matches.slice(0, 200).forEach((name) => {
        const item = document.createElement('div');
        item.className = 'dictionary-object-item' + (name === dictionarySelectedObject ? ' selected' : '');
        item.textContent = name;
        item.addEventListener('click', () => selectDictionaryObject(name));
        dictionaryObjectList.appendChild(item);
    });
}

function selectDictionaryObject(name) {
    dictionarySelectedObject = name;
    dictionaryRow = null;
    dictionaryUsagePending = false;
    renderDictionaryObjectList();
    dictionaryDetailTitle.textContent = 'Loading ' + name + '\u2026';
    dictionaryUsageBtn.hidden = true;
    dictionaryExportBtn.hidden = true;
    dictionaryTableWrap.innerHTML = '';
    vscode.postMessage({ type: 'requestDictionaryForObject', entityName: name });
}

function renderDictionaryTable() {
    if (!dictionaryRow) return;
    dictionaryDetailTitle.textContent = `${dictionaryRow.label} (${dictionaryRow.apiName})`;
    dictionaryUsageBtn.hidden = false;
    dictionaryUsageBtn.disabled = dictionaryUsagePending;
    dictionaryUsageBtn.textContent = dictionaryUsagePending ? 'Calculating\u2026' : 'Calculate Usage';
    dictionaryExportBtn.hidden = false;

    const table = document.createElement('table');
    table.className = 'dictionary-table';
    table.innerHTML = `
        <thead><tr>
            <th></th><th>API Name</th><th>Label</th><th>Type</th>
            <th>Required</th><th>Description</th><th>Last Modified</th><th>% Populated</th>
        </tr></thead>`;
    const tbody = document.createElement('tbody');
    dictionaryRow.fields.forEach((f) => {
        const tr = document.createElement('tr');
        const pctText = f.percentUsed == null ? '\u2014' : Math.round(f.percentUsed * 10) / 10 + '%';
        tr.innerHTML = `
            <td>${f.isPrimaryKey ? '<span class="dictionary-pk-marker">\u2605</span>' : ''}</td>
            <td>${escapeHtml(f.apiName)}</td>
            <td>${escapeHtml(f.label || '')}</td>
            <td>${escapeHtml(f.friendlyType || f.dataType || '')}</td>
            <td>${f.required ? 'Yes' : 'No'}</td>
            <td class="dictionary-desc-cell">${escapeHtml(f.description || '')}</td>
            <td>${escapeHtml(f.lastModifiedDate || '')}</td>
            <td>${pctText}</td>`;
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    dictionaryTableWrap.innerHTML = '';
    dictionaryTableWrap.appendChild(table);
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function requestCalculateUsage() {
    if (!dictionaryRow) return;
    // Matches the original: the primary key field is always 100% by
    // definition and is never included in the actual scan, since
    // scanning it would just re-confirm what's already known.
    const fieldNames = dictionaryRow.fields.filter((f) => !f.isPrimaryKey).map((f) => f.apiName);
    dictionaryUsagePending = true;
    renderDictionaryTable();
    vscode.postMessage({ type: 'requestFieldUsageStats', entityName: dictionaryRow.apiName, fieldNames });
}

function exportDictionaryToExcel() {
    if (!dictionaryRow) return;
    vscode.postMessage({ type: 'exportDictionaryToExcel', row: dictionaryRow });
}

// ── Sharing View / Heatmap ──
// Color logic ported directly from the LWC's own heatColorFor/
// isStaleRecordInfo — three states, not a binary "any records or not":
// empty (no records), stale (records exist, none touched in over a
// year), active (touched within the last year).

function isStaleRecordInfo(rc) {
    if (!rc || !rc.count || !rc.lastModifiedDate) return false;
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    return new Date(rc.lastModifiedDate) < oneYearAgo;
}

function heatColorFor(rc) {
    if (!rc || !rc.count) return '#fde3cc';         // empty
    if (isStaleRecordInfo(rc)) return '#fef3c7';     // stale
    return '#cfe8fb';                                 // active
}

function currentEntityNames() {
    if (!lastModel || !lastModel.entities) return [];
    return lastModel.entities.map((e) => e.name);
}

function requestSharingAndHeatmapData() {
    const names = currentEntityNames();
    if (!names.length) return;
    if (sharingViewToggle.checked) {
        vscode.postMessage({ type: 'requestSharingModels', entityNames: names });
    }
    if (heatmapToggle.checked) {
        vscode.postMessage({ type: 'requestRecordCounts', entityNames: names });
    }
}

// ── Object summary hover card ──
// Ported from the LWC's own sharingBadgeFor/showHoverCard. One
// deliberate, stated scope reduction from the original: the Sharing
// Rules / Apex Sharing detection (a third Apex method, getSharingSignals,
// reading __Share table RowCause values) isn't ported yet, so this
// shows field count, object type, record count/freshness, and sharing
// model, but not that third section — see README for this as a stated
// gap, not an oversight.

function sharingBadgeFor(model) {
    const map = {
        Private: 'Private',
        Read: 'Public Read Only',
        ReadWrite: 'Public Read/Write',
        ReadWriteTransfer: 'Public Read/Write/Transfer',
        FullAccess: 'Full Access',
        ControlledByParent: 'Controlled by Parent (inherits sharing)',
        ControlledByCampaign: 'Controlled by Campaign',
        ControlledByLeadOrContact: 'Controlled by Lead/Contact'
    };
    return map[model] || (model ? model : 'Unknown / not available');
}

function isStaleRecordInfoForHover(rc) {
    return isStaleRecordInfo(rc);
}

function showHoverCard(entityName, box, clientX, clientY) {
    const key = entityName.toLowerCase();
    const rc = recordCounts[key];
    const sharing = sharingModels[key];

    const fieldCount = box.fields.length + (box.hiddenCount || 0);
    const objectTypeText = entityName.endsWith('__c') ? 'Custom Object' : 'Standard Object';

    let html = `<div class="hover-card-title">${escapeHtml(entityName)}</div>`;
    html += `<div class="hover-card-sub">${objectTypeText} &middot; ${fieldCount} fields</div>`;

    if (heatmapToggle.checked) {
        html += '<div class="hover-card-row"><span class="hover-card-label">Records</span><span>' +
            (rc != null ? rc.count.toLocaleString() : 'Unavailable') + '</span></div>';
        if (rc != null && rc.lastModifiedDate) {
            const stale = isStaleRecordInfoForHover(rc);
            const dateText = new Date(rc.lastModifiedDate).toLocaleDateString();
            html += '<div class="hover-card-row"><span></span><span>' +
                (stale ? 'Stale &mdash; ' : '') + 'Last touched ' + dateText + '</span></div>';
        }
    }

    if (sharingViewToggle.checked) {
        html += '<div class="hover-card-row"><span class="hover-card-label">Internal Sharing</span><span>' +
            (sharing && sharing.internalModel ? escapeHtml(sharingBadgeFor(sharing.internalModel)) : 'Unknown') + '</span></div>';
        html += '<div class="hover-card-row"><span class="hover-card-label">External Sharing</span><span>' +
            (sharing && sharing.externalModel ? escapeHtml(sharingBadgeFor(sharing.externalModel)) : 'None configured') + '</span></div>';
    }

    hoverCard.innerHTML = html;
    hoverCard.style.left = (clientX + 12) + 'px';
    hoverCard.style.top = (clientY + 12) + 'px';
    hoverCard.hidden = false;
}

function hideHoverCard() {
    hoverCard.hidden = true;
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
        requestSharingAndHeatmapData();
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

        let hoverTimer = null;
        g.addEventListener('mouseenter', (e) => {
            const clientX = e.clientX;
            const clientY = e.clientY;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => showHoverCard(b.name, b, clientX, clientY), 350);
        });
        g.addEventListener('mouseleave', () => {
            clearTimeout(hoverTimer);
            hideHoverCard();
        });

        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(b.x));
        rect.setAttribute('y', String(b.y));
        rect.setAttribute('width', String(b.width));
        rect.setAttribute('height', String(b.height));
        let bodyFill = 'var(--vscode-editor-background)';
        if (heatmapToggle.checked) {
            const rc = recordCounts[b.name.toLowerCase()];
            if (rc != null) bodyFill = heatColorFor(rc);
        }
        rect.setAttribute('fill', bodyFill);
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

        if (sharingViewToggle.checked) {
            const sm = sharingModels[b.name.toLowerCase()];
            if (sm && sm.internalModel) {
                const badge = document.createElementNS(SVG_NS, 'text');
                badge.setAttribute('x', String(b.x + b.width - 6));
                badge.setAttribute('y', String(b.y - 6));
                badge.setAttribute('text-anchor', 'end');
                badge.setAttribute('font-size', '9');
                badge.setAttribute('fill', 'var(--vscode-descriptionForeground)');
                badge.textContent = sm.internalModel + (sm.externalModel ? ' / ' + sm.externalModel : '');
                g.appendChild(badge);
            }
        }
        if (heatmapToggle.checked) {
            const rc = recordCounts[b.name.toLowerCase()];
            if (rc != null) {
                const badge = document.createElementNS(SVG_NS, 'text');
                badge.setAttribute('x', String(b.x + 6));
                badge.setAttribute('y', String(b.y - 6));
                badge.setAttribute('font-size', '9');
                badge.setAttribute('fill', 'var(--vscode-descriptionForeground)');
                badge.textContent = rc.count.toLocaleString() + ' records';
                g.appendChild(badge);
            }
        }

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
    } else if (msg.type === 'objectList') {
        allObjectNames = msg.names || [];
        renderSuggestions();
    } else if (msg.type === 'entityFields') {
        const key = (msg.entityName || '').toLowerCase();
        objectFieldsCache[key] = msg.fields || [];
        delete objectFieldsFetching[key];
        // Re-check now that this entity's fields have arrived — so a
        // context that was waiting on this data updates automatically
        // rather than requiring another keystroke to see it, matching
        // the LWC's own re-render-after-fetch behavior.
        updateDslSuggestions();
    } else if (msg.type === 'dictionaryRow') {
        if (msg.row && msg.row.apiName === dictionarySelectedObject) {
            dictionaryRow = msg.row;
            renderDictionaryTable();
        }
    } else if (msg.type === 'dictionaryError') {
        if (dictionarySelectedObject) {
            dictionaryDetailTitle.textContent = msg.message || 'Could not load this object.';
        }
    } else if (msg.type === 'fieldUsageStats') {
        dictionaryUsagePending = false;
        if (dictionaryRow && msg.entityName === dictionaryRow.apiName) {
            const pct = (msg.stats && msg.stats.percentages) || {};
            dictionaryRow = {
                ...dictionaryRow,
                fields: dictionaryRow.fields.map((f) => ({
                    ...f,
                    percentUsed: f.isPrimaryKey ? 100 : (pct[f.apiName] != null ? pct[f.apiName] : f.percentUsed)
                }))
            };
            renderDictionaryTable();
            if (msg.stats && msg.stats.error) setStatus(msg.stats.error, true);
        }
    } else if (msg.type === 'sharingModels') {
        sharingModels = {};
        Object.keys(msg.models || {}).forEach((name) => {
            sharingModels[name.toLowerCase()] = msg.models[name];
        });
        scheduleRender();
    } else if (msg.type === 'recordCounts') {
        recordCounts = {};
        Object.keys(msg.counts || {}).forEach((name) => {
            recordCounts[name.toLowerCase()] = msg.counts[name];
        });
        scheduleRender();
    }
}

function setStatus(text, isError) {
    statusText.textContent = text;
    statusText.style.color = isError ? 'var(--vscode-errorForeground)' : '';
}

init();
