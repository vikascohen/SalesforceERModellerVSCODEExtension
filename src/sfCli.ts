import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Every function here shells out to the `sf` CLI and parses its --json
// output. This mirrors how the Salesforce Org Visualizer extension
// already connects (per its own project notes), rather than introducing
// a second, separate auth mechanism via a library like jsforce.
//
// IMPORTANT, stated plainly rather than left implicit: the JSON shapes
// below are based on Salesforce's long-stable, publicly documented
// SObject Describe REST API, which `sf sobject describe` wraps directly
// -- not a guess, but not verified against a live org from this
// environment either, since no org is authenticated here. Confirm
// against a real org before trusting this in anger.

export interface SfCliField {
    name: string;
    label: string;
    type: string;
    custom: boolean;
    nillable: boolean;
    createable: boolean;
    calculated: boolean;
    calculatedFormula: string | null;
    cascadeDelete: boolean;
    relationshipOrder: number | null;
    referenceTo: string[];
    relationshipName: string | null;
}

export interface SfCliDescribe {
    name: string;
    label: string;
    custom: boolean;
    fields: SfCliField[];
}

export class SfCliError extends Error {}

// Every command below runs against whatever org `sf config get target-org`
// currently points to, exactly like running `sf` directly in a terminal
// would. This extension does not manage authentication itself -- the user
// authenticates via `sf org login web` (or the existing Salesforce
// Extensions for VS Code, if installed) the same way they would for any
// other `sf` CLI work, and this extension only ever asks the CLI "what is
// the current default org" or lets the user switch it, never handling
// credentials directly itself.

export interface OrgInfo {
    username: string;
    alias: string | null;
    instanceUrl: string;
    isScratchOrg: boolean;
}

export async function getTargetOrg(): Promise<OrgInfo | null> {
    try {
        const result = await runSfJson(['org', 'display', '--json']);
        return {
            username: result.username,
            alias: result.alias || null,
            instanceUrl: result.instanceUrl,
            isScratchOrg: !!result.isScratchOrg
        };
    } catch {
        // No default org set, or nothing authenticated at all -- both look
        // the same from here (a non-zero exit), and both mean the same
        // thing to the caller: there is no org to work with right now.
        return null;
    }
}

export interface OrgListEntry {
    username: string;
    alias: string | null;
    isDefault: boolean;
}

export async function listAuthenticatedOrgs(): Promise<OrgListEntry[]> {
    const result = await runSfJson(['org', 'list', '--json']);
    const all = [
        ...(result.nonScratchOrgs || []),
        ...(result.scratchOrgs || []),
        ...(result.devHubs || []),
        ...(result.sandboxes || [])
    ];
    // The same org can legitimately appear in more than one of those
    // buckets (a Dev Hub that is also a non-scratch org, for instance) --
    // de-duplicate by username so the picker does not show it twice.
    const seen = new Set<string>();
    const entries: OrgListEntry[] = [];
    for (const o of all) {
        if (seen.has(o.username)) continue;
        seen.add(o.username);
        entries.push({
            username: o.username,
            alias: o.alias || null,
            isDefault: !!o.isDefaultUsername
        });
    }
    return entries;
}

export async function setTargetOrg(usernameOrAlias: string): Promise<void> {
    await runSfJson(['config', 'set', 'target-org=' + usernameOrAlias, '--json']);
}

async function runSfJson(args: string[]): Promise<any> {
    const cmd = 'sf ' + args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    let stdout: string;
    try {
        const result = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 20 });
        stdout = result.stdout;
    } catch (e: any) {
        // `sf` often still writes valid JSON to stdout even on a non-zero
        // exit code (e.g. a describe warning) -- try to parse it before
        // giving up and surfacing the raw error.
        if (e.stdout) {
            stdout = e.stdout;
        } else {
            throw new SfCliError(e.message || String(e));
        }
    }
    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new SfCliError('Could not parse sf CLI output as JSON. Is the Salesforce CLI installed and is an org authenticated (sf org login web)?');
    }
    if (parsed.status !== 0) {
        const message = parsed.message || (parsed.result && parsed.result.message) || 'sf CLI command failed.';
        throw new SfCliError(message);
    }
    return parsed.result;
}

export async function describeObject(apiName: string): Promise<SfCliDescribe> {
    if (!/^[A-Za-z0-9_]+$/.test(apiName)) {
        // Same discipline as the original Apex controller's
        // isSafeIdentifier() check -- this value ends up on a shell
        // command line, so it is validated before that happens, not
        // trusted as-is.
        throw new SfCliError(`"${apiName}" is not a valid object API name.`);
    }
    const result = await runSfJson(['sobject', 'describe', '--sobject', apiName, '--json']);
    return {
        name: result.name,
        label: result.label,
        custom: !!result.custom,
        fields: (result.fields || []).map((f: any) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            custom: !!f.custom,
            nillable: !!f.nillable,
            createable: !!f.createable,
            calculated: !!f.calculated,
            calculatedFormula: f.calculatedFormula || null,
            cascadeDelete: !!f.cascadeDelete,
            relationshipOrder: (f.relationshipOrder === undefined || f.relationshipOrder === null) ? null : f.relationshipOrder,
            referenceTo: f.referenceTo || [],
            relationshipName: f.relationshipName || null
        }))
    };
}

export async function listAllObjectNames(): Promise<string[]> {
    // `sf sobject list --sobject all --json`. Genuinely unverified against
    // a live org from this environment -- handling both plausible result
    // shapes (a plain array of name strings, or an array of objects with
    // a `name` property) rather than committing to one guess, since
    // getting this wrong would silently return an empty palette instead
    // of a clear error.
    const { stdout } = await execAsync('sf sobject list --sobject all --json', { maxBuffer: 1024 * 1024 * 5 });
    const parsed = JSON.parse(stdout);
    if (parsed.status !== 0) {
        throw new SfCliError(parsed.message || 'Could not list objects.');
    }
    const raw: any[] = Array.isArray(parsed.result) ? parsed.result : [];
    const names = raw.map((entry) => (typeof entry === 'string' ? entry : entry && entry.name)).filter(Boolean);
    return names.sort();
}

export interface FieldDescriptionInfo {
    apiName: string;
    description: string | null;
    lastModifiedDate: string | null;
}

export async function getFieldDescriptions(objectApiName: string): Promise<FieldDescriptionInfo[]> {
    if (!/^[A-Za-z0-9_]+$/.test(objectApiName)) {
        throw new SfCliError(`"${objectApiName}" is not a valid object API name.`);
    }
    // FieldDefinition is metadata-catalog data, queried via the Tooling
    // API -- the same source (and the same field names: QualifiedApiName,
    // Description, LastModifiedDate) the original Apex version reads via
    // WITH USER_MODE SOQL. Viewing it generally requires "View Setup and
    // Configuration" in the org; if that's missing, this query comes back
    // empty rather than erroring, which the caller treats as "no
    // descriptions available" rather than a hard failure.
    const soql = `SELECT QualifiedApiName, Description, LastModifiedDate FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectApiName}'`;
    const records = await runSoqlQuery(soql, true);
    return records.map((r) => ({
        apiName: r.QualifiedApiName,
        description: r.Description || null,
        lastModifiedDate: r.LastModifiedDate || null
    }));
}

export async function getRecordCount(objectApiName: string): Promise<number> {
    if (!/^[A-Za-z0-9_]+$/.test(objectApiName)) {
        throw new SfCliError(`"${objectApiName}" is not a valid object API name.`);
    }
    const result = await runSfJson(['data', 'query', '--query', `SELECT COUNT() FROM ${objectApiName}`, '--json']);
    return (result && typeof result.totalSize === 'number') ? result.totalSize : 0;
}

export interface FieldUsageStats {
    percentages: Record<string, number>;
    totalRecords: number;
    error?: string;
}

/**
 * On-demand field population percentage for the Data Dictionary — how
 * many of an object's existing records have a non-blank value in each
 * field. Direct port of SchemaMetadataController.cls's
 * getFieldUsageStats(): batches multiple COUNT(fieldName) expressions
 * into one aggregate query per batch (15 fields at a time — the same
 * batch size, chosen there for the same reason: some long-text field
 * types don't tolerate being counted alongside many others in one
 * query, so a batch that fails falls back to "not available" for just
 * its own fields rather than the whole object), instead of one query
 * per field, which is what an earlier, less efficient draft of this
 * function did before being replaced with this direct port.
 */
export async function getFieldUsageStats(objectApiName: string, fieldApiNames: string[]): Promise<FieldUsageStats> {
    const percentages: Record<string, number> = {};
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectApiName)) {
        return { percentages, totalRecords: 0, error: 'Invalid object name.' };
    }

    let totalRecords: number;
    try {
        totalRecords = await getRecordCount(objectApiName);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { percentages, totalRecords: 0, error: `Could not count records: ${msg}` };
    }

    const safeFields = fieldApiNames.filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(f));
    if (totalRecords === 0 || safeFields.length === 0) {
        safeFields.forEach((f) => { percentages[f] = 0; });
        return { percentages, totalRecords };
    }

    const batchSize = 15;
    for (let i = 0; i < safeFields.length; i += batchSize) {
        const batch = safeFields.slice(i, i + batchSize);
        try {
            const selectParts = batch.map((f) => `COUNT(${f})`);
            const soql = `SELECT ${selectParts.join(', ')} FROM ${objectApiName}`;
            const result = await runSfJson(['data', 'query', '--query', soql, '--json']);
            const row = (result && result.records && result.records[0]) || {};
            batch.forEach((f, idx) => {
                const cnt = row[`expr${idx}`];
                percentages[f] = (typeof cnt === 'number' ? cnt : 0) / totalRecords * 100;
            });
        } catch (e) {
            // This batch's fields fall back to "not available" (absent
            // from the map) rather than failing every other batch.
        }
    }

    return { percentages, totalRecords };
}

export interface SharingModelInfo {
    internalModel: string | null;
    externalModel: string | null;
}

/**
 * Direct port of SchemaMetadataController.cls's getSharingModels() —
 * each object's org-wide default sharing model, both internal (regular
 * org users) and external (Experience Cloud / guest users, null on orgs
 * without that license), sourced from EntityDefinition. One query per
 * object, each wrapped so a single unresolvable name can't fail the
 * whole batch, matching the Apex version's own reasoning: EntityDefinition
 * is a metadata catalog object with its own SOQL restrictions (no
 * IN/OR/NOT/LIMIT), so this can't be done as one batched query the way
 * getRecordCounts below can.
 */
export async function getSharingModels(objectApiNames: string[]): Promise<Record<string, SharingModelInfo>> {
    const result: Record<string, SharingModelInfo> = {};
    for (const rawName of objectApiNames) {
        const name = (rawName || '').trim();
        if (!name) continue;
        try {
            const soql = `SELECT InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${name}'`;
            const rows = await runSoqlQuery(soql, true);
            const row = rows[0];
            if (row && (row.InternalSharingModel != null || row.ExternalSharingModel != null)) {
                result[name] = {
                    internalModel: row.InternalSharingModel || null,
                    externalModel: row.ExternalSharingModel || null
                };
            }
        } catch (e) {
            // Skip this one object's badge, don't fail the batch.
        }
    }
    return result;
}

export interface RecordCountInfo {
    count: number;
    lastModifiedDate: string | null;
}

/**
 * Direct port of SchemaMetadataController.cls's getRecordCounts() — count
 * and freshness (most recent LastModifiedDate) per object, for the
 * canvas Heatmap's stale-vs-active-vs-empty coloring. One aggregate
 * query per object (COUNT(Id) and MAX(LastModifiedDate) together, not
 * two separate round trips), each wrapped so a single object failing
 * doesn't blank out the rest.
 */
export async function getRecordCounts(objectApiNames: string[]): Promise<Record<string, RecordCountInfo>> {
    const result: Record<string, RecordCountInfo> = {};
    for (const rawName of objectApiNames) {
        const name = (rawName || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue;
        try {
            const soql = `SELECT COUNT(Id) cnt, MAX(LastModifiedDate) lastMod FROM ${name}`;
            const rows = await runSoqlQuery(soql, false);
            const row = rows[0];
            if (row) {
                result[name] = {
                    count: typeof row.cnt === 'number' ? row.cnt : 0,
                    lastModifiedDate: row.lastMod || null
                };
            }
        } catch (e) {
            // Skip this one object's count, don't fail the batch.
        }
    }
    return result;
}

export async function runSoqlQuery(soql: string, useToolingApi: boolean): Promise<any[]> {
    const args = ['data', 'query', '--query', soql, '--json'];
    if (useToolingApi) args.push('--use-tooling-api');
    const result = await runSfJson(args);
    return (result && result.records) || [];
}
