import { codexPrice } from './codexPricing';
import { costPartsAtPrice, emptyCostParts } from './pricing';
import type { CostParts } from './pricing';
import { addTotals, emptyTotals, incomingTokens } from './tokenUsage';
import type { AgentSlice, ModelSlice, TokenSnapshot, TokenTotals } from './tokenUsage';

type JsonRecord = Record<string, unknown>;
export type CodexTokenSnapshot = Omit<TokenSnapshot, 'last30dCostUsd'>;

interface ModelUsage {
  totals: TokenTotals;
  cost: CostParts | null;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenTotals(value: unknown): TokenTotals | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as JsonRecord;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input === undefined || output === undefined) return null;
  const cacheRead = Math.min(input, tokenCount(usage.cached_input_tokens) ?? 0);
  const cacheCreate = Math.min(input - cacheRead, tokenCount(usage.cache_write_input_tokens) ?? 0);
  // Reasoning tokens are already part of cumulative output_tokens.
  return { input: input - cacheRead - cacheCreate, output, cacheRead, cacheCreate };
}

function delta(current: TokenTotals, previous: TokenTotals): TokenTotals {
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    cacheCreate: current.cacheCreate - previous.cacheCreate,
    cacheRead: current.cacheRead - previous.cacheRead,
  };
}

function mergeCost(target: CostParts | null, add: CostParts | null): CostParts | null {
  if (!add) return target;
  const sum = target ?? emptyCostParts();
  sum.input += add.input;
  sum.output += add.output;
  sum.cacheRead += add.cacheRead;
  sum.cacheWrite += add.cacheWrite;
  sum.total += add.total;
  return sum;
}

class UsageByModel {
  private readonly models = new Map<string, ModelUsage>();

  add(model: string, totals: TokenTotals, cost: CostParts | null): void {
    const slice = this.models.get(model) ?? { totals: emptyTotals(), cost: null };
    addTotals(slice.totals, totals);
    slice.cost = mergeCost(slice.cost, cost);
    this.models.set(model, slice);
  }

  merge(other: UsageByModel): void {
    for (const [model, slice] of other.models) this.add(model, slice.totals, slice.cost);
  }

  summarize(): { totals: TokenTotals; cost: CostParts | null; byModel: ModelSlice[] } {
    const totals = emptyTotals();
    let cost: CostParts | null = null;
    const byModel = [...this.models].map(([model, slice]) => {
      addTotals(totals, slice.totals);
      cost = mergeCost(cost, slice.cost);
      return { model, totals: slice.totals, costUsd: slice.cost?.total ?? null };
    }).sort((a, b) => incomingTokens(b.totals) - incomingTokens(a.totals));
    return { totals, cost, byModel };
  }
}

export class CodexThreadUsage {
  readonly models = new UsageByModel();
  lastAt = '';
  private previous: TokenTotals | null = null;
  private ownTurn = false;
  private model = '';

  constructor(
    private readonly createdAt: number,
    private readonly legacyFork: boolean,
    private readonly inheritedUntil: number | undefined,
    private readonly openAiProvider: boolean,
  ) {}

  consume(type: unknown, payload: JsonRecord, at: string, ordinal: number | undefined): void {
    const started = type === 'event_msg' && ['task_started', 'turn_started'].includes(String(payload.type));
    const counted = type === 'event_msg' && payload.type === 'token_count';
    if (!started && !counted && type !== 'turn_context') return;
    if (this.legacyFork && started) {
      const seconds = tokenCount(payload.started_at);
      const id = typeof payload.turn_id === 'string' ? payload.turn_id : '';
      const uuidTime = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(id)
        ? parseInt(id.slice(0, 13).replace('-', ''), 16) : undefined;
      this.ownTurn = uuidTime !== undefined ? uuidTime >= this.createdAt
        : seconds !== undefined && seconds >= Math.floor(this.createdAt / 1000);
    }
    const inherited = Date.parse(at) < this.createdAt ||
      (ordinal !== undefined && this.inheritedUntil !== undefined && ordinal < this.inheritedUntil) ||
      (this.legacyFork && !this.ownTurn);
    if (type === 'turn_context' && !inherited && typeof payload.model === 'string') this.model = payload.model;
    if (!counted) return;
    if (!payload.info || typeof payload.info !== 'object') return;
    const info = payload.info as JsonRecord;
    const total = tokenTotals(info.total_token_usage);
    if (!total) return;
    const previous = this.previous;
    // Quota and context events can repeat the same cumulative token count.
    if (previous && incomingTokens(previous) === incomingTokens(total) && previous.output === total.output) return;
    this.previous = total;
    if (inherited) return;
    const last = tokenTotals(info.last_token_usage);
    let spend = previous ? delta(total, previous) : total;
    // Codex can resume a thread with a restarted cumulative counter.
    // A legacy fork with no recorded inherited baseline may start from its parent's total.
    if (Object.values(spend).some((count) => count < 0) || (!previous && this.legacyFork)) {
      if (!last) return;
      spend = last;
      if (info.last_usage_includes_reasoning === false) {
        const lastUsage = info.last_token_usage as JsonRecord;
        spend.output += tokenCount(lastUsage.reasoning_output_tokens) ?? 0;
      }
    }
    if (!incomingTokens(spend) && !spend.output) return;
    const price = this.openAiProvider ? codexPrice(this.model) : undefined;
    this.models.add(this.model, spend, price ? costPartsAtPrice(price, spend) : null);
    this.lastAt = at;
  }
}

export interface CodexTokenThread {
  session: string;
  agent: string;
  usage: CodexThreadUsage;
}

function summarize(threads: CodexTokenThread[]) {
  const all = new UsageByModel();
  const agents = new Map<string, UsageByModel>();
  for (const thread of threads) {
    all.merge(thread.usage.models);
    const agent = agents.get(thread.agent) ?? new UsageByModel();
    agent.merge(thread.usage.models);
    agents.set(thread.agent, agent);
  }
  const byAgent: AgentSlice[] = [...agents].map(([agent, usage]) => {
    const { totals, cost, byModel } = usage.summarize();
    return { agent, totals, costUsd: cost?.total ?? null, byModel };
  }).sort((a, b) => incomingTokens(b.totals) - incomingTokens(a.totals));
  return { ...all.summarize(), byAgent };
}

export function codexTokenSnapshot(threads: CodexTokenThread[]): CodexTokenSnapshot | null {
  const newest = threads.reduce<CodexTokenThread | undefined>(
    (latest, thread) => !latest || thread.usage.lastAt > latest.usage.lastAt ? thread : latest, undefined);
  if (!newest) return null;
  const project = summarize(threads);
  const current = summarize(threads.filter((thread) => thread.session === newest.session));
  return {
    fetchedAt: newest.usage.lastAt,
    session: {
      id: newest.session, totals: current.totals, byModel: current.byModel, byAgent: current.byAgent,
      costUsd: current.cost?.total ?? null, costParts: current.cost, context: null,
    },
    total: project.totals, byModel: project.byModel, byAgent: project.byAgent,
    totalCostUsd: project.cost?.total ?? null, totalCostParts: project.cost,
  };
}
