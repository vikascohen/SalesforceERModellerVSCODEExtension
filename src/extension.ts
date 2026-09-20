import * as vscode from 'vscode';
import * as fs from 'fs';
import ExcelJS from 'exceljs';
import {
    describeObject,
    listAllObjectNames,
    getTargetOrg,
    listAuthenticatedOrgs,
    setTargetOrg,
    getFieldDescriptions,
    getRecordCount,
    getFieldUsageStats,
    SfCliError
} from './sfCli';
import { classifyDescribe, buildErSource, ClassifiedObject } from './schemaService';

// This is the extension-host side: it creates the webview, talks to the
// Salesforce CLI and the file system, and relays results back as
// messages. None of the DSL parsing or rendering logic runs here -- all
// of that lives in erDiagramLogic.js and runs INSIDE the webview, exactly
// as it did as an LWC in the original project. This file stays thin for
// that reason -- it is plumbing, not the app's actual logic.

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('sfErModeller.open', () => {
            ErModellerPanel.createOrShow(context.extensionUri);
        }),
        vscode.commands.registerCommand('sfErModeller.selectOrg', selectOrgCommand),
        vscode.commands.registerCommand('sfErModeller.newDiagram', () => {
            ErModellerPanel.createOrShow(context.extensionUri, /* forceNew */ true);
        })
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'sfErModeller.selectOrg';
    context.subscriptions.push(statusBarItem);
    refreshStatusBar();
}

export function deactivate() {
    // Nothing to clean up beyond what context.subscriptions already owns.
}

async function refreshStatusBar(): Promise<void> {
    statusBarItem.text = '$(sync~spin) ER Modeller: checking org...';
    statusBarItem.show();
    try {
        const org = await getTargetOrg();
        statusBarItem.text = org
            ? `$(cloud) ER Modeller: ${org.alias || org.username}`
            : '$(warning) ER Modeller: no org selected';
        statusBarItem.tooltip = org
            ? `Connected to ${org.instanceUrl}. Click to switch orgs.`
            : 'Click to select a Salesforce org (requires the sf CLI and at least one authenticated org).';
    } catch {
        statusBarItem.text = '$(error) ER Modeller: sf CLI not found';
        statusBarItem.tooltip = 'Install the Salesforce CLI: https://developer.salesforce.com/tools/salesforcecli';
    }
}

async function selectOrgCommand(): Promise<void> {
    let orgs;
    try {
        orgs = await listAuthenticatedOrgs();
    } catch (e) {
        vscode.window.showErrorMessage(
            'Could not list Salesforce orgs. Is the Salesforce CLI installed? ' + errorMessage(e)
        );
        return;
    }
    if (orgs.length === 0) {
        const choice = await vscode.window.showInformationMessage(
            'No Salesforce orgs are authenticated yet. Run "sf org login web" in a terminal, or in VS Code\'s built-in terminal.',
            'Open Terminal'
        );
        if (choice === 'Open Terminal') {
            const terminal = vscode.window.createTerminal('Salesforce Login');
            terminal.show();
            terminal.sendText('sf org login web');
        }
        return;
    }
    const picked = await vscode.window.showQuickPick(
        orgs.map((o) => ({
            label: o.alias || o.username,
            description: o.alias ? o.username : undefined,
            detail: o.isDefault ? 'Current default org' : undefined,
            username: o.username
        })),
        { placeHolder: 'Select the Salesforce org to describe objects from' }
    );
    if (!picked) return;
    await setTargetOrg(picked.username);
    await refreshStatusBar();
    if (ErModellerPanel.currentPanel) {
        ErModellerPanel.currentPanel.notifyOrgChanged();
    }
}

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

class ErModellerPanel {
    public static currentPanel: ErModellerPanel | undefined;
    private static readonly viewType = 'sfErModeller';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];
    private currentFileUri: vscode.Uri | undefined;
    private isDirty = false;

    public static createOrShow(extensionUri: vscode.Uri, forceNew = false): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ErModellerPanel.currentPanel && !forceNew) {
            ErModellerPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ErModellerPanel.viewType,
            'Salesforce ER Modeller',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                // Scoped to the whole src/ folder, not just src/webview/ --
                // erDiagramLogic.js lives one level up from the webview
                // assets (kept there deliberately, matching where it lives
                // in the original repo, so it stays easy to diff against
                // upstream). A webview can only ever load resources from
                // inside localResourceRoots, so scoping this to just
                // src/webview/ would have silently blocked that file from
                // ever loading at all -- caught this while wiring up a
                // second cross-folder import, not from a runtime failure.
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src')]
            }
        );

        ErModellerPanel.currentPanel = new ErModellerPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
        this.updateTitle();
    }

    public notifyOrgChanged(): void {
        getTargetOrg().then((org) => {
            this.panel.webview.postMessage({ type: 'orgChanged', org });
        });
    }

    private async handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'importFromOrg':
                await this.handleImportFromOrg(msg.names as string[]);
                return;
            case 'requestObjectList':
                await this.handleRequestObjectList();
                return;
            case 'requestFieldsForEntity':
                await this.handleRequestFieldsForEntity(msg.entityName as string);
                return;
            case 'requestDictionaryForObject':
                await this.handleRequestDictionaryForObject(msg.entityName as string);
                return;
            case 'requestFieldUsageStats':
                await this.handleRequestFieldUsageStats(msg.entityName as string, msg.fieldNames as string[]);
                return;
            case 'exportDictionaryToExcel':
                await this.handleExportDictionaryToExcel(msg.row);
                return;
            case 'dirtyChanged':
                this.isDirty = !!msg.dirty;
                this.updateTitle();
                return;
            case 'requestSave':
                await this.handleSave(msg.text as string);
                return;
            case 'requestSaveAs':
                await this.handleSaveAs(msg.text as string);
                return;
            case 'requestOpen':
                await this.handleOpen();
                return;
            case 'exportMermaidToClipboard':
                await vscode.env.clipboard.writeText(msg.text as string);
                vscode.window.showInformationMessage('Mermaid erDiagram syntax copied to clipboard.');
                return;
            case 'exportDrawioToFile':
                await this.handleExportToFile(msg.text as string, 'drawio', 'draw.io Files');
                return;
            case 'ready':
                this.notifyOrgChanged();
                return;
        }
    }

    private async handleImportFromOrg(names: string[]): Promise<void> {
        const org = await getTargetOrg();
        if (!org) {
            this.panel.webview.postMessage({
                type: 'importError',
                message: 'No Salesforce org selected. Click the ER Modeller status bar item, or run "Salesforce ER Modeller: Select Org" from the command palette.'
            });
            return;
        }
        try {
            const described: ClassifiedObject[] = [];
            for (const rawName of names) {
                const name = rawName.trim();
                if (!name) continue;
                const raw = await describeObject(name);
                described.push(classifyDescribe(raw));
            }
            const dsl = buildErSource(described);
            this.panel.webview.postMessage({ type: 'appendDsl', dsl });
        } catch (e) {
            this.panel.webview.postMessage({
                type: 'importError',
                message: e instanceof SfCliError ? e.message : errorMessage(e)
            });
        }
    }

    private async handleRequestObjectList(): Promise<void> {
        try {
            const names = await listAllObjectNames();
            this.panel.webview.postMessage({ type: 'objectList', names });
        } catch (e) {
            this.panel.webview.postMessage({ type: 'importError', message: errorMessage(e) });
        }
    }

    private async handleRequestFieldsForEntity(entityName: string): Promise<void> {
        // Backs the DSL editor's own intellisense — a different message
        // from importFromOrg above (which appends whole entities to the
        // DSL text), but reuses the exact same describeObject +
        // classifyDescribe pipeline, since intellisense needs the same
        // field data (type, required, relationship info) that import does.
        try {
            const raw = await describeObject(entityName);
            const classified = classifyDescribe(raw);
            this.panel.webview.postMessage({
                type: 'entityFields',
                entityName,
                fields: classified.fields
            });
        } catch (e) {
            // Intellisense failing quietly for one entity (typo'd object
            // name, no org selected, etc.) shouldn't interrupt typing with
            // an error banner the way a real Import from Org failure
            // should — just report back an empty field list.
            this.panel.webview.postMessage({ type: 'entityFields', entityName, fields: [] });
        }
    }

    private async handleRequestDictionaryForObject(entityName: string): Promise<void> {
        try {
            const raw = await describeObject(entityName);
            const classified = classifyDescribe(raw);

            // Descriptions come from a separate Tooling API query
            // (FieldDefinition) that needs "View Setup and Configuration" —
            // if that's missing, fields still show without descriptions
            // rather than failing the whole dictionary lookup.
            let descByField: Record<string, { description: string | null; lastModifiedDate: string | null }> = {};
            try {
                const descs = await getFieldDescriptions(entityName);
                descs.forEach((d) => { descByField[d.apiName] = d; });
            } catch (e) {
                // No descriptions available — proceed without them.
            }

            const fields = classified.fields.map((f) => {
                const isPrimaryKey = f.apiName === 'Id';
                const desc = descByField[f.apiName];
                return {
                    ...f,
                    isPrimaryKey,
                    description: desc ? desc.description : null,
                    lastModifiedDate: desc ? desc.lastModifiedDate : null,
                    // Matches the original: the Id field is always 100%
                    // used by definition, every other field starts as
                    // "not yet calculated" (null) until the user opts in
                    // via Calculate Usage — this is never computed
                    // automatically, since it scans actual record data.
                    percentUsed: isPrimaryKey ? 100 : null
                };
            });

            this.panel.webview.postMessage({
                type: 'dictionaryRow',
                row: { apiName: classified.apiName, label: classified.label, isCustom: classified.isCustom, fields }
            });
        } catch (e) {
            this.panel.webview.postMessage({
                type: 'dictionaryError',
                message: e instanceof SfCliError ? e.message : (e instanceof Error ? e.message : String(e))
            });
        }
    }

    private async handleRequestFieldUsageStats(entityName: string, fieldNames: string[]): Promise<void> {
        try {
            const stats = await getFieldUsageStats(entityName, fieldNames);
            this.panel.webview.postMessage({ type: 'fieldUsageStats', entityName, stats });
        } catch (e) {
            this.panel.webview.postMessage({
                type: 'fieldUsageStats',
                entityName,
                stats: { percentages: {}, totalRecords: 0, error: e instanceof Error ? e.message : String(e) }
            });
        }
    }

    private async handleSave(text: string): Promise<void> {
        if (!this.currentFileUri) {
            await this.handleSaveAs(text);
            return;
        }
        await vscode.workspace.fs.writeFile(this.currentFileUri, Buffer.from(text, 'utf8'));
        this.isDirty = false;
        this.updateTitle();
        this.panel.webview.postMessage({ type: 'saved' });
    }

    private async handleSaveAs(text: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'ER Diagram': ['erd'] },
            saveLabel: 'Save Diagram'
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        this.currentFileUri = uri;
        this.isDirty = false;
        this.updateTitle();
        this.panel.webview.postMessage({ type: 'saved' });
    }

    private async handleOpen(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            filters: { 'ER Diagram': ['erd'], 'All Files': ['*'] },
            canSelectMany: false,
            openLabel: 'Open Diagram'
        });
        if (!uris || uris.length === 0) return;
        const bytes = await vscode.workspace.fs.readFile(uris[0]);
        this.currentFileUri = uris[0];
        this.isDirty = false;
        this.updateTitle();
        this.panel.webview.postMessage({ type: 'loadDsl', dsl: Buffer.from(bytes).toString('utf8') });
    }

    private async handleExportDictionaryToExcel(row: any): Promise<void> {
        if (!row || !Array.isArray(row.fields)) return;
        try {
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet(row.apiName || 'Fields');
            sheet.columns = [
                { header: 'API Name', key: 'apiName', width: 28 },
                { header: 'Label', key: 'label', width: 24 },
                { header: 'Type', key: 'type', width: 20 },
                { header: 'Required', key: 'required', width: 10 },
                { header: 'Description', key: 'description', width: 50 },
                { header: 'Last Modified', key: 'lastModifiedDate', width: 14 },
                { header: '% Populated', key: 'percentUsed', width: 12 }
            ];
            row.fields.forEach((f: any) => {
                sheet.addRow({
                    apiName: f.apiName,
                    label: f.label || '',
                    type: f.friendlyType || f.dataType || '',
                    required: f.required ? 'Yes' : 'No',
                    description: f.description || '',
                    lastModifiedDate: f.lastModifiedDate || '',
                    percentUsed: f.percentUsed == null ? '' : Math.round(f.percentUsed * 10) / 10
                });
            });
            sheet.getRow(1).font = { bold: true };

            const uri = await vscode.window.showSaveDialog({
                filters: { 'Excel Workbook': ['xlsx'] },
                saveLabel: 'Export',
                defaultUri: vscode.Uri.file(`${row.apiName || 'DataDictionary'}.xlsx`)
            });
            if (!uri) return;

            const buffer = await workbook.xlsx.writeBuffer();
            await vscode.workspace.fs.writeFile(uri, Buffer.from(buffer));
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Could not export to Excel: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async handleExportToFile(content: string, extension: string, filterLabel: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: { [filterLabel]: [extension] },
            saveLabel: 'Export'
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
    }

    private updateTitle(): void {
        const base = this.currentFileUri
            ? this.currentFileUri.path.split('/').pop()
            : 'Untitled Diagram';
        this.panel.title = (this.isDirty ? '\u25CF ' : '') + base;
    }

    private getHtmlForWebview(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'main.js')
        );
        const logicUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'erDiagramLogic.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'style.css')
        );
        const nonce = getNonce();

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

        html = html
            .replace(/__CSP_SOURCE__/g, webview.cspSource)
            .replace(/__NONCE__/g, nonce)
            .replace(/__STYLE_URI__/g, styleUri.toString())
            .replace(/__SCRIPT_URI__/g, scriptUri.toString())
            .replace(/__LOGIC_URI__/g, logicUri.toString());

        return html;
    }

    private dispose(): void {
        ErModellerPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
