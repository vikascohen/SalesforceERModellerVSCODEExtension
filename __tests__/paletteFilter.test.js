import { currentSearchTerm, filterObjectNames, appendNameToInput } from '../src/webview/paletteFilter';

describe('currentSearchTerm', () => {
    it('returns the whole input when there is no comma yet', () => {
        expect(currentSearchTerm('Acc')).toBe('Acc');
    });
    it('returns only the text after the last comma, trimmed', () => {
        expect(currentSearchTerm('Account, Cont')).toBe('Cont');
    });
    it('returns an empty string right after typing a comma', () => {
        expect(currentSearchTerm('Account, ')).toBe('');
    });
});

describe('filterObjectNames', () => {
    const all = ['Account', 'AccountContactRelation', 'Contact', 'Contract', 'Order__c'];

    it('is case-insensitive and matches anywhere in the name, not just the start', () => {
        expect(filterObjectNames(all, 'con')).toEqual(['AccountContactRelation', 'Contact', 'Contract']);
    });

    it('returns nothing for a blank query rather than the whole list', () => {
        expect(filterObjectNames(all, '')).toEqual([]);
        expect(filterObjectNames(all, '   ')).toEqual([]);
    });

    it('respects the limit', () => {
        expect(filterObjectNames(all, 'c', 2)).toHaveLength(2);
    });
});

describe('appendNameToInput', () => {
    it('fills in a fresh, empty input', () => {
        expect(appendNameToInput('', 'Account')).toBe('Account, ');
    });

    it('replaces only the partial term after the last comma, keeping earlier entries intact', () => {
        expect(appendNameToInput('Account, Cont', 'Contact')).toBe('Account, Contact, ');
    });

    it('replaces a partial first entry cleanly, with no leading comma or stray space', () => {
        expect(appendNameToInput('Acc', 'Account')).toBe('Account, ');
    });

    it('handles three or more entries, only touching the last one', () => {
        expect(appendNameToInput('Account, Contact, Ord', 'Order__c')).toBe('Account, Contact, Order__c, ');
    });
});
