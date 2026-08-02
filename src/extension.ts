import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { EventWatcher } from './eventWatcher';
import { AgentStateStore } from './agentState';
import { OfficeDashboardProvider } from './webview/provider';
import { UsageWatcher } from './usageWatcher';
import { SubscriptionUsageWatcher, claudeUsageProvider } from './subscriptionUsage';
import { kimiUsageProvider } from './kimiUsage';
import { discoverProjectAgents } from './agentRoster';
import { ensureHooksOnActivation, installHooks } from './hookInstaller';
import { MAIN_AGENT_NAME, getRoomForAgent } from './types';
import { buildAgentRuns } from './agentDetail';
import { isRussianUi } from './locale';
import { migrateLegacyConfiguration } from './configMigration';
import {
  activateStopEverywhere,
  readStopFlag,
  releaseStopEverywhere,
  stopAppliesToWindow,
  stopFlagPaths,
} from './stopFlag';

/**
 * Read a project-local agent→room map from `<folder>/.claude/office-rooms.json`
 * and `<folder>/.kimi-code/office-rooms.json` for each workspace folder. This
 * lets a project carry its own mapping (highest precedence) instead of
 * relying on VSCode `aiOffice.agentRooms` settings. When both files name
 * the same agent, the kimi-code entry wins.
 */
function readProjectRoomMap(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const cliDir of ['.claude', '.kimi-code']) {
      const file = path.join(folder.uri.fsPath, cliDir, 'office-rooms.json');
      try {
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          for (const [name, room] of Object.entries(parsed)) {
            if (typeof room === 'string') merged[name] = room;
          }
        }
      } catch (err) {
        log.appendLine(`AI Office: failed to read ${file}: ${String(err)}`);
      }
    }
  }
  return merged;
}

function buildRoomResolver(): (name: string) => string {
  const customMap = vscode.workspace
    .getConfiguration('aiOffice')
    .get<Record<string, string>>('agentRooms', {});
  // Project file wins over VSCode settings, which win over built-in defaults.
  const map = { ...customMap, ...readProjectRoomMap() };
  return (name) => getRoomForAgent(name, map);
}

function currentCwdFilter(): string[] | null {
  const scope = vscode.workspace
    .getConfiguration('aiOffice')
    .get<string>('scope', 'workspace');
  if (scope === 'global') return null;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders.map((f) => f.uri.fsPath);
}

function seedRoster(store: AgentStateStore): void {
  const enabled = vscode.workspace
    .getConfiguration('aiOffice')
    .get<boolean>('roster.enabled', true);
  if (!enabled) return;
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) return;
  const names = discoverProjectAgents(folders);
  if (names.length > 0) {
    log.appendLine(`AI Office: roster — ${names.length} agents from project agent dirs`);
    store.seedAgents(names);
  }
}

function usagePollSeconds(): number {
  const v = vscode.workspace
    .getConfiguration('aiOffice')
    .get<number>('usage.pollSeconds', 90);
  return Math.max(30, v);
}

let watcher: EventWatcher | null = null;
let store: AgentStateStore | null = null;
let costWatcher: UsageWatcher | null = null;
let subscriptionWatcher: SubscriptionUsageWatcher | null = null;
let kimiUsageWatcher: SubscriptionUsageWatcher | null = null;
const log = vscode.window.createOutputChannel('AI Office');

export function activate(context: vscode.ExtensionContext) {
  // Carry settings over from the legacy claudeOffice.* keys (no-op on fresh installs).
  void migrateLegacyConfiguration(context);
  store = new AgentStateStore();
  store.setRoomResolver(buildRoomResolver());
  store.setCwdFilter(currentCwdFilter());
  const filterDesc = currentCwdFilter();
  log.appendLine(
    `AI Office: cwd filter = ${filterDesc ? filterDesc.join(', ') : '(global, no filter)'}`,
  );
  const provider = new OfficeDashboardProvider(
    context.extensionUri,
    String(context.extension.packageJSON.version ?? ''),
  );

  const configPath = vscode.workspace
    .getConfiguration('aiOffice')
    .get<string>('eventsFile');

  const eventsFile = configPath || path.join(os.homedir(), '.claude', 'agent-events.jsonl');
  log.appendLine(`AI Office: watching ${eventsFile}`);

  const statusBarItem = vscode.window.createStatusBarItem(
    'aiOffice.status',
    vscode.StatusBarAlignment.Left,
    -50,
  );
  statusBarItem.name = 'AI Office';
  statusBarItem.command = 'aiOffice.showDashboard';

  const statusBarEnabled = () =>
    vscode.workspace.getConfiguration('aiOffice').get<boolean>('statusBar.enabled', true);

  // ── Emergency stop ──
  // The dashboard button (or the command) writes the office-stop flag for
  // every supported CLI (~/.claude/office-stop.json, ~/.kimi-code/
  // office-stop.json); each CLI's PreToolUse stop_gate hook then denies every
  // tool call in the covered cwds until the flag is cleared (button again,
  // or the next user prompt in any CLI).
  let stopActive = false;
  let stopSince: string | null = null;

  const refreshStopState = () => {
    const flag = readStopFlag();
    stopActive = stopAppliesToWindow(flag, currentCwdFilter());
    stopSince = stopActive && flag ? flag.since || null : null;
    provider.updateStop(stopActive, stopSince);
    updateStatusBar();
  };

  const toggleStop = async () => {
    const ru = isRussianUi();
    try {
      if (stopActive) {
        const remaining = releaseStopEverywhere(currentCwdFilter());
        if (remaining) {
          // Other windows stopped their own projects — leave those untouched.
          void vscode.window.showInformationMessage(
            ru
              ? 'AI Office: остановка снята для этого проекта. Для других проектов она всё ещё активна.'
              : 'AI Office: stop released for this project. It is still active for other projects.',
          );
        } else {
          void vscode.window.showInformationMessage(
            ru
              ? 'AI Office: экстренная остановка снята — агенты снова могут работать.'
              : 'AI Office: emergency stop released — agents may work again.',
          );
        }
      } else {
        const cwds = currentCwdFilter();
        if (!cwds || cwds.length === 0) {
          // No folder open (or scope=global) — the stop will cover every session on this machine.
          const confirmLabel = ru ? 'Остановить всё' : 'Stop everything';
          const picked = await vscode.window.showWarningMessage(
            ru
              ? 'В этом окне нет открытой папки (или включён режим scope=global), поэтому остановка будет ГЛОБАЛЬНОЙ: заблокируются все сессии Claude Code и Kimi Code на этой машине, во всех проектах. Продолжить?'
              : 'This window has no open folder (or scope=global is set), so the stop will be GLOBAL: every Claude Code and Kimi Code session on this machine, in every project, will be blocked. Continue?',
            { modal: true },
            confirmLabel,
          );
          if (picked !== confirmLabel) return;
        }
        activateStopEverywhere(cwds, new Date().toISOString());
        void vscode.window.showWarningMessage(
          ru
            ? 'AI Office: ЭКСТРЕННАЯ ОСТАНОВКА — все вызовы инструментов блокируются. Повторное нажатие или новый промпт снимает её.'
            : 'AI Office: EMERGENCY STOP — all tool calls are blocked. Press again (or send a new prompt) to resume.',
        );
      }
    } catch (err) {
      log.appendLine(`AI Office: failed to toggle stop flag: ${String(err)}`);
      void vscode.window.showErrorMessage(
        `AI Office: failed to toggle emergency stop: ${String(err)}`,
      );
    }
    refreshStopState();
  };

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
    if (stopActive) {
      statusBarItem.text = '🛑 Agents';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBarItem.tooltip = ru
        ? 'AI Office: экстренная остановка — все вызовы инструментов блокируются'
        : 'AI Office: emergency stop — all tool calls are blocked';
      statusBarItem.show();
      return;
    }
    if (waiting) {
      statusBarItem.text = '✋ Agent';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBarItem.tooltip = ru
        ? `Агент ждёт вас${waiting.message ? `: ${waiting.message}` : ''}`
        : `The agent is waiting for you${waiting.message ? `: ${waiting.message}` : ''}`;
    } else if (errors > 0) {
      statusBarItem.text = ru
        ? `$(error) ${errors} с ошибкой`
        : `$(error) ${errors} agent${errors > 1 ? 's' : ''}`;
      statusBarItem.tooltip = ru
        ? `AI Office: агентов, завершившихся с ошибкой: ${errors}`
        : `AI Office: ${errors} agent(s) finished with errors`;
    } else if (working > 0) {
      statusBarItem.text = ru ? `$(pulse) ${working} в работе` : `$(pulse) ${working} working`;
      statusBarItem.tooltip = ru
        ? `AI Office: агентов в работе: ${working}`
        : `AI Office: ${working} agent(s) working`;
    } else if (mainWorking) {
      statusBarItem.text = '$(pulse) Agent';
      statusBarItem.tooltip = ru
        ? 'AI Office: основная модель работает над ходом (без делегирования агентам)'
        : 'AI Office: the main model is working on the turn (no agents delegated)';
    } else if (total > 0) {
      statusBarItem.text = ru ? '$(home) без задач' : '$(home) idle';
      statusBarItem.tooltip = ru
        ? `AI Office: агентов: ${total}, все без задач`
        : `AI Office: ${total} agents, all idle`;
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
    pushAgentDetail();
  };

  // Agent drill-down: the drawer in the webview requests one agent's detail;
  // while it's open we re-push the detail on every state change (live view).
  let detailAgent: string | null = null;
  const pushAgentDetail = () => {
    if (!store || !detailAgent) return;
    const snapshot = store.getSnapshot();
    provider.sendAgentDetail({
      name: detailAgent,
      state: snapshot[detailAgent] ?? null,
      runs: buildAgentRuns(store.getRecentEvents(), detailAgent),
    });
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
  provider.onToggleStop = toggleStop;
  provider.onAgentDetailRequest = (name) => {
    detailAgent = name;
    pushAgentDetail();
  };
  provider.onAgentDetailClose = () => {
    detailAgent = null;
  };

  // Pick up flag changes from other windows and the user_prompt auto-release
  // in the hook script. watchFile polls, so it also survives file re-creation.
  refreshStopState();
  for (const flagPath of stopFlagPaths()) {
    fs.watchFile(flagPath, { interval: 1500 }, refreshStopState);
    context.subscriptions.push(
      new vscode.Disposable(() => fs.unwatchFile(flagPath, refreshStopState)),
    );
  }

  // Zero-config: offer to install agent CLI hooks if they are missing.
  const bundledHooksDir = path.join(context.extensionUri.fsPath, 'hooks');
  void ensureHooksOnActivation(context, log, bundledHooksDir);

  const viewRegistration = vscode.window.registerWebviewViewProvider(
    OfficeDashboardProvider.viewId,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const showCmd = vscode.commands.registerCommand('aiOffice.showDashboard', () => {
    provider.show();
  });

  const openInEditorCmd = vscode.commands.registerCommand('aiOffice.openInEditor', () => {
    provider.openInEditor();
  });

  const emergencyStopCmd = vscode.commands.registerCommand('aiOffice.emergencyStop', () => {
    void toggleStop();
  });

  const installHooksCmd = vscode.commands.registerCommand('aiOffice.installHooks', () => {
    const result = installHooks(log, bundledHooksDir, { replace: true });
    if (result !== 'failed') {
      void vscode.window.showInformationMessage(
        result === 'installed'
          ? 'AI Office: hooks installed. New Claude Code / Kimi Code sessions will now appear on the dashboard.'
          : 'AI Office: hooks were already installed — scripts refreshed.',
      );
    }
  });

  const clearCmd = vscode.commands.registerCommand('aiOffice.clearEvents', () => {
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
    const intervalMs = usagePollSeconds() * 1000;
    subscriptionWatcher = new SubscriptionUsageWatcher(claudeUsageProvider, {
      intervalMs,
      onUpdate: (snapshot) => provider.updateSubscription(snapshot),
      onError: (message) => provider.reportUsageError('claude', message),
      log: (message) => log.appendLine(message),
    });
    subscriptionWatcher.start();
    kimiUsageWatcher = new SubscriptionUsageWatcher(kimiUsageProvider, {
      intervalMs,
      onUpdate: (snapshot) => provider.updateSubscription(snapshot),
      onError: (message) => provider.reportUsageError('kimi', message),
      log: (message) => log.appendLine(message),
    });
    kimiUsageWatcher.start();
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
    vscode.workspace.getConfiguration('aiOffice').get<string>('usage.costSource', 'off');

  const usageEnabled = () =>
    vscode.workspace.getConfiguration('aiOffice').get<boolean>('usage.enabled', true);

  if (usageEnabled()) {
    startSubscriptionWatcher();
    if (costSource() === 'ccusage') startCostWatcher();
  }

  const cfgChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('aiOffice.agentRooms') && store) {
      store.setRoomResolver(buildRoomResolver());
    }
    if (e.affectsConfiguration('aiOffice.scope') && store) {
      store.setCwdFilter(currentCwdFilter());
      store.clear();
      seedRoster(store);
      broadcastState();
      refreshStopState();
    }
    if (e.affectsConfiguration('aiOffice.roster') && store) {
      store.clear();
      seedRoster(store);
      broadcastState();
    }
    if (e.affectsConfiguration('aiOffice.statusBar')) {
      updateStatusBar();
    }
    if (e.affectsConfiguration('aiOffice.language')) {
      updateStatusBar();
      // The webview bakes the locale into its HTML at creation, so an open
      // dashboard keeps the old language until it is reopened or VSCode reloads.
      void vscode.window.showInformationMessage(
        isRussianUi()
          ? 'AI Office: язык изменён — перезагрузите окно, чтобы дашборд подхватил его.'
          : 'AI Office: language changed — reload the window for the dashboard to pick it up.',
      );
    }
    if (!e.affectsConfiguration('aiOffice.usage')) return;

    // Restart usage watchers with fresh config.
    subscriptionWatcher?.stop();
    subscriptionWatcher = null;
    kimiUsageWatcher?.stop();
    kimiUsageWatcher = null;
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
    refreshStopState();
  });

  context.subscriptions.push(
    viewRegistration, showCmd, openInEditorCmd, emergencyStopCmd, installHooksCmd, clearCmd,
    cfgChange, foldersChange, statusBarItem,
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
  if (kimiUsageWatcher) {
    kimiUsageWatcher.stop();
    kimiUsageWatcher = null;
  }
}
