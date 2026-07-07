import * as assert from 'assert';
import {
  buildHookCommand,
  hasOfficeHooks,
  mergeOfficeHooks,
  officeHookCoverage,
  HOOK_EVENTS,
} from '../src/hookConfig';

// --- buildHookCommand ---

assert.strictEqual(
  buildHookCommand('python', 'agent_start'),
  'python "$HOME/.claude/hooks/emit-agent-event.py" agent_start',
  'python command',
);
assert.strictEqual(
  buildHookCommand('node', 'session_stop'),
  'node "$HOME/.claude/hooks/emit-agent-event.js" session_stop',
  'node command uses .js script',
);
assert.strictEqual(
  buildHookCommand('py', 'agent_stop'),
  'py -3 "$HOME/.claude/hooks/emit-agent-event.py" agent_stop',
  'Windows py launcher',
);

// --- SessionStart is registered (model tracking) ---

assert.ok(
  HOOK_EVENTS.some((e) => e.hookEvent === 'SessionStart' && e.arg === 'session_start'),
  'SessionStart hook registered for model tracking',
);

// --- merge into empty settings ---

const empty = mergeOfficeHooks({}, 'python');
assert.strictEqual(empty.changed, true, 'empty settings get hooks');
assert.ok(hasOfficeHooks(empty.settings), 'all events registered after merge');
for (const { hookEvent } of HOOK_EVENTS) {
  const entries = (empty.settings.hooks as Record<string, unknown[]>)[hookEvent];
  assert.strictEqual(entries.length, 1, `${hookEvent} has exactly one entry`);
}

// --- merge is idempotent ---

const again = mergeOfficeHooks(empty.settings, 'python');
assert.strictEqual(again.changed, false, 'second merge is a no-op');

// --- unrelated settings and hooks survive untouched ---

const existing = {
  model: 'opus',
  hooks: {
    SubagentStart: [
      { hooks: [{ type: 'command', command: 'echo other-tool', timeout: 3 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] },
    ],
  },
};
const merged = mergeOfficeHooks(existing, 'node');
assert.strictEqual(merged.changed, true);
assert.strictEqual((merged.settings as Record<string, unknown>).model, 'opus', 'unrelated top-level key kept');
const hooksObj = merged.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
assert.strictEqual(hooksObj.SubagentStart.length, 2, 'foreign SubagentStart hook kept');
assert.strictEqual(hooksObj.SubagentStart[0].hooks[0].command, 'echo other-tool', 'foreign hook first');
assert.ok(hooksObj.PreToolUse, 'unrelated hook event kept');
assert.strictEqual(existing.hooks.SubagentStart.length, 1, 'input object not mutated');

// --- replace swaps our stale entries (runtime switch), keeps foreign ones ---

const stale = mergeOfficeHooks(existing, 'python').settings;
const swapped = mergeOfficeHooks(stale, 'node', { replace: true });
assert.strictEqual(swapped.changed, true, 'runtime switch counts as change');
const swappedHooks = swapped.settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
const ourEntries = swappedHooks.SubagentStart.filter((e) =>
  e.hooks.some((h) => h.command.includes('emit-agent-event')),
);
assert.strictEqual(ourEntries.length, 1, 'no duplicate office entries after replace');
assert.ok(ourEntries[0].hooks[0].command.startsWith('node '), 'replace switched runtime to node');
assert.ok(
  swappedHooks.SubagentStart.some((e) => e.hooks.some((h) => h.command === 'echo other-tool')),
  'foreign hook survives replace',
);

// --- replace with same runtime is a no-op ---

const noop = mergeOfficeHooks(swapped.settings, 'node', { replace: true });
assert.strictEqual(noop.changed, false, 'replace with identical entry does not rewrite');

// --- hasOfficeHooks negative cases ---

assert.strictEqual(hasOfficeHooks(null), false, 'null settings');
assert.strictEqual(hasOfficeHooks({}), false, 'no hooks key');
assert.strictEqual(
  hasOfficeHooks({ hooks: { SubagentStart: [{ hooks: [{ command: 'x emit-agent-event.py y' }] }] } }),
  false,
  'partial registration is not ok',
);

// --- officeHookCoverage: none / partial / full ---

assert.strictEqual(officeHookCoverage(null), 'none', 'null settings → none');
assert.strictEqual(officeHookCoverage({}), 'none', 'no hooks key → none');
assert.strictEqual(
  officeHookCoverage({ hooks: { PreToolUse: [{ hooks: [{ command: 'foreign.sh' }] }] } }),
  'none',
  'only foreign hooks → none',
);
assert.strictEqual(
  officeHookCoverage({
    hooks: { SubagentStart: [{ hooks: [{ command: 'x emit-agent-event.py y' }] }] },
  }),
  'partial',
  'old install missing new events → partial',
);
assert.strictEqual(
  officeHookCoverage(mergeOfficeHooks({}, 'node').settings),
  'full',
  'fresh merge → full',
);

// v0.9-era install (without Notification/UserPromptSubmit) must read as partial,
// so activation upgrades it silently instead of nagging like a fresh install.
{
  const v9 = mergeOfficeHooks({}, 'python').settings;
  const hooks = v9.hooks as Record<string, unknown>;
  delete hooks.Notification;
  delete hooks.UserPromptSubmit;
  assert.strictEqual(officeHookCoverage(v9), 'partial', 'v0.9 install → partial');
  const upgraded = mergeOfficeHooks(v9, 'python');
  assert.strictEqual(upgraded.changed, true, 'upgrade merge adds new events');
  assert.strictEqual(officeHookCoverage(upgraded.settings), 'full', 'upgrade → full');
}

console.log('All hookConfig tests passed.');
