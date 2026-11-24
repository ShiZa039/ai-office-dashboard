import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SubscriptionSnapshot, UsageLimitEntry } from './subscriptionUsage';
import type { AgentDetail, AgentRun, AgentState } from './types';
import { withPace } from './usagePace';
import { CodexThreadUsage, codexTokenSnapshot } from './codexUsage';
import type { CodexTokenSnapshot, CodexTokenThread } from './codexUsage';
import type { CodexMainSession } from './quotaProvider';

const ACTIVITY_MS = 20 * 60_000;
const FINISHED_MS = 15_000;
const HISTORY_MS = 8 * 24 * 60 * 60_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RUNS = 50;

type RecordValue = Record<string, unknown>;
type Quota = { at: string; plan: string | null; limits: UsageLimitEntry[] };
type Turn = AgentRun & { id?: string };

interface Rollout {
  offset: number;
  ino: number;
  mtime: number;
  size: number;
  pending: Buffer;
  droppingLine: boolean;
  id: string;
  archived: boolean;
  session?: string;
  parent?: string;
  usage?: CodexThreadUsage;
  account?: string;
  cwd: string;
  role?: string;
  subagent: boolean;
  createdAt: number;
  lastActivity: string;
  model?: string;
  turns: Turn[];
  quotas: Map<string, Quota>;
}

function object(value: unknown): RecordValue {
  return value && typeof value === 'object' ? value as RecordValue : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readQuota(value: unknown, at: string, quotas: Map<string, Quota>): void {
  const data = object(value);
  const id = string(data.limit_id) ?? 'codex';
  if (!/^[a-z\d_.-]+$/i.test(id)) return;
  const name = (string(data.limit_name) ?? id).slice(0, 80);
  const limits: UsageLimitEntry[] = [];
  for (const slot of ['primary', 'secondary']) {
    const window = object(data[slot]);
    const utilization = number(window.used_percent);
    if (utilization === undefined || utilization < 0) continue;
    const durationMinutes = number(window.window_minutes);
    const minutes = durationMinutes && durationMinutes > 0 ? durationMinutes : undefined;
    const reset = number(window.resets_at);
    const duration = minutes === 10080 ? '7d' : minutes && minutes % 60 === 0
      ? `${minutes / 60}h` : minutes ? `${minutes}m` : slot;
    limits.push({
      kind: `${id}:${slot}`,
      label: id === 'codex' ? duration : `${name} · ${duration}`,
      utilization: Math.min(100, utilization),
      resetsAt: reset && Math.abs(reset) <= 8.64e12 ? new Date(reset * 1000).toISOString() : null,
      windowMinutes: minutes,
    });
  }
  const prior = quotas.get(id);
  if (limits.length && (!prior || at >= prior.at)) {
    quotas.set(id, { at, plan: string(data.plan_type) ?? null, limits });
  }
}

function consume(line: Buffer, rollout: Rollout): void {
  let item: RecordValue;
  try {
    item = object(JSON.parse(line.toString('utf8')));
  } catch {
    return;
  }
  const payload = object(item.payload);
  const time = Date.parse(string(item.timestamp) ?? '');
  if (!Number.isFinite(time)) return;
  const at = new Date(time).toISOString();

  if (item.type === 'session_meta' && !rollout.id) {
    rollout.id = string(payload.id) ?? '';
    rollout.cwd = string(payload.cwd) ?? '';
    const account = string(payload.creator_account_id);
    if (account) rollout.account = JSON.stringify([account, string(payload.creator_user_id)]);
    rollout.createdAt = Date.parse(string(payload.timestamp) ?? '') || time;
    const source = object(payload.source);
    const spawn = object(object(source.subagent).thread_spawn);
    rollout.parent = string(payload.parent_thread_id) ?? string(spawn.parent_thread_id);
    rollout.session = string(payload.session_id);
    rollout.subagent = !!(source.subagent || rollout.parent);
    rollout.role = string(spawn.agent_nickname) ?? string(payload.agent_nickname) ??
      string(spawn.agent_role) ?? string(payload.agent_role);
    const historyBase = object(payload.history_base);
    const cutoff = number(payload.subagent_history_start_ordinal) ?? number(payload.forked_from_ordinal_exclusive);
    const legacyFork = !!(rollout.parent || payload.forked_from_id) &&
      payload.history_mode !== 'paginated' && !historyBase.thread_id;
    rollout.usage = new CodexThreadUsage(
      rollout.createdAt, legacyFork, cutoff, !payload.model_provider || payload.model_provider === 'openai',
    );
    return;
  }
  rollout.usage?.consume(item.type, payload, at, number(item.ordinal));
  if (!rollout.id || rollout.archived || time < rollout.createdAt) return;
  if (item.type === 'turn_context') rollout.model = string(payload.model) ?? rollout.model;
  if (item.type === 'event_msg' && payload.type === 'thread_settings_applied') {
    rollout.model = string(object(payload.thread_settings).model) ?? rollout.model;
  }
  if (item.type === 'event_msg' && payload.type === 'token_count' && payload.rate_limits) {
    readQuota(payload.rate_limits, at, rollout.quotas);
  }

  if (item.type === 'event_msg') {
    const turnId = string(payload.turn_id);
    const current = rollout.turns[0];
    const started = payload.type === 'task_started' || payload.type === 'turn_started';
    const aborted = payload.type === 'turn_aborted';
    const finished = payload.type === 'task_complete' || payload.type === 'turn_complete' || aborted;
    // Older forks can copy the parent's turns with fresh envelope timestamps.
    const eventSeconds = number(started ? payload.started_at : payload.completed_at);
    if ((started || finished) && eventSeconds !== undefined &&
      eventSeconds < Math.floor(rollout.createdAt / 1000)) return;
    if (started && (!current || current.id !== turnId || !turnId)) {
      // A recovered start supersedes an unmatched start from an interrupted process.
      if (current && !current.endedAt) current.endedAt = at;
      rollout.turns.unshift({ id: turnId, startedAt: at, endedAt: null });
      if (rollout.turns.length > MAX_RUNS) rollout.turns.pop();
    } else if (finished) {
      const turn = turnId ? rollout.turns.find((candidate) => candidate.id === turnId) : current;
      const result = payload.error || (aborted && !['interrupted', 'budget_limited'].includes(String(payload.reason)))
        ? 'error' : undefined;
      if (turn) {
        turn.endedAt = at;
        turn.result = result;
      } else if (!current || current.endedAt) {
        rollout.turns.unshift({ id: turnId, startedAt: null, endedAt: at, result });
        if (rollout.turns.length > MAX_RUNS) rollout.turns.pop();
      }
    }
  }
  if (rollout.turns[0] && at > rollout.lastActivity) rollout.lastActivity = at;
}

/** Read only appended bytes. Keep an unfinished line until Codex writes its newline. */
async function readRollout(file: string, rollout: Rollout, size: number): Promise<void> {
  if (rollout.offset >= size) return;
  for await (const chunk of fs.createReadStream(file, { start: rollout.offset, end: size - 1 })) {
    const bytes = chunk as Buffer;
    let start = 0;
    for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, start)) {
      const part = bytes.subarray(start, newline);
      if (!rollout.droppingLine && rollout.pending.length + part.length <= MAX_LINE_BYTES) {
        consume(rollout.pending.length ? Buffer.concat([rollout.pending, part]) : part, rollout);
      }
      rollout.pending = Buffer.alloc(0);
      rollout.droppingLine = false;
      start = newline + 1;
    }
    if (!rollout.droppingLine && start < bytes.length) {
      if (rollout.pending.length + bytes.length - start > MAX_LINE_BYTES) {
        rollout.pending = Buffer.alloc(0);
        rollout.droppingLine = true;
      } else {
        rollout.pending = Buffer.concat([rollout.pending, bytes.subarray(start)]);
      }
    }
    rollout.offset += bytes.length;
  }
}

async function* rolloutFiles(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) yield* rolloutFiles(full);
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield full;
  }
}

function inScope(cwd: string, folders: string[] | null): boolean {
  if (!folders?.length) return true;
  return !!cwd && folders.some((folder) => {
    const relative = path.relative(folder, cwd);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
}

/** Local, read-only telemetry for Codex CLI and editor sessions. */
export class CodexActivity {
  private readonly rollouts = new Map<string, Rollout>();
  private clearedAt = 0;

  constructor(
    private readonly sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    private readonly archive = path.join(path.dirname(sessions), 'archived_sessions'),
  ) {}

  async poll(now = Date.now(), includeUsage = false): Promise<void> {
    const seen = new Set<string>();
    await this.scan(this.sessions, seen, includeUsage ? -Infinity : now - HISTORY_MS);
    if (includeUsage) await this.scan(this.archive, seen, -Infinity, true);
    for (const file of this.rollouts.keys()) {
      if (!seen.has(file)) this.rollouts.delete(file);
    }
  }

  private async scan(dir: string, seen: Set<string>, minMtime: number, archived = false): Promise<void> {
    for await (const file of rolloutFiles(dir)) {
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < minMtime) continue;
        seen.add(file);
        let rollout = this.rollouts.get(file);
        if (!rollout || stat.ino !== rollout.ino || stat.size < rollout.size ||
          (stat.size === rollout.size && stat.mtimeMs !== rollout.mtime)) {
          rollout = {
            offset: 0, ino: stat.ino, mtime: 0, size: 0, pending: Buffer.alloc(0), droppingLine: false,
            id: '', archived, cwd: '', subagent: false, createdAt: 0, lastActivity: '', turns: [], quotas: new Map(),
          };
          this.rollouts.set(file, rollout);
        }
        await readRollout(file, rollout, stat.size);
        rollout.mtime = stat.mtimeMs;
        rollout.size = stat.size;
      } catch {
        // A rollout can be rotated or temporarily inaccessible during a scan.
      }
    }
  }

  clearActivity(now = Date.now()): void {
    this.clearedAt = now;
  }

  latestMainSession(folders: string[] | null): CodexMainSession | null {
    let latest: CodexMainSession | null = null;
    for (const rollout of this.rollouts.values()) {
      if (rollout.archived || rollout.subagent || !inScope(rollout.cwd, folders)) continue;
      const turn = rollout.turns[0];
      const at = turn ? Date.parse(turn.startedAt ?? turn.endedAt ?? '') : rollout.createdAt;
      if ((turn || rollout.model) && at > this.clearedAt && (!latest || at > latest.at)) {
        latest = { at, model: rollout.model ?? null };
      }
    }
    return latest;
  }

  agents(folders: string[] | null, roomFor: (role: string) => string, now = Date.now()): Map<string, AgentDetail> {
    const agents = new Map<string, AgentDetail>();
    for (const rollout of this.rollouts.values()) {
      const last = Date.parse(rollout.lastActivity);
      if (!inScope(rollout.cwd, folders) || !Number.isFinite(last) || now - last > ACTIVITY_MS) continue;
      const turns = rollout.turns.filter((turn) => Date.parse(turn.startedAt ?? turn.endedAt ?? '') > this.clearedAt);
      const turn = turns[0];
      if (!turn) continue;
      const name = rollout.subagent ? `Codex · ${(rollout.role ?? 'worker').slice(0, 60)}` : 'Codex';
      const state: AgentState = {
        name,
        state: !turn.endedAt ? 'working' : now - Date.parse(turn.endedAt) < FINISHED_MS
          ? turn.result === 'error' ? 'error' : 'done' : 'idle',
        room: rollout.subagent ? roomFor(rollout.role ?? 'worker') : 'directors',
        lastActivity: rollout.lastActivity,
        task: rollout.model,
      };
      const id = `codex:${rollout.id}`;
      agents.set(id, {
        id, name, state, runs: turns.map(({ startedAt, endedAt, result }) => ({ startedAt, endedAt, result })),
      });
    }
    return agents;
  }

  tokens(folders: string[] | null): CodexTokenSnapshot | null {
    const byId = new Map<string, Rollout>();
    for (const thread of this.rollouts.values()) {
      const prior = byId.get(thread.id);
      if (thread.id && (!prior || (thread.usage?.lastAt ?? '') > (prior.usage?.lastAt ?? ''))) {
        byId.set(thread.id, thread);
      }
    }
    const threads: CodexTokenThread[] = [];
    for (const thread of byId.values()) {
      const usage = thread.usage;
      if (!usage?.lastAt) continue;
      let root = thread;
      const visited = new Set([thread.id]);
      while (root.parent && !visited.has(root.parent)) {
        const parent = byId.get(root.parent);
        if (!parent) break;
        visited.add(parent.id);
        root = parent;
      }
      const rootSession = root.session && root.session !== root.id ? root.session : root.parent ?? root.id;
      const session = thread.session && thread.session !== thread.id ? thread.session : rootSession;
      if (!inScope(byId.get(session)?.cwd ?? root.cwd, folders)) continue;
      threads.push({ session, usage, agent: thread.subagent ? thread.role ?? 'worker' : '' });
    }
    return codexTokenSnapshot(threads);
  }

  quota(now = Date.now()): SubscriptionSnapshot | null {
    const accounts = new Map<string | undefined, Map<string, Quota>>();
    let newest = '';
    let latestAccount: string | undefined;
    for (const rollout of this.rollouts.values()) {
      for (const [id, quota] of rollout.quotas) {
        let latest = accounts.get(rollout.account);
        if (!latest) {
          latest = new Map();
          accounts.set(rollout.account, latest);
        }
        const prior = latest.get(id);
        if (!prior || quota.at > prior.at) latest.set(id, quota);
        if (quota.at > newest) {
          newest = quota.at;
          latestAccount = rollout.account;
        }
      }
    }
    const latest = accounts.get(latestAccount);
    if (!latest) return null;
    const buckets = [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
    const current = buckets.map((bucket) => {
      const recordedAt = Date.parse(bucket.at);
      const limits = bucket.limits.filter((limit) => limit.resetsAt
        ? Date.parse(limit.resetsAt) > now : now - recordedAt < ACTIVITY_MS);
      return withPace({ fetchedAt: bucket.at, plan: bucket.plan, limits }, recordedAt);
    }).filter((bucket) => bucket.limits.length);
    if (!current.length) return null;
    return {
      fetchedAt: current[0].fetchedAt,
      provider: 'codex',
      plan: current[0].plan,
      limits: current.flatMap((bucket) => bucket.limits),
    };
  }
}
