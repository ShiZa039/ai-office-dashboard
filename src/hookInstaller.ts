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

const PROMPT_DISMISSED_KEY = 'claudeOffice.hooksPromptDismissed';
const HOOK_SCRIPTS = ['emit-agent-event.py', 'emit-agent-event.js'];

function claudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json');
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
  /** Every hook event from HOOK_EVENTS registered in ~/.claude/settings.json. */
  settingsOk: boolean;
  /** Bundled hook scripts are present and current in ~/.claude/hooks/. */
  scriptsOk: boolean;
}

function readUserSettings(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return null; // unreadable/corrupt — caller must not overwrite it
  }
}

export function checkHookStatus(bundledHooksDir: string): HookStatus {
  const settings = readUserSettings();
  const settingsOk = settings !== null && hasOfficeHooks(settings);
  const scriptsOk = HOOK_SCRIPTS.every((name) => {
    try {
      const installed = fs.readFileSync(path.join(claudeDir(), 'hooks', name), 'utf-8');
      const bundled = fs.readFileSync(path.join(bundledHooksDir, name), 'utf-8');
      return installed === bundled;
    } catch {
      return false;
    }
  });
  return { settingsOk, scriptsOk };
}

function copyHookScripts(bundledHooksDir: string): void {
  const dst = path.join(claudeDir(), 'hooks');
  fs.mkdirSync(dst, { recursive: true });
  for (const name of HOOK_SCRIPTS) {
    fs.copyFileSync(path.join(bundledHooksDir, name), path.join(dst, name));
  }
}

export type InstallResult = 'installed' | 'already' | 'failed';

/**
 * Install (or repair) hooks: copy bundled scripts and merge registrations
 * into ~/.claude/settings.json. `replace` swaps stale registrations for
 * freshly built ones (runtime change / manual re-install).
 */
export function installHooks(
  log: vscode.OutputChannel,
  bundledHooksDir: string,
  opts?: { replace?: boolean },
): InstallResult {
  const runtime = detectRuntime();
  if (!runtime) {
    void vscode.window.showErrorMessage(
      'Claude Office: neither Python 3 nor Node.js found in PATH — cannot install Claude Code hooks.',
    );
    return 'failed';
  }

  try {
    copyHookScripts(bundledHooksDir);
  } catch (err) {
    log.appendLine(`[hooks] failed to copy scripts: ${String(err)}`);
    void vscode.window.showErrorMessage(`Claude Office: failed to copy hook scripts: ${String(err)}`);
    return 'failed';
  }

  const settings = readUserSettings();
  if (settings === null) {
    void vscode.window.showErrorMessage(
      `Claude Office: ${settingsPath()} exists but is not valid JSON — fix it manually, then run "Claude Office: Install Claude Code Hooks".`,
    );
    return 'failed';
  }

  const { settings: merged, changed } = mergeOfficeHooks(settings, runtime, {
    replace: opts?.replace,
  });
  if (!changed) {
    log.appendLine(`[hooks] scripts refreshed, settings already registered (runtime: ${runtime})`);
    return 'already';
  }

  try {
    const file = settingsPath();
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.claude-office.bak');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  } catch (err) {
    log.appendLine(`[hooks] failed to write settings: ${String(err)}`);
    void vscode.window.showErrorMessage(`Claude Office: failed to update ${settingsPath()}: ${String(err)}`);
    return 'failed';
  }

  log.appendLine(`[hooks] installed (runtime: ${runtime})`);
  return 'installed';
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
    .getConfiguration('claudeOffice')
    .get<boolean>('hooks.autoSetup', true);
  if (!autoSetup) return;

  const status = checkHookStatus(bundledHooksDir);
  if (status.settingsOk && status.scriptsOk) return;

  if (status.settingsOk && !status.scriptsOk) {
    // Hooks are registered; just refresh the script files to the bundled version.
    try {
      copyHookScripts(bundledHooksDir);
      log.appendLine('[hooks] refreshed hook scripts to bundled version');
    } catch (err) {
      log.appendLine(`[hooks] failed to refresh scripts: ${String(err)}`);
    }
    return;
  }

  // Partial registration = older extension version already installed our
  // hooks (consent given); merge the newly added events in silently.
  const settings = readUserSettings();
  if (settings !== null && officeHookCoverage(settings) === 'partial') {
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
    'Claude Office: Claude Code hooks are not set up — the dashboard will stay empty without them. Install them automatically?',
    install,
    later,
    never,
  );
  if (choice === install) {
    const result = installHooks(log, bundledHooksDir);
    if (result !== 'failed') {
      void vscode.window.showInformationMessage(
        'Claude Office: hooks installed. New Claude Code sessions will now appear on the dashboard.',
      );
    }
  } else if (choice === never) {
    await context.globalState.update(PROMPT_DISMISSED_KEY, true);
  }
}
