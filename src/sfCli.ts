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

export async function runSoqlQuery(soql: string, useToolingApi: boolean): Promise<any[]> {
    const args = ['data', 'query', '--query', soql, '--json'];
    if (useToolingApi) args.push('--use-tooling-api');
    const result = await runSfJson(args);
    return (result && result.records) || [];
}
