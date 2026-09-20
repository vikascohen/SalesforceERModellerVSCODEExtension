// Mirrors buildFieldMarkerSuffix in schemaService.ts (the extension-host
// side) exactly, field for field. Kept as a separate, plain-JS copy
// rather than a shared import, since the webview runs in an isolated
// browser context and cannot import the extension host's TypeScript
// module directly — the same reason the original LWC app's own
// buildFieldMarkerSuffix lives in the UI-layer file (diagramStudio.js),
// not the Apex layer, even though the Apex layer computes the same
// underlying field data.
export function buildFieldMarkerSuffix(f) {
    const markers = [];
    if (f.isRollupSummary) markers.push('rollup');
    else if (f.friendlyType) markers.push(f.friendlyType);
    else if (f.isRelationship && f.relationshipType) markers.push(f.relationshipType);
    if (f.required) markers.push('Required');
    return markers.length ? `[${markers.join(', ')}]` : '';
}
