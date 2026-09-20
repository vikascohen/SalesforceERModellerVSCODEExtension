// Direct port of diagramStudio.js's detectDslContext(), preserving every
// bug fix already found and verified there (bracket-aware field-list
// splitting, cursor-position-aware "already typed" exclusion) rather than
// re-deriving this logic from scratch and risking reintroducing bugs
// already fixed once. Kept as a pure function — no VS Code API, no
// webview globals — so it can be unit tested the same way the original
// was, and so main.js only has to supply data, not behavior.
//
// deps:
//   allObjectNames: string[] — every object name in the org (for entity-name autocomplete)
//   getCachedFields(entityLower): field[] | undefined — synchronous cache read
//   requestFieldsIfMissing(entityName): void — side effect, triggers an async fetch if not cached; caller decides how (e.g. postMessage)
//   buildFieldMarkerSuffix(field): string — same marker-building logic buildErSource() uses

export function declaredEntityNames(text) {
    const names = [];
    const re = /^\s*entity\s+([A-Za-z0-9_]+)/gim;
    let m;
    while ((m = re.exec(text)) !== null) names.push(m[1]);
    return Array.from(new Set(names));
}

export function detectDslContext(linePrefix, fullText, lineStart, deps) {
    const { allObjectNames, getCachedFields, requestFieldsIfMissing, buildFieldMarkerSuffix, splitFieldList } = deps;
    let m;

    // 1) Partial "entity" keyword at the start of an otherwise-empty line.
    m = linePrefix.match(/^([A-Za-z]{0,6})$/);
    if (m && m[1].length > 0 && 'entity'.startsWith(m[1].toLowerCase())) {
        return {
            replaceStart: lineStart,
            items: [{ id: 'kw-entity', label: 'entity', detail: 'Declare an entity', insertText: 'entity ' }]
        };
    }

    // 2) entity <partial object name>
    m = linePrefix.match(/^entity\s+([A-Za-z0-9_]*)$/i);
    if (m) {
        const partial = m[1].toLowerCase();
        const start = lineStart + m[0].length - m[1].length;
        const items = (allObjectNames || [])
            .filter((n) => n.toLowerCase().startsWith(partial))
            .slice(0, 50)
            .map((n) => ({ id: 'obj-' + n, label: n, detail: 'Object', insertText: n }));
        return { replaceStart: start, items };
    }

    // 3) entity Name : field1[Type], field2, <partial field>
    //
    // Two real bugs already found and fixed here in the original, both
    // preserved: (a) an earlier version assumed every already-typed field
    // was plain [A-Za-z0-9_]+ with no bracket suffix at all, which broke
    // the moment a bracketed field ("FieldName[Type]") existed earlier on
    // the line — fixed with bracket-aware splitting (splitFieldList)
    // instead of a single monolithic regex; (b) "already typed" was
    // computed only from text BEFORE the cursor, so a field sitting AFTER
    // wherever the cursor happened to be was never excluded — fixed by
    // also reading the rest of the line from fullText and folding those
    // fields into the same exclusion set.
    m = linePrefix.match(/^entity\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/i);
    if (m) {
        const entityName = m[1];
        const rawFieldsPortion = m[2];
        const endsWithComma = /,\s*$/.test(rawFieldsPortion);
        const parts = splitFieldList(rawFieldsPortion).map((s) => s.trim()).filter(Boolean);
        const completeParts = endsWithComma ? parts : parts.slice(0, -1);
        const partial = endsWithComma ? '' : (parts.length > 0 ? parts[parts.length - 1] : '');

        if (!/^[A-Za-z0-9_]*$/.test(partial)) return null;

        const start = lineStart + linePrefix.length - partial.length;

        const caret = lineStart + linePrefix.length;
        const restOfLineMatch = fullText.slice(caret).match(/^[^\n]*/);
        const afterCaretText = restOfLineMatch ? restOfLineMatch[0] : '';
        const afterCaretParts = splitFieldList(afterCaretText).map((s) => s.trim()).filter(Boolean);

        const already = new Set(
            completeParts.concat(afterCaretParts).map((s) => s.replace(/\[.*$/, '').toLowerCase())
        );
        const cached = getCachedFields(entityName.toLowerCase());
        requestFieldsIfMissing(entityName);
        const items = (cached || [])
            .filter((f) => f.apiName.toLowerCase().startsWith(partial.toLowerCase()) && !already.has(f.apiName.toLowerCase()))
            .slice(0, 50)
            .map((f) => ({
                id: 'fld-' + f.apiName,
                label: f.apiName,
                detail: f.isRelationship ? 'Lookup field' : 'Field',
                insertText: f.apiName + buildFieldMarkerSuffix(f)
            }));
        return { replaceStart: start, items };
    }

    // 4) Child.<partial field> — relationship source field
    m = linePrefix.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]*)$/);
    if (m) {
        const entityName = m[1];
        const partial = m[2].toLowerCase();
        const start = lineStart + m[0].length - m[2].length;
        const cached = getCachedFields(entityName.toLowerCase());
        requestFieldsIfMissing(entityName);
        const items = (cached || [])
            .filter((f) => f.isRelationship && f.apiName.toLowerCase().startsWith(partial))
            .slice(0, 50)
            .map((f) => {
                const arrow = f.relationshipType === 'Master-Detail' ? '=>' : f.relationshipType === 'Polymorphic Lookup' ? '~>' : '->';
                return {
                    id: 'relfld-' + f.apiName,
                    label: f.apiName,
                    detail: `${f.relationshipType} \u2192 ${f.relatesTo}`,
                    insertText: f.apiName,
                    appendText: ` ${arrow} ${f.relatesTo}`
                };
            });
        return { replaceStart: start, items };
    }

    // 5) Child.Field <partial arrow>
    m = linePrefix.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+([=\-~]{0,2}>?)$/);
    if (m) {
        const typed = m[3];
        const start = lineStart + m[0].length - typed.length;
        const arrows = [
            { arrow: '=>', detail: 'Master-Detail' },
            { arrow: '->', detail: 'Lookup' },
            { arrow: '~>', detail: 'Polymorphic Lookup' }
        ].filter((a) => typed === '' || a.arrow.startsWith(typed));
        const items = arrows.map((a) => ({ id: 'arrow-' + a.arrow, label: a.arrow, detail: a.detail, insertText: a.arrow + ' ' }));
        return { replaceStart: start, items };
    }

    // 6) Child.Field => <partial parent entity>
    m = linePrefix.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*(=>|->|~>)\s*([A-Za-z0-9_]*)$/);
    if (m) {
        const partial = m[4].toLowerCase();
        const start = lineStart + m[0].length - m[4].length;
        const declared = declaredEntityNames(fullText);
        const names = Array.from(new Set([...declared, ...(allObjectNames || [])]));
        const items = names
            .filter((n) => n.toLowerCase().startsWith(partial))
            .slice(0, 50)
            .map((n) => ({ id: 'target-' + n, label: n, detail: declared.includes(n) ? 'On canvas' : 'Object', insertText: n }));
        return { replaceStart: start, items };
    }

    return null;
}
