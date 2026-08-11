/**
 * Auto emergency stop: decides when a plan-limits snapshot should trip the
 * office-wide stop flag (the same one behind the dashboard button — see
 * stopFlag.ts). Plan limits are account-wide, so the caller is expected to
 * activate a GLOBAL stop, not a per-project one.
 *
 * A limit fires once per (provider, kind, reset window). Releasing the stop
 * while the same window is still over the threshold must NOT re-trip it — the
 * user consciously resumed — but the next window, or a limit that dipped
 * below the threshold and climbed back, arms it again. No vscode imports —
 * unit-testable.
 */
import { SubscriptionSnapshot, UsageLimitEntry } from './subscriptionUsage';

export class AutoStopLatch {
  /** `provider:kind` → `resetsAt` of the window that already fired. */
  private fired = new Map<string, string>();

  /**
   * Latch every limit at/over the threshold and return the first newly
   * latched one (null when nothing new crossed). Call on every snapshot,
   * even while a stop is already active or the feature is disabled, so the
   * latches stay current and a user-released stop is not re-tripped by the
   * very next poll.
   */
  check(snapshot: SubscriptionSnapshot, thresholdPct: number): UsageLimitEntry | null {
    let hit: UsageLimitEntry | null = null;
    for (const lim of snapshot.limits) {
      const key = `${snapshot.provider ?? ''}:${lim.kind}`;
      if (lim.utilization >= thresholdPct) {
        const window = lim.resetsAt ?? '';
        if (this.fired.get(key) !== window) {
          this.fired.set(key, window);
          hit = hit ?? lim;
        }
      } else {
        this.fired.delete(key);
      }
    }
    return hit;
  }
}
