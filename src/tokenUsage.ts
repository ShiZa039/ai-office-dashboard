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
 * No vscode imports — unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TokenTotals {
  /** Plain (uncached) prompt tokens. */
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

/** One (cwd, session) slice of a transcript file. */
interface Bucket {
  cwd: string;
  session: string;
  totals: TokenTotals;
}

interface FileState {
  /** Byte offset of the first not-yet-parsed line; transcripts only ever grow. */
  offset: number;
  buckets: Map<string, Bucket>;
  /** Newest entry timestamp seen per session, for "which session is current". */
  lastTs: Map<string, number>;
}

/** Shape persisted between windows/restarts (VSCode workspaceState). */
export interface PersistedTokenState {
  version: 1;
  /** cwd → tokens of transcripts that are gone from disk. */
  retired: Record<string, TokenTotals>;
  /** file path → its buckets, so a vanished file can be retired exactly once. */
  files: Record<string, Bucket[]>;
}

export interface TokenSnapshot {
  fetchedAt: string;
  /** null until a session of this project is known. */
  session: { id: string; totals: TokenTotals } | null;
  total: TokenTotals;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
}

export function addTotals(target: TokenTotals, add: TokenTotals): TokenTotals {
  target.input += add.input;
  target.output += add.output;
  target.cacheCreate += add.cacheCreate;
  target.cacheRead += add.cacheRead;
  return target;
}

/** Everything that was fed to the model: prompt + both kinds of cache traffic. */
export function incomingTokens(t: TokenTotals): number {
  return t.input + t.cacheCreate + t.cacheRead;
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
  private retired = new Map<string, TokenTotals>();
  /** Files known to a previous process; drained as this pass rediscovers them. */
  private known = new Map<string, Bucket[]>();
  private cwdFilters: string[] | null = null;
  private scanning = false;

  constructor(
    private root: string,
    state?: PersistedTokenState,
  ) {
    if (state && state.version === 1) {
      for (const [cwd, totals] of Object.entries(state.retired ?? {})) {
        this.retired.set(cwd, { ...emptyTotals(), ...totals });
      }
      for (const [file, buckets] of Object.entries(state.files ?? {})) {
        this.known.set(file, buckets);
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
    const total = emptyTotals();
    const perSession = new Map<string, TokenTotals>();
    let newest: { id: string; ts: number } | null = null;

    for (const state of this.files.values()) {
      for (const bucket of state.buckets.values()) {
        if (!this.matchesCwd(bucket.cwd)) continue;
        addTotals(total, bucket.totals);
        if (!bucket.session) continue;
        const acc = perSession.get(bucket.session) ?? emptyTotals();
        addTotals(acc, bucket.totals);
        perSession.set(bucket.session, acc);
        const ts = state.lastTs.get(bucket.session) ?? 0;
        if (!newest || ts > newest.ts) newest = { id: bucket.session, ts };
      }
    }
    for (const [cwd, totals] of this.retired) {
      if (this.matchesCwd(cwd)) addTotals(total, totals);
    }

    const id = sessionId && perSession.has(sessionId) ? sessionId : (newest?.id ?? null);
    return {
      fetchedAt: new Date().toISOString(),
      session: id ? { id, totals: perSession.get(id) ?? emptyTotals() } : null,
      total,
    };
  }

  getState(): PersistedTokenState {
    const retired: Record<string, TokenTotals> = {};
    for (const [cwd, totals] of this.retired) retired[cwd] = totals;
    const files: Record<string, Bucket[]> = {};
    for (const [file, state] of this.files) files[file] = [...state.buckets.values()];
    // Files of other projects (this window never scans them) must survive, or
    // the next window to open that project would retire them a second time.
    for (const [file, buckets] of this.known) {
      if (!files[file]) files[file] = buckets;
    }
    return { version: 1, retired, files };
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
        for (const file of await fs.promises.readdir(dir)) {
          if (file.toLowerCase().endsWith('.jsonl')) files.push(path.join(dir, file));
        }
      } catch {
        // directory disappeared mid-scan — nothing to read
      }
    }
    return { files, dirs };
  }

  /**
   * A transcript we tracked before but that is no longer on disk keeps its
   * tokens: they were really spent. Only files under directories this pass
   * actually looked at can be retired — everything else belongs to another
   * project and is none of this window's business.
   */
  private retireMissing(seen: string[], dirs: Set<string>): void {
    const present = new Set(seen);
    for (const [file, buckets] of [...this.known]) {
      if (present.has(file) || !dirs.has(path.dirname(file))) continue;
      for (const bucket of buckets) {
        const acc = this.retired.get(bucket.cwd) ?? emptyTotals();
        addTotals(acc, bucket.totals);
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
      state = { offset: 0, buckets: new Map(), lastTs: new Map() };
      this.files.set(file, state);
      // Rediscovered — its persisted copy must no longer look "vanished".
      this.known.delete(file);
    }
    // Truncated or replaced: the offsets no longer mean anything, start over.
    if (size < state.offset) {
      state.offset = 0;
      state.buckets.clear();
      state.lastTs.clear();
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
      bucket = { cwd, session, totals: emptyTotals() };
      state.buckets.set(bucketKey, bucket);
    }
    bucket.totals.input += Number(usage.input_tokens ?? 0) || 0;
    bucket.totals.output += Number(usage.output_tokens ?? 0) || 0;
    bucket.totals.cacheCreate += Number(usage.cache_creation_input_tokens ?? 0) || 0;
    bucket.totals.cacheRead += Number(usage.cache_read_input_tokens ?? 0) || 0;

    if (session) {
      const ts = Date.parse(String(entry.timestamp ?? ''));
      if (!Number.isNaN(ts) && ts > (state.lastTs.get(session) ?? 0)) {
        state.lastTs.set(session, ts);
      }
    }
  }
}
