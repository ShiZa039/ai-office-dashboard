import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Integration test for hooks/emit-agent-event.js: runs the real script with
 * a redirected home directory and asserts the JSONL events it appends,
 * including model resolution (payload field vs transcript tail fallback).
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'hooks', 'emit-agent-event.js');
assert.ok(fs.existsSync(script), `hook script exists at ${script}`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-office-test-'));
const eventsFile = path.join(home, '.claude', 'agent-events.jsonl');

function runHook(arg: string, payload: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [script, arg], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    // Both vars so os.homedir() resolves to our sandbox on Windows and POSIX.
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  assert.strictEqual(r.status, 0, `hook exited 0 for ${arg}: ${r.stderr}`);
}

function lastEvent(): Record<string, unknown> {
  const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// Fake transcript: model must come from the NEWEST assistant entry, and
// non-assistant / malformed trailing lines must be skipped when scanning back.
const transcript = path.join(home, 'transcript.jsonl');
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } }),
    JSON.stringify({ message: { role: 'assistant', model: 'claude-fable-5', content: [] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'thanks' } }),
    'not json at all',
  ].join('\n') + '\n',
  'utf-8',
);

// --- session_start: model comes straight from the hook payload ---

runHook('session_start', { session_id: 'S1', cwd: '/p', model: 'claude-opus-4-8' });
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'session_start');
  assert.strictEqual(e.model, 'claude-opus-4-8', 'payload model wins');
}

// --- agent_stop: no payload model → newest assistant entry in transcript ---

runHook('agent_stop', {
  session_id: 'S1',
  cwd: '/p',
  transcript_path: transcript,
  agent_type: 'qa-lead',
  last_assistant_message: 'done',
});
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'agent_stop');
  assert.strictEqual(e.agent, 'qa-lead');
  assert.strictEqual(e.model, 'claude-fable-5', 'model read from transcript tail');
}

// --- missing transcript: event still written, just without model ---

runHook('session_stop', {
  session_id: 'S1',
  cwd: '/p',
  transcript_path: path.join(home, 'nope.jsonl'),
});
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'session_stop');
  assert.ok(!('model' in e), 'no model field when nothing resolvable');
}

// --- agent_waiting: Notification message lands in task, truncated to 120 ---

runHook('agent_waiting', {
  session_id: 'S1',
  cwd: '/p',
  message: 'Claude needs your permission to use Bash',
});
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'agent_waiting');
  assert.strictEqual(e.task, 'Claude needs your permission to use Bash', 'message carried in task');
}

runHook('agent_waiting', { session_id: 'S1', cwd: '/p', message: 'x'.repeat(300) });
{
  const e = lastEvent();
  assert.strictEqual((e.task as string).length, 120, 'long message truncated to 120');
}

// --- user_prompt: no payload recorded (prompt text stays private) ---

runHook('user_prompt', { session_id: 'S1', cwd: '/p', prompt: 'secret question' });
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'user_prompt');
  assert.ok(!('task' in e), 'prompt text not recorded');
  assert.ok(!('agent' in e), 'no agent field for session-level event');
}

// ── Emergency stop (stop_gate + user_prompt release) ──

const stopFlagFile = path.join(home, '.claude', 'office-stop.json');

function runGate(payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [script, 'stop_gate'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
  assert.strictEqual(r.status, 0, `stop_gate exited 0: ${r.stderr}`);
  return r.stdout.trim();
}

// --- no flag file: gate allows silently and writes no event ---

const eventsBefore = fs.readFileSync(eventsFile, 'utf-8');
assert.strictEqual(runGate({ session_id: 'S1', cwd: '/p' }), '', 'no flag → no output');
assert.strictEqual(fs.readFileSync(eventsFile, 'utf-8'), eventsBefore, 'gate never appends events');

// --- active flag covering the cwd: gate denies the tool call ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: '2026-07-14T10:00:00Z' }),
  'utf-8',
);
{
  const out = runGate({ session_id: 'S1', cwd: path.join('/p', 'sub') });
  const decision = JSON.parse(out);
  assert.strictEqual(
    decision.hookSpecificOutput.permissionDecision,
    'deny',
    'covered cwd (subdir) is denied',
  );
  assert.ok(decision.hookSpecificOutput.permissionDecisionReason.includes('EMERGENCY STOP'));
}

// --- active flag for another project: gate allows ---

assert.strictEqual(runGate({ session_id: 'S1', cwd: '/other' }), '', 'uncovered cwd passes');

// --- inactive flag: gate allows ---

fs.writeFileSync(stopFlagFile, JSON.stringify({ active: false, cwds: [] }), 'utf-8');
assert.strictEqual(runGate({ session_id: 'S1', cwd: '/p' }), '', 'inactive flag passes');

// --- global flag (empty cwds) denies everywhere ---

fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: [] }), 'utf-8');
{
  const decision = JSON.parse(runGate({ session_id: 'S1', cwd: '/anywhere' }));
  assert.strictEqual(decision.hookSpecificOutput.permissionDecision, 'deny', 'global stop');
}

// --- user_prompt releases the covering flag (new prompt = resume) ---

fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: ['/p'] }), 'utf-8');
runHook('user_prompt', { session_id: 'S1', cwd: '/other' });
assert.ok(fs.existsSync(stopFlagFile), 'prompt in another project keeps the flag');
runHook('user_prompt', { session_id: 'S1', cwd: '/p' });
assert.ok(!fs.existsSync(stopFlagFile), 'prompt in the stopped project releases the flag');

// --- user_prompt releases only its own project, stops elsewhere survive ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p', '/q'], since: 'T0' }),
  'utf-8',
);
runHook('user_prompt', { session_id: 'S1', cwd: path.join('/p', 'sub') });
{
  const flag = JSON.parse(fs.readFileSync(stopFlagFile, 'utf-8'));
  assert.deepStrictEqual(flag.cwds, ['/q'], 'own project removed, other project still stopped');
  assert.strictEqual(flag.active, true, 'flag stays active for the rest');
}
runHook('user_prompt', { session_id: 'S1', cwd: '/q' });
assert.ok(!fs.existsSync(stopFlagFile), 'last covered project released → flag file gone');

// --- global flag: any prompt releases it entirely ---

fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: [] }), 'utf-8');
runHook('user_prompt', { session_id: 'S1', cwd: '/anywhere' });
assert.ok(!fs.existsSync(stopFlagFile), 'global stop released by any prompt');

fs.rmSync(home, { recursive: true, force: true });
console.log('All emitAgentEvent tests passed.');
