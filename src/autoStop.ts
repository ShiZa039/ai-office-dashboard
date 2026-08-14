/**
 * Auto emergency stop: decides when a plan-limits snapshot should trip the
 * office-wide stop flag (the same one behind the dashboard button — see
 * stopFlag.ts). Plan limits are account-wide, so the caller is expected to
 * activate a GLOBAL stop, not a per-project one.
 *
 * The fuse is ONE-SHOT per limit window, with one last warning:
 *   • level 1 fires when utilization reaches the main threshold (default 95%);
 *   • level 2 fires once more at the final threshold (default 99%);
 *   • nothing else fires until that limit's window actually resets.
 * Releasing the stop and burning the rest of the window (a commit, a push)
 * must never be interrupted again, so a limit that dips below the threshold
 * and climbs back inside the SAME window stays quiet — only a new `resetsAt`
 * re-arms it.
 *
 * The latch state is persisted through a LatchStore. In-memory state was not
 * enough: every new VSCode window, every extension-host reload, re-created an
 * empty latch, and the watcher polls immediately on start — so at 96% the
 * stop fired again the moment a window opened. The file-backed store makes
 * the fuse survive reloads and stay shared across windows.
 *
 * No vscode imports — unit-testable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SubscriptionSnapshot, UsageLimitEntry } from './subscriptionUsage';

export interface AutoStopThresholds {
  /** Main trip point, % of the limit. */
  warn: number;
  /** Last-warning trip point; anything <= warn means "no second shot". */
  final: number;
}

export interface AutoStopHit {
  limit: UsageLimitEntry;
  /** 1 = first trip at `warn`, 2 = the last warning at `final`. */
  level: 1 | 2;
}

/** What already fired for one `provider:kind`. */
export interface LatchEntry {
  /** `resetsAt` of the window the level belongs to ('' when unknown). */
  window: string;
  /** Highest level already fired for that window (0 = armed). */
  level: number;
}

export interface LatchStore {
  load(): Record<string, LatchEntry>;
  save(state: Record<string, LatchEntry>): void;
}

/**
 * Limits with an unknown reset time cannot be keyed by window, so they re-arm
 * the old way instead: utilization has to fall this far below the threshold.
 */
const REARM_MARGIN_PCT = 5;

export class AutoStopLatch {
  constructor(private readonly store: LatchStore = memoryLatchStore()) {}

  /**
   * Latch every limit at/over a threshold and return the first newly latched
   * one (null when nothing new crossed). Call on every snapshot, even while a
   * stop is already active or the feature is disabled, so the latches stay
   * current and a user-released stop is not re-tripped by the very next poll.
   */
  check(
    snapshot: SubscriptionSnapshot,
    thresholds: AutoStopThresholds,
    nowMs: number = Date.now(),
  ): AutoStopHit | null {
    const warn = thresholds.warn;
    const final = Math.max(thresholds.final, warn);
    const state = this.store.load();
    let hit: AutoStopHit | null = null;
    let dirty = false;

    for (const lim of snapshot.limits) {
      const key = latchKey(snapshot.provider ?? '', lim);
      const window = lim.resetsAt ?? '';
      const prev = state[key];
      // A different window normally means the limit reset — but only if it
      // really did (see windowReallyReset); otherwise the level carries over.
      const reset =
        !!prev &&
        prev.window !== window &&
        windowReallyReset(prev.window, window, lim.utilization, warn, nowMs);
      let level = prev && !reset ? prev.level : 0;
      if (!window && prev && lim.utilization < warn - REARM_MARGIN_PCT) level = 0;
      // On a wobble the previous window is kept: adopting the wobbling value
      // would let the endpoint flap two reset times and slip one shot through
      // per round trip.
      const stored = prev && !reset && prev.window !== window ? prev.window : window;

      const wanted = lim.utilization >= final ? 2 : lim.utilization >= warn ? 1 : 0;
      if (wanted > level) {
        level = wanted;
        hit = hit ?? { limit: lim, level: wanted as 1 | 2 };
      }
      if (!prev || prev.window !== stored || prev.level !== level) {
        state[key] = { window: stored, level };
        dirty = true;
      }
    }

    if (dirty) this.store.save(state);
    return hit;
  }
}

/**
 * One latch per limit BAR, not per kind: `weekly_scoped` arrives once per
 * model-scoped limit (Week (Opus), Week (Sonnet), …), and those entries used
 * to share a `provider:kind` key. Two entries with different reset times then
 * overwrote each other's window on every poll and the fuse re-fired forever
 * inside one window. The label is derived from kind+scope, so it separates
 * them without touching the parser.
 */
function latchKey(provider: string, lim: UsageLimitEntry): string {
  return `${provider}:${lim.kind}:${lim.label}`;
}

/**
 * Did the limit really enter a new window, or did `resetsAt` merely change
 * shape? A reset time that goes backwards, or a fresh window whose
 * predecessor has not even elapsed yet while utilization is still at the
 * threshold, is not a reset — and re-arming on it would put the user back
 * where they started: an auto-stop on every poll.
 */
function windowReallyReset(
  prevWindow: string,
  nextWindow: string,
  utilization: number,
  warn: number,
  nowMs: number,
): boolean {
  if (utilization < warn) return true; // usage actually fell — a new window
  const prevEnd = Date.parse(prevWindow);
  if (!Number.isFinite(prevEnd)) return true; // nothing to compare against
  const nextEnd = Date.parse(nextWindow);
  // Windows only ever move forward; anything else is the endpoint wobbling.
  if (Number.isFinite(nextEnd) && nextEnd <= prevEnd) return false;
  return prevEnd <= nowMs; // the old window has genuinely ended
}

/** Non-persistent store — the default, and what the unit tests use. */
export function memoryLatchStore(): LatchStore {
  let state: Record<string, LatchEntry> = {};
  return {
    load: () => ({ ...state }),
    save: (next) => {
      state = { ...next };
    },
  };
}

/** Where the persisted latch lives (next to the stop flag). */
export function autoStopLatchPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.claude', 'office-autostop.json');
}

/**
 * File-backed store: survives extension-host reloads and is shared by every
 * VSCode window, so the fuse really fires once per window and not once per
 * window-of-VSCode. Unreadable/corrupt state degrades to "armed" rather than
 * throwing — a spurious stop is better than a crashed poll.
 */
export function fileLatchStore(file: string = autoStopLatchPath()): LatchStore {
  return {
    load: () => {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return parseLatchState(parsed);
      } catch {
        return {};
      }
    },
    save: (state) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      } catch {
        // best effort — the in-snapshot check still holds for this session
      }
    },
  };
}

/** Keep only well-formed entries; anything else is treated as "armed". */
export function parseLatchState(parsed: unknown): Record<string, LatchEntry> {
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, LatchEntry> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.level !== 'number' || !Number.isFinite(entry.level)) continue;
    out[key] = {
      window: typeof entry.window === 'string' ? entry.window : '',
      level: entry.level,
    };
  }
  return out;
}
