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

// --- no flag file: gate allows and records a tool_activity event ---

assert.strictEqual(runGate({ session_id: 'S1', cwd: '/p' }), '', 'no flag → no output');
{
  const e = lastEvent();
  assert.strictEqual(e.event, 'tool_activity', 'allowed call appends tool_activity');
  assert.strictEqual(e.session, 'S1');
  assert.strictEqual(e.cwd, '/p');
}

// --- active flag covering the cwd: gate denies the tool call, no activity ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: '2026-07-14T10:00:00Z' }),
  'utf-8',
);
{
  const eventsBefore = fs.readFileSync(eventsFile, 'utf-8');
  const out = runGate({ session_id: 'S1', cwd: path.join('/p', 'sub') });
  const decision = JSON.parse(out);
  assert.strictEqual(
    decision.hookSpecificOutput.permissionDecision,
    'deny',
    'covered cwd (subdir) is denied',
  );
  assert.ok(decision.hookSpecificOutput.permissionDecisionReason.includes('EMERGENCY STOP'));
  assert.strictEqual(
    fs.readFileSync(eventsFile, 'utf-8'),
    eventsBefore,
    'denied call appends no activity',
  );
}

// --- active flag for another project: gate allows (and records activity) ---

assert.strictEqual(runGate({ session_id: 'S1', cwd: '/other' }), '', 'uncovered cwd passes');
assert.strictEqual(lastEvent().event, 'tool_activity', 'allowed call still appends activity');

// --- inactive flag: gate allows ---

fs.writeFileSync(stopFlagFile, JSON.stringify({ active: false, cwds: [] }), 'utf-8');
assert.strictEqual(runGate({ session_id: 'S1', cwd: '/p' }), '', 'inactive flag passes');

// --- expired flag (auto-stop past its limit window): gate allows ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: 'T0', until: '2020-01-01T00:00:00Z' }),
  'utf-8',
);
assert.strictEqual(
  runGate({ session_id: 'S1', cwd: '/p' }),
  '',
  'a stop whose limit window has reset no longer blocks',
);

// --- flag still inside its window: gate denies ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: 'T0', until: '2099-01-01T00:00:00Z' }),
  'utf-8',
);
{
  const decision = JSON.parse(runGate({ session_id: 'S1', cwd: '/p' }));
  assert.strictEqual(
    decision.hookSpecificOutput.permissionDecision,
    'deny',
    'a deadline in the future still blocks',
  );
}

// --- unparsable deadline: blocking is the safe side ---

fs.writeFileSync(
  stopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: 'T0', until: 'whenever' }),
  'utf-8',
);
{
  const decision = JSON.parse(runGate({ session_id: 'S1', cwd: '/p' }));
  assert.strictEqual(
    decision.hookSpecificOutput.permissionDecision,
    'deny',
    'a garbage deadline is treated as no deadline',
  );
}

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

// --- harness-injected prompts must NOT release the stop ---
// Task notifications and system reminders arrive via UserPromptSubmit too;
// only an explicit human prompt may resume.

const automatedPrompts = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.',
  '  [SYSTEM NOTIFICATION] leading whitespace still counts',
  '<system-reminder>background context</system-reminder>',
  'Some wrapper text\n<task-notification>\n<task-id>abc</task-id>\n</task-notification>',
];
for (const prompt of automatedPrompts) {
  fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: ['/p'] }), 'utf-8');
  runHook('user_prompt', { session_id: 'S1', cwd: '/p', prompt });
  assert.ok(
    fs.existsSync(stopFlagFile),
    `automated prompt keeps the flag: ${prompt.slice(0, 40)}`,
  );
  const e = lastEvent();
  assert.strictEqual(e.event, 'user_prompt', 'event still emitted for automated prompt');
}

// A genuine prompt that merely mentions the markers mid-text is not automated…
fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: ['/p'] }), 'utf-8');
runHook('user_prompt', { session_id: 'S1', cwd: '/p', prompt: 'why does [SYSTEM NOTIFICATION appear in logs?' });
assert.ok(!fs.existsSync(stopFlagFile), 'human prompt mentioning marker mid-text still releases');

// …and a payload without a prompt field keeps the documented release behavior.
fs.writeFileSync(stopFlagFile, JSON.stringify({ active: true, cwds: ['/p'] }), 'utf-8');
runHook('user_prompt', { session_id: 'S1', cwd: '/p' });
assert.ok(!fs.existsSync(stopFlagFile), 'missing prompt field → release (backward compatible)');

// ══ Kimi Code mode (argv[3] = 'kimi') ══
// Payloads use the kimi-code snake_case fields (agent_name + prompt/response,
// tool_name for permission waits) and carry no model/transcript — the model
// falls back to default_model in ~/.kimi-code/config.toml.

const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-office-kimi-test-'));
const kimiEventsFile = path.join(kimiHome, '.claude', 'agent-events.jsonl');
const kimiStopFlagFile = path.join(kimiHome, '.kimi-code', 'office-stop.json');
const claudeFlagInKimiHome = path.join(kimiHome, '.claude', 'office-stop.json');

fs.mkdirSync(path.join(kimiHome, '.kimi-code'), { recursive: true });
fs.writeFileSync(
  path.join(kimiHome, '.kimi-code', 'config.toml'),
  'default_model = "kimi-code/k3"\n\n[providers.kimi]\nmodel = "kimi-for-coding"\n',
  'utf-8',
);

function runKimiHook(arg: string, payload: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [script, arg, 'kimi'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, USERPROFILE: kimiHome, HOME: kimiHome },
  });
  assert.strictEqual(r.status, 0, `kimi hook exited 0 for ${arg}: ${r.stderr}`);
}

function runKimiGate(payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [script, 'stop_gate', 'kimi'], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, USERPROFILE: kimiHome, HOME: kimiHome },
  });
  assert.strictEqual(r.status, 0, `kimi stop_gate exited 0: ${r.stderr}`);
  return r.stdout.trim();
}

function lastKimiEvent(): Record<string, unknown> {
  const lines = fs.readFileSync(kimiEventsFile, 'utf-8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// --- session_start: model from default_model in ~/.kimi-code/config.toml ---

runKimiHook('session_start', { session_id: 'K1', cwd: '/p', source: 'startup' });
{
  const e = lastKimiEvent();
  assert.strictEqual(e.event, 'session_start');
  assert.strictEqual(e.model, 'kimi-code/k3', 'model read from config.toml default_model');
}

// --- agent_start: agent_name + delegated prompt as the task label ---

runKimiHook('agent_start', {
  session_id: 'K1',
  cwd: '/p',
  agent_name: 'explore',
  prompt: 'Map out the relevant files before making changes',
});
{
  const e = lastKimiEvent();
  assert.strictEqual(e.agent, 'explore');
  assert.strictEqual(e.task, 'Map out the relevant files before making changes');
}

// --- agent_stop: response preview as the task label ---

runKimiHook('agent_stop', {
  session_id: 'K1',
  cwd: '/p',
  agent_name: 'explore',
  response: 'Found 3 relevant files under src/',
});
{
  const e = lastKimiEvent();
  assert.strictEqual(e.agent, 'explore');
  assert.strictEqual(e.task, 'Found 3 relevant files under src/');
  assert.strictEqual(e.result, 'success');
}

// --- agent_waiting: PermissionRequest tool_name builds the message ---

runKimiHook('agent_waiting', { session_id: 'K1', cwd: '/p', tool_name: 'Bash' });
{
  const e = lastKimiEvent();
  assert.strictEqual(e.event, 'agent_waiting');
  assert.strictEqual(e.task, 'Kimi needs your permission to use Bash');
}

// --- stop_gate: kimi mode reads ~/.kimi-code/office-stop.json, not ~/.claude ---

fs.writeFileSync(
  claudeFlagInKimiHome,
  JSON.stringify({ active: true, cwds: [] }),
  'utf-8',
);
assert.strictEqual(
  runKimiGate({ session_id: 'K1', cwd: '/p' }),
  '',
  'claude flag does not gate kimi tool calls',
);
fs.rmSync(claudeFlagInKimiHome);

fs.mkdirSync(path.dirname(kimiStopFlagFile), { recursive: true });
fs.writeFileSync(
  kimiStopFlagFile,
  JSON.stringify({ active: true, cwds: ['/p'], since: '2026-07-27T10:00:00Z' }),
  'utf-8',
);
{
  const decision = JSON.parse(runKimiGate({ session_id: 'K1', cwd: path.join('/p', 'sub') }));
  assert.strictEqual(
    decision.hookSpecificOutput.permissionDecision,
    'deny',
    'kimi flag gates kimi tool calls',
  );
  assert.strictEqual(runKimiGate({ session_id: 'K1', cwd: '/other' }), '', 'uncovered cwd passes');
}

// --- user_prompt in kimi mode releases BOTH cli flag files ---

fs.writeFileSync(
  claudeFlagInKimiHome,
  JSON.stringify({ active: true, cwds: ['/p'] }),
  'utf-8',
);
runKimiHook('user_prompt', { session_id: 'K1', cwd: '/p', prompt: 'resume please' });
assert.ok(!fs.existsSync(kimiStopFlagFile), 'kimi flag released by human prompt');
assert.ok(!fs.existsSync(claudeFlagInKimiHome), 'claude flag released by the same prompt');

// --- kimi cron-fire prompts must NOT release the stop ---

fs.writeFileSync(kimiStopFlagFile, JSON.stringify({ active: true, cwds: ['/p'] }), 'utf-8');
runKimiHook('user_prompt', {
  session_id: 'K1',
  cwd: '/p',
  prompt: '<cron-fire jobId="abc" cron="*/5 * * * *">\n<prompt>check the build</prompt>\n</cron-fire>',
});
assert.ok(fs.existsSync(kimiStopFlagFile), 'cron-fire prompt keeps the stop');

fs.rmSync(kimiHome, { recursive: true, force: true });

fs.rmSync(home, { recursive: true, force: true });
console.log('All emitAgentEvent tests passed.');
