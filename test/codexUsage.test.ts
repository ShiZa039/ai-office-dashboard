import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexActivity } from '../src/codexActivity';
import { priceForModel } from '../src/pricing';

async function test(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'office-codex-usage-'));
  try {
    const now = Date.now();
    const createdAt = Math.floor((now - 60_000) / 1000);
    const line = (type: string, payload: object, offset: number, ordinal?: number) =>
      JSON.stringify({ timestamp: new Date(now + offset).toISOString(), type, payload, ordinal }) + '\n';
    const event = (type: string, payload: object, offset: number, ordinal?: number) =>
      line('event_msg', { type, ...payload }, offset, ordinal);
    const meta = (id: string, cwd: string, fields: object = {}) =>
      line('session_meta', {
        id, cwd, timestamp: new Date(createdAt * 1000).toISOString(), model_provider: 'openai', ...fields,
      }, -60_000);
    const model = (id: string, offset: number, ordinal?: number) =>
      line('turn_context', { model: id }, offset, ordinal);
    const tokens = (input: number, cacheRead: number, cacheWrite: number, output: number, reasoning = 0) => ({
      input_tokens: input, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite,
      output_tokens: output, reasoning_output_tokens: reasoning,
    });
    const count = (total: object, offset: number, ordinal?: number, more: object = {}) =>
      event('token_count', { info: { total_token_usage: total, ...more } }, offset, ordinal);
    const near = (actual: number | null | undefined, expected: number) =>
      assert.ok(actual != null && Math.abs(actual - expected) < 1e-10, `expected ${expected}, got ${actual}`);

    const project = path.join(home, 'project');
    const sessions = path.join(home, 'sessions');
    const archive = path.join(home, 'archived_sessions');
    await fs.mkdir(sessions);
    await fs.mkdir(archive);
    const main = path.join(sessions, 'rollout-main.jsonl');
    const first = tokens(100_000, 60_000, 10_000, 2000, 1000);
    const second = tokens(110_000, 64_000, 11_000, 3000, 1300);
    await fs.writeFile(main, meta('main', project)
      + model('gpt-6.2-sol', -50_000)
      + count(first, -48_000)
      + model('gpt-6.2-astra', -46_000)
      + count(tokens(100_000, 0, 0, 2000), -45_000, undefined, { last_token_usage: first })
      + count(second, -44_000));
    const child = path.join(sessions, 'rollout-child.jsonl');
    await fs.writeFile(child, meta('child', path.join(home, 'worktree'), {
      session_id: 'main', parent_thread_id: 'main', history_mode: 'legacy',
      source: { subagent: { thread_spawn: { agent_nickname: 'Worker' } } },
    }) + event('task_started', { started_at: createdAt - 10 }, -59_000)
      + model('gpt-6.2-astra', -58_000)
      + count(second, -57_000)
      + event('task_started', { started_at: createdAt + 2 }, -56_000)
      + model('gpt-6.1-sol', -55_000)
      + count(tokens(130_000, 79_000, 11_000, 3200), -1000));
    await fs.copyFile(child, path.join(archive, 'rollout-child.jsonl'));
    await fs.writeFile(path.join(sessions, 'rollout-cutoff.jsonl'), meta('cutoff', project, {
      session_id: 'main', parent_thread_id: 'main', history_mode: 'paginated', subagent_history_start_ordinal: 10,
      agent_nickname: 'Reviewer',
    }) + model('gpt-6.2-sol', -40_000, 8)
      + count(first, -39_000, 9)
      + model('codex-unpriced', -38_000, 10)
      + count(tokens(101_000, 60_000, 10_000, 2010), -37_000, 11));
    const old = path.join(archive, 'rollout-old.jsonl');
    await fs.writeFile(old, meta('old', project) + model('gpt-5.4-2026-03-05', -36_000)
      + count(tokens(100_000, 0, 0, 1000), -35_000));
    const oldDate = new Date(now - 60 * 24 * 60 * 60_000);
    await fs.utimes(old, oldDate, oldDate);
    const custom = path.join(sessions, 'rollout-custom.jsonl');
    const otherProject = path.join(home, 'project-other');
    await fs.writeFile(custom, meta('custom', otherProject, { model_provider: 'custom' })
      + model('gpt-6.2-sol', -34_000) + count(tokens(500_000, 0, 0, 3000), -33_000));

    const scanner = new CodexActivity(sessions);
    await scanner.poll(now, true);
    const snapshot = scanner.tokens([project]);
    assert.equal(snapshot?.session?.id, 'main');
    assert.deepEqual(snapshot?.session?.totals, {
      input: 41_000, output: 3210, cacheRead: 79_000, cacheCreate: 11_000, cacheCreate1h: 0,
    });
    near(snapshot?.session?.costUsd, 0.2161);
    near(snapshot?.totalCostUsd, 0.4811);
    near(snapshot?.session?.costParts?.cacheWrite, 0.035);
    near(snapshot?.session?.byAgent.find((a) => a.agent === 'Worker')?.costUsd, 0.0135);
    assert.equal(snapshot?.session?.byAgent.find((a) => a.agent === 'Reviewer')?.costUsd, null);
    assert.equal(snapshot?.byModel.find((m) => m.model === 'codex-unpriced')?.costUsd, null);
    assert.equal(scanner.tokens([otherProject])?.totalCostUsd, null);
    assert.equal(scanner.tokens([path.join(home, 'missing')]), null);
    assert.equal(priceForModel('gpt-6.2-sol'), null, 'the existing CLI price lookup stays provider-specific');

    await fs.appendFile(main, count(tokens(500, 100, 0, 16), 1000, undefined, {
      last_token_usage: tokens(500, 100, 0, 10, 6), last_usage_includes_reasoning: false,
    }));
    await scanner.poll(now + 2000, true);
    await scanner.poll(now + 3000, true);
    const resumed = scanner.tokens([project]);
    assert.equal(resumed?.session?.totals.output, 3226);
    near(resumed?.session?.costUsd, 0.21998);
    await scanner.poll(now + 4000, false);
    near(scanner.tokens([project])?.totalCostUsd, 0.21998);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

void test().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
