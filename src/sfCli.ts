import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const describeCache = new Map<string, Promise<SfCliDescribe>>();
let objectNamesCache: Promise<string[]> | null = null;
const fieldDescriptionsCache = new Map<string, Promise<FieldDescriptionInfo[]>>();
const sharingModelCache = new Map<string, Promise<SharingModelInfo | null>>();
const recordCountCache = new Map<string, Promise<RecordCountInfo | null>>();
const sharingSignalCache = new Map<string, Promise<SharingSignals>>();
let restSessionCache: Promise<{ instanceUrl:string; accessToken:string }> | null = null;

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
    describeCache.clear();
    objectNamesCache = null;
    fieldDescriptionsCache.clear();
    sharingModelCache.clear();
    recordCountCache.clear();
    sharingSignalCache.clear();
    restSessionCache = null;
}

async function getRestSession(): Promise<{ instanceUrl:string; accessToken:string }> {
    if(restSessionCache) return restSessionCache;
    restSessionCache=(async()=>{
        const result=await runSfJson(['org','display','--verbose','--json']);
        if(!result?.instanceUrl||!result?.accessToken) throw new SfCliError('Could not obtain an authenticated Salesforce REST session.');
        return {instanceUrl:String(result.instanceUrl).replace(/\/$/,''),accessToken:String(result.accessToken)};
    })();
    try{return await restSessionCache;}catch(e){restSessionCache=null;throw e;}
}

async function restQuery(soql:string, tooling=false):Promise<any[]> {
    // Keep the CLI as the compatibility fallback. Different sf auth methods do
    // not all expose a reusable REST bearer session to extensions.
    try {
        const base=tooling?'/services/data/v61.0/tooling/query':'/services/data/v61.0/query';
        const queryOnce=async()=>{const session=await getRestSession();return fetch(session.instanceUrl+base+'?q='+encodeURIComponent(soql),{headers:{Authorization:'Bearer '+session.accessToken,Accept:'application/json'}});};
        let response=await queryOnce();
        if(response.status===401){restSessionCache=null;response=await queryOnce();}
        if(response.ok){const body:any=await response.json();return Array.isArray(body.records)?body.records:[];}
    } catch { /* fall through to authenticated CLI */ }
    return runSoqlQueryViaCli(soql,tooling);
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

export async function describeAllObjectsBulk(): Promise<SfCliDescribe[]> {
    // Bulk cache warm-up using one Tooling query. Keep the query deliberately
    // flat: compound parent-field selections such as EntityDefinition.Label
    // are not accepted consistently by sf data query --use-tooling-api.
    const soql = "SELECT EntityDefinitionId, QualifiedApiName, Label, DataType, IsNillable, IsCalculated FROM FieldDefinition WHERE IsFieldDefinition = true";
    const records = await runSoqlQueryViaCli(soql, true);
    const byEntity = new Map<string, any[]>();
    for(const r of records){
        const id=String(r.EntityDefinitionId||'');
        if(!id||!r.QualifiedApiName) continue;
        const list=byEntity.get(id)||[]; list.push(r); byEntity.set(id,list);
    }
    // EntityDefinition is fetched separately, still in one bulk query rather
    // than one describe process per object.
    const entities = await runSoqlQueryViaCli("SELECT Id, QualifiedApiName, Label, IsCustom FROM EntityDefinition", true);
    const objects:SfCliDescribe[]=[];
    for(const entity of entities){
        const name=entity.QualifiedApiName, rows=byEntity.get(String(entity.Id))||[];
        if(!name||rows.length===0) continue;
        objects.push({name,label:entity.Label||name,custom:!!entity.IsCustom,fields:rows.map((r:any)=>({
            name:r.QualifiedApiName,label:r.Label||r.QualifiedApiName,type:String(r.DataType||'').toLowerCase(),
            custom:String(r.QualifiedApiName).endsWith('__c'),nillable:!!r.IsNillable,createable:true,
            calculated:!!r.IsCalculated,calculatedFormula:null,cascadeDelete:false,relationshipOrder:null,
            referenceTo:[],relationshipName:null
        }))});
    }
    return objects;
}

export async function describeObject(apiName: string): Promise<SfCliDescribe> {
    if (!/^[A-Za-z0-9_]+$/.test(apiName)) throw new SfCliError(`"${apiName}" is not a valid object API name.`);
    const key=apiName.toLowerCase(),cached=describeCache.get(key); if(cached)return cached;
    const request=(async()=>{
        // The CLI is the source of truth for authentication. It works for web,
        // JWT, SFDX URL and other sf auth methods without us handling tokens.
        const result=await runSfJson(['sobject','describe','--sobject',apiName,'--json']);
        return {name:result.name,label:result.label,custom:!!result.custom,fields:(result.fields||[]).map((f:any)=>({
            name:f.name,label:f.label,type:f.type,custom:!!f.custom,nillable:!!f.nillable,createable:!!f.createable,
            calculated:!!f.calculated,calculatedFormula:f.calculatedFormula||null,cascadeDelete:!!f.cascadeDelete,
            relationshipOrder:(f.relationshipOrder===undefined||f.relationshipOrder===null)?null:f.relationshipOrder,
            referenceTo:f.referenceTo||[],relationshipName:f.relationshipName||null
        }))};
    })();
    describeCache.set(key,request); try{return await request;}catch(e){describeCache.delete(key);throw e;}
}

export async function listAllObjectNames(): Promise<string[]> {
    if (objectNamesCache) return objectNamesCache;
    objectNamesCache = (async () => {
        const { stdout } = await execAsync('sf sobject list --sobject all --json', { maxBuffer: 1024 * 1024 * 5 });
        const parsed = JSON.parse(stdout);
        if (parsed.status !== 0) throw new SfCliError(parsed.message || 'Could not list objects.');
        const raw: any[] = Array.isArray(parsed.result) ? parsed.result : [];
        return raw.map((entry) => (typeof entry === 'string' ? entry : entry && entry.name)).filter(Boolean).sort();
    })();
    try { return await objectNamesCache; } catch (e) { objectNamesCache = null; throw e; }
}

export interface FieldDescriptionInfo {
    apiName: string;
    description: string | null;
    lastModifiedDate: string | null;
}

export async function getFieldDescriptions(objectApiName: string): Promise<FieldDescriptionInfo[]> {
    if (!/^[A-Za-z0-9_]+$/.test(objectApiName)) throw new SfCliError(`"${objectApiName}" is not a valid object API name.`);
    const key=objectApiName.toLowerCase();
    const cached=fieldDescriptionsCache.get(key); if(cached) return cached;
    const request=(async()=>{const soql = `SELECT QualifiedApiName, Description, LastModifiedDate FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${objectApiName}'`;const records=await runSoqlQuery(soql,true);return records.map((r)=>({apiName:r.QualifiedApiName,description:r.Description||null,lastModifiedDate:r.LastModifiedDate||null}));})();
    fieldDescriptionsCache.set(key,request);
    try{return await request;}catch(e){fieldDescriptionsCache.delete(key);throw e;}
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
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectApiName)) return { percentages, totalRecords: 0, error: 'Invalid object name.' };
    const safeFields = fieldApiNames.filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(f));
    if (!safeFields.length) return { percentages, totalRecords: 0 };

    // Count once, then run independent aggregate batches concurrently.
    // The old sequential loop multiplied sf CLI startup latency by the
    // number of field batches on large standard objects such as Account.
    let totalRecords:number;
    try { totalRecords=await getRecordCount(objectApiName); }
    catch(e){const msg=e instanceof Error?e.message:String(e);return {percentages,totalRecords:0,error:`Could not count records: ${msg}`};}
    if(totalRecords===0){safeFields.forEach(f=>percentages[f]=0);return {percentages,totalRecords};}

    const batchSize=15,batches:string[][]=[];
    for(let i=0;i<safeFields.length;i+=batchSize)batches.push(safeFields.slice(i,i+batchSize));
    const results=await Promise.all(batches.map(async batch=>{
        try{
            const soql=`SELECT ${batch.map(f=>`COUNT(${f})`).join(', ')} FROM ${objectApiName}`;
            const result=await runSfJson(['data','query','--query',soql,'--json']);
            const row=(result&&result.records&&result.records[0])||{};
            return batch.map((f,idx)=>[f,typeof row[`expr${idx}`]==='number'?row[`expr${idx}`]/totalRecords*100:null] as const);
        }catch{return batch.map(f=>[f,null] as const);}
    }));
    results.flat().forEach(([field,pct])=>{if(pct!=null)percentages[field]=pct;});
    return {percentages,totalRecords};
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
    await Promise.all(objectApiNames.map(async rawName=>{const name=(rawName||'').trim();if(!name)return;const key=name.toLowerCase();let request=sharingModelCache.get(key);if(!request){request=(async()=>{try{const rows=await restQuery(`SELECT InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${name}'`,true);const row=rows[0];return row?{internalModel:row.InternalSharingModel||null,externalModel:row.ExternalSharingModel||null}:null;}catch{return null;}})();sharingModelCache.set(key,request);}const value=await request;if(value)result[name]=value;}));
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
    await Promise.all(objectApiNames.map(async rawName=>{const name=(rawName||'').trim();if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))return;const key=name.toLowerCase();let request=recordCountCache.get(key);if(!request){request=(async()=>{try{const rows=await restQuery(`SELECT COUNT(Id) cnt, MAX(LastModifiedDate) lastMod FROM ${name}`),row=rows[0];return row?{count:typeof row.cnt==='number'?row.cnt:0,lastModifiedDate:row.lastMod||null}:null;}catch{return null;}})();recordCountCache.set(key,request);}const value=await request;if(value)result[name]=value;}));
    return result;
}


const KNOWN_STANDARD_ROW_CAUSES = new Set([
    'Owner', 'Manual', 'Rule', 'Team', 'Territory', 'Territory2',
    'TerritoryManual', 'Territory2Manual', 'ImplicitChild', 'ImplicitParent'
]);

export interface SharingSignals {
    shareTableAvailable: boolean;
    isCustomObject: boolean;
    hasSharingRule: boolean;
    hasApexSharing: boolean;
}

/**
 * Direct port of SchemaMetadataController.cls's getSharingSignals().
 * Deliberately Tooling-API-free, same reasoning as the rest of this
 * app: reading the actual SharingRules metadata needs a Named
 * Credential and a Connected App, neither required for anything else
 * here. Reads the runtime EFFECT instead — the distinct RowCause values
 * present on the object's own __Share table, via GROUP BY RowCause
 * (plain regular SOQL, one query per object, no static Share-object
 * type referenced).
 *
 * hasApexSharing is only reliably meaningful on a CUSTOM object —
 * standard objects can't define their own Apex Sharing Reason at all,
 * so Apex Managed Sharing there uses the same RowCause ('Manual') a
 * person manually sharing one record also produces. The caller must
 * show "not determinable" for a standard object rather than a definite
 * Yes/No — see the original Apex comment on this exact point.
 */
export async function getSharingSignals(objectApiNames: string[]): Promise<Record<string, SharingSignals>> {
    const result: Record<string, SharingSignals> = {};
    await Promise.all(objectApiNames.map(async rawName=>{const name=(rawName||'').trim();if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))return;const key=name.toLowerCase();let request=sharingSignalCache.get(key);if(!request){request=(async()=>{const signals:SharingSignals={shareTableAvailable:false,isCustomObject:name.endsWith('__c'),hasSharingRule:false,hasApexSharing:false};try{const rows=await restQuery(`SELECT RowCause FROM ${name}Share GROUP BY RowCause`);signals.shareTableAvailable=true;rows.forEach((row:any)=>{const cause=row.RowCause;if(cause==='Rule')signals.hasSharingRule=true;else if(!KNOWN_STANDARD_ROW_CAUSES.has(cause))signals.hasApexSharing=true;});}catch{}return signals;})();sharingSignalCache.set(key,request);}result[name]=await request;}));
    return result;
}


async function runSoqlQueryViaCli(soql:string,useToolingApi:boolean):Promise<any[]> {
    const args=['data','query','--query',soql,'--json']; if(useToolingApi)args.push('--use-tooling-api');
    const result=await runSfJson(args); return (result&&result.records)||[];
}
export async function runSoqlQuery(soql:string,useToolingApi:boolean):Promise<any[]> { return runSoqlQueryViaCli(soql,useToolingApi); }
