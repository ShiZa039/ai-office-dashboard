import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  HookRuntime,
  hasOfficeHooks,
  mergeOfficeHooks,
  officeHookCoverage,
} from './hookConfig';
import {
  hasKimiOfficeHooks,
  kimiOfficeHookCoverage,
  mergeKimiOfficeHooks,
} from './hookConfigKimi';

const PROMPT_DISMISSED_KEY = 'aiOffice.hooksPromptDismissed';
const HOOK_SCRIPTS = ['emit-agent-event.py', 'emit-agent-event.js'];

/** Agent CLIs the dashboard can hook into. */
export type HookTarget = 'claude' | 'kimi';

function claudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function kimiDir(): string {
  return path.join(os.homedir(), '.kimi-code');
}

function targetDir(target: HookTarget): string {
  return target === 'kimi' ? kimiDir() : claudeDir();
}

function settingsPath(target: HookTarget): string {
  return target === 'kimi'
    ? path.join(kimiDir(), 'config.toml')
    : path.join(claudeDir(), 'settings.json');
}

function hookScriptPath(target: HookTarget, runtime: HookRuntime): string {
  const file = runtime === 'node' ? 'emit-agent-event.js' : 'emit-agent-event.py';
  return path.join(targetDir(target), 'hooks', file);
}

/**
 * Which CLIs to install hooks into, from the `aiOffice.hooks.targets`
 * setting. 'auto' covers every CLI whose home directory exists (i.e. was used
 * at least once); with neither present it falls back to both, so a later CLI
 * install picks the hooks up.
 */
export function resolveTargets(setting: string): HookTarget[] {
  if (setting === 'claude') return ['claude'];
  if (setting === 'kimi') return ['kimi'];
  if (setting === 'both') return ['claude', 'kimi'];
  const targets: HookTarget[] = [];
  if (fs.existsSync(claudeDir())) targets.push('claude');
  if (fs.existsSync(kimiDir())) targets.push('kimi');
  return targets.length > 0 ? targets : ['claude', 'kimi'];
}

function configuredTargets(): HookTarget[] {
  const setting = vscode.workspace
    .getConfiguration('aiOffice')
    .get<string>('hooks.targets', 'auto');
  return resolveTargets(setting);
}

/** Find a runtime for the hook script. Prefers Python (parity with older installs). */
export function detectRuntime(): HookRuntime | null {
  const candidates: Array<{ rt: HookRuntime; cmd: string; args: string[]; probe: RegExp }> = [
    { rt: 'python', cmd: 'python', args: ['--version'], probe: /Python 3/ },
    { rt: 'python3', cmd: 'python3', args: ['--version'], probe: /Python 3/ },
    { rt: 'py', cmd: 'py', args: ['-3', '--version'], probe: /Python 3/ },
    { rt: 'node', cmd: 'node', args: ['--version'], probe: /v\d+/ },
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c.cmd, c.args, {
        timeout: 4000,
        windowsHide: true,
        encoding: 'utf-8',
      });
      // Windows Store python alias exits non-zero with no real interpreter.
      if (r.status === 0 && c.probe.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) {
        return c.rt;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export interface HookStatus {
  /** Every hook event registered, in every configured target. */
  settingsOk: boolean;
  /** Bundled hook scripts are present and current in every target's hooks dir. */
  scriptsOk: boolean;
  /** Targets with at least one emit-agent-event registration (partial or full). */
  coveredTargets: HookTarget[];
}

function readUserSettings(): Record<string, unknown> | null {
  const file = settingsPath('claude');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return null; // unreadable/corrupt — caller must not overwrite it
  }
}

function readKimiConfig(): string | null {
  try {
    return fs.readFileSync(settingsPath('kimi'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    return null; // unreadable — caller must not overwrite it
  }
}

/** Registrations in place for one target? null = settings file unreadable. */
function targetSettingsOk(target: HookTarget): boolean | null {
  if (target === 'kimi') {
    const text = readKimiConfig();
    return text === null ? null : hasKimiOfficeHooks(text);
  }
  const settings = readUserSettings();
  return settings === null ? null : hasOfficeHooks(settings);
}

/** At least one of our hook events registered in this target? */
function targetCoveragePartial(target: HookTarget): boolean {
  if (target === 'kimi') {
    const text = readKimiConfig();
    return text !== null && kimiOfficeHookCoverage(text) === 'partial';
  }
  const settings = readUserSettings();
  return settings !== null && officeHookCoverage(settings) === 'partial';
}

function targetScriptsOk(target: HookTarget, bundledHooksDir: string): boolean {
  return HOOK_SCRIPTS.every((name) => {
    try {
      const installed = fs.readFileSync(path.join(targetDir(target), 'hooks', name), 'utf-8');
      const bundled = fs.readFileSync(path.join(bundledHooksDir, name), 'utf-8');
      return installed === bundled;
    } catch {
      return false;
    }
  });
}

export function checkHookStatus(
  bundledHooksDir: string,
  targets: HookTarget[] = configuredTargets(),
): HookStatus {
  const settingsOk = targets.every((t) => targetSettingsOk(t) === true);
  const scriptsOk = targets.every((t) => targetScriptsOk(t, bundledHooksDir));
  const coveredTargets = targets.filter(
    (t) => targetSettingsOk(t) === true || targetCoveragePartial(t),
  );
  return { settingsOk, scriptsOk, coveredTargets };
}

function copyHookScripts(target: HookTarget, bundledHooksDir: string): void {
  const dst = path.join(targetDir(target), 'hooks');
  fs.mkdirSync(dst, { recursive: true });
  for (const name of HOOK_SCRIPTS) {
    fs.copyFileSync(path.join(bundledHooksDir, name), path.join(dst, name));
  }
}

export type InstallResult = 'installed' | 'already' | 'failed';

function installClaudeHooks(
  log: vscode.OutputChannel,
  runtime: HookRuntime,
  opts?: { replace?: boolean },
): InstallResult {
  const settings = readUserSettings();
  if (settings === null) {
    void vscode.window.showErrorMessage(
      `AI Office: ${settingsPath('claude')} exists but is not valid JSON — fix it manually, then run "AI Office: Install Agent Hooks".`,
    );
    return 'failed';
  }

  const { settings: merged, changed } = mergeOfficeHooks(settings, runtime, {
    replace: opts?.replace,
  });
  if (!changed) {
    log.appendLine(`[hooks] claude: settings already registered (runtime: ${runtime})`);
    return 'already';
  }

  const file = settingsPath('claude');
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.ai-office.bak');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.appendLine(`[hooks] failed to write settings: ${String(err)}`);
    void vscode.window.showErrorMessage(`AI Office: failed to update ${file}: ${String(err)}`);
    return 'failed';
  }

  log.appendLine(`[hooks] claude: installed (runtime: ${runtime})`);
  return 'installed';
}

function installKimiHooks(
  log: vscode.OutputChannel,
  runtime: HookRuntime,
  opts?: { replace?: boolean },
): InstallResult {
  const text = readKimiConfig();
  if (text === null) {
    void vscode.window.showErrorMessage(
      `AI Office: ${settingsPath('kimi')} exists but is not readable — fix it manually, then run "AI Office: Install Agent Hooks".`,
    );
    return 'failed';
  }

  const { text: merged, changed } = mergeKimiOfficeHooks(
    text,
    runtime,
    hookScriptPath('kimi', runtime),
    { replace: opts?.replace },
  );
  if (!changed) {
    log.appendLine(`[hooks] kimi: config.toml already registered (runtime: ${runtime})`);
    return 'already';
  }

  const file = settingsPath('kimi');
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.office-dashboard.bak');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(file, merged, 'utf-8');
  } catch (err) {
    log.appendLine(`[hooks] failed to write kimi config: ${String(err)}`);
    void vscode.window.showErrorMessage(`AI Office: failed to update ${file}: ${String(err)}`);
    return 'failed';
  }

  log.appendLine(`[hooks] kimi: installed (runtime: ${runtime})`);
  return 'installed';
}

/**
 * Install (or repair) hooks into every configured target: copy bundled
 * scripts and merge registrations (~/.claude/settings.json resp.
 * ~/.kimi-code/config.toml). `replace` swaps stale registrations for freshly
 * built ones (runtime change / manual re-install). Returns 'installed' if any
 * target changed, 'already' if all were up to date, 'failed' on any error.
 */
export function installHooks(
  log: vscode.OutputChannel,
  bundledHooksDir: string,
  opts?: { replace?: boolean },
): InstallResult {
  const runtime = detectRuntime();
  if (!runtime) {
    void vscode.window.showErrorMessage(
      'AI Office: neither Python 3 nor Node.js found in PATH — cannot install agent CLI hooks.',
    );
    return 'failed';
  }

  const targets = configuredTargets();
  try {
    for (const target of targets) {
      copyHookScripts(target, bundledHooksDir);
    }
  } catch (err) {
    log.appendLine(`[hooks] failed to copy scripts: ${String(err)}`);
    void vscode.window.showErrorMessage(`AI Office: failed to copy hook scripts: ${String(err)}`);
    return 'failed';
  }

  let anyInstalled = false;
  for (const target of targets) {
    const result =
      target === 'kimi'
        ? installKimiHooks(log, runtime, opts)
        : installClaudeHooks(log, runtime, opts);
    if (result === 'failed') return 'failed';
    if (result === 'installed') anyInstalled = true;
  }
  return anyInstalled ? 'installed' : 'already';
}

/**
 * Zero-config startup path: silently refresh outdated scripts; if hook
 * registrations are missing, offer a one-click install (once, dismissible).
 */
export async function ensureHooksOnActivation(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  bundledHooksDir: string,
): Promise<void> {
  const autoSetup = vscode.workspace
    .getConfiguration('aiOffice')
    .get<boolean>('hooks.autoSetup', true);
  if (!autoSetup) return;

  const targets = configuredTargets();
  const status = checkHookStatus(bundledHooksDir, targets);
  if (status.settingsOk && status.scriptsOk) return;

  if (status.settingsOk && !status.scriptsOk) {
    // Hooks are registered; just refresh the script files to the bundled version.
    for (const target of targets) {
      try {
        copyHookScripts(target, bundledHooksDir);
      } catch (err) {
        log.appendLine(`[hooks] failed to refresh scripts for ${target}: ${String(err)}`);
      }
    }
    log.appendLine('[hooks] refreshed hook scripts to bundled version');
    return;
  }

  // Partial registration = older extension version already installed our
  // hooks (consent given); merge the newly added events in silently.
  if (status.coveredTargets.length > 0) {
    const result = installHooks(log, bundledHooksDir);
    if (result === 'installed') {
      log.appendLine('[hooks] upgraded registrations to the current hook set');
    }
    return;
  }

  if (context.globalState.get<boolean>(PROMPT_DISMISSED_KEY)) return;

  const install = 'Install';
  const later = 'Later';
  const never = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(
    'AI Office: agent CLI hooks are not set up — the dashboard will stay empty without them. Install them automatically?',
    install,
    later,
    never,
  );
  if (choice === install) {
    const result = installHooks(log, bundledHooksDir);
    if (result !== 'failed') {
      void vscode.window.showInformationMessage(
        'AI Office: hooks installed. New agent sessions will now appear on the dashboard.',
      );
    }
  } else if (choice === never) {
    await context.globalState.update(PROMPT_DISMISSED_KEY, true);
  }
}
