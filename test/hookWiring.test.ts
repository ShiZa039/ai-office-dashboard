import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { HOOK_EVENTS } from '../src/hookConfig';
import { KIMI_HOOK_EVENTS } from '../src/hookConfigKimi';

/**
 * Wiring test (ADR-0001, II.7 / gotcha-green-modules-dead-system):
 * the event_type args handled by the hook scripts must match the hook
 * registrations of BOTH CLIs, and every registered event arg must be a
 * known JSONL event type in src/types.ts. A registration that points at an
 * arg the scripts don't know (or vice versa) would fail silently at runtime.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const pySrc = fs.readFileSync(path.join(repoRoot, 'hooks', 'emit-agent-event.py'), 'utf-8');
const jsSrc = fs.readFileSync(path.join(repoRoot, 'hooks', 'emit-agent-event.js'), 'utf-8');
const typesSrc = fs.readFileSync(path.join(repoRoot, 'src', 'types.ts'), 'utf-8');

const claudeArgs = HOOK_EVENTS.map((e) => e.arg);
const kimiArgs = KIMI_HOOK_EVENTS.map((e) => e.arg);

// Both CLIs subscribe to the same set of script arguments.
assert.deepStrictEqual(
  [...claudeArgs].sort(),
  [...kimiArgs].sort(),
  'Claude and Kimi register the same event_type args',
);

// Both script implementations know every registered arg.
for (const arg of claudeArgs) {
  assert.ok(pySrc.includes(arg), `emit-agent-event.py handles '${arg}'`);
  assert.ok(jsSrc.includes(arg), `emit-agent-event.js handles '${arg}'`);
}

// stop_gate is a PreToolUse gate, not a JSONL event type; the rest must be
// declared in the OfficeEvent union. tool_activity exists only via stop_gate.
for (const arg of claudeArgs.filter((a) => a !== 'stop_gate')) {
  assert.ok(typesSrc.includes(`'${arg}'`), `src/types.ts declares event '${arg}'`);
}
assert.ok(
  typesSrc.includes(`'tool_activity'`),
  "src/types.ts declares 'tool_activity' (emitted via the stop_gate path)",
);

console.log('All hookWiring tests passed.');
