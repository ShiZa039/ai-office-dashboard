import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexActivity } from '../src/codexActivity';

async function test(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-codex-'));
  try {
    const now = Date.now();
    const iso = (offset = 0) => new Date(now + offset).toISOString();
    const line = (type: string, payload: object, offset = 0) =>
      JSON.stringify({ timestamp: iso(offset), type, payload }) + '\n';
    const event = (type: string, payload: object, offset = 0) => line('event_msg', { type, ...payload }, offset);
    const meta = (id: string, cwd: string, extra: object = {}) =>
      line('session_meta', { id, cwd, timestamp: iso(-60_000), creator_account_id: 'account-a', ...extra }, -60_000);
    const quota = (limitId: string, used: number, resetOffset = 3_600_000) => ({
      limit_id: limitId, plan_type: 'pro',
      primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor((now + resetOffset) / 1000) },
    });
    const project = path.join(root, 'project');
    const dir = path.join(root, '2026', '11', '24');
    await fs.mkdir(dir, { recursive: true });
    const main = path.join(dir, 'rollout-main.jsonl');
    const child = path.join(dir, 'rollout-worker.jsonl');
    const other = path.join(dir, 'rollout-other.jsonl');
    await fs.writeFile(main, meta('main', project)
      + event('task_started', { turn_id: 'a' }, -10_000)
      + line('turn_context', { model: 'gpt-test' }, -9000)
      + event('user_message', { message: 'private prompt' }, -8000)
      + event('token_count', { rate_limits: quota('codex', 25.5) }, -7000));
    await fs.writeFile(child, meta('child', path.join(project, 'nested'), {
      source: { subagent: { thread_spawn: { agent_nickname: 'Тестировщик' } } },
    }) + event('turn_started', { turn_id: 'copied', started_at: Math.floor(now / 1000) - 120 }, -50_000)
      + event('turn_started', { turn_id: 'b' }, -5000));
    await fs.writeFile(other, meta('other', project + '-other')
      + event('task_started', { turn_id: 'c' }, -4000)
      + event('token_count', { rate_limits: quota('codex_other', 35) }, -3000));
    await fs.writeFile(path.join(dir, 'rollout-another-account.jsonl'),
      meta('another-account', project, { creator_account_id: 'account-b' })
      + event('token_count', { rate_limits: quota('codex_foreign', 99) }, -6000));

    const scanner = new CodexActivity(root);
    const roomFor = (role: string) => role === 'Тестировщик' ? 'qa' : 'lobby';
    const agents = (time = now) => scanner.agents([project], roomFor, time);
    await scanner.poll(now);
    assert.equal(agents().size, 2);
    assert.equal(scanner.agents(null, roomFor, now).size, 3);
    assert.equal(agents().get('codex:main')?.state?.state, 'working');
    assert.equal(agents().get('codex:main')?.state?.task, 'gpt-test');
    assert.deepEqual(scanner.latestMainSession([project]), { at: now - 10_000, model: 'gpt-test' });
    assert.deepEqual(scanner.latestMainSession(null), { at: now - 4000, model: null });
    assert.equal(agents().get('codex:child')?.name, 'Codex · Тестировщик');
    assert.equal(agents().get('codex:child')?.id, 'codex:child');
    assert.equal(agents().get('codex:child')?.state?.room, 'qa');
    assert.equal(agents().get('codex:child')?.runs.length, 1);
    assert.doesNotMatch(JSON.stringify([...agents()]), /private prompt|account-a/);
    const snapshot = scanner.quota(now);
    assert.equal(snapshot?.provider, 'codex');
    assert.equal(snapshot?.fetchedAt, iso(-3000));
    assert.deepEqual(snapshot?.limits.map(({ kind, utilization }) => [kind, utilization]),
      [['codex_other:primary', 35], ['codex:primary', 25.5]]);
    assert.equal(scanner.quota(now + 3_600_000), null);

    const done = event('task_complete', { turn_id: 'b', last_agent_message: 'private output' }, 1000);
    await fs.appendFile(child, done.slice(0, -1));
    await scanner.poll(now + 1000);
    assert.equal(agents(now + 1000).get('codex:child')?.state?.state, 'working');
    await fs.appendFile(child, '\n');
    await fs.appendFile(main,
      event('turn_aborted', { turn_id: 'a', reason: 'interrupted' }, 1000)
      + event('token_count', { rate_limits: quota('codex', 30, 1000) }, 1000));
    await scanner.poll(now + 1000);
    assert.equal(agents(now + 1000).get('codex:child')?.state?.state, 'done');
    assert.equal(agents(now + 1000).get('codex:main')?.runs[0]?.result, undefined);
    assert.doesNotMatch(JSON.stringify([...agents(now + 1000)]), /private output/);
    assert.deepEqual(scanner.quota(now + 1000)?.limits.map(({ kind }) => kind), ['codex_other:primary']);
    assert.equal(agents(now + 16_000).get('codex:child')?.state?.state, 'idle');
    assert.equal(agents(now + 21 * 60_000).size, 0);

    scanner.clearActivity(now + 1000);
    assert.equal(agents(now + 1000).size, 0);
    assert.equal(scanner.latestMainSession([project]), null);
    await fs.appendFile(main, event('task_started', { turn_id: 'd' }, 2000)
      + event('thread_settings_applied', { thread_settings: { model: 'gpt-settings' } }, 2500)
      + event('task_complete', { turn_id: 'd', error: { message: 'private error' } }, 3000));
    await scanner.poll(now + 3000);
    assert.equal(agents(now + 3000).get('codex:main')?.state?.state, 'error');
    assert.equal(agents(now + 3000).get('codex:main')?.runs.length, 1);
    assert.deepEqual(scanner.latestMainSession([project]), { at: now + 2000, model: 'gpt-settings' });

    await fs.writeFile(child, meta('replacement', project) + event('task_started', { turn_id: 'e' }, 4000));
    await scanner.poll(now + 4000);
    assert.equal(agents(now + 4000).has('codex:child'), false);
    assert.equal(agents(now + 4000).get('codex:replacement')?.state?.state, 'working');
    const missing = new CodexActivity(path.join(root, 'missing'));
    await missing.poll(now);
    assert.equal(missing.agents(null, roomFor).size, 0);
    assert.equal(missing.quota(now), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void test().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
