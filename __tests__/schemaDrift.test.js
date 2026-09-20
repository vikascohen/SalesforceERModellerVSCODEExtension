import { computeSchemaDrift } from '../src/webview/schemaDrift';
import { buildFieldMarkerSuffix } from '../src/webview/fieldMarkers';

describe('computeSchemaDrift', () => {
    it('reports a field present in the org but not in the DSL as a new field, with the correct marker', () => {
        const model = { entities: [{ name: 'Account', fields: [{ name: 'Name' }] }] };
        const fresh = {
            account: [
                { apiName: 'Name' },
                { apiName: 'Industry', isRelationship: false, friendlyType: 'Picklist', required: false, isRollupSummary: false }
            ]
        };
        const results = computeSchemaDrift(model, fresh, buildFieldMarkerSuffix);
        expect(results).toHaveLength(1);
        expect(results[0].newFields).toEqual([
            { id: 'Account-new-Industry', name: 'Industry', markerSuffix: '[Picklist]' }
        ]);
        expect(results[0].missingFields).toEqual([]);
    });

    it('reports a field in the DSL but no longer in the org as a missing field', () => {
        const model = { entities: [{ name: 'Account', fields: [{ name: 'Name' }, { name: 'OldField__c' }] }] };
        const fresh = { account: [{ apiName: 'Name' }] };
        const results = computeSchemaDrift(model, fresh, buildFieldMarkerSuffix);
        expect(results).toHaveLength(1);
        expect(results[0].missingFields).toEqual([{ id: 'Account-miss-OldField__c', name: 'OldField__c' }]);
        expect(results[0].newFields).toEqual([]);
    });

    it('does not include an entity with no drift at all', () => {
        const model = { entities: [{ name: 'Account', fields: [{ name: 'Name' }] }] };
        const fresh = { account: [{ apiName: 'Name' }] };
        const results = computeSchemaDrift(model, fresh, buildFieldMarkerSuffix);
        expect(results).toEqual([]);
    });

    it('skips an entity with no fresh data entirely, rather than reporting every field as missing', () => {
        const model = { entities: [{ name: 'NotARealObject__c', fields: [{ name: 'Name' }] }] };
        const fresh = {}; // describe returned nothing for this entity
        const results = computeSchemaDrift(model, fresh, buildFieldMarkerSuffix);
        expect(results).toEqual([]);
    });

    it('handles multiple entities independently, each with its own drift', () => {
        const model = {
            entities: [
                { name: 'Account', fields: [{ name: 'Name' }] },
                { name: 'Contact', fields: [{ name: 'LastName' }, { name: 'Gone__c' }] }
            ]
        };
        const fresh = {
            account: [{ apiName: 'Name' }, { apiName: 'Industry', isRelationship: false, friendlyType: 'Picklist', required: false, isRollupSummary: false }],
            contact: [{ apiName: 'LastName' }]
        };
        const results = computeSchemaDrift(model, fresh, buildFieldMarkerSuffix);
        expect(results).toHaveLength(2);
        const accountResult = results.find((r) => r.entityName === 'Account');
        const contactResult = results.find((r) => r.entityName === 'Contact');
        expect(accountResult.newFields.map((f) => f.name)).toEqual(['Industry']);
        expect(contactResult.missingFields.map((f) => f.name)).toEqual(['Gone__c']);
    });
});
