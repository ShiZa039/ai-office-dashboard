/**
 * Real subscription usage (Pro/Max plan limits) via the same OAuth endpoint
 * Claude Code's own /usage command uses: GET api.anthropic.com/api/oauth/usage.
 * Returns utilization percentages (0–100) and reset timestamps for the rolling
 * 5-hour window, the weekly cap, and (on Max plans) the weekly Opus cap.
 *
 * Credentials come from Claude Code's own login (~/.claude/.credentials.json;
 * macOS keychain fallback). We never refresh tokens ourselves — if the token
 * is expired, any Claude Code session refreshes it.
 *
 * The watcher is provider-agnostic (see UsageProviderConfig); the Kimi Code
 * provider lives in kimiUsage.ts.
 *
 * No vscode imports — unit-testable; wiring lives in extension.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// The endpoint expects a Claude Code user agent; other agents hit a strict rate bucket.
const USER_AGENT = 'claude-code/2.1.0';

export interface UsageLimitEntry {
  /** Limit kind as reported: session | weekly_all | weekly_scoped | ... */
  kind: string;
  /** Human-readable bar label, e.g. "Session (5h)" / "Week (all)" / "Week (Opus)". */
  label: string;
  /** Percent of the limit used, 0–100. */
  utilization: number;
  /** ISO timestamp when this window resets, if reported. */
  resetsAt: string | null;
}

export interface SubscriptionSnapshot {
  fetchedAt: string;
  /** Which provider this snapshot belongs to (set by the watcher, not parsers). */
  provider?: 'claude' | 'kimi';
  /** Raw subscription type from credentials, e.g. "pro" / "max". */
  plan: string | null;
  limits: UsageLimitEntry[];
}

export interface OAuthCredentials {
  accessToken: string;
  /** Epoch millis, if reported. */
  expiresAt: number | null;
  subscriptionType: string | null;
}

export function parseCredentials(json: unknown): OAuthCredentials | null {
  const oauth = (json as Record<string, unknown> | null | undefined)?.claudeAiOauth as
    | Record<string, unknown>
    | undefined;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType:
      typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function labelForKind(kind: string, scope: unknown): string {
  if (kind === 'session') return 'Session (5h)';
  if (kind === 'weekly_all') return 'Week (all)';
  if (kind === 'weekly_scoped') {
    const model = (scope as { model?: { display_name?: unknown } } | null | undefined)?.model
      ?.display_name;
    return typeof model === 'string' && model ? `Week (${model})` : 'Week (model)';
  }
  return kind.replace(/_/g, ' ');
}

/**
 * Parse the /api/oauth/usage response defensively; null if nothing usable.
 * Prefers the `limits` array (kind/percent/resets_at, model-scoped weekly
 * limits carry the model name); falls back to the older flat
 * five_hour/seven_day/seven_day_opus shape.
 */
export function parseUsageResponse(
  json: unknown,
  plan: string | null,
  fetchedAt: string,
): SubscriptionSnapshot | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const out: UsageLimitEntry[] = [];

  if (Array.isArray(o.limits)) {
    for (const item of o.limits) {
      if (!item || typeof item !== 'object') continue;
      const l = item as Record<string, unknown>;
      if (typeof l.kind !== 'string' || typeof l.percent !== 'number' || Number.isNaN(l.percent)) {
        continue;
      }
      out.push({
        kind: l.kind,
        label: labelForKind(l.kind, l.scope),
        utilization: clampPct(l.percent),
        resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
      });
    }
  }

  if (out.length === 0) {
    const flat: Array<[string, string, unknown]> = [
      ['session', 'Session (5h)', o.five_hour],
      ['weekly_all', 'Week (all)', o.seven_day],
      ['weekly_scoped', 'Week (Opus)', o.seven_day_opus],
    ];
    for (const [kind, label, value] of flat) {
      if (!value || typeof value !== 'object') continue;
      const w = value as Record<string, unknown>;
      if (typeof w.utilization !== 'number' || Number.isNaN(w.utilization)) continue;
      out.push({
        kind,
        label,
        utilization: clampPct(w.utilization),
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
      });
    }
  }

  if (out.length === 0) return null;
  return { fetchedAt, plan, limits: out };
}

/** Read Claude Code OAuth credentials from disk (or the macOS keychain). */
export function readCredentials(homeDir: string = os.homedir()): OAuthCredentials | null {
  const file = path.join(homeDir, '.claude', '.credentials.json');
  try {
    const creds = parseCredentials(JSON.parse(fs.readFileSync(file, 'utf-8')));
    if (creds) return creds;
  } catch {
    // fall through to keychain
  }
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8', timeout: 5000 },
      );
      if (r.status === 0 && r.stdout.trim()) {
        return parseCredentials(JSON.parse(r.stdout.trim()));
      }
    } catch {
      // no keychain entry
    }
  }
  return null;
}

export interface ProviderCredentials {
  accessToken: string;
  /** Epoch millis, if reported. */
  expiresAt: number | null;
  /** Plan label for the UI, e.g. "max" / "intermediate". */
  plan: string | null;
}

/** Everything the watcher needs to poll one provider's usage endpoint. */
export interface UsageProviderConfig {
  id: 'claude' | 'kimi';
  url: string;
  headers: (accessToken: string) => Record<string, string>;
  readCredentials: () => ProviderCredentials | null;
  parse: (body: unknown, plan: string | null, fetchedAt: string) => SubscriptionSnapshot | null;
  messages: {
    /** null = optional provider — stay silent when it was never logged in. */
    noCredentials: string | null;
    /** null = expiry is routine (short-lived tokens) — keep last data, just log. */
    expired: string | null;
    unauthorized: string;
  };
}

export const claudeUsageProvider: UsageProviderConfig = {
  id: 'claude',
  url: USAGE_URL,
  headers: (accessToken) => ({
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  }),
  readCredentials: () => {
    const c = readCredentials();
    return c && { accessToken: c.accessToken, expiresAt: c.expiresAt, plan: c.subscriptionType };
  },
  parse: parseUsageResponse,
  messages: {
    noCredentials:
      'no Claude Code login found — sign in to Claude Code (Pro/Max) to see plan limits',
    // Expiry is routine — any Claude Code session refreshes the token. Keep last
    // data on screen and just log, like the Kimi provider does.
    expired: null,
    unauthorized: 'not authorized — re-login in Claude Code to refresh credentials',
  },
};

export interface SubscriptionWatcherOptions {
  intervalMs: number;
  onUpdate: (snapshot: SubscriptionSnapshot) => void;
  onError: (message: string) => void;
  log?: (message: string) => void;
}

export class SubscriptionUsageWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private config: UsageProviderConfig,
    private opts: SubscriptionWatcherOptions,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const cfg = this.config;
    try {
      const creds = cfg.readCredentials();
      if (!creds) {
        if (cfg.messages.noCredentials) this.opts.onError(cfg.messages.noCredentials);
        return;
      }
      if (creds.expiresAt && creds.expiresAt < Date.now()) {
        if (cfg.messages.expired) this.opts.onError(cfg.messages.expired);
        else this.opts.log?.(`[subscription:${cfg.id}] token expired, will retry next poll`);
        return;
      }
      const res = await fetch(cfg.url, { headers: cfg.headers(creds.accessToken) });
      if (res.status === 401 || res.status === 403) {
        this.opts.onError(cfg.messages.unauthorized);
        return;
      }
      if (res.status === 429) {
        this.opts.log?.(`[subscription:${cfg.id}] rate limited (429), will retry next poll`);
        return; // keep last good data on screen
      }
      if (!res.ok) {
        this.opts.onError(`usage endpoint returned HTTP ${res.status}`);
        return;
      }
      const snapshot = cfg.parse(await res.json(), creds.plan, new Date().toISOString());
      if (!snapshot) {
        this.opts.onError('usage endpoint returned no recognizable limit data');
        return;
      }
      snapshot.provider = cfg.id;
      this.opts.onUpdate(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[subscription:${cfg.id}] error: ${msg}`);
      this.opts.onError(msg);
    } finally {
      this.inFlight = false;
    }
  }
}
