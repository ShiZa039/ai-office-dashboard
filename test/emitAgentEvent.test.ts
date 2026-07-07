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

fs.rmSync(home, { recursive: true, force: true });
console.log('All emitAgentEvent tests passed.');
