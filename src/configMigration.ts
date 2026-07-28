/**
 * One-shot migration of user settings from the legacy `claudeOffice.*` keys
 * (pre-0.14.0 "Claude Office Dashboard") to the renamed `aiOffice.*` keys.
 * The pure part (`migrateConfigKeys`) takes minimal reader/writer interfaces
 * so it can be unit-tested without the vscode runtime; the thin wrapper
 * (`migrateLegacyConfiguration`) wires it to the real configuration API.
 */

import type * as vscode from 'vscode';

/** Settings renamed from `claudeOffice.X` to `aiOffice.X`. */
const MIGRATED_KEYS = [
  'language',
  'eventsFile',
  'hooks.autoSetup',
  'hooks.targets',
  'statusBar.enabled',
  'roster.enabled',
  'usage.enabled',
  'usage.pollSeconds',
  'usage.costSource',
  'usage.limitBlockUsd',
  'usage.limitWeeklyUsd',
  'usage.limitWeeklyOpusUsd',
  'scope',
  'agentRooms',
] as const;

/** Subset of vscode's inspect() result we care about (folder level is not migrated). */
export interface ConfigInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
}

export interface ConfigReader {
  inspect(key: string): ConfigInspection | undefined;
}

export type MigrationTarget = 'global' | 'workspace';

export interface ConfigWriter {
  update(key: string, value: unknown, target: MigrationTarget): void;
}

/**
 * Copy every legacy `claudeOffice.*` value to its `aiOffice.*` counterpart,
 * per level (global / workspace), unless the new key is already set there.
 * Returns the keys that were migrated (once per level touched).
 */
export function migrateConfigKeys(reader: ConfigReader, writer: ConfigWriter): string[] {
  const migrated: string[] = [];
  for (const key of MIGRATED_KEYS) {
    const legacy = reader.inspect(`claudeOffice.${key}`);
    const current = reader.inspect(`aiOffice.${key}`);
    if (legacy?.globalValue !== undefined && current?.globalValue === undefined) {
      writer.update(`aiOffice.${key}`, legacy.globalValue, 'global');
      migrated.push(key);
    }
    if (legacy?.workspaceValue !== undefined && current?.workspaceValue === undefined) {
      writer.update(`aiOffice.${key}`, legacy.workspaceValue, 'workspace');
      migrated.push(key);
    }
  }
  return migrated;
}

/**
 * Run the migration against the real VSCode configuration, once at
 * activation. Also carries over the hooks-prompt dismissal flag stored in
 * globalState under the old extension name.
 */
export async function migrateLegacyConfiguration(context: vscode.ExtensionContext): Promise<void> {
  // Lazy require: this module is also loaded by plain-node unit tests, where
  // the vscode runtime is unavailable. Only the wrapper ever touches it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscodeApi = require('vscode') as typeof vscode;

  const config = vscodeApi.workspace.getConfiguration();
  const pending: Thenable<unknown>[] = [];
  const migrated = migrateConfigKeys(
    { inspect: (key) => config.inspect(key) },
    {
      update: (key, value, target) => {
        pending.push(
          config.update(
            key,
            value,
            target === 'global'
              ? vscodeApi.ConfigurationTarget.Global
              : vscodeApi.ConfigurationTarget.Workspace,
          ),
        );
      },
    },
  );
  await Promise.all(pending);

  const legacyDismissed = context.globalState.get<unknown>('claudeOffice.hooksPromptDismissed');
  const currentDismissed = context.globalState.get<unknown>('aiOffice.hooksPromptDismissed');
  if (legacyDismissed !== undefined && currentDismissed === undefined) {
    await context.globalState.update('aiOffice.hooksPromptDismissed', legacyDismissed);
  }

  if (migrated.length > 0) {
    console.log(`AI Office: migrated settings: ${[...new Set(migrated)].join(', ')}`);
  }
}
