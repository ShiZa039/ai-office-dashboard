/**
 * Kimi Code plan usage via the same endpoint the Kimi Code CLI /usage command
 * uses: GET api.kimi.com/coding/v1/usages. Returns the weekly quota plus a
 * rolling rate-limit window (5 hours) as used/limit pairs with reset times.
 *
 * Credentials come from Kimi Code's own login
 * ($KIMI_CODE_HOME/credentials/*.json, default ~/.kimi-code/credentials/).
 * Access tokens live ~15 minutes and are refreshed by the CLI itself, so an
 * expired stored token is routine — we keep the last good data on screen and
 * wait for the next poll instead of nagging.
 *
 * No vscode imports — unit-testable; wiring lives in extension.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SubscriptionSnapshot,
  UsageLimitEntry,
  UsageProviderConfig,
} from './subscriptionUsage';

const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

interface KimiCredentialFile {
  accessToken: string;
  /** Epoch millis (file stores epoch seconds in `expires_at`). */
  expiresAt: number | null;
}

export function parseKimiCredentials(json: unknown): KimiCredentialFile | null {
  const o = json as Record<string, unknown> | null | undefined;
  if (!o || typeof o.access_token !== 'string' || !o.access_token) return null;
  const expiresAt =
    typeof o.expires_at === 'number' && o.expires_at > 0 ? o.expires_at * 1000 : null;
  return { accessToken: o.access_token, expiresAt };
}

/** Read Kimi Code OAuth credentials from the credentials dir (first usable file). */
export function readKimiCredentials(homeDir: string = os.homedir()): KimiCredentialFile | null {
  const envHome = (process.env.KIMI_CODE_HOME || '').trim();
  const root = envHome || path.join(homeDir, '.kimi-code');
  const dir = path.join(root, 'credentials');
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return null; // no Kimi Code data dir — provider not in use
  }
  for (const file of files) {
    try {
      const creds = parseKimiCredentials(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')));
      if (creds) return creds;
    } catch {
      // skip unreadable / non-OAuth json
    }
  }
  return null;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

interface QuotaNumbers {
  used: number;
  limit: number;
  resetsAt: string | null;
}

/** Quota fields arrive as strings ("used": "23"); accept numbers too. */
function quotaNumbers(json: unknown): QuotaNumbers | null {
  const o = json as Record<string, unknown> | null | undefined;
  if (!o) return null;
  const used = Number(o.used);
  const limit = Number(o.limit);
  if (Number.isNaN(used) || Number.isNaN(limit)) return null;
  return { used, limit, resetsAt: typeof o.resetTime === 'string' ? o.resetTime : null };
}

function windowLabel(window: unknown): string {
  const w = window as Record<string, unknown> | null | undefined;
  const minutes =
    w && w.timeUnit === 'TIME_UNIT_MINUTE' && typeof w.duration === 'number' ? w.duration : null;
  if (minutes === null || minutes <= 0) return 'Rate window';
  if (minutes % 60 === 0) return `Session (${minutes / 60}h)`;
  return `Window (${minutes}m)`;
}

/**
 * Parse the /coding/v1/usages response defensively; null if nothing usable.
 * `limits[]` entries are rate windows (5h), top-level `usage` is the weekly
 * quota. Plan label comes from user.membership.level ("LEVEL_INTERMEDIATE" →
 * "intermediate").
 */
export function parseKimiUsageResponse(
  json: unknown,
  fetchedAt: string,
): SubscriptionSnapshot | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const out: UsageLimitEntry[] = [];

  if (Array.isArray(o.limits)) {
    for (const item of o.limits) {
      if (!item || typeof item !== 'object') continue;
      const l = item as Record<string, unknown>;
      const q = quotaNumbers(l.detail);
      if (!q) continue;
      out.push({
        kind: 'session',
        label: windowLabel(l.window),
        utilization: q.limit > 0 ? clampPct(Math.round((q.used / q.limit) * 100)) : 0,
        resetsAt: q.resetsAt,
      });
    }
  }

  const weekly = quotaNumbers(o.usage);
  if (weekly) {
    out.push({
      kind: 'weekly',
      label: 'Week',
      utilization:
        weekly.limit > 0 ? clampPct(Math.round((weekly.used / weekly.limit) * 100)) : 0,
      resetsAt: weekly.resetsAt,
    });
  }

  if (out.length === 0) return null;

  let plan: string | null = null;
  const user = o.user as Record<string, unknown> | undefined;
  const membership = user?.membership as Record<string, unknown> | undefined;
  if (typeof membership?.level === 'string' && membership.level) {
    plan = membership.level.replace(/^LEVEL_/, '').toLowerCase();
  }

  return { fetchedAt, plan, limits: out };
}

export const kimiUsageProvider: UsageProviderConfig = {
  id: 'kimi',
  url: KIMI_USAGE_URL,
  headers: (accessToken) => ({
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  }),
  readCredentials: () => {
    const c = readKimiCredentials();
    return c && { accessToken: c.accessToken, expiresAt: c.expiresAt, plan: null };
  },
  parse: (body, _plan, fetchedAt) => parseKimiUsageResponse(body, fetchedAt),
  messages: {
    // Optional provider: many users only run Claude Code, so absence of Kimi
    // credentials is not an error. Tokens live ~15 min and the CLI refreshes
    // them on its own — expiry is routine, keep last data and stay quiet.
    noCredentials: null,
    expired: null,
    unauthorized: 'not authorized — re-login in Kimi Code (`/login`) to refresh credentials',
  },
};
