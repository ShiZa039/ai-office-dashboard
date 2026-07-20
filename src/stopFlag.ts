/**
 * Emergency-stop flag (~/.claude/office-stop.json) shared with the hook
 * scripts: while the flag is active, the PreToolUse `stop_gate` hook denies
 * every tool call in the covered cwds. Pure logic is separated from the
 * filesystem glue so it stays unit-testable; keep the coverage semantics in
 * sync with hooks/emit-agent-event.py / .js.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface StopFlag {
  active: boolean;
  /** Covered working directories; empty = global stop (all sessions). */
  cwds: string[];
  /** ISO timestamp of activation. */
  since: string;
}

export function stopFlagPath(): string {
  return path.join(os.homedir(), '.claude', 'office-stop.json');
}

/** Parse flag file content. Returns null for malformed or inactive flags. */
export function parseStopFlag(raw: string | null | undefined): StopFlag | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!obj.active) return null;
  const cwds = Array.isArray(obj.cwds)
    ? obj.cwds.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];
  return {
    active: true,
    cwds,
    since: typeof obj.since === 'string' ? obj.since : '',
  };
}

/**
 * Build the flag for activation. Merges with an already-active flag from
 * another window: a global stop (empty cwds) on either side stays global,
 * otherwise the cwd lists are united.
 */
export function activateStopFlag(
  existing: StopFlag | null,
  cwds: string[] | null,
  now: string,
): StopFlag {
  const ours = cwds ?? [];
  if (!existing) return { active: true, cwds: ours, since: now };
  if (existing.cwds.length === 0 || ours.length === 0) {
    return { active: true, cwds: [], since: existing.since || now };
  }
  const union = [...existing.cwds];
  for (const c of ours) {
    if (!union.some((u) => samePath(u, c))) union.push(c);
  }
  return { active: true, cwds: union, since: existing.since || now };
}

/**
 * Build the flag after a release from a window covering `cwds` (null/empty =
 * global scope → release everything). Only the window's own folders are
 * subtracted; stops set by other windows survive. Returns the remaining flag,
 * or null when nothing is left and the file should be deleted.
 */
export function deactivateStopFlag(
  existing: StopFlag | null,
  cwds: string[] | null,
): StopFlag | null {
  if (!existing) return null;
  const ours = cwds ?? [];
  // A global flag has no per-project parts to subtract — full release.
  if (existing.cwds.length === 0 || ours.length === 0) return null;
  const remaining = existing.cwds.filter((c) => !ours.some((o) => pathsOverlap(c, o)));
  if (remaining.length === 0) return null;
  return { active: true, cwds: remaining, since: existing.since };
}

function normPath(p: string): string {
  let n = path.normalize(p);
  while (n.length > 1 && n.endsWith(path.sep)) n = n.slice(0, -1);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** One path equals or contains the other (order-insensitive). */
function pathsOverlap(a: string, b: string): boolean {
  const na = normPath(a);
  const nb = normPath(b);
  return na === nb || na.startsWith(nb + path.sep) || nb.startsWith(na + path.sep);
}

/**
 * Does the flag concern this window? `windowCwds` is the window's cwd filter
 * (null = global scope → any active flag applies). A global flag applies to
 * every window; otherwise the cwd sets must overlap.
 */
export function stopAppliesToWindow(
  flag: StopFlag | null,
  windowCwds: string[] | null,
): boolean {
  if (!flag) return false;
  if (flag.cwds.length === 0 || windowCwds === null || windowCwds.length === 0) return true;
  return flag.cwds.some((f) => windowCwds.some((w) => pathsOverlap(f, w)));
}

// ── Filesystem glue ──

export function readStopFlag(): StopFlag | null {
  try {
    return parseStopFlag(fs.readFileSync(stopFlagPath(), 'utf-8'));
  } catch {
    return null;
  }
}

export function writeStopFlag(flag: StopFlag): void {
  const file = stopFlagPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(flag, null, 2) + '\n', 'utf-8');
}

export function clearStopFlag(): void {
  try {
    fs.unlinkSync(stopFlagPath());
  } catch {
    // already gone — fine
  }
}
