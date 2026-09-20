import { scanForMissingRelationships } from '../src/webview/relationshipLinter';

function field(overrides) {
    return { apiName: 'AccountId', isRelationship: true, relationshipType: 'Lookup', relatesTo: 'Account', ...overrides };
}

describe('scanForMissingRelationships', () => {
    it('suggests a relationship field whose target is on canvas but not yet wired up', () => {
        const model = { entities: [], relationships: [] };
        const suggestions = scanForMissingRelationships(
            model,
            ['Contact', 'Account'],
            { contact: [field()] },
            new Set()
        );
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].line).toBe('Contact.AccountId -> Account');
    });

    it('does not suggest a relationship field whose target is NOT on canvas', () => {
        const model = { entities: [], relationships: [] };
        const suggestions = scanForMissingRelationships(
            model,
            ['Contact'], // Account is not on canvas
            { contact: [field()] },
            new Set()
        );
        expect(suggestions).toHaveLength(0);
    });

    it('does not suggest a relationship already wired up in the DSL', () => {
        const model = {
            entities: [],
            relationships: [{ childEntity: 'Contact', childField: 'AccountId', parentEntity: 'Account' }]
        };
        const suggestions = scanForMissingRelationships(
            model,
            ['Contact', 'Account'],
            { contact: [field()] },
            new Set()
        );
        expect(suggestions).toHaveLength(0);
    });

    it('does not suggest a relationship the user already dismissed', () => {
        const model = { entities: [], relationships: [] };
        const dismissed = new Set(['contact|accountid|account']);
        const suggestions = scanForMissingRelationships(
            model,
            ['Contact', 'Account'],
            { contact: [field()] },
            dismissed
        );
        expect(suggestions).toHaveLength(0);
    });

    it('uses the correct arrow for each relationship type', () => {
        const model = { entities: [], relationships: [] };
        const suggestions = scanForMissingRelationships(
            model,
            ['OpportunityLineItem', 'Opportunity', 'Task', 'WhatId'],
            {
                opportunitylineitem: [field({ apiName: 'OpportunityId', relationshipType: 'Master-Detail', relatesTo: 'Opportunity' })],
                task: [field({ apiName: 'WhatId', relationshipType: 'Polymorphic Lookup', relatesTo: 'WhatId' })]
            },
            new Set()
        );
        const md = suggestions.find((s) => s.id.includes('opportunityid'));
        const poly = suggestions.find((s) => s.id.includes('whatid'));
        expect(md.line).toContain('=>');
        expect(poly.line).toContain('~>');
    });

    it('ignores non-relationship fields entirely', () => {
        const model = { entities: [], relationships: [] };
        const suggestions = scanForMissingRelationships(
            model,
            ['Contact'],
            { contact: [{ apiName: 'LastName', isRelationship: false }] },
            new Set()
        );
        expect(suggestions).toHaveLength(0);
    });
});
