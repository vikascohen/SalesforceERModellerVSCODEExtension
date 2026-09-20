// Direct port of the LWC's scanForMissingRelationships() core logic,
// extracted as a pure function: given the parsed model, the entities
// currently on canvas, a per-entity field cache, and a set of
// previously-dismissed suggestion keys, returns relationship-field
// suggestions that aren't wired up as a DSL relationship line yet.
//
// model: { entities, relationships } — parseEr()'s own output shape
// canvasEntityNames: string[] — entity names currently on the canvas
// objectFieldsCache: Record<lowercaseEntityName, field[]>
// dismissedKeys: Set<string> — keys already dismissed by the user

export function scanForMissingRelationships(model, canvasEntityNames, objectFieldsCache, dismissedKeys) {
    const canvasNames = new Set(canvasEntityNames.map((n) => n.toLowerCase()));
    const existing = new Set(
        model.relationships.map((r) =>
            [r.childEntity.toLowerCase(), r.childField.toLowerCase(), r.parentEntity.toLowerCase()].join('|')
        )
    );

    const suggestions = [];
    canvasEntityNames.forEach((entityName) => {
        const fields = objectFieldsCache[entityName.toLowerCase()] || [];
        fields.forEach((f) => {
            if (!f.isRelationship || !f.relatesTo) return;
            if (!canvasNames.has(f.relatesTo.toLowerCase())) return; // target isn't on canvas
            const key = [entityName.toLowerCase(), f.apiName.toLowerCase(), f.relatesTo.toLowerCase()].join('|');
            if (existing.has(key) || dismissedKeys.has(key)) return;
            const arrow = f.relationshipType === 'Master-Detail' ? '=>' : f.relationshipType === 'Polymorphic Lookup' ? '~>' : '->';
            suggestions.push({
                id: key,
                label: `${entityName}.${f.apiName} ${arrow} ${f.relatesTo}`,
                line: `${entityName}.${f.apiName} ${arrow} ${f.relatesTo}`
            });
        });
    });
    return suggestions;
}
