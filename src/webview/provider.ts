import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentDetail, AgentState, SessionWaiting } from '../types';
import { uiLocale } from '../locale';

interface WebviewSlot {
  webview: vscode.Webview;
  ready: boolean;
}

export class OfficeDashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'aiOffice.dashboard';
  public static readonly editorViewType = 'aiOffice.dashboardEditor';

  private viewSlot: WebviewSlot | null = null;
  private panelSlot: WebviewSlot | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private lastState: Record<string, AgentState> | null = null;
  private lastModel: string | null = null;
  private lastWaiting: SessionWaiting | null = null;
  private lastStop: { active: boolean; since: string | null } = { active: false, since: null };
  private lastSubscription: { claude: unknown; kimi: unknown } = { claude: null, kimi: null };
  private lastCost: unknown = null;
  private lastTokens: unknown = null;
  private usageErrors: { claude: string | null; kimi: string | null; cost: string | null } = {
    claude: null,
    kimi: null,
    cost: null,
  };

  constructor(
    private extensionUri: vscode.Uri,
    private version: string = '',
    /** Pre-escaped repo/license tail of the footer line — see `repoLink.ts`. */
    private footerMeta: string = '',
  ) {}

  /** Callback invoked when any webview signals it's ready */
  onReady?: () => void;

  /** Callback invoked when the user hits the emergency-stop / resume button. */
  onToggleStop?: () => void;

  /** Callback invoked when the user hits the settings (gear) button. */
  onOpenSettings?: () => void;

  /** Callbacks for the agent drill-down drawer. */
  onAgentDetailRequest?: (name: string) => void;
  onAgentDetailClose?: () => void;

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const slot: WebviewSlot = { webview: webviewView.webview, ready: false };
    this.viewSlot = slot;
    this.attachWebview(webviewView.webview, slot);

    // Messages posted while the view is hidden can be dropped even with
    // retainContextWhenHidden, leaving stale UI (e.g. the stop banner after
    // an auto-release). Replay the cached state whenever it comes back.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && slot.ready) this.replay(slot.webview);
    });

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
      'AI Office',
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

    panel.onDidChangeViewState(() => {
      if (panel.visible && slot.ready) this.replay(slot.webview);
    });

    panel.onDidDispose(() => {
      if (this.panelSlot === slot) this.panelSlot = null;
      if (this.panel === panel) this.panel = null;
    });
  }

  updateAgents(
    agents: Record<string, AgentState>,
    model: string | null = null,
    waiting: SessionWaiting | null = null,
  ): void {
    this.lastState = agents;
    this.lastModel = model;
    this.lastWaiting = waiting;
    this.broadcast({ type: 'full_state', agents, model, waiting });
  }

  /** Push the emergency-stop state to the dashboard (button + banner). */
  updateStop(active: boolean, since: string | null = null): void {
    this.lastStop = { active, since };
    this.broadcast({ type: 'stop_state', active, since });
  }

  /** Answer a drill-down request (also re-sent on state changes while open). */
  sendAgentDetail(detail: AgentDetail): void {
    this.broadcast({ type: 'agent_detail', detail });
  }

  updateSubscription(data: unknown): void {
    const provider =
      data && typeof data === 'object' && typeof (data as { provider?: unknown }).provider === 'string'
        ? ((data as { provider: string }).provider as 'claude' | 'kimi')
        : 'claude';
    this.lastSubscription[provider] = data;
    this.usageErrors[provider] = null;
    this.pushUsage();
  }

  updateCost(data: unknown): void {
    this.lastCost = data;
    this.usageErrors.cost = null;
    this.pushUsage();
  }

  /** Session / project token totals read from the transcripts. */
  updateTokens(data: unknown): void {
    this.lastTokens = data;
    this.pushUsage();
  }

  /** Drop cached token totals (e.g. when the panel is switched off). */
  resetTokens(): void {
    this.lastTokens = null;
    this.pushUsage();
  }

  reportUsageError(source: 'claude' | 'kimi' | 'cost', message: string): void {
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
      data: { subscription: this.lastSubscription, cost: this.lastCost, tokens: this.lastTokens },
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
      if (msg.type === 'toggle_stop') {
        this.onToggleStop?.();
        return;
      }
      if (msg.type === 'open_settings') {
        this.onOpenSettings?.();
        return;
      }
      if (msg.type === 'agent_detail_request') {
        if (typeof msg.name === 'string' && msg.name) this.onAgentDetailRequest?.(msg.name);
        return;
      }
      if (msg.type === 'agent_detail_close') {
        this.onAgentDetailClose?.();
        return;
      }
      if (msg.type !== 'webview_ready') return;
      slot.ready = true;
      this.replay(webview);
      this.onReady?.();
    });
  }

  /** Re-send the full cached state so a (re)shown webview can't stay stale. */
  private replay(webview: vscode.Webview): void {
    if (this.lastState) {
      webview.postMessage({
        type: 'full_state',
        agents: this.lastState,
        model: this.lastModel,
        waiting: this.lastWaiting,
      });
    }
    webview.postMessage({ type: 'stop_state', ...this.lastStop });
    if (
      this.lastSubscription.claude !== null ||
      this.lastSubscription.kimi !== null ||
      this.lastCost !== null ||
      this.lastTokens !== null
    ) {
      webview.postMessage({
        type: 'usage_update',
        data: { subscription: this.lastSubscription, cost: this.lastCost, tokens: this.lastTokens },
      });
    }
    for (const source of ['claude', 'kimi', 'cost'] as const) {
      const message = this.usageErrors[source];
      if (message) {
        webview.postMessage({ type: 'usage_error', source, message });
      }
    }
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
    // Resolved UI locale (e.g. "ru-RU") — the webview localizes its chrome from it.
    html = html.replace(/\{\{lang\}\}/g, uiLocale());
    html = html.replace(/\{\{version\}\}/g, this.version);
    html = html.replace(/\{\{footerMeta\}\}/g, this.footerMeta);

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
