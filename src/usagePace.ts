/**
 * Pace model for plan quotas: is the limit burning faster than the window
 * elapses? Idea and thresholds adapted from ClaudeBar
 * (https://github.com/tddworks/ClaudeBar) — see docs/USAGE-PROVIDERS.md §3.
 *
 * percentTimeElapsed = (windowDuration − timeUntilReset) / windowDuration
 * burnRate           = percentUsed / percentTimeElapsed   (1.0 = on schedule)
 *
 * Status combines absolute guardrails (depleted at 100%, critical below 20%
 * remaining) with an early pace warning (burnRate > 1.5 while under 50%
 * remaining), so a hot window trips the alarm long before the absolute
 * thresholds would.
 *
 * No vscode imports — unit-testable; wiring lives in subscriptionUsage.ts
 * (withPace) and extension.ts (alerts).
 */
import type { SubscriptionSnapshot, UsageLimitEntry } from './subscriptionUsage';

export type UsagePace = 'hot' | 'on_pace' | 'room';
export type PaceStatus = 'ok' | 'warning' | 'critical' | 'depleted';

/** |used% − elapsed%| within this band reads as "on pace". */
const ON_PACE_TOLERANCE_PP = 5;
/** burnRate above this while under HOT_REMAINING_PCT% remaining → warning. */
const HOT_BURN_RATE = 1.5;
const HOT_REMAINING_PCT = 50;
/** Absolute guardrail: below this % remaining → critical regardless of pace. */
const CRITICAL_REMAINING_PCT = 20;

/**
 * % of the quota window already elapsed (0–100), or null when it cannot be
 * derived (no reset time, no window length, or an inconsistent/stale pair —
 * e.g. reset already passed or lies beyond the window).
 */
export function percentTimeElapsed(
  entry: Pick<UsageLimitEntry, 'resetsAt' | 'windowMinutes'>,
  now: number = Date.now(),
): number | null {
  if (!entry.resetsAt || !entry.windowMinutes || entry.windowMinutes <= 0) return null;
  const reset = Date.parse(entry.resetsAt);
  if (Number.isNaN(reset)) return null;
  const windowMs = entry.windowMinutes * 60000;
  const remainingMs = reset - now;
  if (remainingMs < 0 || remainingMs > windowMs) return null;
  return Math.max(0, Math.min(100, ((windowMs - remainingMs) / windowMs) * 100));
}

/** Used% per elapsed% — 1.0 burns exactly on schedule; null if unknowable. */
export function burnRate(
  entry: Pick<UsageLimitEntry, 'resetsAt' | 'windowMinutes' | 'utilization'>,
  now: number = Date.now(),
): number | null {
  const elapsed = percentTimeElapsed(entry, now);
  if (elapsed === null || elapsed <= 0) return null;
  return entry.utilization / elapsed;
}

/** Hot = burning ahead of the window; room = behind it; ±5 p.p. = on pace. */
export function usagePace(
  entry: Pick<UsageLimitEntry, 'resetsAt' | 'windowMinutes' | 'utilization'>,
  now: number = Date.now(),
): UsagePace | null {
  const elapsed = percentTimeElapsed(entry, now);
  if (elapsed === null) return null;
  const diff = entry.utilization - elapsed;
  if (Math.abs(diff) <= ON_PACE_TOLERANCE_PP) return 'on_pace';
  return diff > 0 ? 'hot' : 'room';
}

/**
 * Guardrails first (depleted at 100%, critical under 20% remaining), then the
 * early pace warning. Pace never downgrades an absolute status.
 */
export function paceStatus(
  entry: Pick<UsageLimitEntry, 'resetsAt' | 'windowMinutes' | 'utilization'>,
  now: number = Date.now(),
): PaceStatus {
  const remaining = 100 - entry.utilization;
  if (entry.utilization >= 100) return 'depleted';
  if (remaining < CRITICAL_REMAINING_PCT) return 'critical';
  const rate = burnRate(entry, now);
  if (rate !== null && rate > HOT_BURN_RATE && remaining < HOT_REMAINING_PCT) {
    return 'warning';
  }
  return 'ok';
}

const SEVERITY: readonly PaceStatus[] = ['ok', 'warning', 'critical', 'depleted'];

/** curr when it is strictly worse than prev (alert once), else null. */
export function nextAlertLevel(prev: PaceStatus, curr: PaceStatus): PaceStatus | null {
  return SEVERITY.indexOf(curr) > SEVERITY.indexOf(prev) ? curr : null;
}

/** Fill expectedPct/pace/paceStatus on every limit of the snapshot in place. */
export function withPace<T extends SubscriptionSnapshot>(
  snapshot: T,
  now: number = Date.now(),
): T {
  for (const lim of snapshot.limits) {
    lim.expectedPct = percentTimeElapsed(lim, now);
    lim.pace = usagePace(lim, now);
    lim.paceStatus = paceStatus(lim, now);
  }
  return snapshot;
}
