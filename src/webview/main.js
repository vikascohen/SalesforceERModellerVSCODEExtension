// Runs INSIDE the webview's isolated browser context. Owns the DSL
// editor, the SVG canvas, and all messaging with the extension host
// (acquireVsCodeApi()) for anything needing real filesystem or
// Salesforce CLI access, neither of which a webview can do itself.

import { currentSearchTerm, filterObjectNames, appendNameToInput } from './paletteFilter.js';
import { detectDslContext } from './dslIntellisense.js';
import { buildFieldMarkerSuffix } from './fieldMarkers.js';
import { scanForMissingRelationships } from './relationshipLinter.js';
import { computeSchemaDrift } from './schemaDrift.js';
import { analyseArchitecture, analyseObject, findArchitecturePath, analyseBlastRadius, detectJunctionObjects, analyseDomains } from './architectureIntelligence.js';
import { parseEr, buildErGeometry, buildMermaidErDiagram, buildDrawioXml, splitFieldList } from '../erDiagramLogic.js';

const bootDiagnostic = document.getElementById('bootDiagnostic');
if (bootDiagnostic) bootDiagnostic.textContent = 'ER runtime: bundle executing';
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
const linterPanel = document.getElementById('linterPanel');
const linterTitle = document.getElementById('linterTitle');
const linterList = document.getElementById('linterList');
const linterAddAllBtn = document.getElementById('linterAddAllBtn');
const linterDismissBtn = document.getElementById('linterDismissBtn');
const compareOrgBtn = document.getElementById('compareOrgBtn');
const driftModal = document.getElementById('driftModal');
const driftTitle = document.getElementById('driftTitle');
const driftBody = document.getElementById('driftBody');
const driftCloseBtn = document.getElementById('driftCloseBtn');
const paletteToggleBtn = document.getElementById('paletteToggleBtn');
const objectPalette = document.getElementById('objectPalette');
const paletteSearch = document.getElementById('paletteSearch');
const paletteList = document.getElementById('paletteList');
const openBtn = document.getElementById('openBtn');
const saveBtn = document.getElementById('saveBtn');
const saveAsBtn = document.getElementById('saveAsBtn');
const exportMermaidBtn = document.getElementById('exportMermaidBtn');
const exportDrawioBtn = document.getElementById('exportDrawioBtn');
const focusToggle = document.getElementById('focusToggle');
const zoomOutBtn=document.getElementById('zoomOutBtn'),zoomResetBtn=document.getElementById('zoomResetBtn'),zoomInBtn=document.getElementById('zoomInBtn'),autoLayoutBtn=document.getElementById('autoLayoutBtn');
const mimicBtn=document.getElementById('mimicBtn'),mimicModal=document.getElementById('mimicModal'),mimicCloseBtn=document.getElementById('mimicCloseBtn'),mimicAddObjectBtn=document.getElementById('mimicAddObjectBtn'),mimicGenerateBtn=document.getElementById('mimicGenerateBtn'),mimicModelName=document.getElementById('mimicModelName'),mimicBody=document.getElementById('mimicBody'),mimicError=document.getElementById('mimicError'),exportPngBtn=document.getElementById('exportPngBtn'),dictionaryCsvBtn=document.getElementById('dictionaryCsvBtn'),dictionaryIntelligenceBtn=document.getElementById('dictionaryIntelligenceBtn'),dictionaryIntelligence=document.getElementById('dictionaryIntelligence');
const architectureBtn=document.getElementById('architectureBtn'),architecturePanel=document.getElementById('architecturePanel'),architectureBody=document.getElementById('architectureBody'),architectureCloseBtn=document.getElementById('architectureCloseBtn'),architectureRefreshBtn=document.getElementById('architectureRefreshBtn'),architectureExportBtn=document.getElementById('architectureExportBtn');

let renderTimer = null;
let lastModel = null;
let dirty = false;
let focusedEntity = null;
let erPositions={},boxHeightOverrides={},boxWidthOverrides={},zoomLevel=1,dragState=null,resizeState=null;
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
let sharingSignals = {};

// Smart relationship linter state
let missingRelationshipSuggestions = [];
let dismissedSuggestionKeys = new Set();
let relScanTimer = null;

let driftResults = [];
let architectureAnalysis=null,architectureTab='overview',architectureObject='',architecturePathSource='',architecturePathTarget='',architectureDomainAssignments={};
let mimicObjects=[],mimicSeq=0;

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
    if (bootDiagnostic) bootDiagnostic.textContent = 'ER runtime: init started';
    // window.__LOGIC_URI__ is set by an inline script in index.html --
    // a webview's asWebviewUri() result isn't known until the extension
    // host renders the HTML, so a static import path can't reference it;
    // this loads it as a dynamic import instead.

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
    mimicBtn.addEventListener('click',openMimic); mimicCloseBtn.addEventListener('click',closeMimic); mimicAddObjectBtn.addEventListener('click',()=>{mimicAddObject();renderMimic();}); mimicGenerateBtn.addEventListener('click',generateMimic);
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
    dictionaryCsvBtn.addEventListener('click', exportDictionaryToCsv); dictionaryIntelligenceBtn.addEventListener('click',()=>{dictionaryIntelligence.hidden=!dictionaryIntelligence.hidden;renderDictionaryIntelligence();});
    heatmapToggle.addEventListener('change', () => { requestSharingAndHeatmapData(true); scheduleRender(); });
    sharingViewToggle.addEventListener('change', () => { requestSharingAndHeatmapData(true); scheduleRender(); });
    linterAddAllBtn.addEventListener('click', handleAddAllSuggestions);
    linterDismissBtn.addEventListener('click', handleDismissSuggestions);
    compareOrgBtn.addEventListener('click', openDriftCheck);
    architectureBtn.addEventListener('click',openArchitecture); architectureExportBtn.addEventListener('click',exportArchitectureReport); architectureCloseBtn.addEventListener('click',()=>architecturePanel.hidden=true); architectureRefreshBtn.addEventListener('click',refreshArchitecture);
    document.querySelectorAll('[data-arch-tab]').forEach(btn=>btn.addEventListener('click',()=>{architectureTab=btn.dataset.archTab;document.querySelectorAll('[data-arch-tab]').forEach(b=>b.classList.toggle('active',b===btn));renderArchitecture();}));
    driftCloseBtn.addEventListener('click', closeDriftModal);
    paletteToggleBtn.addEventListener('click', togglePalette);
    paletteSearch.addEventListener('input', renderPaletteList);
    canvas.parentElement.addEventListener('dragover', handleCanvasDragOver);
    canvas.parentElement.addEventListener('dragleave', handleCanvasDragLeave);
    canvas.parentElement.addEventListener('drop', handleCanvasDrop);
    saveBtn.addEventListener('click', doSave);
    saveAsBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestSaveAs', text: editor.value }));
    exportMermaidBtn.addEventListener('click', doExportMermaid);
    exportDrawioBtn.addEventListener('click', doExportDrawio);
    exportPngBtn.addEventListener('click', doExportPng);
    focusToggle.addEventListener('change', () => { focusedEntity = null; render(); });
    zoomOutBtn.addEventListener('click',()=>setZoom(zoomLevel-0.1)); zoomInBtn.addEventListener('click',()=>setZoom(zoomLevel+0.1)); zoomResetBtn.addEventListener('click',()=>setZoom(1));
    autoLayoutBtn.addEventListener('click',()=>{erPositions={};boxHeightOverrides={};boxWidthOverrides={};render();});
    canvas.addEventListener('click', onCanvasClick);
    window.addEventListener('pointermove',(e)=>{if(dragState){const p=svgPoint(e);erPositions[dragState.name]={x:Math.max(0,p.x-dragState.dx),y:Math.max(0,p.y-dragState.dy)};render();}else if(resizeState){const p=svgPoint(e);boxWidthOverrides[resizeState.name]=Math.max(160,resizeState.w+(p.x-resizeState.x));boxHeightOverrides[resizeState.name]=Math.max(70,resizeState.h+(p.y-resizeState.y));render();}});
    window.addEventListener('pointerup',()=>{dragState=null;resizeState=null;});

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


function archEsc(v){return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function openArchitecture(){architecturePanel.hidden=false;refreshArchitecture();}
function refreshArchitecture(){try{architectureAnalysis=analyseArchitecture(parseEr(editor.value||''));const n=architectureAnalysis.nodes;if(!architectureObject&&n.length)architectureObject=n[0].name;if(!architecturePathSource&&n.length)architecturePathSource=n[0].name;if(!architecturePathTarget&&n.length>1)architecturePathTarget=n[1].name;renderArchitecture();}catch(e){architectureAnalysis=null;architectureBody.innerHTML='<div class="arch-card"><strong>Analysis unavailable</strong><div class="arch-muted">'+archEsc(e.message||e)+'</div></div>';}}
function archOptions(s){return(architectureAnalysis?.nodes||[]).map(n=>'<option value="'+archEsc(n.name)+'"'+(n.name===s?' selected':'')+'>'+archEsc(n.name)+'</option>').join('');}
function renderArchitecture(){const a=architectureAnalysis;if(!a)return;
 if(architectureTab==='overview'){const metrics=[['Objects',a.entityCount],['Fields',a.fieldCount],['Relationships',a.relationshipCount],['Components',a.componentCount],['Max depth',a.maxRelationshipDepth],['Density',a.relationshipDensity],['Custom objects',a.customObjectCount],['Cycles',a.cycles.length]];architectureBody.innerHTML='<div class="arch-metrics">'+metrics.map(x=>'<div class="arch-metric"><div class="arch-muted">'+x[0]+'</div><div class="arch-metric-value">'+x[1]+'</div></div>').join('')+'</div><div class="arch-grid"><div class="arch-card"><strong>Most connected</strong><ul class="arch-list">'+a.mostConnected.map(n=>'<li>'+archEsc(n.name)+' · '+n.degree+' relationships</li>').join('')+'</ul></div><div class="arch-card"><strong>Isolated objects</strong><ul class="arch-list">'+(a.islands.length?a.islands.map(n=>'<li>'+archEsc(n.name)+'</li>').join(''):'<li>None</li>')+'</ul></div><div class="arch-card"><strong>Architecture observations</strong><ul class="arch-list">'+(a.observations.length?a.observations.map(o=>'<li><strong>'+archEsc(o.title)+'</strong>: '+archEsc(o.detail)+'</li>').join(''):'<li>None</li>')+'</ul></div><div class="arch-card"><strong>Relationship mix</strong><div>Lookup: '+a.lookupCount+'</div><div>Master Detail: '+a.masterDetailCount+'</div><div>Polymorphic: '+a.polymorphicCount+'</div><div>Parallel: '+a.parallelRelationshipCount+'</div></div></div>';return;}
 if(architectureTab==='object'||architectureTab==='usage'){const d=analyseObject(a,architectureObject),b=analyseBlastRadius(a,architectureObject,3);architectureBody.innerHTML='<div class="arch-controls">Object <select id="archObject">'+archOptions(architectureObject)+'</select></div>'+(d?'<div class="arch-metrics"><div class="arch-metric"><div class="arch-muted">Role</div>'+archEsc(d.role)+'</div><div class="arch-metric"><div class="arch-muted">Incoming</div><div class="arch-metric-value">'+d.incoming+'</div></div><div class="arch-metric"><div class="arch-muted">Outgoing</div><div class="arch-metric-value">'+d.outgoing+'</div></div><div class="arch-metric"><div class="arch-muted">Reach within 3 hops</div><div class="arch-metric-value">'+d.reachableWithin3+'</div></div></div><div class="arch-grid"><div class="arch-card"><strong>Depends on</strong><ul class="arch-list">'+(d.parents.length?d.parents.map(x=>'<li>'+archEsc(x.name)+' via '+archEsc(x.field||x.kind)+'</li>').join(''):'<li>None represented</li>')+'</ul></div><div class="arch-card"><strong>Depended on by</strong><ul class="arch-list">'+(d.children.length?d.children.map(x=>'<li>'+archEsc(x.name)+' via '+archEsc(x.field||x.kind)+'</li>').join(''):'<li>None represented</li>')+'</ul></div><div class="arch-card"><strong>Change impact / blast radius</strong><div>'+b.total+' object(s) reachable within '+b.maxDepth+' hops.</div><div class="arch-muted">Structural evidence, not a prediction that every reachable object will break.</div></div><div class="arch-card"><strong>Cycles</strong><ul class="arch-list">'+(d.cycles.length?d.cycles.map(x=>'<li>'+archEsc(x.join(' → '))+'</li>').join(''):'<li>None detected</li>')+'</ul></div></div>':'');document.getElementById('archObject')?.addEventListener('change',e=>{architectureObject=e.target.value;renderArchitecture();});return;}
 if(architectureTab==='path'){const p=findArchitecturePath(a,architecturePathSource,architecturePathTarget);architectureBody.innerHTML='<div class="arch-controls">From <select id="archFrom">'+archOptions(architecturePathSource)+'</select> To <select id="archTo">'+archOptions(architecturePathTarget)+'</select></div><div class="arch-card">'+(p?.found?'<strong>'+p.hops+' hop'+(p.hops===1?'':'s')+'</strong><div>'+p.path.map(archEsc).join(' → ')+'</div>':'No structural path found.')+'</div>';document.getElementById('archFrom')?.addEventListener('change',e=>{architecturePathSource=e.target.value;renderArchitecture();});document.getElementById('archTo')?.addEventListener('change',e=>{architecturePathTarget=e.target.value;renderArchitecture();});return;}
 if(architectureTab==='junctions'){const j=detectJunctionObjects(a);architectureBody.innerHTML='<div class="arch-card"><strong>Junction candidates</strong><div class="arch-muted">Strong patterns have multiple distinct Master Detail parents. This is structural evidence, not business intent.</div><table class="arch-table"><tr><th>Object</th><th>Pattern</th><th>Parents</th></tr>'+j.map(x=>'<tr><td>'+archEsc(x.name)+'</td><td>'+archEsc(x.pattern)+'</td><td>'+archEsc((x.parents||[]).map(p=>p.name||p).join(', '))+'</td></tr>').join('')+'</table></div>';return;}
 if(architectureTab==='relationships'){architectureBody.innerHTML='<div class="arch-card"><strong>Relationship detail</strong><div class="arch-muted">Self relationships are omitted from this interpretation view.</div><table class="arch-table"><tr><th>Child</th><th>Field</th><th>Type</th><th>Parent</th></tr>'+a.relationships.filter(x=>x.childEntity.toLowerCase()!==x.parentEntity.toLowerCase()).map(x=>'<tr><td>'+archEsc(x.childEntity)+'</td><td>'+archEsc(x.childField||'')+'</td><td>'+archEsc(x.kind||'relationship')+'</td><td>'+archEsc(x.parentEntity)+'</td></tr>').join('')+'</table></div>';}
 if(architectureTab==='domains'){const d=analyseDomains(a,architectureDomainAssignments);architectureBody.innerHTML='<div class="arch-card"><strong>Architecture Domains</strong><div class="arch-muted">Assign business domains explicitly. The engine does not guess them from object names.</div><table class="arch-table"><tr><th>Object</th><th>Domain</th></tr>'+a.nodes.map(n=>'<tr><td>'+archEsc(n.name)+'</td><td><input class="domain-input" data-domain-object="'+archEsc(n.name)+'" value="'+archEsc(architectureDomainAssignments[n.name]||'')+'" placeholder="Unassigned"></td></tr>').join('')+'</table></div><div class="arch-card" style="margin-top:10px"><strong>Cross-domain coupling</strong><table class="arch-table"><tr><th>Domain A</th><th>Domain B</th><th>Relationships</th></tr>'+d.couplings.map(x=>'<tr><td>'+archEsc(x.domainA)+'</td><td>'+archEsc(x.domainB)+'</td><td>'+x.relationshipCount+'</td></tr>').join('')+'</table><div class="arch-muted">'+d.unassigned.length+' object(s) unassigned.</div></div>';architectureBody.querySelectorAll('[data-domain-object]').forEach(el=>el.addEventListener('change',e=>{architectureDomainAssignments[e.target.dataset.domainObject]=e.target.value.trim();renderArchitecture();}));return;}

}


const MIMIC_TYPES=['Text','Text Area','Long Text Area','Number','Currency','Percent','Checkbox','Date','DateTime','Email','Phone','URL','Picklist','Multi Select Picklist','Auto Number','Formula','Lookup','Master Detail','Polymorphic'];
function mimicBase(v){return String(v||'').split('__')[0].replace(/_c$/i,'').replace(/_+$/g,'').replace(/[^A-Za-z0-9_]/g,'');}
function mimicApi(v){const b=mimicBase(v);return b?b+'__c':'';}
function mimicAddObject(){const id='mo'+(++mimicSeq);mimicObjects.push({id,name:'',fields:[{id:id+'id',name:'Id',type:'Id',locked:true,target:''},{id:id+'f1',name:'Name',type:'Text',locked:false,target:''}]});}
function openMimic(){mimicObjects=[];mimicSeq=0;mimicModelName.value='Mimicked Model';mimicError.textContent='';mimicAddObject();mimicModal.hidden=false;renderMimic();}
function closeMimic(){mimicModal.hidden=true;mimicObjects=[];}
function renderMimic(){mimicBody.innerHTML='';mimicObjects.forEach(o=>{const card=document.createElement('div');card.className='mimic-card';const head=document.createElement('div');head.className='mimic-object-head';head.innerHTML='<input value="'+archEsc(o.name)+'" placeholder="Object name"><span class="mimic-api">'+archEsc(mimicApi(o.name)||'Object__c')+'</span><button>Remove</button>';const inp=head.querySelector('input');inp.addEventListener('input',e=>{o.name=mimicBase(e.target.value);e.target.value=o.name;renderMimic();});head.querySelector('button').addEventListener('click',()=>{mimicObjects=mimicObjects.filter(x=>x.id!==o.id);mimicObjects.forEach(x=>x.fields.forEach(f=>{if(f.target===o.id){f.target='';f.type='Text';}}));renderMimic();});card.appendChild(head);o.fields.forEach(field=>{const row=document.createElement('div');row.className='mimic-field';const name=document.createElement('input');name.value=field.name;name.disabled=field.locked;name.placeholder='Field name';name.addEventListener('input',e=>{field.name=mimicBase(e.target.value);e.target.value=field.name;});row.appendChild(name);const type=document.createElement('select');(field.locked?['Id']:MIMIC_TYPES).forEach(t=>{const op=document.createElement('option');op.value=t;op.textContent=t;op.selected=t===field.type;type.appendChild(op);});type.disabled=field.locked;type.addEventListener('change',e=>{field.type=e.target.value;if(['Lookup','Master Detail','Polymorphic'].includes(field.type)){const targets=mimicObjects.filter(x=>x.id!==o.id);field.target=targets[0]?.id||'';}else field.target='';renderMimic();});row.appendChild(type);if(['Lookup','Master Detail','Polymorphic'].includes(field.type)){const target=document.createElement('select');mimicObjects.filter(x=>x.id!==o.id).forEach(t=>{const op=document.createElement('option');op.value=t.id;op.textContent=mimicApi(t.name)||'Unnamed object';op.selected=t.id===field.target;target.appendChild(op);});target.addEventListener('change',e=>field.target=e.target.value);row.appendChild(target);}if(!field.locked){const rm=document.createElement('button');rm.textContent='Remove';rm.addEventListener('click',()=>{o.fields=o.fields.filter(x=>x.id!==field.id);renderMimic();});row.appendChild(rm);}card.appendChild(row);});const add=document.createElement('button');add.textContent='Add Field';add.addEventListener('click',()=>{o.fields.push({id:o.id+'f'+(++mimicSeq),name:'',type:'Text',locked:false,target:''});renderMimic();});card.appendChild(add);mimicBody.appendChild(card);});}
function generateMimic(){const objs=mimicObjects.filter(o=>mimicBase(o.name));if(!objs.length){mimicError.textContent='Mimic New ER needs at least one named object.';return;}const names=new Set(objs.map(o=>mimicApi(o.name).toLowerCase()));if(names.size!==objs.length){mimicError.textContent='Object names must be unique.';return;}const byId=new Map(objs.map(o=>[o.id,o])),lines=[];for(const o of objs)for(const f of o.fields)if(['Lookup','Master Detail','Polymorphic'].includes(f.type)&&(!f.target||!byId.has(f.target))){mimicError.textContent='Choose a target for '+(mimicApi(f.name)||'relationship field')+' on '+mimicApi(o.name)+'.';return;}objs.forEach(o=>{const fs=o.fields.filter(f=>!f.locked&&mimicBase(f.name)&&!['Lookup','Master Detail','Polymorphic'].includes(f.type)).map(f=>mimicApi(f.name)+(f.type!=='Text'?' ['+f.type+']':''));lines.push('entity '+mimicApi(o.name)+(fs.length?' : '+fs.join(', '):''));});objs.forEach(o=>o.fields.filter(f=>!f.locked&&mimicBase(f.name)&&['Lookup','Master Detail','Polymorphic'].includes(f.type)).forEach(f=>{const t=byId.get(f.target),op=f.type==='Master Detail'?'=>':f.type==='Polymorphic'?'~>':'->';lines.push(mimicApi(o.name)+'.'+mimicApi(f.name)+' '+op+' '+mimicApi(t.name));}));editor.value=lines.join('\n');markDirty();render();closeMimic();setStatus('Mimic New ER generated '+objs.length+' custom object'+(objs.length===1?'':'s')+'.');}
function doExportPng(){if(!lastModel){setStatus('Nothing to export yet.',true);return;}const clone=canvas.cloneNode(true);clone.setAttribute('xmlns','http://www.w3.org/2000/svg');const xml=new XMLSerializer().serializeToString(clone);const img=new Image();const blob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob);img.onload=()=>{const out=document.createElement('canvas');out.width=Math.max(1,Number(canvas.getAttribute('width'))||800);out.height=Math.max(1,Number(canvas.getAttribute('height'))||600);const ctx=out.getContext('2d');ctx.fillStyle=getComputedStyle(document.body).backgroundColor||'#ffffff';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(img,0,0);URL.revokeObjectURL(url);vscode.postMessage({type:'exportPngToFile',dataUrl:out.toDataURL('image/png')});};img.onerror=()=>{URL.revokeObjectURL(url);setStatus('PNG export failed.',true);};img.src=url;}

function normaliseDictToken(v){return String(v||'').replace(/__c$/i,'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[^a-zA-Z0-9]+/g,' ').toLowerCase().trim();}
function renderDictionaryIntelligence(){if(!dictionaryRow||dictionaryIntelligence.hidden)return;const fs=dictionaryRow.fields.filter(f=>!f.isPrimaryKey),custom=fs.filter(f=>f.isCustom),rel=fs.filter(f=>f.isRelationship),derived=fs.filter(f=>String(f.dataType||'').startsWith('Formula')||f.isRollupSummary),documented=custom.filter(f=>(f.description||'').trim());const typeMap=new Map(),targetMap=new Map(),families=new Map(),stop=new Set(['id','is','has','the','and','field','value','date','number','type','name']);fs.forEach(f=>{const t=f.friendlyType||f.dataType||'Other';typeMap.set(t,(typeMap.get(t)||0)+1);if(f.isRelationship&&f.relatesTo)String(f.relatesTo).split(',').map(x=>x.trim()).filter(Boolean).forEach(x=>targetMap.set(x,(targetMap.get(x)||0)+1));const toks=new Set((normaliseDictToken(f.apiName)+' '+normaliseDictToken(f.label)).split(/\s+/).filter(x=>x.length>2&&!stop.has(x)));toks.forEach(x=>{if(!families.has(x))families.set(x,[]);families.get(x).push(f.apiName);});});const fam=[...families.entries()].filter(([,v])=>v.length>=2).sort((a,b)=>b[1].length-a[1].length).slice(0,12);const usage=dictionaryRow.fields.filter(f=>!f.isPrimaryKey&&f.percentUsed!=null);dictionaryIntelligence.innerHTML='<strong>Field Intelligence</strong><div class="arch-muted">Metadata evidence only. Similar names and low population are review signals, not proof a field is redundant.</div><div class="dict-metrics"><div class="dict-metric">Business fields<br><strong>'+fs.length+'</strong></div><div class="dict-metric">Custom<br><strong>'+custom.length+'</strong></div><div class="dict-metric">Relationships<br><strong>'+rel.length+'</strong></div><div class="dict-metric">Derived<br><strong>'+derived.length+'</strong></div><div class="dict-metric">Custom documented<br><strong>'+(custom.length?Math.round(documented.length/custom.length*100)+'%':'—')+'</strong></div></div><div class="dict-section"><strong>Field type landscape</strong><div>'+[...typeMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(x=>'<span class="dict-chip">'+archEsc(x[0])+' '+x[1]+'</span>').join('')+'</div></div><div class="dict-section"><strong>Relationship concentration</strong><div>'+([...targetMap.entries()].length?[...targetMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(x=>'<span class="dict-chip">'+archEsc(x[0])+' '+x[1]+'</span>').join(''):'None')+'</div></div><div class="dict-section"><strong>Field families</strong><div>'+(fam.length?fam.map(x=>'<span class="dict-chip" title="'+archEsc(x[1].join(', '))+'">'+archEsc(x[0])+' '+x[1].length+'</span>').join(''):'No repeated naming families detected')+'</div></div>'+(usage.length?'<div class="dict-section"><strong>Population evidence</strong><div><span class="dict-chip">0% '+usage.filter(f=>f.percentUsed===0).length+'</span><span class="dict-chip">Below 5% '+usage.filter(f=>f.percentUsed>0&&f.percentUsed<5).length+'</span><span class="dict-chip">90%+ '+usage.filter(f=>f.percentUsed>=90).length+'</span></div></div>':'');}
function exportArchitectureReport(){const a=architectureAnalysis;if(!a)return;const out=document.createElement('canvas'),ctx=out.getContext('2d'),w=1400,h=900;out.width=w;out.height=h;const cs=getComputedStyle(document.body);ctx.fillStyle=cs.backgroundColor||'#1e1e1e';ctx.fillRect(0,0,w,h);ctx.fillStyle=cs.color||'#ffffff';ctx.font='bold 32px sans-serif';ctx.fillText('ER Architecture Intelligence',50,60);ctx.font='16px sans-serif';ctx.fillText('Objects: '+a.entityCount+'   Fields: '+a.fieldCount+'   Relationships: '+a.relationshipCount+'   Components: '+a.componentCount,50,100);ctx.fillText('Max depth: '+a.maxRelationshipDepth+'   Density: '+a.relationshipDensity+'   Cycles: '+a.cycles.length+'   Isolated: '+a.islands.length,50,130);ctx.font='bold 20px sans-serif';ctx.fillText('Most connected',50,185);ctx.font='15px sans-serif';a.mostConnected.slice(0,12).forEach((n,i)=>ctx.fillText((i+1)+'. '+n.name+' · '+n.degree+' relationships',65,220+i*25));ctx.font='bold 20px sans-serif';ctx.fillText('Architecture observations',720,185);ctx.font='15px sans-serif';a.observations.slice(0,12).forEach((o,i)=>{ctx.fillText(o.title,735,220+i*45);ctx.font='13px sans-serif';ctx.fillText(String(o.detail||'').slice(0,80),735,238+i*45);ctx.font='15px sans-serif';});vscode.postMessage({type:'exportPngToFile',dataUrl:out.toDataURL('image/png')});}

function exportDictionaryToCsv(){if(!dictionaryRow)return;const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const rows=[['API Name','Label','Type','Required','Description','Last Modified','% Populated'],...dictionaryRow.fields.map(f=>[f.apiName,f.label||'',f.friendlyType||f.dataType||'',f.required?'Yes':'No',f.description||'',f.lastModifiedDate||'',f.percentUsed==null?'':Math.round(f.percentUsed*10)/10])];vscode.postMessage({type:'exportCsvToFile',text:rows.map(r=>r.map(q).join(',')).join('\r\n'),name:(dictionaryRow.apiName||'DataDictionary')+'.csv'});}

// ── Data Dictionary ──

function openDictionary() {
    dictionaryPanel.hidden = false;
    if (allObjectNames.length === 0) vscode.postMessage({ type: 'requestObjectList' });
    renderDictionaryObjectList();
}

function closeDictionary() {
    dictionaryPanel.hidden = true;
    dictionaryIntelligence.hidden = true;
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
    dictionaryCsvBtn.hidden = false;
    dictionaryIntelligenceBtn.hidden = false;
    renderDictionaryIntelligence();

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

let lastFetchedEntityNamesKey = null; // avoids re-fetching sharing/heatmap data on every keystroke when the entity set hasn't actually changed
let hoverTimer = null; // module-level, not per-box — see drawGeometry's own comment on why

function requestSharingAndHeatmapData(forceFetch) {
    const names = currentEntityNames();
    if (!names.length) return;
    // Real, worth-fixing inefficiency this avoids: render() runs on every
    // keystroke (debounced), so without this check, editing an existing
    // field's marker or fixing a typo would re-fetch sharing/heatmap data
    // for every entity on canvas every time, even though the entity SET
    // itself never changed — wasteful given these shell out to the sf
    // CLI once per object. Only re-fetch when the set of names actually
    // differs from what was last fetched (order-independent, via a
    // sorted key). forceFetch is passed true from the toggle change
    // handlers specifically, since turning a toggle off then back on
    // with no DSL change in between would otherwise see an unchanged key
    // and skip the fetch, leaving that toggle showing stale or no data.
    const key = names.slice().sort().join('|');
    if (key === lastFetchedEntityNamesKey && !forceFetch) return;
    lastFetchedEntityNamesKey = key;

    if (sharingViewToggle.checked) {
        vscode.postMessage({ type: 'requestSharingModels', entityNames: names });
        vscode.postMessage({ type: 'requestSharingSignals', entityNames: names });
    }
    if (heatmapToggle.checked) {
        vscode.postMessage({ type: 'requestRecordCounts', entityNames: names });
    }
}

// ── Object summary hover card ──
// Ported from the LWC's own sharingBadgeFor/showHoverCard.

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

        // Reliable for any object: RowCause = 'Rule' means a sharing rule
        // has fired. Apex Managed Sharing is only reliably distinguishable
        // from plain manual sharing on a CUSTOM object — standard objects
        // can't define their own Apex Sharing Reason at all, so this must
        // say "not determinable" there rather than a definite Yes/No,
        // which would be actively misleading, not just incomplete.
        const signals = sharingSignals[key];
        if (signals && signals.shareTableAvailable) {
            html += '<div class="hover-card-row"><span class="hover-card-label">Sharing Rules</span><span>' +
                (signals.hasSharingRule ? 'Yes' : 'No') + '</span></div>';
            const apexSharingText = signals.isCustomObject
                ? (signals.hasApexSharing ? 'Yes' : 'No')
                : 'Not determinable on standard objects';
            html += '<div class="hover-card-row"><span class="hover-card-label">Apex Sharing</span><span>' +
                escapeHtml(apexSharingText) + '</span></div>';
        } else if (signals) {
            html += '<div class="hover-card-row"><span class="hover-card-label">Sharing Rules / Apex Sharing</span><span>No sharing data for this object</span></div>';
        }
    }

    hoverCard.innerHTML = html;
    hoverCard.style.left = (clientX + 12) + 'px';
    hoverCard.style.top = (clientY + 12) + 'px';
    hoverCard.hidden = false;
}

function hideHoverCard() {
    hoverCard.hidden = true;
}

// ── Smart relationship linter ──
// Notices relationship fields on entities already on the canvas that
// point at another entity also on the canvas, but aren't wired up as a
// DSL relationship line yet. Ported from the LWC's own
// scheduleRelationshipScan/scanForMissingRelationships.

function scheduleRelationshipScan() {
    clearTimeout(relScanTimer);
    relScanTimer = setTimeout(runRelationshipScan, 600);
}

async function runRelationshipScan() {
    const names = currentEntityNames();
    if (!names.length) {
        missingRelationshipSuggestions = [];
        renderLinterPanel();
        return;
    }

    // Reuses the same on-demand field cache and fetch mechanism the DSL
    // intellisense already uses — a no-op for anything already cached.
    names.forEach((n) => requestFieldsForEntity(n));

    let model;
    try {
        model = parseEr(editor.value);
    } catch (e) {
        return; // mid-typing / invalid DSL — leave whatever was showing
    }

    missingRelationshipSuggestions = scanForMissingRelationships(
        model, names, objectFieldsCache, dismissedSuggestionKeys
    );
    renderLinterPanel();
}

function renderLinterPanel() {
    if (!missingRelationshipSuggestions.length) {
        linterPanel.hidden = true;
        return;
    }
    linterPanel.hidden = false;
    linterTitle.textContent = `${missingRelationshipSuggestions.length} relationship${missingRelationshipSuggestions.length === 1 ? '' : 's'} not wired up`;
    linterList.innerHTML = '';
    missingRelationshipSuggestions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'linter-item';
        const label = document.createElement('span');
        label.textContent = s.line;
        label.style.flex = '1';
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add';
        addBtn.addEventListener('click', () => appendDslLines([s.line]));
        item.appendChild(label);
        item.appendChild(addBtn);
        linterList.appendChild(item);
    });
}

function appendDslLines(lines) {
    const trimmed = editor.value.replace(/\s+$/, '');
    editor.value = (trimmed ? trimmed + '\n' : '') + lines.join('\n') + '\n';
    markDirty();
    scheduleRender();
}

function handleAddAllSuggestions() {
    appendDslLines(missingRelationshipSuggestions.map((s) => s.line));
}

function handleDismissSuggestions() {
    missingRelationshipSuggestions.forEach((s) => dismissedSuggestionKeys.add(s.id));
    missingRelationshipSuggestions = [];
    renderLinterPanel();
}

// ── Compare with Org / schema drift ──
// Direct port of the LWC's handleOpenDriftCheck/checkSchemaDrift.

function openDriftCheck() {
    driftModal.hidden = false;
    driftTitle.textContent = 'Comparing with org\u2026';
    driftBody.innerHTML = '';
    driftResults = [];
    runSchemaDriftCheck();
}

function closeDriftModal() {
    driftModal.hidden = true;
}

function runSchemaDriftCheck() {
    let model;
    try {
        model = parseEr(editor.value);
    } catch (e) {
        driftModal.hidden = true;
        setStatus(e.message || String(e), true);
        return;
    }
    const names = model.entities.map((e) => e.name);
    if (!names.length) {
        driftTitle.textContent = 'Nothing on the canvas to compare';
        return;
    }
    vscode.postMessage({ type: 'requestSchemaDrift', entityNames: names });
}

function renderDriftModal() {
    if (!driftResults.length) {
        driftTitle.textContent = 'No drift found \u2014 everything matches the org';
        driftBody.innerHTML = '';
        return;
    }
    driftTitle.textContent = `Schema drift found in ${driftResults.length} entit${driftResults.length === 1 ? 'y' : 'ies'}`;
    driftBody.innerHTML = '';
    driftResults.forEach((result) => {
        const block = document.createElement('div');
        block.className = 'drift-entity-block';
        const name = document.createElement('div');
        name.className = 'drift-entity-name';
        name.textContent = result.entityName;
        block.appendChild(name);

        if (result.newFields.length) {
            const addAllRow = document.createElement('div');
            addAllRow.className = 'drift-field-row';
            const addAllBtn = document.createElement('button');
            addAllBtn.textContent = `Add All ${result.newFields.length} New Field${result.newFields.length === 1 ? '' : 's'}`;
            addAllBtn.addEventListener('click', () => addAllDriftFields(result.entityName));
            addAllRow.appendChild(addAllBtn);
            block.appendChild(addAllRow);

            result.newFields.forEach((f) => {
                const row = document.createElement('div');
                row.className = 'drift-field-row';
                const label = document.createElement('span');
                label.className = 'drift-new-label';
                label.style.flex = '1';
                label.textContent = '+ ' + f.name + ' (in org, not in diagram)';
                const addBtn = document.createElement('button');
                addBtn.textContent = 'Add';
                addBtn.addEventListener('click', () => addDriftField(result.entityName, f.name, f.markerSuffix));
                row.appendChild(label);
                row.appendChild(addBtn);
                block.appendChild(row);
            });
        }

        result.missingFields.forEach((f) => {
            const row = document.createElement('div');
            row.className = 'drift-field-row';
            const label = document.createElement('span');
            label.className = 'drift-missing-label';
            label.textContent = '\u2013 ' + f.name + ' (in diagram, no longer in org)';
            row.appendChild(label);
            block.appendChild(row);
        });

        driftBody.appendChild(block);
    });
}

function addFieldToEntityLine(entityName, fieldName, markerSuffix) {
    const lines = editor.value.split('\n');
    const re = new RegExp('^(\\s*entity\\s+' + entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*)(.*)$', 'i');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
            const fieldsPortion = m[2].replace(/\s+$/, '');
            const sep = fieldsPortion ? ', ' : '';
            lines[i] = m[1] + fieldsPortion + sep + fieldName + markerSuffix;
            break;
        }
    }
    editor.value = lines.join('\n');
    markDirty();
    scheduleRender();
}

function addDriftField(entityName, fieldName, markerSuffix) {
    addFieldToEntityLine(entityName, fieldName, markerSuffix);
    driftResults = driftResults
        .map((r) => (r.entityName === entityName ? { ...r, newFields: r.newFields.filter((f) => f.name !== fieldName) } : r))
        .filter((r) => r.newFields.length || r.missingFields.length);
    renderDriftModal();
}

function addAllDriftFields(entityName) {
    const result = driftResults.find((r) => r.entityName === entityName);
    if (!result) return;
    result.newFields.forEach((f) => addFieldToEntityLine(entityName, f.name, f.markerSuffix));
    driftResults = driftResults
        .map((r) => (r.entityName === entityName ? { ...r, newFields: [] } : r))
        .filter((r) => r.newFields.length || r.missingFields.length);
    renderDriftModal();
}

// ── Object palette (drag-and-drop) ──
// Direct port of the LWC's handlePaletteDragStart/handleCanvasDrop, one
// deliberate simplification: the original also tracks a manual x/y drop
// position per entity (erPositions), overriding the geometry engine's
// automatic layout for that one entity. This port's canvas is always
// auto-laid-out (no manual position tracking exists anywhere else in
// this port either), so a drop just adds the entity via the same
// importFromOrg message Import from Org already uses, letting the
// geometry engine place it — not a missing feature, a consistent choice
// given nothing else here overrides the auto layout.

function togglePalette() {
    objectPalette.hidden = !objectPalette.hidden;
    if (!objectPalette.hidden) {
        if (allObjectNames.length === 0) vscode.postMessage({ type: 'requestObjectList' });
        renderPaletteList();
    }
}

function renderPaletteList() {
    const term = paletteSearch.value.trim().toLowerCase();
    const matches = term ? allObjectNames.filter((n) => n.toLowerCase().includes(term)) : allObjectNames;
    paletteList.innerHTML = '';
    matches.slice(0, 300).forEach((name) => {
        const item = document.createElement('div');
        item.className = 'palette-item';
        item.textContent = name;
        item.draggable = true;
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', name);
            e.dataTransfer.effectAllowed = 'copy';
        });
        paletteList.appendChild(item);
    });
}

function handleCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.parentElement.classList.add('drag-over');
}

function handleCanvasDragLeave() {
    canvas.parentElement.classList.remove('drag-over');
}

function handleCanvasDrop(e) {
    e.preventDefault();
    canvas.parentElement.classList.remove('drag-over');
    const name = e.dataTransfer.getData('text/plain');
    if (!name) return;
    addEntityByDrop(name);
}

function addEntityByDrop(name) {
    let existingNames = [];
    if (editor.value.trim()) {
        try { existingNames = parseEr(editor.value).entities.map((e) => e.name); } catch (e) { /* mid-typing / invalid DSL */ }
    }
    if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) return; // already on canvas
    vscode.postMessage({ type: 'importFromOrg', names: [name] });
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
    const geo = buildErGeometry(lastModel, erPositions, boxHeightOverrides, boxWidthOverrides);
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
        const geo = buildErGeometry(model, erPositions, boxHeightOverrides, boxWidthOverrides);
        drawGeometry(geo);
        requestSharingAndHeatmapData();
        scheduleRelationshipScan();
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

function setZoom(value){zoomLevel=Math.max(0.4,Math.min(2,Math.round(value*10)/10));zoomResetBtn.textContent=Math.round(zoomLevel*100)+'%';canvas.style.transform='scale('+zoomLevel+')';canvas.style.transformOrigin='0 0';}
function svgPoint(e){const rect=canvas.getBoundingClientRect();return{x:(e.clientX-rect.left)/zoomLevel,y:(e.clientY-rect.top)/zoomLevel};}
function drawGeometry(geo) {
    // Real bug this avoids, found during review rather than reported:
    // scheduleRender's debounce (300ms) is shorter than the hover show
    // delay (350ms). Hover a box, then type within that 300ms window,
    // and the OLD box's pending hover timer — a per-box closure — would
    // still fire after this re-render replaces canvas.innerHTML, calling
    // showHoverCard for an element that no longer exists in the DOM.
    // Worse, since that element is detached, its own mouseleave can
    // never fire to dismiss the card afterward — a hover card that
    // shows up and then never goes away. Clearing any pending timer here
    // — module-level, not per-box, since only one hover can ever be
    // pending at a time regardless — invalidates it before it can fire
    // against a stale element.
    clearTimeout(hoverTimer);
    hoverTimer = null;

    canvas.setAttribute('width', String(geo.svgWidth));
    canvas.setAttribute('height', String(geo.svgHeight));
    canvas.innerHTML = '';
    setZoom(zoomLevel);

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
        g.style.cursor = 'move';
        g.addEventListener('pointerdown',(e)=>{if(e.target.dataset.resize==='1')return;const p=svgPoint(e);dragState={name:b.name,dx:p.x-b.x,dy:p.y-b.y};g.setPointerCapture?.(e.pointerId);e.preventDefault();});


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

        const handle=document.createElementNS(SVG_NS,'rect');handle.dataset.resize='1';handle.setAttribute('x',String(b.x+b.width-8));handle.setAttribute('y',String(b.y+b.height-8));handle.setAttribute('width','8');handle.setAttribute('height','8');handle.setAttribute('fill','var(--vscode-focusBorder)');handle.style.cursor='nwse-resize';handle.addEventListener('pointerdown',(e)=>{const p=svgPoint(e);resizeState={name:b.name,x:p.x,y:p.y,w:b.width,h:b.height};handle.setPointerCapture?.(e.pointerId);e.stopPropagation();});g.appendChild(handle);
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
    } else if (msg.type === 'sharingSignals') {
        sharingSignals = {};
        Object.keys(msg.signals || {}).forEach((name) => {
            sharingSignals[name.toLowerCase()] = msg.signals[name];
        });
    } else if (msg.type === 'schemaDriftData') {
        // Real, if rare, race this avoids: the extension host describes
        // every entity SEQUENTIALLY, which can take a moment for many
        // entities — if the user closes the modal before this response
        // arrives, applying it anyway would silently reopen the modal
        // they'd already dismissed. Skip a response that arrives after
        // the modal has been closed.
        if (driftModal.hidden) return;
        let model;
        try {
            model = parseEr(editor.value);
        } catch (e) {
            return;
        }
        driftResults = computeSchemaDrift(model, msg.freshByEntityName || {}, buildFieldMarkerSuffix);
        renderDriftModal();
    }
}

function setStatus(text, isError) {
    statusText.textContent = text;
    statusText.style.color = isError ? 'var(--vscode-errorForeground)' : '';
}

init().then(() => { if (bootDiagnostic) { bootDiagnostic.textContent = 'ER runtime: READY'; setTimeout(() => bootDiagnostic.remove(), 2500); } }).catch((e) => { if (bootDiagnostic) bootDiagnostic.textContent = 'ER runtime ERROR: ' + (e && e.message ? e.message : String(e)); console.error(e); });
