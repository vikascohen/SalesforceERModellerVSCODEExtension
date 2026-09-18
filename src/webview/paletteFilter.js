// Kept separate from main.js (which only runs inside a webview and can't
// be unit tested directly) so this one piece of real logic — matching
// what's already typed after the last comma against the full object
// list — is actually covered by a test, not just eyeballed.

export function currentSearchTerm(inputValue) {
    const parts = inputValue.split(',');
    return parts[parts.length - 1].trim();
}

export function filterObjectNames(allNames, query, limit = 20) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allNames.filter((n) => n.toLowerCase().includes(q)).slice(0, limit);
}

export function appendNameToInput(inputValue, name) {
    const parts = inputValue.split(',');
    parts[parts.length - 1] = ' ' + name;
    return parts.map((p, i) => (i === 0 ? p.trim() : p)).join(',').replace(/^,\s*/, '') + ', ';
}
