import * as assert from 'assert';
import { buildAgentRuns } from '../src/agentDetail';
import { AgentEvent } from '../src/types';

let clock = Date.parse('2026-07-28T10:00:00.000Z');
function ts(offsetSec: number): string {
  return new Date(clock + offsetSec * 1000).toISOString();
}

function mkEvent(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    ts: ts(0),
    event: 'agent_start',
    agent: 'backend-lead',
    session: 'S1',
    cwd: '/proj',
    ...overrides,
  };
}

// --- A start/stop pair becomes one closed run ---

{
  const runs = buildAgentRuns(
    [
      mkEvent({ ts: ts(0), event: 'agent_start', task: 'fix bug' }),
      mkEvent({ ts: ts(60), event: 'agent_stop' }),
    ],
    'backend-lead',
  );
  assert.strictEqual(runs.length, 1, 'one run');
  assert.strictEqual(runs[0].startedAt, ts(0));
  assert.strictEqual(runs[0].endedAt, ts(60));
  assert.strictEqual(runs[0].task, 'fix bug', 'task from the start event');
  assert.strictEqual(runs[0].result, undefined);
}

// --- Error result is captured; stop task fills a missing start task ---

{
  const runs = buildAgentRuns(
    [
      mkEvent({ ts: ts(0), event: 'agent_start' }),
      mkEvent({ ts: ts(30), event: 'agent_stop', result: 'error', task: 'boom' }),
    ],
    'backend-lead',
  );
  assert.strictEqual(runs[0].result, 'error');
  assert.strictEqual(runs[0].task, 'boom', 'stop task backfills empty start task');
}

// --- A start without a stop stays an open run (agent still working) ---

{
  const runs = buildAgentRuns(
    [mkEvent({ ts: ts(0), event: 'agent_start', task: 'long job' })],
    'backend-lead',
  );
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].endedAt, null, 'open run');
  assert.strictEqual(runs[0].startedAt, ts(0));
}

// --- Parallel instances: stops close the oldest open run first (FIFO) ---

{
  const runs = buildAgentRuns(
    [
      mkEvent({ ts: ts(0), event: 'agent_start', task: 'first' }),
      mkEvent({ ts: ts(10), event: 'agent_start', task: 'second' }),
      mkEvent({ ts: ts(20), event: 'agent_stop' }),
    ],
    'backend-lead',
  );
  assert.strictEqual(runs.length, 2);
  const closed = runs.find((r) => r.endedAt !== null);
  const open = runs.find((r) => r.endedAt === null);
  assert.ok(closed && open, 'one closed, one open');
  assert.strictEqual(closed.task, 'first', 'oldest open run closes first');
  assert.strictEqual(open.task, 'second');
}

// --- A stop without a recorded start becomes a run with startedAt: null ---

{
  const runs = buildAgentRuns(
    [mkEvent({ ts: ts(5), event: 'agent_stop', task: 'orphan' })],
    'backend-lead',
  );
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].startedAt, null);
  assert.strictEqual(runs[0].endedAt, ts(5));
  assert.strictEqual(runs[0].task, 'orphan');
}

// --- Other agents and event types are ignored; newest runs come first ---

{
  const runs = buildAgentRuns(
    [
      mkEvent({ ts: ts(0), event: 'agent_start', agent: 'qa-lead' }),
      mkEvent({ ts: ts(1), event: 'agent_stop', agent: 'qa-lead' }),
      mkEvent({ ts: ts(2), event: 'user_prompt', agent: '' }),
      mkEvent({ ts: ts(3), event: 'agent_start', task: 'old' }),
      mkEvent({ ts: ts(4), event: 'agent_stop' }),
      mkEvent({ ts: ts(5), event: 'agent_start', task: 'new' }),
      mkEvent({ ts: ts(6), event: 'agent_stop' }),
    ],
    'backend-lead',
  );
  assert.strictEqual(runs.length, 2, 'only this agent, only start/stop');
  assert.strictEqual(runs[0].task, 'new', 'newest first');
  assert.strictEqual(runs[1].task, 'old');
}

// --- The limit caps the returned history ---

{
  const events: AgentEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push(mkEvent({ ts: ts(i * 2), event: 'agent_start', task: `run ${i}` }));
    events.push(mkEvent({ ts: ts(i * 2 + 1), event: 'agent_stop' }));
  }
  const runs = buildAgentRuns(events, 'backend-lead', 3);
  assert.strictEqual(runs.length, 3, 'limit applied');
  assert.strictEqual(runs[0].task, 'run 9', 'limit keeps the newest');
}

console.log('All agentDetail tests passed.');
