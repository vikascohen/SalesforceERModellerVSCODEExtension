import { SfCliDescribe, SfCliField } from './sfCli';

// This is the TypeScript equivalent of SchemaMetadataController.cls's
// describeObjectsInternal() classification logic, adapted from Apex's
// Schema.DescribeFieldResult to the sf CLI's --json describe shape. The
// underlying REST Describe API both are built on is the same one, and
// the field names below (relationshipOrder, cascadeDelete, calculatedFormula,
// nillable) are long-stable, documented REST API field names -- not
// renamed or reinterpreted here, deliberately, to stay faithful to the
// exact detection logic already proven correct (including its known,
// documented limitation: some standard/system objects' relationships,
// e.g. Salesforce Commerce's CartItem -> WebCart, cannot be reliably
// classified this way even in the original Apex version — see
// SalesforceERModellerStudio's CONTRIBUTING.md for the full writeup).

export type RelationshipType = 'Master-Detail' | 'Lookup' | 'Polymorphic Lookup' | null;

export interface ClassifiedField {
    apiName: string;
    label: string;
    isCustom: boolean;
    isRelationship: boolean;
    relationshipType: RelationshipType;
    relatesTo: string | null; // single target; polymorphic fields use the first target, matching the original Apex behaviour
    isRollupSummary: boolean;
    friendlyType: string | null; // null for relationship fields -- their type is expressed via relationshipType instead
    required: boolean;
}

export interface ClassifiedObject {
    apiName: string;
    label: string;
    isCustom: boolean;
    fields: ClassifiedField[];
}

function classifyRelationship(field: SfCliField): { isRelationship: boolean; relationshipType: RelationshipType; relatesTo: string | null } {
    if (field.type !== 'reference' || !field.referenceTo || field.referenceTo.length === 0) {
        return { isRelationship: false, relationshipType: null, relatesTo: null };
    }
    if (field.referenceTo.length > 1) {
        // Polymorphic -- same heuristic as the Apex version (refs.size() > 1),
        // deliberately not relying on a `polymorphicForeignKey` flag whose
        // exact presence in the CLI's JSON hasn't been confirmed here.
        return { isRelationship: true, relationshipType: 'Polymorphic Lookup', relatesTo: field.referenceTo[0] };
    }
    const isMasterDetail = field.relationshipOrder !== null || field.cascadeDelete;
    return {
        isRelationship: true,
        relationshipType: isMasterDetail ? 'Master-Detail' : 'Lookup',
        relatesTo: field.referenceTo[0]
    };
}

function isRollupSummaryField(field: SfCliField): boolean {
    // isCalculated() (here: field.calculated) is the REQUIRED first gate --
    // true for BOTH formula fields and roll-up summary fields, false for
    // every ordinary field. Only once that gate passes does a blank
    // calculatedFormula distinguish a roll-up from a genuine formula.
    // Skipping this gate (an earlier version of this file did exactly
    // that) misclassifies every ordinary field with no formula at all --
    // which is most fields -- as a Roll-Up Summary, since they also have
    // a blank calculatedFormula. Caught by a real test, not by inspection.
    if (!field.calculated) return false;
    return !field.calculatedFormula || field.calculatedFormula.trim() === '';
}

// Friendly, Setup-style labels for the REST API's lowercase type strings --
// the TypeScript equivalent of friendlyDataType() in SchemaMetadataController.cls.
// Apex's Schema.DisplayType enum uses UPPERCASE names (STRING, DOUBLE); the
// REST Describe JSON this extension actually receives uses lowercase
// (string, double) -- mapped here against the REST API's own values, not
// the Apex enum's, since that is what is actually being read.
const FRIENDLY_TYPE_MAP: Record<string, string> = {
    string: 'Text',
    textarea: 'Text Area',
    boolean: 'Checkbox',
    double: 'Number',
    int: 'Number',
    currency: 'Currency',
    percent: 'Percent',
    date: 'Date',
    datetime: 'Date/Time',
    time: 'Time',
    email: 'Email',
    phone: 'Phone',
    url: 'URL',
    picklist: 'Picklist',
    multipicklist: 'Picklist (Multi-Select)',
    combobox: 'Picklist',
    id: 'ID',
    base64: 'File/Attachment',
    address: 'Address',
    location: 'Geolocation',
    anyType: 'Any'
};

function friendlyType(field: SfCliField, isRollup: boolean): string {
    const base = FRIENDLY_TYPE_MAP[field.type] || field.label || field.type;
    if (isRollup) return 'Roll-Up Summary';
    // Same gate as isRollupSummaryField() above, applied explicitly here
    // too rather than assumed: a genuinely non-calculated field should
    // never carry a populated calculatedFormula in practice, but this
    // makes that assumption visible instead of silently relied upon.
    if (field.calculated && field.calculatedFormula && field.calculatedFormula.trim() !== '') {
        return `Formula (${base})`;
    }
    return base;
}

export function classifyDescribe(raw: SfCliDescribe): ClassifiedObject {
    const fields: ClassifiedField[] = raw.fields.map((f) => {
        const rel = classifyRelationship(f);
        const isRollup = !rel.isRelationship && isRollupSummaryField(f);
        return {
            apiName: f.name,
            label: f.label,
            isCustom: f.custom,
            isRelationship: rel.isRelationship,
            relationshipType: rel.relationshipType,
            relatesTo: rel.relatesTo,
            isRollupSummary: rel.isRelationship ? false : isRollup,
            friendlyType: rel.isRelationship ? null : friendlyType(f, isRollup),
            // Real bug fix ported over from the Apex version, not the
            // original reasoning: a plain "!f.nillable" here was found to
            // mark every Checkbox field (a checkbox can never be null by
            // platform design, confirmed directly against Salesforce's own
            // help docs on this exact problem) and every true system field
            // (CreatedDate, LastModifiedDate, SystemModstamp -- read-only
            // for every user, with no createable toggle that could ever
            // change that) as required on every single object. Checkboxes
            // are excluded entirely; createable is back as an additional
            // condition, since for these specific system fields it is a
            // structural fact of the field, not a per-viewer permission
            // fact -- see SchemaMetadataController.cls's own comment on
            // this exact fix for the full reasoning and the acknowledged,
            // rarer tradeoff it accepts.
            required: f.type !== 'boolean' && !f.nillable && f.createable
        };
    });

    return {
        apiName: raw.name,
        label: raw.label,
        isCustom: raw.custom,
        fields
    };
}

// Direct TypeScript port of diagramStudio.js's buildErSource() -- pure
// logic, no LWC dependency in the original either, so this is a faithful
// port rather than a reimplementation from scratch.
export function buildErSource(objects: ClassifiedObject[], presentNamesOverride?: Set<string>): string {
    const presentNames = presentNamesOverride || new Set(objects.map((o) => o.apiName));
    const lines: string[] = [];

    objects.forEach((o) => {
        const plain = o.fields
            .filter((f) => !f.isRelationship)
            .map((f) => {
                if (f.isRollupSummary) return `${f.apiName}[rollup]`;
                if (f.friendlyType) return `${f.apiName}[${f.friendlyType}]`;
                return f.apiName;
            });
        lines.push(`entity ${o.apiName} : ${plain.join(', ')}`);
    });

    lines.push('');

    objects.forEach((o) => {
        o.fields
            .filter((f) => f.isRelationship && f.relatesTo && presentNames.has(f.relatesTo))
            .forEach((f) => {
                const arrow = f.relationshipType === 'Master-Detail' ? '=>' : f.relationshipType === 'Polymorphic Lookup' ? '~>' : '->';
                lines.push(`${o.apiName}.${f.apiName} ${arrow} ${f.relatesTo}`);
            });
    });

    return lines.join('\n');
}
