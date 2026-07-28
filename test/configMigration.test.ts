import * as assert from 'assert';
import {
  ConfigInspection,
  ConfigWriter,
  MigrationTarget,
  migrateConfigKeys,
} from '../src/configMigration';

/**
 * Unit tests for the claudeOffice.* → aiOffice.* settings migration. The pure
 * migrateConfigKeys() is driven with in-memory reader/writer doubles — no
 * vscode runtime involved.
 */

interface UpdateCall {
  key: string;
  value: unknown;
  target: MigrationTarget;
}

function makeHarness(store: Record<string, ConfigInspection>) {
  const updates: UpdateCall[] = [];
  const writer: ConfigWriter = {
    update: (key, value, target) => {
      updates.push({ key, value, target });
      const entry = (store[key] ??= {});
      if (target === 'global') entry.globalValue = value;
      else entry.workspaceValue = value;
    },
  };
  const reader = { inspect: (key: string) => store[key] };
  return { updates, writer, reader };
}

// --- global value is copied when the new key is unset ---

{
  const { updates, reader, writer } = makeHarness({
    'claudeOffice.language': { globalValue: 'ru' },
  });
  const migrated = migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(updates, [
    { key: 'aiOffice.language', value: 'ru', target: 'global' },
  ]);
  assert.deepStrictEqual(migrated, ['language']);
}

// --- workspace value is copied to the workspace level ---

{
  const { updates, reader, writer } = makeHarness({
    'claudeOffice.scope': { workspaceValue: 'global' },
  });
  migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(updates, [
    { key: 'aiOffice.scope', value: 'global', target: 'workspace' },
  ]);
}

// --- both levels migrate independently ---

{
  const { updates, reader, writer } = makeHarness({
    'claudeOffice.usage.pollSeconds': { globalValue: 120, workspaceValue: 60 },
  });
  migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(updates, [
    { key: 'aiOffice.usage.pollSeconds', value: 120, target: 'global' },
    { key: 'aiOffice.usage.pollSeconds', value: 60, target: 'workspace' },
  ]);
}

// --- an already-set new key is never overwritten ---

{
  const { updates, reader, writer } = makeHarness({
    'claudeOffice.language': { globalValue: 'ru', workspaceValue: 'en' },
    'aiOffice.language': { globalValue: 'en' },
  });
  migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(
    updates,
    [{ key: 'aiOffice.language', value: 'en', target: 'workspace' }],
    'global kept, workspace still migrated',
  );
}

// --- unset legacy keys are skipped entirely ---

{
  const { updates, reader, writer } = makeHarness({
    'aiOffice.language': { globalValue: 'en' },
  });
  const migrated = migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(updates, [], 'no legacy values → no writes');
  assert.deepStrictEqual(migrated, []);
}

// --- undefined means "not set", falsy values still migrate ---

{
  const { updates, reader, writer } = makeHarness({
    'claudeOffice.usage.enabled': { globalValue: false },
    'claudeOffice.eventsFile': { globalValue: '' },
    'claudeOffice.agentRooms': { workspaceValue: {} },
  });
  migrateConfigKeys(reader, writer);
  assert.deepStrictEqual(updates, [
    { key: 'aiOffice.eventsFile', value: '', target: 'global' },
    { key: 'aiOffice.usage.enabled', value: false, target: 'global' },
    { key: 'aiOffice.agentRooms', value: {}, target: 'workspace' },
  ]);
}

// --- all 14 renamed keys are covered ---

{
  const store: Record<string, ConfigInspection> = {};
  const keys = [
    'language', 'eventsFile', 'hooks.autoSetup', 'hooks.targets', 'statusBar.enabled',
    'roster.enabled', 'usage.enabled', 'usage.pollSeconds', 'usage.costSource',
    'usage.limitBlockUsd', 'usage.limitWeeklyUsd', 'usage.limitWeeklyOpusUsd',
    'scope', 'agentRooms',
  ];
  for (const key of keys) store[`claudeOffice.${key}`] = { globalValue: 1 };
  const { updates, reader, writer } = makeHarness(store);
  migrateConfigKeys(reader, writer);
  assert.strictEqual(updates.length, 14, 'every legacy key migrated');
  assert.deepStrictEqual(
    updates.map((u) => u.key),
    keys.map((k) => `aiOffice.${k}`),
  );
}

console.log('configMigration.test.ts: all assertions passed');
