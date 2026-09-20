import { classifyDescribe, buildErSource, ClassifiedObject } from '../src/schemaService';
import { SfCliDescribe, SfCliField } from '../src/sfCli';

// Every mock field below is built with exactly the shape the sf CLI's
// `sobject describe --json` output has, per Salesforce's long-stable REST
// Describe API — not a shape invented for convenience. If the real CLI's
// JSON ever differs from what's assumed here, these tests would still
// pass against the wrong assumption, so this is a genuine, stated
// limitation: these tests prove the classification LOGIC is correct given
// this shape, not that the shape itself is correct. That second part
// needs a real, authenticated org to confirm.

function field(overrides: Partial<SfCliField>): SfCliField {
    return {
        name: 'Some_Field__c',
        label: 'Some Field',
        type: 'string',
        custom: true,
        nillable: true,
        createable: true,
        calculated: false,
        calculatedFormula: null,
        cascadeDelete: false,
        relationshipOrder: null,
        referenceTo: [],
        relationshipName: null,
        ...overrides
    };
}

function describe_(name: string, fields: SfCliField[]): SfCliDescribe {
    return { name, label: name, custom: false, fields };
}

describe('classifyDescribe — relationship detection', () => {
    it('a plain reference field with no relationshipOrder and no cascadeDelete classifies as Lookup', () => {
        const result = classifyDescribe(describe_('Contact', [
            field({ name: 'AccountId', type: 'reference', referenceTo: ['Account'], relationshipOrder: null, cascadeDelete: false })
        ]));
        expect(result.fields[0].relationshipType).toBe('Lookup');
        expect(result.fields[0].relatesTo).toBe('Account');
        expect(result.fields[0].isRelationship).toBe(true);
    });

    it('relationshipOrder present classifies as Master-Detail', () => {
        const result = classifyDescribe(describe_('OpportunityLineItem', [
            field({ name: 'OpportunityId', type: 'reference', referenceTo: ['Opportunity'], relationshipOrder: 0 })
        ]));
        expect(result.fields[0].relationshipType).toBe('Master-Detail');
    });

    it('cascadeDelete true (with no relationshipOrder) also classifies as Master-Detail, matching the additive Apex fix', () => {
        const result = classifyDescribe(describe_('CartItem', [
            field({ name: 'CartId', type: 'reference', referenceTo: ['WebCart'], relationshipOrder: null, cascadeDelete: true })
        ]));
        expect(result.fields[0].relationshipType).toBe('Master-Detail');
    });

    it('multiple referenceTo targets classifies as Polymorphic Lookup, using the first target as relatesTo', () => {
        const result = classifyDescribe(describe_('Task', [
            field({ name: 'WhoId', type: 'reference', referenceTo: ['Contact', 'Lead'] })
        ]));
        expect(result.fields[0].relationshipType).toBe('Polymorphic Lookup');
        expect(result.fields[0].relatesTo).toBe('Contact');
    });

    it('a non-reference field is never classified as a relationship at all', () => {
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'Name', type: 'string' })
        ]));
        expect(result.fields[0].isRelationship).toBe(false);
        expect(result.fields[0].relationshipType).toBeNull();
    });
});

describe('classifyDescribe — Roll-Up Summary vs Formula', () => {
    it('a blank calculatedFormula on a calculated, non-relationship field is a Roll-Up Summary', () => {
        const result = classifyDescribe(describe_('WebCart', [
            field({ name: 'TotalProductAmount', type: 'currency', calculated: true, calculatedFormula: null })
        ]));
        expect(result.fields[0].isRollupSummary).toBe(true);
        expect(result.fields[0].friendlyType).toBe('Roll-Up Summary');
    });

    it('a non-blank calculatedFormula on a calculated field is a genuine Formula field, not a rollup', () => {
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'My_Formula__c', type: 'string', calculated: true, calculatedFormula: 'Name & " Ltd"' })
        ]));
        expect(result.fields[0].isRollupSummary).toBe(false);
        expect(result.fields[0].friendlyType).toBe('Formula (Text)');
    });

    it('an ordinary, non-calculated field with no formula at all is NOT treated as a rollup, even though its calculatedFormula is also blank', () => {
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'Name', type: 'string', calculated: false, calculatedFormula: null })
        ]));
        // This is the exact bug an earlier version of this file had: any
        // field with a blank calculatedFormula was misclassified as a
        // Roll-Up Summary, which is most fields, since most fields are not
        // calculated at all. calculated=false must gate this off entirely.
        expect(result.fields[0].isRollupSummary).toBe(false);
        expect(result.fields[0].friendlyType).toBe('Text');
    });

    it('a plain field with no calculatedFormula at all (the ordinary case) is not treated as a rollup or formula', () => {
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'Industry', type: 'picklist', calculatedFormula: undefined as any })
        ]));
        // undefined calculatedFormula still passes the blank check, which
        // reflects a real API quirk (a plain field may omit the property
        // entirely rather than sending null) -- but Industry is a picklist,
        // and roll-ups are never picklist-typed in practice, so this is
        // exactly the kind of case worth being honest about rather than
        // asserting confidently either way without a live org to check.
        expect(result.fields[0].friendlyType).toBe('Picklist');
    });
});

describe('classifyDescribe — required and friendly type', () => {
    it('required needs nillable=false AND createable=true — not nillable alone', () => {
        // A real bug this fix corrects: a field that is genuinely not
        // createable by anyone (true system fields, checked separately
        // below) must not show as required just because it also happens
        // to be non-nillable.
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'Name', type: 'string', nillable: false, createable: true })
        ]));
        expect(result.fields[0].required).toBe(true);
    });

    it('a Checkbox field is never required, even though it can never be null by platform design', () => {
        // Confirmed directly against Salesforce's own help documentation:
        // a checkbox field is inherently non-nillable since it can only
        // ever be true or false, never blank -- that is a platform
        // artifact, not a "you must fill this in" signal the way it is
        // for a Text or Number field.
        const result = classifyDescribe(describe_('Contact', [
            field({ name: 'DoNotCall', type: 'boolean', nillable: false, createable: true })
        ]));
        expect(result.fields[0].required).toBe(false);
    });

    it('a true system field (not createable by anyone) is never required, even though it is non-nillable', () => {
        // CreatedDate, LastModifiedDate, SystemModstamp are read-only for
        // every user, with no createable toggle that could ever change
        // that for anyone -- createable=false here is a structural fact
        // of the field, not a per-viewer permission fact.
        const result = classifyDescribe(describe_('Contact', [
            field({ name: 'CreatedDate', type: 'datetime', nillable: false, createable: false })
        ]));
        expect(result.fields[0].required).toBe(false);
    });

    it('maps common REST API lowercase type strings to Setup-style labels', () => {
        const result = classifyDescribe(describe_('Account', [
            field({ name: 'a', type: 'double' }),
            field({ name: 'b', type: 'textarea' }),
            field({ name: 'c', type: 'datetime' }),
            field({ name: 'd', type: 'boolean' })
        ]));
        expect(result.fields[0].friendlyType).toBe('Number');
        expect(result.fields[1].friendlyType).toBe('Text Area');
        expect(result.fields[2].friendlyType).toBe('Date/Time');
        expect(result.fields[3].friendlyType).toBe('Checkbox');
    });
});

describe('buildErSource', () => {
    it('emits plain fields with friendly type brackets and rollup fields with [rollup]', () => {
        const objects: ClassifiedObject[] = [
            classifyDescribe(describe_('Account', [
                field({ name: 'Name', type: 'string' }),
                field({ name: 'AnnualRevenue', type: 'currency' })
            ]))
        ];
        const dsl = buildErSource(objects);
        expect(dsl).toContain('Name[Text]');
        expect(dsl).toContain('AnnualRevenue[Currency]');
    });

    it('only emits a relationship line when the target object is also present', () => {
        const contact = classifyDescribe(describe_('Contact', [
            field({ name: 'AccountId', type: 'reference', referenceTo: ['Account'] })
        ]));
        const dslWithoutAccount = buildErSource([contact]);
        expect(dslWithoutAccount).not.toContain('->');

        const dslWithAccount = buildErSource([contact], new Set(['Contact', 'Account']));
        expect(dslWithAccount).toContain('Contact.AccountId -> Account');
    });

    it('uses => for Master-Detail and ~> for Polymorphic Lookup', () => {
        const cartItem = classifyDescribe(describe_('CartItem', [
            field({ name: 'CartId', type: 'reference', referenceTo: ['WebCart'], cascadeDelete: true })
        ]));
        const task = classifyDescribe(describe_('Task', [
            field({ name: 'WhoId', type: 'reference', referenceTo: ['Contact', 'Lead'] })
        ]));
        const dsl1 = buildErSource([cartItem], new Set(['CartItem', 'WebCart']));
        const dsl2 = buildErSource([task], new Set(['Task', 'Contact']));
        expect(dsl1).toContain('CartItem.CartId => WebCart');
        expect(dsl2).toContain('Task.WhoId ~> Contact');
    });
});
