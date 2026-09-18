import * as vscode from 'vscode';
import * as fs from 'fs';

// This is the extension-host side: it only ever creates the webview and
// wires up messages between it and the rest of VS Code (the file system,
// the Salesforce CLI). None of the actual DSL parsing or rendering logic
// runs here — all of that lives in erDiagramLogic.js and runs INSIDE the
// webview, exactly as it did as an LWC in the original project. This file
// is deliberately thin for that reason.

export function activate(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('sfErModeller.open', () => {
        ErModellerPanel.createOrShow(context.extensionUri);
    });
    context.subscriptions.push(disposable);
}

export function deactivate() {
    // Nothing to clean up yet — no background connections, no watchers.
}

class ErModellerPanel {
    public static currentPanel: ErModellerPanel | undefined;
    private static readonly viewType = 'sfErModeller';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ErModellerPanel.currentPanel) {
            ErModellerPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ErModellerPanel.viewType,
            'Salesforce ER Modeller',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                // Restrict the webview to only the extension's own webview
                // folder — it never needs to load anything else, and this
                // keeps the content-security surface as small as possible.
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')]
            }
        );

        ErModellerPanel.currentPanel = new ErModellerPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.panel.webview.html = this.getHtmlForWebview();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
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

        // Placeholder substitution rather than a templating library — the
        // HTML shell has exactly three tokens to fill in, and pulling in a
        // templating dependency for that would be overkill.
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
