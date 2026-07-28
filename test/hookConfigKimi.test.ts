import * as assert from 'assert';
import {
  buildKimiHookCommand,
  hasKimiOfficeHooks,
  kimiOfficeHookCoverage,
  mergeKimiOfficeHooks,
  KIMI_HOOK_EVENTS,
} from '../src/hookConfigKimi';

const SCRIPT = 'C:\\Users\\serge\\.kimi-code\\hooks\\emit-agent-event.js';

// --- buildKimiHookCommand ---

assert.strictEqual(
  buildKimiHookCommand('node', SCRIPT, 'stop_gate'),
  `node "${SCRIPT}" stop_gate kimi`,
  'node command carries the kimi cli flag',
);
assert.strictEqual(
  buildKimiHookCommand('py', SCRIPT.replace('.js', '.py'), 'agent_start'),
  `py -3 "${SCRIPT.replace('.js', '.py')}" agent_start kimi`,
  'Windows py launcher',
);

// --- the kimi event set covers the claude parity events ---

for (const [hookEvent, arg] of [
  ['SessionStart', 'session_start'],
  ['SubagentStart', 'agent_start'],
  ['SubagentStop', 'agent_stop'],
  ['Stop', 'session_stop'],
  ['PermissionRequest', 'agent_waiting'],
  ['UserPromptSubmit', 'user_prompt'],
  ['PreToolUse', 'stop_gate'],
] as const) {
  assert.ok(
    KIMI_HOOK_EVENTS.some((e) => e.hookEvent === hookEvent && e.arg === arg),
    `${hookEvent} → ${arg} registered`,
  );
}

// --- merge into an empty config ---

const empty = mergeKimiOfficeHooks('', 'node', SCRIPT);
assert.strictEqual(empty.changed, true, 'empty config gets hooks');
assert.ok(hasKimiOfficeHooks(empty.text), 'all events registered after merge');
for (const { hookEvent } of KIMI_HOOK_EVENTS) {
  assert.ok(
    empty.text.includes(`event = "${hookEvent}"`),
    `${hookEvent} present in merged config`,
  );
}

// --- merge is idempotent ---

const again = mergeKimiOfficeHooks(empty.text, 'node', SCRIPT);
assert.strictEqual(again.changed, false, 'second merge is a no-op');
assert.strictEqual(again.text, empty.text, 'no-op merge keeps the text byte-identical');

// --- unrelated TOML survives untouched ---

const userConfig = [
  'default_model = "kimi-code/k3"',
  '',
  '[providers.kimi]',
  'model = "kimi-for-coding"',
  'api_key = "sk-secret"', // noqa: secret — fake key for the test
  '',
  '# a comment about hooks',
  '[[hooks]]',
  'event = "PreToolUse"',
  'command = "some-other-tool --check"',
  'timeout = 3',
  '',
].join('\n');

const merged = mergeKimiOfficeHooks(userConfig, 'node', SCRIPT);
assert.strictEqual(merged.changed, true, 'user config gets our hooks appended');
assert.ok(
  merged.text.startsWith(userConfig.replace(/\s+$/, '')),
  'existing content stays at the top, unchanged',
);
assert.ok(merged.text.includes('api_key = "sk-secret"'), 'credentials untouched');
assert.ok(merged.text.includes('some-other-tool --check'), 'foreign hooks untouched');
assert.ok(hasKimiOfficeHooks(merged.text), 'full coverage after merge');
assert.strictEqual(
  kimiOfficeHookCoverage(userConfig),
  'none',
  'foreign hooks alone are not our coverage',
);

// --- partial coverage: merge fills in the missing events ---

const partialText = [
  'default_model = "kimi-code/k3"',
  '',
  '# office-dashboard-hook: SessionStart',
  '[[hooks]]',
  'event = "SessionStart"',
  `command = 'node "${SCRIPT}" session_start kimi'`,
  'timeout = 5',
  '',
].join('\n');
assert.strictEqual(kimiOfficeHookCoverage(partialText), 'partial', 'one event = partial');
const upgraded = mergeKimiOfficeHooks(partialText, 'node', SCRIPT);
assert.ok(hasKimiOfficeHooks(upgraded.text), 'partial upgraded to full');
assert.strictEqual(
  (upgraded.text.match(/emit-agent-event/g) ?? []).length,
  KIMI_HOOK_EVENTS.length,
  'exactly one registration per event, no duplicates',
);
assert.ok(upgraded.text.includes('default_model = "kimi-code/k3"'), 'user settings survive');

// --- replace: stale registration is swapped for a fresh one ---

const stale = mergeKimiOfficeHooks(userConfig, 'python', SCRIPT.replace('.js', '.py'));
const replaced = mergeKimiOfficeHooks(stale.text, 'node', SCRIPT, { replace: true });
assert.strictEqual(replaced.changed, true, 'replace swaps the runtime');
assert.ok(!replaced.text.includes('.py'), 'old python registrations gone');
assert.strictEqual(
  (replaced.text.match(/office-dashboard-hook:/g) ?? []).length,
  KIMI_HOOK_EVENTS.length,
  'one beacon per event after replace',
);
const replacedAgain = mergeKimiOfficeHooks(replaced.text, 'node', SCRIPT, { replace: true });
assert.strictEqual(replacedAgain.changed, false, 'replace with same runtime is a no-op');

// --- coverage of a full set ---

assert.strictEqual(kimiOfficeHookCoverage(empty.text), 'full', 'merged config is full coverage');

console.log('All hookConfigKimi tests passed.');
