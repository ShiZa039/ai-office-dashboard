import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventWatcher } from './eventWatcher';
import { AgentStateStore } from './agentState';
import { OfficeDashboardProvider } from './webview/provider';
import { UsageWatcher } from './usageWatcher';
import { SubscriptionUsageWatcher } from './subscriptionUsage';
import { discoverProjectAgents } from './agentRoster';
import { ensureHooksOnActivation, installHooks } from './hookInstaller';
import { MAIN_AGENT_NAME, getRoomForAgent } from './types';
import { isRussianUi } from './locale';

/**
 * Read a project-local agent→room map from `<folder>/.claude/office-rooms.json`
 * for each workspace folder. This lets a project carry its own mapping (highest
 * precedence) instead of relying on VSCode `claudeOffice.agentRooms` settings.
 */
function readProjectRoomMap(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const file = path.join(folder.uri.fsPath, '.claude', 'office-rooms.json');
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [name, room] of Object.entries(parsed)) {
          if (typeof room === 'string') merged[name] = room;
        }
      }
    } catch (err) {
      log.appendLine(`Claude Office: failed to read ${file}: ${String(err)}`);
    }
  }
  return merged;
}

function buildRoomResolver(): (name: string) => string {
  const customMap = vscode.workspace
    .getConfiguration('claudeOffice')
    .get<Record<string, string>>('agentRooms', {});
  // Project file wins over VSCode settings, which win over built-in defaults.
  const map = { ...customMap, ...readProjectRoomMap() };
  return (name) => getRoomForAgent(name, map);
}

function currentCwdFilter(): string[] | null {
  const scope = vscode.workspace
    .getConfiguration('claudeOffice')
    .get<string>('scope', 'workspace');
  if (scope === 'global') return null;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders.map((f) => f.uri.fsPath);
}

function seedRoster(store: AgentStateStore): void {
  const enabled = vscode.workspace
    .getConfiguration('claudeOffice')
    .get<boolean>('roster.enabled', true);
  if (!enabled) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) return;
  const names = discoverProjectAgents(folders);
  if (names.length > 0) {
    log.appendLine(`Claude Office: roster — ${names.length} agents from .claude/agents`);
    store.seedAgents(names);
  }
}

function usagePollSeconds(): number {
  const v = vscode.workspace
    .getConfiguration('claudeOffice')
    .get<number>('usage.pollSeconds', 90);
  return Math.max(30, v);
}

let watcher: EventWatcher | null = null;
let store: AgentStateStore | null = null;
let costWatcher: UsageWatcher | null = null;
let subscriptionWatcher: SubscriptionUsageWatcher | null = null;
const log = vscode.window.createOutputChannel('Claude Office');

export function activate(context: vscode.ExtensionContext) {
  store = new AgentStateStore();
  store.setRoomResolver(buildRoomResolver());
  store.setCwdFilter(currentCwdFilter());
  const filterDesc = currentCwdFilter();
  log.appendLine(
    `Claude Office: cwd filter = ${filterDesc ? filterDesc.join(', ') : '(global, no filter)'}`,
  );
  const provider = new OfficeDashboardProvider(context.extensionUri);

  const configPath = vscode.workspace
    .getConfiguration('claudeOffice')
    .get<string>('eventsFile');

  const eventsFile = configPath || path.join(os.homedir(), '.claude', 'agent-events.jsonl');
  log.appendLine(`Claude Office: watching ${eventsFile}`);

  const statusBarItem = vscode.window.createStatusBarItem(
    'claudeOffice.status',
    vscode.StatusBarAlignment.Left,
    -50,
  );
  statusBarItem.name = 'Claude Office';
  statusBarItem.command = 'claudeOffice.showDashboard';

  const statusBarEnabled = () =>
    vscode.workspace.getConfiguration('claudeOffice').get<boolean>('statusBar.enabled', true);

  const updateStatusBar = () => {
    if (!store || !statusBarEnabled()) {
      statusBarItem.hide();
      return;
    }
    const snapshot = store.getSnapshot();
    const waiting = store.getWaiting();
    let working = 0;
    let errors = 0;
    let total = 0;
    let mainWorking = false;
    for (const agent of Object.values(snapshot)) {
      if (agent.name === MAIN_AGENT_NAME) {
        // The main model is a separate signal, not one of the agents.
        mainWorking = agent.state === 'working';
        continue;
      }
      total++;
      if (agent.state === 'working') working += agent.activeCount ?? 1;
      if (agent.state === 'error') errors++;
    }

    const ru = isRussianUi();
    statusBarItem.backgroundColor = undefined;
    if (waiting) {
      statusBarItem.text = '✋ Claude';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.tooltip = ru
        ? `Claude ждёт вас${waiting.message ? `: ${waiting.message}` : ''}`
        : `Claude is waiting for you${waiting.message ? `: ${waiting.message}` : ''}`;
    } else if (errors > 0) {
      statusBarItem.text = ru
        ? `$(error) ${errors} с ошибкой`
        : `$(error) ${errors} agent${errors > 1 ? 's' : ''}`;
      statusBarItem.tooltip = ru
        ? `Claude Office: агентов, завершившихся с ошибкой: ${errors}`
        : `Claude Office: ${errors} agent(s) finished with errors`;
    } else if (working > 0) {
      statusBarItem.text = ru ? `$(pulse) ${working} в работе` : `$(pulse) ${working} working`;
      statusBarItem.tooltip = ru
        ? `Claude Office: агентов в работе: ${working}`
        : `Claude Office: ${working} agent(s) working`;
    } else if (mainWorking) {
      statusBarItem.text = '$(pulse) Claude';
      statusBarItem.tooltip = ru
        ? 'Claude Office: основная модель работает над ходом (без делегирования агентам)'
        : 'Claude Office: the main model is working on the turn (no agents delegated)';
    } else if (total > 0) {
      statusBarItem.text = ru ? '$(home) без задач' : '$(home) idle';
      statusBarItem.tooltip = ru
        ? `Claude Office: агентов: ${total}, все без задач`
        : `Claude Office: ${total} agents, all idle`;
    } else {
      statusBarItem.hide();
      return;
    }
    statusBarItem.show();
  };

  const broadcastState = () => {
    if (!store) return;
    provider.updateAgents(store.getSnapshot(), store.getModel(), store.getWaiting());
    updateStatusBar();
  };

  store.onChange = broadcastState;
  store.start();
  seedRoster(store);

  watcher = new EventWatcher(eventsFile, (events) => {
    if (!store) return;
    for (const event of events) {
      store.processEvent(event);
    }
    broadcastState();
  });
  watcher.start();

  provider.onReady = broadcastState;

  // Zero-config: offer to install Claude Code hooks if they are missing.
  const bundledHooksDir = path.join(context.extensionUri.fsPath, 'hooks');
  void ensureHooksOnActivation(context, log, bundledHooksDir);

  const viewRegistration = vscode.window.registerWebviewViewProvider(
    OfficeDashboardProvider.viewId,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const showCmd = vscode.commands.registerCommand('claudeOffice.showDashboard', () => {
    provider.show();
  });

  const openInEditorCmd = vscode.commands.registerCommand('claudeOffice.openInEditor', () => {
    provider.openInEditor();
  });

  const installHooksCmd = vscode.commands.registerCommand('claudeOffice.installHooks', () => {
    const result = installHooks(log, bundledHooksDir, { replace: true });
    if (result !== 'failed') {
      void vscode.window.showInformationMessage(
        result === 'installed'
          ? 'Claude Office: hooks installed. New Claude Code sessions will now appear on the dashboard.'
          : 'Claude Office: hooks were already installed — scripts refreshed.',
      );
    }
  });

  const clearCmd = vscode.commands.registerCommand('claudeOffice.clearEvents', () => {
    if (!store) return;
    store.clear();
    try {
      fs.writeFileSync(eventsFile, '');
    } catch {
      // ignore
    }
    seedRoster(store);
    broadcastState();
    vscode.window.showInformationMessage('Agent events cleared');
  });

  const startSubscriptionWatcher = () => {
    subscriptionWatcher = new SubscriptionUsageWatcher({
      intervalMs: usagePollSeconds() * 1000,
      onUpdate: (snapshot) => provider.updateSubscription(snapshot),
      onError: (message) => provider.reportUsageError('subscription', message),
      log: (message) => log.appendLine(message),
    });
    subscriptionWatcher.start();
  };

  const startCostWatcher = () => {
    costWatcher = new UsageWatcher(
      log,
      (snapshot) => provider.updateCost(snapshot),
      (message) => provider.reportUsageError('cost', message),
    );
    costWatcher.start();
  };

  const costSource = () =>
    vscode.workspace.getConfiguration('claudeOffice').get<string>('usage.costSource', 'off');

  const usageEnabled = () =>
    vscode.workspace.getConfiguration('claudeOffice').get<boolean>('usage.enabled', true);

  if (usageEnabled()) {
    startSubscriptionWatcher();
    if (costSource() === 'ccusage') startCostWatcher();
  }

  const cfgChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeOffice.agentRooms') && store) {
      store.setRoomResolver(buildRoomResolver());
    }
    if (e.affectsConfiguration('claudeOffice.scope') && store) {
      store.setCwdFilter(currentCwdFilter());
      store.clear();
      seedRoster(store);
      broadcastState();
    }
    if (e.affectsConfiguration('claudeOffice.roster') && store) {
      store.clear();
      seedRoster(store);
      broadcastState();
    }
    if (e.affectsConfiguration('claudeOffice.statusBar')) {
      updateStatusBar();
    }
    if (e.affectsConfiguration('claudeOffice.language')) {
      updateStatusBar();
      // The webview bakes the locale into its HTML at creation, so an open
      // dashboard keeps the old language until it is reopened or VSCode reloads.
      void vscode.window.showInformationMessage(
        isRussianUi()
          ? 'Claude Office: язык изменён — перезагрузите окно, чтобы дашборд подхватил его.'
          : 'Claude Office: language changed — reload the window for the dashboard to pick it up.',
      );
    }
    if (!e.affectsConfiguration('claudeOffice.usage')) return;

    // Restart usage watchers with fresh config.
    subscriptionWatcher?.stop();
    subscriptionWatcher = null;
    costWatcher?.stop();
    costWatcher = null;
    if (usageEnabled()) {
      startSubscriptionWatcher();
      if (costSource() === 'ccusage') startCostWatcher();
      else provider.resetCost();
    }
  });

  const foldersChange = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (!store) return;
    store.setRoomResolver(buildRoomResolver());
    store.setCwdFilter(currentCwdFilter());
    store.clear();
    seedRoster(store);
    broadcastState();
  });

  context.subscriptions.push(
    viewRegistration, showCmd, openInEditorCmd, installHooksCmd, clearCmd, cfgChange, foldersChange,
    statusBarItem,
  );
}

export function deactivate() {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  if (store) {
    store.stop();
    store = null;
  }
  if (costWatcher) {
    costWatcher.stop();
    costWatcher = null;
  }
  if (subscriptionWatcher) {
    subscriptionWatcher.stop();
    subscriptionWatcher = null;
  }
}
