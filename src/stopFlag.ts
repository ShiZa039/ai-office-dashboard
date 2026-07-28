/**
 * Emergency-stop flag shared with the hook scripts: while the flag is active,
 * the PreToolUse `stop_gate` hook denies every tool call in the covered cwds.
 * Each agent CLI has its own flag file (~/.claude/office-stop.json resp.
 * ~/.kimi-code/office-stop.json); the extension writes/reads ALL of them so
 * one dashboard button stops every CLI at once, and a human prompt in any
 * CLI releases all of them (the hook scripts mirror this). Pure logic is
 * separated from the filesystem glue so it stays unit-testable; keep the
 * coverage semantics in sync with hooks/emit-agent-event.py / .js.
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

/** Claude Code's flag file. */
export function stopFlagPath(): string {
  return path.join(os.homedir(), '.claude', 'office-stop.json');
}

/** Kimi Code's flag file. */
export function kimiStopFlagPath(): string {
  return path.join(os.homedir(), '.kimi-code', 'office-stop.json');
}

/** Every cli's flag file — the dashboard stop button covers all of them. */
export function stopFlagPaths(): string[] {
  return [stopFlagPath(), kimiStopFlagPath()];
}

function readStopFlagAt(file: string): StopFlag | null {
  try {
    return parseStopFlag(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function writeStopFlagAt(file: string, flag: StopFlag): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(flag, null, 2) + '\n', 'utf-8');
}

function clearStopFlagAt(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — fine
  }
}

/** The first active flag across all cli flag files, or null. */
export function readStopFlag(): StopFlag | null {
  for (const file of stopFlagPaths()) {
    const flag = readStopFlagAt(file);
    if (flag) return flag;
  }
  return null;
}

export function writeStopFlag(flag: StopFlag): void {
  for (const file of stopFlagPaths()) {
    writeStopFlagAt(file, flag);
  }
}

export function clearStopFlag(): void {
  for (const file of stopFlagPaths()) {
    clearStopFlagAt(file);
  }
}

/** Activate the stop for `cwds` in every cli's flag file (merging per file). */
export function activateStopEverywhere(cwds: string[] | null, now: string): void {
  for (const file of stopFlagPaths()) {
    writeStopFlagAt(file, activateStopFlag(readStopFlagAt(file), cwds, now));
  }
}

/**
 * Release the stop for `cwds` in every cli's flag file (subtracting per
 * file). Returns true if any stop is still active afterwards.
 */
export function releaseStopEverywhere(cwds: string[] | null): boolean {
  let remaining = false;
  for (const file of stopFlagPaths()) {
    const next = deactivateStopFlag(readStopFlagAt(file), cwds);
    if (next) {
      writeStopFlagAt(file, next);
      remaining = true;
    } else {
      clearStopFlagAt(file);
    }
  }
  return remaining;
}
