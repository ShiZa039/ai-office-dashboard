import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentState } from '../types';

interface WebviewSlot {
  webview: vscode.Webview;
  ready: boolean;
}

export class OfficeDashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'claudeOffice.dashboard';
  public static readonly editorViewType = 'claudeOffice.dashboardEditor';

  private viewSlot: WebviewSlot | null = null;
  private panelSlot: WebviewSlot | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private lastState: Record<string, AgentState> | null = null;
  private lastModel: string | null = null;
  private lastSubscription: unknown = null;
  private lastCost: unknown = null;
  private usageErrors: { subscription: string | null; cost: string | null } = {
    subscription: null,
    cost: null,
  };

  constructor(private extensionUri: vscode.Uri) {}

  /** Callback invoked when any webview signals it's ready */
  onReady?: () => void;

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const slot: WebviewSlot = { webview: webviewView.webview, ready: false };
    this.viewSlot = slot;
    this.attachWebview(webviewView.webview, slot);

    webviewView.onDidDispose(() => {
      if (this.viewSlot === slot) this.viewSlot = null;
    });
  }

  /** Focus the dashboard view in the Activity Bar. */
  show(): void {
    vscode.commands.executeCommand(`${OfficeDashboardProvider.viewId}.focus`);
  }

  /** Open (or reveal) the dashboard as an editor tab, parallel to the sidebar view. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      OfficeDashboardProvider.editorViewType,
      'Claude Office',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'activitybar-icon.svg');
    this.panel = panel;
    const slot: WebviewSlot = { webview: panel.webview, ready: false };
    this.panelSlot = slot;
    this.attachWebview(panel.webview, slot);

    panel.onDidDispose(() => {
      if (this.panelSlot === slot) this.panelSlot = null;
      if (this.panel === panel) this.panel = null;
    });
  }

  updateAgents(agents: Record<string, AgentState>, model: string | null = null): void {
    this.lastState = agents;
    this.lastModel = model;
    this.broadcast({ type: 'full_state', agents, model });
  }

  updateSubscription(data: unknown): void {
    this.lastSubscription = data;
    this.usageErrors.subscription = null;
    this.pushUsage();
  }

  updateCost(data: unknown): void {
    this.lastCost = data;
    this.usageErrors.cost = null;
    this.pushUsage();
  }

  reportUsageError(source: 'subscription' | 'cost', message: string): void {
    this.usageErrors[source] = message;
    this.broadcast({ type: 'usage_error', source, message });
  }

  /** Clear cached cost data (e.g. when the cost source is switched off). */
  resetCost(): void {
    this.lastCost = null;
    this.usageErrors.cost = null;
    this.pushUsage();
  }

  private pushUsage(): void {
    this.broadcast({
      type: 'usage_update',
      data: { subscription: this.lastSubscription, cost: this.lastCost },
    });
  }

  isVisible(): boolean {
    return !!(this.viewSlot?.ready || this.panelSlot?.ready);
  }

  private attachWebview(webview: vscode.Webview, slot: WebviewSlot): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage((msg) => {
      if (msg.type !== 'webview_ready') return;
      slot.ready = true;
      if (this.lastState) {
        webview.postMessage({ type: 'full_state', agents: this.lastState, model: this.lastModel });
      }
      if (this.lastSubscription !== null || this.lastCost !== null) {
        webview.postMessage({
          type: 'usage_update',
          data: { subscription: this.lastSubscription, cost: this.lastCost },
        });
      }
      for (const source of ['subscription', 'cost'] as const) {
        const message = this.usageErrors[source];
        if (message) {
          webview.postMessage({ type: 'usage_error', source, message });
        }
      }
      this.onReady?.();
    });
  }

  private broadcast(message: unknown): void {
    if (this.viewSlot?.ready) this.viewSlot.webview.postMessage(message);
    if (this.panelSlot?.ready) this.panelSlot.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaPath = path.join(this.extensionUri.fsPath, 'media');
    const htmlPath = path.join(mediaPath, 'office.html');

    let html = fs.readFileSync(htmlPath, 'utf-8');

    const nonce = this.getNonce();

    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'office.css'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'office.js'),
    );
    const iconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'icons.js'),
    );
    const avatarsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'avatars.js'),
    );

    html = html.replace('{{cssUri}}', cssUri.toString());
    html = html.replace('{{jsUri}}', jsUri.toString());
    html = html.replace('{{iconsUri}}', iconsUri.toString());
    html = html.replace('{{avatarsUri}}', avatarsUri.toString());
    html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);
    html = html.replace(/\{\{nonce\}\}/g, nonce);

    return html;
  }

  private getNonce(): string {
    let text = '';
    // noqa: secret — alphabet for nonce generation, not a secret
    const possible = 'ABCDEFGHIJKLMNOP' + 'QRSTUVWXYZabcdef' + 'ghijklmnopqrstuv' + 'wxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
