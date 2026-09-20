import { detectDslContext, declaredEntityNames } from '../src/webview/dslIntellisense';
import { buildFieldMarkerSuffix } from '../src/webview/fieldMarkers';
import { splitFieldList } from '../src/erDiagramLogic';

function makeDeps(overrides = {}) {
    const fieldsByEntity = overrides.fieldsByEntity || {};
    return {
        allObjectNames: overrides.allObjectNames || ['Account', 'Contact', 'Order__c'],
        getCachedFields: (entityLower) => fieldsByEntity[entityLower],
        requestFieldsIfMissing: overrides.requestFieldsIfMissing || (() => {}),
        buildFieldMarkerSuffix,
        splitFieldList
    };
}

describe('declaredEntityNames', () => {
    it('extracts every entity name declared anywhere in the text', () => {
        const text = 'entity Account : Name\nentity Contact : LastName\n';
        expect(declaredEntityNames(text)).toEqual(['Account', 'Contact']);
    });

    it('deduplicates repeated declarations', () => {
        const text = 'entity Account : Name\nentity Account : Industry\n';
        expect(declaredEntityNames(text)).toEqual(['Account']);
    });
});

describe('detectDslContext — context 1: "entity" keyword', () => {
    it('suggests the keyword when typing a prefix of it at the start of a line', () => {
        const ctx = detectDslContext('ent', 'ent', 0, makeDeps());
        expect(ctx.items[0].insertText).toBe('entity ');
    });

    it('does not match once something else follows on the line', () => {
        const ctx = detectDslContext('entity Acc', 'entity Acc', 0, makeDeps());
        expect(ctx.items.every((i) => i.id !== 'kw-entity')).toBe(true);
    });
});

describe('detectDslContext — context 2: entity <partial object name>', () => {
    it('suggests matching object names', () => {
        const ctx = detectDslContext('entity Acc', 'entity Acc', 0, makeDeps());
        expect(ctx.items.map((i) => i.label)).toEqual(['Account']);
    });
});

describe('detectDslContext — context 3: entity Name : field list', () => {
    it('suggests fields matching the partial being typed, with the correct marker', () => {
        const deps = makeDeps({
            fieldsByEntity: { account: [{ apiName: 'Industry', isRelationship: false, friendlyType: 'Picklist', required: false, isRollupSummary: false }] }
        });
        const line = 'entity Account : Ind';
        const ctx = detectDslContext(line, line, 0, deps);
        expect(ctx.items[0].insertText).toBe('Industry[Picklist]');
    });

    it('BUG FIX preserved: a bracket-suffixed field earlier on the line does not break detection for a field typed after it', () => {
        const deps = makeDeps({
            fieldsByEntity: { contact: [{ apiName: 'Fax', isRelationship: false, friendlyType: 'Phone', required: false, isRollupSummary: false }] }
        });
        const line = 'entity Contact : LastName[Text], Fa';
        const ctx = detectDslContext(line, line, 0, deps);
        expect(ctx).not.toBeNull();
        expect(ctx.items.map((i) => i.label)).toContain('Fax');
    });

    it('BUG FIX preserved: a field already on the line AFTER the cursor is excluded, even though it would otherwise match the prefix', () => {
        const deps = makeDeps({
            fieldsByEntity: {
                account: [
                    { apiName: 'Active', isRelationship: false, friendlyType: 'Checkbox', required: false, isRollupSummary: false },
                    { apiName: 'AccountNumber', isRelationship: false, friendlyType: 'Text', required: false, isRollupSummary: false }
                ]
            }
        });
        const fullText = 'entity Account : Ac, Active';
        const linePrefix = 'entity Account : Ac'; // cursor right before ", Active"
        const ctx = detectDslContext(linePrefix, fullText, 0, deps);
        const labels = ctx.items.map((i) => i.label);
        expect(labels).toContain('AccountNumber');
        expect(labels).not.toContain('Active');
    });

    it('does not offer suggestions while still inside an unclosed bracket', () => {
        const deps = makeDeps({ fieldsByEntity: { account: [{ apiName: 'Industry', isRelationship: false, friendlyType: 'Picklist', required: false, isRollupSummary: false }] } });
        const line = 'entity Account : Industry[Pick';
        const ctx = detectDslContext(line, line, 0, deps);
        expect(ctx).toBeNull();
    });

    it('triggers requestFieldsIfMissing when the entity is not yet cached', () => {
        const requested = [];
        const deps = makeDeps({ requestFieldsIfMissing: (name) => requested.push(name) });
        detectDslContext('entity Account : ', 'entity Account : ', 0, deps);
        expect(requested).toContain('Account');
    });
});

describe('detectDslContext — context 4: Child.<partial field> relationship source', () => {
    it('suggests only relationship fields, with the arrow appended on selection', () => {
        const deps = makeDeps({
            fieldsByEntity: {
                contact: [
                    { apiName: 'AccountId', isRelationship: true, relationshipType: 'Lookup', relatesTo: 'Account' },
                    { apiName: 'LastName', isRelationship: false }
                ]
            }
        });
        const line = 'Contact.Acc';
        const ctx = detectDslContext(line, line, 0, deps);
        expect(ctx.items).toHaveLength(1);
        expect(ctx.items[0].insertText).toBe('AccountId');
        expect(ctx.items[0].appendText).toBe(' -> Account');
    });
});

describe('detectDslContext — context 5: Child.Field <partial arrow>', () => {
    it('suggests all three arrows when nothing is typed yet', () => {
        const line = 'Contact.AccountId ';
        const ctx = detectDslContext(line, line, 0, makeDeps());
        expect(ctx.items.map((i) => i.label)).toEqual(['=>', '->', '~>']);
    });

    it('narrows to matching arrows once partially typed', () => {
        const line = 'Contact.AccountId =';
        const ctx = detectDslContext(line, line, 0, makeDeps());
        expect(ctx.items.map((i) => i.label)).toEqual(['=>']);
    });
});

describe('detectDslContext — context 6: Child.Field => <partial parent entity>', () => {
    it('suggests both declared entities and org objects, labeling which is which', () => {
        const fullText = 'entity Contact : LastName\nContact.AccountId => Acc';
        const linePrefix = 'Contact.AccountId => Acc';
        const ctx = detectDslContext(linePrefix, fullText, fullText.indexOf('Contact.AccountId'), makeDeps());
        const accountItem = ctx.items.find((i) => i.label === 'Account');
        expect(accountItem.detail).toBe('Object'); // not declared on canvas in this DSL
    });
});
