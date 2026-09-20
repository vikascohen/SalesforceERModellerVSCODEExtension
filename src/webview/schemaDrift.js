// Direct port of the LWC's checkSchemaDrift() core comparison logic,
// extracted as a pure function. Given the parsed DSL model and a map of
// entity name (lowercase) -> fresh field list (from a live describe),
// returns which entities have fields in the org not yet in the DSL
// (newFields) and fields in the DSL no longer in the org
// (missingFields) — skipping any entity with no fresh data at all
// (not a real/accessible org object, nothing to compare).
//
// buildFieldMarkerSuffix is passed in rather than imported, matching
// this module's own no-side-effect, no-DOM-dependency design — the
// caller supplies it (fieldMarkers.js in this project).

export function computeSchemaDrift(model, freshByEntityName, buildFieldMarkerSuffix) {
    const results = [];
    model.entities.forEach((ent) => {
        const fresh = freshByEntityName[ent.name.toLowerCase()];
        if (!fresh) return; // not a real/accessible org object — skip quietly

        const dslFieldNames = new Set(ent.fields.map((f) => f.name.toLowerCase()));
        const freshFieldNames = new Set(fresh.map((f) => f.apiName.toLowerCase()));

        const newFields = fresh.filter((f) => !dslFieldNames.has(f.apiName.toLowerCase()));
        const missingFields = ent.fields.filter((f) => !freshFieldNames.has(f.name.toLowerCase()));

        if (newFields.length || missingFields.length) {
            results.push({
                entityName: ent.name,
                // Same marker text buildErSource()/the autocomplete would
                // generate for this exact field — computed here, upfront,
                // while the full field object is still in scope, matching
                // a real bug already found and fixed once in the main
                // project: fields added via Compare with Org landed with
                // no bracket at all, since addFieldToEntity() only ever
                // gets a plain string with no way to look this back up
                // once the field is reduced to just its name.
                newFields: newFields.map((f) => ({
                    id: ent.name + '-new-' + f.apiName,
                    name: f.apiName,
                    markerSuffix: buildFieldMarkerSuffix(f)
                })),
                missingFields: missingFields.map((f) => ({ id: ent.name + '-miss-' + f.name, name: f.name }))
            });
        }
    });
    return results;
}
