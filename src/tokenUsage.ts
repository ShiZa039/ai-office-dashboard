/**
 * Token accounting straight from the agent CLI transcripts
 * (`~/.claude/projects/<slug>/<session>.jsonl`).
 *
 * Why not ccusage: the cost panel shells out to `npx ccusage` and is off by
 * default, while the transcripts already hold every `message.usage` block.
 * Reading them costs ~1s for a 250 MB history on the first pass and nothing
 * afterwards (each file is re-read only from its last byte offset), needs no
 * network and no subprocess.
 *
 * Two numbers are produced, both scoped to the window's project:
 *   - `session` — the current CLI session only.
 *   - `total`   — every session ever recorded for this project. Transcripts
 *     are eventually pruned by Claude Code, so totals of files that vanish are
 *     retired into a persisted bucket instead of silently dropping off.
 *
 * Each of the two is also split by model, since the same session routinely
 * mixes Opus with the Haiku behind background tasks.
 *
 * No vscode imports — unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CostParts, contextWindowTokens, costOfModels, costPartsOfModels, costUsd } from './pricing';

export interface TokenTotals {
  /** Plain (uncached) prompt tokens. */
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /**
   * The 1-hour-TTL share of `cacheCreate` (billed at 2× instead of 1.25×).
   * Optional: pre-v0.18 persisted totals don't carry it — treated as 0, i.e.
   * everything priced as the cheaper 5m writes.
   */
  cacheCreate1h?: number;
}

/**
 * A sum plus the same sum split by the model that spent it. Keys are the raw
 * ids carried by the transcript (`claude-opus-4-5-20251101`, `kimi-k2-…`);
 * they are folded into display names only when a snapshot is taken. `''` is
 * "model unknown" — entries with no model field, and everything counted before
 * the split existed.
 */
export interface ModelTotals {
  totals: TokenTotals;
  byModel: Record<string, TokenTotals>;
}

/**
 * A sum split by model and, independently, by the agent that spent it. Agent
 * keys are the `attributionAgent` the transcript carries ("Explore",
 * "general-purpose", custom roster names); `''` is the main chain — and, for
 * totals migrated from pre-v3 state, "agent unknown", since the split did not
 * exist yet.
 */
export interface AgentModelTotals extends ModelTotals {
  byAgent: Record<string, ModelTotals>;
}

/** One (cwd, session) slice of a transcript file. */
interface Bucket extends AgentModelTotals {
  cwd: string;
  session: string;
}

/** One model's share of a scope, ready to render. */
export interface ModelSlice {
  /** Display name, e.g. "Opus 4.5"; `''` when the model was not recorded. */
  model: string;
  totals: TokenTotals;
  /** API-list-price cost of this slice; null when the model is unpriced. */
  costUsd?: number | null;
}

/** One agent's share of a scope, with its own per-model split. */
export interface AgentSlice {
  /** Agent type as spawned ("Explore", …); `''` = the main chain. */
  agent: string;
  totals: TokenTotals;
  costUsd: number | null;
  byModel: ModelSlice[];
}

/** Size of one request's prompt — proxy for "how full is the context". */
interface ContextSample {
  ts: number;
  tokens: number;
  model: string;
}

interface FileState {
  /** Byte offset of the first not-yet-parsed line; transcripts only ever grow. */
  offset: number;
  buckets: Map<string, Bucket>;
  /** Newest entry timestamp seen per session, for "which session is current". */
  lastTs: Map<string, number>;
  /** Latest main-chain request per session (sidechains have their own context). */
  lastCtx: Map<string, ContextSample>;
  /**
   * `YYYY-MM-DD <cwd>` (day is fixed-width) → priced $ spent that day.
   * In-memory only (rebuilt by the full rescan on restart, like the buckets)
   * — feeds the 30-day figure.
   */
  days: Map<string, number>;
}

/** Shape persisted between windows/restarts (VSCode workspaceState). */
export interface PersistedTokenState {
  version: 3;
  /** cwd → tokens of transcripts that are gone from disk. */
  retired: Record<string, AgentModelTotals>;
  /** file path → its buckets, so a vanished file can be retired exactly once. */
  files: Record<string, Bucket[]>;
}

/** v2 knew models but not agents. */
export interface PersistedTokenStateV2 {
  version: 2;
  retired: Record<string, ModelTotals>;
  files: Record<string, (ModelTotals & { cwd: string; session: string })[]>;
}

/** v1 knew no models; its buckets and retired sums are plain `TokenTotals`. */
interface PersistedTokenStateV1 {
  version: 1;
  retired: Record<string, TokenTotals>;
  files: Record<string, { cwd: string; session: string; totals: TokenTotals }[]>;
}

/** Session context gauge: how full the model's window is right now. */
export interface ContextGauge {
  /** Prompt size of the session's latest request (input + both cache kinds). */
  tokens: number;
  /** Assumed window size for that model; null → unknown, no gauge. */
  window: number | null;
  /** Raw model id the sample came from. */
  model: string;
}

export interface TokenSnapshot {
  fetchedAt: string;
  /** null until a session of this project is known. */
  session: {
    id: string;
    totals: TokenTotals;
    byModel: ModelSlice[];
    byAgent: AgentSlice[];
    /** API-list-price cost of the session; null when nothing was priceable. */
    costUsd: number | null;
    /** The same cost split by billing lane (full price vs the cache lanes). */
    costParts: CostParts | null;
    context: ContextGauge | null;
  } | null;
  total: TokenTotals;
  /** Project-wide split, biggest spender first. */
  byModel: ModelSlice[];
  /** Project-wide split by agent, biggest spender first. */
  byAgent: AgentSlice[];
  /** API-list-price cost of the whole project (retired transcripts included). */
  totalCostUsd: number | null;
  /** The project-wide cost split by billing lane. */
  totalCostParts: CostParts | null;
  /**
   * Priced spend of the last 30 days (live transcripts only — files already
   * pruned by the CLI can't contribute). null until anything was priced.
   */
  last30dCostUsd: number | null;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cacheCreate1h: 0 };
}

export function addTotals(target: TokenTotals, add: TokenTotals): TokenTotals {
  target.input += add.input;
  target.output += add.output;
  target.cacheCreate += add.cacheCreate;
  target.cacheRead += add.cacheRead;
  target.cacheCreate1h = (target.cacheCreate1h ?? 0) + (add.cacheCreate1h ?? 0);
  return target;
}

/** Everything that was fed to the model: prompt + both kinds of cache traffic. */
export function incomingTokens(t: TokenTotals): number {
  return t.input + t.cacheCreate + t.cacheRead;
}

function emptyModelTotals(): ModelTotals {
  return { totals: emptyTotals(), byModel: {} };
}

/** Persisted sum → live one, accepting both the v1 (flat) and v2 shapes. */
function reviveModelTotals(entry: Partial<ModelTotals> & Partial<TokenTotals>): ModelTotals {
  const flat = !entry.totals;
  const totals = { ...emptyTotals(), ...((flat ? entry : entry.totals) as TokenTotals) };
  const byModel: Record<string, TokenTotals> = {};
  for (const [model, slice] of Object.entries(entry.byModel ?? {})) {
    byModel[model] = { ...emptyTotals(), ...slice };
  }
  // A v1 entry has a sum but no split; keeping it whole under "unknown" is what
  // makes the slices of a migrated state still add up to the total.
  if (!Object.keys(byModel).length) byModel[''] = { ...totals };
  return { totals, byModel };
}

/** Fold `add` into `target`, model split included. */
function addModelTotals(target: ModelTotals, add: ModelTotals): ModelTotals {
  addTotals(target.totals, add.totals);
  for (const [model, totals] of Object.entries(add.byModel)) {
    addModel(target, model, totals);
  }
  return target;
}

function emptyAgentModelTotals(): AgentModelTotals {
  return { ...emptyModelTotals(), byAgent: {} };
}

/**
 * Persisted sum → live one, agent split included. A pre-v3 entry has no
 * split; keeping it whole under the `''` agent is what makes the agent slices
 * of a migrated state still add up to the total.
 */
function reviveAgentModelTotals(
  entry: Partial<AgentModelTotals> & Partial<TokenTotals>,
): AgentModelTotals {
  const byAgent: Record<string, ModelTotals> = {};
  for (const [agent, slice] of Object.entries(entry.byAgent ?? {})) {
    byAgent[agent] = reviveModelTotals(slice);
  }
  if (!Object.keys(byAgent).length) byAgent[''] = reviveModelTotals(entry);
  return { ...reviveModelTotals(entry), byAgent };
}

/** Fold `add` into `target`, both splits included. */
function addAgentModelTotals(target: AgentModelTotals, add: AgentModelTotals): AgentModelTotals {
  addModelTotals(target, add);
  for (const [agent, totals] of Object.entries(add.byAgent)) {
    const slice = target.byAgent[agent] ?? emptyModelTotals();
    target.byAgent[agent] = addModelTotals(slice, totals);
  }
  return target;
}

/** Add one model's spend to a scope (the scope's own sum stays untouched). */
function addModel(target: ModelTotals, model: string, add: TokenTotals): void {
  const slice = target.byModel[model] ?? emptyTotals();
  target.byModel[model] = addTotals(slice, add);
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Transcript model id → what a human calls it: `claude-opus-4-5-20251101` and
 * `claude-3-5-haiku-20241022` both become "<Family> <version>". Anything that
 * is not a Claude id (Kimi and friends) is left exactly as it came, since we
 * have no naming rule we can trust for it.
 */
export function modelLabel(raw: string): string {
  if (!raw) return '';
  // Context-window suffixes like "claude-opus-5[1m]" are the same model.
  const parts = raw.toLowerCase().replace(/\[.*$/, '').split('-');
  const family = parts.findIndex((p) => MODEL_FAMILIES.includes(p));
  if (parts[0] !== 'claude' || family === -1) return raw;
  // Version digits sit either after the family ("opus-4-5") or before it
  // ("3-5-haiku"); a trailing release date is not a version.
  const digits = (from: number, to: number): string[] => {
    const out: string[] = [];
    for (const p of parts.slice(from, to)) {
      if (!/^\d{1,2}$/.test(p)) break;
      out.push(p);
    }
    return out;
  };
  const after = digits(family + 1, parts.length);
  const version = after.length ? after : digits(1, family);
  const name = parts[family][0].toUpperCase() + parts[family].slice(1);
  return version.length ? `${name} ${version.join('.')}` : name;
}

/** Raw-id buckets → display slices, biggest incoming spend first. */
function modelSlices(byModel: Record<string, TokenTotals>): ModelSlice[] {
  const merged = new Map<string, { totals: TokenTotals; costUsd: number | null }>();
  for (const [raw, totals] of Object.entries(byModel)) {
    const label = modelLabel(raw);
    const acc = merged.get(label) ?? { totals: emptyTotals(), costUsd: null };
    addTotals(acc.totals, totals);
    // Different raw ids can fold into one label; a priced id keeps its cost
    // even when an unpriced sibling folds in beside it.
    const c = costUsd(raw, totals);
    if (c !== null) acc.costUsd = (acc.costUsd ?? 0) + c;
    merged.set(label, acc);
  }
  return [...merged]
    .map(([model, acc]) => ({ model, totals: acc.totals, costUsd: acc.costUsd }))
    .filter((s) => incomingTokens(s.totals) > 0 || s.totals.output > 0)
    .sort((a, b) => incomingTokens(b.totals) - incomingTokens(a.totals));
}

/** Agent buckets → display slices, biggest incoming spend first. */
function agentSlices(byAgent: Record<string, ModelTotals>): AgentSlice[] {
  return Object.entries(byAgent)
    .map(([agent, mt]) => ({
      agent,
      totals: mt.totals,
      costUsd: costOfModels(mt.byModel),
      byModel: modelSlices(mt.byModel),
    }))
    .filter((s) => incomingTokens(s.totals) > 0 || s.totals.output > 0)
    .sort((a, b) => incomingTokens(b.totals) - incomingTokens(a.totals));
}

function normalizeCwd(p: string | undefined | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Claude Code's project-directory name: every non-alphanumeric character of
 * the cwd becomes a dash ("D:\Code projects\app" → "D--Code-projects-app").
 * Used only to skip directories that cannot belong to this workspace — the
 * authoritative check is the `cwd` field carried by each transcript entry.
 */
export function projectDirSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A line long enough to be corrupt rather than a real entry — give up on it. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class TokenScanner {
  private files = new Map<string, FileState>();
  /**
   * `messageId:requestId` of every counted entry. A single assistant message
   * is written once per content block (and copied wholesale into forked
   * sessions), each copy repeating the same cumulative usage — counting them
   * all would roughly double every number.
   */
  private keys = new Set<string>();
  private retired = new Map<string, AgentModelTotals>();
  /** Files known to a previous process; drained as this pass rediscovers them. */
  private known = new Map<string, Bucket[]>();
  private cwdFilters: string[] | null = null;
  private scanning = false;
  /** The user's Claude Code model selection, for sizing the context gauge. */
  private modelSelection: string | null = null;

  constructor(
    private root: string,
    state?: PersistedTokenState | PersistedTokenStateV2 | PersistedTokenStateV1,
  ) {
    // Pre-v3 states predate the model/agent splits: their numbers are still
    // exact, they just land under "model unknown" / "agent unknown".
    if (state && (state.version === 1 || state.version === 2 || state.version === 3)) {
      for (const [cwd, entry] of Object.entries(state.retired ?? {})) {
        this.retired.set(cwd, reviveAgentModelTotals(entry));
      }
      for (const [file, buckets] of Object.entries(state.files ?? {})) {
        this.known.set(
          file,
          buckets.map((b) => ({ cwd: b.cwd, session: b.session, ...reviveAgentModelTotals(b) })),
        );
      }
    }
  }

  /** Scope to the window's workspace folders; `null` counts every project. */
  setCwdFilter(cwd: string | string[] | null): void {
    const list = (Array.isArray(cwd) ? cwd : [cwd])
      .map((c) => normalizeCwd(c))
      .filter(Boolean);
    this.cwdFilters = list.length > 0 ? list : null;
  }

  /**
   * The model the user picked in Claude Code (`opus[1m]`, …). Transcripts
   * record the resolved id without the context-window marker, so this is what
   * tells a 1M session apart from a 200K one — see modelSelection.ts.
   */
  setModelSelection(selection: string | null): void {
    this.modelSelection = selection;
  }

  private matchesCwd(cwd: string): boolean {
    if (!this.cwdFilters) return true;
    if (!cwd) return false;
    return this.cwdFilters.some((f) => cwd === f || cwd.startsWith(f + '/'));
  }

  /**
   * Re-read whatever grew since the last pass. Concurrent calls are dropped:
   * the poll interval is far shorter than a cold scan of a large history.
   */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const { files, dirs } = await this.listFiles();
      for (const file of files) {
        await this.scanFile(file);
      }
      this.retireMissing(files, dirs);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Totals for the project, plus the given session's own slice. Pass the
   * session id the hooks reported; when it is unknown (or belongs to another
   * project) the most recently active session of this project is used.
   */
  snapshot(sessionId: string | null): TokenSnapshot {
    const total = emptyAgentModelTotals();
    const perSession = new Map<string, AgentModelTotals>();
    let newest: { id: string; ts: number } | null = null;

    for (const state of this.files.values()) {
      for (const bucket of state.buckets.values()) {
        if (!this.matchesCwd(bucket.cwd)) continue;
        addAgentModelTotals(total, bucket);
        if (!bucket.session) continue;
        const acc = perSession.get(bucket.session) ?? emptyAgentModelTotals();
        addAgentModelTotals(acc, bucket);
        perSession.set(bucket.session, acc);
        const ts = state.lastTs.get(bucket.session) ?? 0;
        if (!newest || ts > newest.ts) newest = { id: bucket.session, ts };
      }
    }
    for (const [cwd, retired] of this.retired) {
      if (this.matchesCwd(cwd)) addAgentModelTotals(total, retired);
    }

    const id = sessionId && perSession.has(sessionId) ? sessionId : (newest?.id ?? null);
    const session = id ? (perSession.get(id) ?? emptyAgentModelTotals()) : null;
    return {
      fetchedAt: new Date().toISOString(),
      session:
        id && session
          ? {
              id,
              totals: session.totals,
              byModel: modelSlices(session.byModel),
              byAgent: agentSlices(session.byAgent),
              costUsd: costOfModels(session.byModel),
              costParts: costPartsOfModels(session.byModel),
              context: this.contextFor(id),
            }
          : null,
      total: total.totals,
      byModel: modelSlices(total.byModel),
      byAgent: agentSlices(total.byAgent),
      totalCostUsd: costOfModels(total.byModel),
      totalCostParts: costPartsOfModels(total.byModel),
      last30dCostUsd: this.last30dCost(),
    };
  }

  /** Newest context sample of the session, across every file that mentions it. */
  private contextFor(sessionId: string): ContextGauge | null {
    let best: ContextSample | null = null;
    for (const state of this.files.values()) {
      const ctx = state.lastCtx.get(sessionId);
      if (ctx && (!best || ctx.ts > best.ts)) best = ctx;
    }
    if (!best) return null;
    return {
      tokens: best.tokens,
      window: contextWindowTokens(best.model, {
        selection: this.modelSelection,
        observedTokens: best.tokens,
      }),
      model: best.model,
    };
  }

  /** Priced spend of the last 30 calendar days across the project's live files. */
  private last30dCost(): number | null {
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    let sum = 0;
    let any = false;
    for (const state of this.files.values()) {
      for (const [key, usd] of state.days) {
        if (!this.matchesCwd(key.slice(11))) continue;
        const dayTs = Date.parse(key.slice(0, 10));
        if (Number.isNaN(dayTs) || dayTs < cutoff) continue;
        sum += usd;
        any = true;
      }
    }
    return any ? sum : null;
  }

  getState(): PersistedTokenState {
    const retired: Record<string, AgentModelTotals> = {};
    for (const [cwd, totals] of this.retired) retired[cwd] = totals;
    const files: Record<string, Bucket[]> = {};
    for (const [file, state] of this.files) files[file] = [...state.buckets.values()];
    // Files of other projects (this window never scans them) must survive, or
    // the next window to open that project would retire them a second time.
    for (const [file, buckets] of this.known) {
      if (!files[file]) files[file] = buckets;
    }
    return { version: 3, retired, files };
  }

  /** Transcript files under project dirs that could belong to this workspace. */
  private async listFiles(): Promise<{ files: string[]; dirs: Set<string> }> {
    const files: string[] = [];
    const dirs = new Set<string>();
    const slugs = this.cwdFilters?.map((c) => projectDirSlug(c).toLowerCase()) ?? null;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return { files, dirs };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // A subfolder or worktree of the workspace gets its own project dir whose
      // slug starts with the workspace's — keep those too.
      const name = entry.name.toLowerCase();
      if (slugs && !slugs.some((s) => name.startsWith(s))) continue;
      const dir = path.join(this.root, entry.name);
      dirs.add(dir);
      try {
        for (const item of await fs.promises.readdir(dir, { withFileTypes: true })) {
          if (item.isFile() && item.name.toLowerCase().endsWith('.jsonl')) {
            files.push(path.join(dir, item.name));
          } else if (item.isDirectory()) {
            // Subagent transcripts live in <session>/subagents/*.jsonl — their
            // entries carry the parent sessionId, so they fold right in.
            const sub = path.join(dir, item.name, 'subagents');
            try {
              for (const f of await fs.promises.readdir(sub)) {
                if (f.toLowerCase().endsWith('.jsonl')) files.push(path.join(sub, f));
              }
            } catch {
              // not a session dir (no subagents/) — nothing to read
            }
          }
        }
      } catch {
        // directory disappeared mid-scan — nothing to read
      }
    }
    return { files, dirs };
  }

  /**
   * The `<root>/<slug>` project dir a transcript belongs to: its parent for a
   * top-level session file, the great-grandparent for a file nested under
   * `<session>/subagents/`.
   */
  private projectDirOf(file: string): string {
    let dir = path.dirname(file);
    let parent = path.dirname(dir);
    while (parent !== this.root && parent !== dir) {
      dir = parent;
      parent = path.dirname(dir);
    }
    return dir;
  }

  /**
   * A transcript we tracked before but that is no longer on disk keeps its
   * tokens: they were really spent. Only files under project dirs this pass
   * actually looked at can be retired — everything else belongs to another
   * project and is none of this window's business. (The project dir is what
   * matters: a pruned session takes its whole `<session>/subagents/` tree
   * with it, so the vanished file's own parent dir is gone too.)
   */
  private retireMissing(seen: string[], dirs: Set<string>): void {
    const present = new Set(seen);
    for (const [file, buckets] of [...this.known]) {
      if (present.has(file) || !dirs.has(this.projectDirOf(file))) continue;
      for (const bucket of buckets) {
        const acc = this.retired.get(bucket.cwd) ?? emptyAgentModelTotals();
        addAgentModelTotals(acc, bucket);
        this.retired.set(bucket.cwd, acc);
      }
      this.known.delete(file);
    }
  }

  private async scanFile(file: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return;
    }
    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, buckets: new Map(), lastTs: new Map(), lastCtx: new Map(), days: new Map() };
      this.files.set(file, state);
      // Rediscovered — its persisted copy must no longer look "vanished".
      this.known.delete(file);
    }
    // Truncated or replaced: the offsets no longer mean anything, start over.
    if (size < state.offset) {
      state.offset = 0;
      state.buckets.clear();
      state.lastTs.clear();
      state.lastCtx.clear();
      state.days.clear();
    }
    if (size === state.offset) return;

    const start = state.offset;
    let pending = start;
    let leftover = Buffer.alloc(0);
    const stream = fs.createReadStream(file, { start });
    try {
      for await (const chunk of stream) {
        // `leftover` always begins exactly at byte `pending`, so the offset of
        // every complete line follows from how much of `buf` we consumed.
        const buf = Buffer.concat([leftover, chunk as Buffer]);
        let from = 0;
        let idx: number;
        while ((idx = buf.indexOf(0x0a, from)) !== -1) {
          this.handleLine(buf.subarray(from, idx).toString('utf-8'), state);
          from = idx + 1;
        }
        pending += from;
        leftover = Buffer.from(buf.subarray(from));
        if (leftover.length > MAX_LINE_BYTES) {
          pending += leftover.length;
          leftover = Buffer.alloc(0);
        }
      }
    } catch {
      // Locked or unreadable mid-write — keep what we parsed, retry next pass.
    }
    // The trailing partial line (a hook writing right now) is re-read next time.
    state.offset = pending;
  }

  private handleLine(text: string, state: FileState): void {
    if (text.indexOf('"usage"') === -1) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const message = entry.message as { usage?: Record<string, number>; id?: string; model?: string } | undefined;
    const usage = message?.usage;
    if (!usage || typeof usage !== 'object') return;
    // Local error placeholders carry a usage block with no real spend.
    if (message?.model === '<synthetic>') return;

    const id = typeof message?.id === 'string' ? message.id : '';
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
    if (id || requestId) {
      const key = `${id}:${requestId}`;
      if (this.keys.has(key)) return;
      this.keys.add(key);
    }

    const cwd = normalizeCwd(entry.cwd as string | undefined);
    const session = typeof entry.sessionId === 'string' ? entry.sessionId : '';
    const bucketKey = `${cwd}\u0000${session}`;
    let bucket = state.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { cwd, session, ...emptyAgentModelTotals() };
      state.buckets.set(bucketKey, bucket);
    }
    // Cache writes may carry a TTL split (5m is billed 1.25×, 1h is 2×).
    const cacheDetail = (usage as Record<string, unknown>).cache_creation as
      | Record<string, unknown>
      | undefined;
    const spend: TokenTotals = {
      input: Number(usage.input_tokens ?? 0) || 0,
      output: Number(usage.output_tokens ?? 0) || 0,
      cacheCreate: Number(usage.cache_creation_input_tokens ?? 0) || 0,
      cacheRead: Number(usage.cache_read_input_tokens ?? 0) || 0,
      cacheCreate1h: Number(cacheDetail?.ephemeral_1h_input_tokens ?? 0) || 0,
    };
    const model = typeof message?.model === 'string' ? message.model : '';
    addTotals(bucket.totals, spend);
    addModel(bucket, model, spend);

    // Which agent made the request: subagent entries carry their type in
    // `attributionAgent`; the main chain has no such field and lands in `''`.
    const agent = typeof entry.attributionAgent === 'string' ? entry.attributionAgent : '';
    const agentAcc = bucket.byAgent[agent] ?? emptyModelTotals();
    addTotals(agentAcc.totals, spend);
    addModel(agentAcc, model, spend);
    bucket.byAgent[agent] = agentAcc;

    const ts = Date.parse(String(entry.timestamp ?? ''));
    if (session && !Number.isNaN(ts) && ts > (state.lastTs.get(session) ?? 0)) {
      state.lastTs.set(session, ts);
    }

    // The $ spent this entry, attributed to the calendar day it happened.
    if (!Number.isNaN(ts)) {
      const c = costUsd(model, spend);
      if (c !== null && c > 0) {
        const day = new Date(ts).toISOString().slice(0, 10);
        const dayKey = `${day} ${cwd}`;
        state.days.set(dayKey, (state.days.get(dayKey) ?? 0) + c);
      }
    }

    // Context gauge: one request's prompt size ≈ how full the window is.
    // Sidechains (subagents) run their own context — only the main chain counts.
    const incoming = spend.input + spend.cacheCreate + spend.cacheRead;
    if (session && entry.isSidechain !== true && !Number.isNaN(ts) && incoming > 0) {
      const prev = state.lastCtx.get(session);
      if (!prev || ts >= prev.ts) {
        state.lastCtx.set(session, { ts, tokens: incoming, model });
      }
    }
  }
}
