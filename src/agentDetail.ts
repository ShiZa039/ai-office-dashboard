import { AgentEvent, AgentRun } from './types';

/** Default cap of runs handed to the drill-down drawer. */
const RUNS_LIMIT = 50;

/**
 * Pair one agent's start/stop events into runs for the drill-down drawer.
 *
 * Events carry no instance id, so parallel same-type agents interleave in the
 * log; stops are matched FIFO (oldest open run closes first). A stop whose
 * start fell out of the history cap becomes a run with `startedAt: null`.
 *
 * Input is expected in chronological order (the store's recentEvents are);
 * the result is newest-first.
 */
export function buildAgentRuns(
  events: AgentEvent[],
  agentName: string,
  limit: number = RUNS_LIMIT,
): AgentRun[] {
  const open: AgentRun[] = [];
  const done: AgentRun[] = [];

  for (const event of events) {
    if (event.agent !== agentName) continue;
    if (event.event === 'agent_start') {
      open.push({ startedAt: event.ts, endedAt: null, task: event.task });
    } else if (event.event === 'agent_stop') {
      const run = open.shift() ?? { startedAt: null, endedAt: null };
      run.endedAt = event.ts;
      run.result = event.result;
      if (run.task === undefined) run.task = event.task;
      done.push(run);
    }
  }

  // Newest first: still-open runs (they're the most recent starts) on top.
  return [...open.reverse(), ...done.reverse()].slice(0, limit);
}
