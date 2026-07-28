/**
 * Pure logic for registering AI Office hooks in ~/.kimi-code/config.toml.
 * No vscode imports — unit-testable. Filesystem/UI glue lives in hookInstaller.ts.
 *
 * Kimi Code reads hooks from TOML `[[hooks]]` tables (event / matcher /
 * command / timeout). We do not parse TOML: our tables are located by the
 * `emit-agent-event` marker inside the command and by a beacon comment line
 * (`# office-dashboard-hook: <Event>`) right before each table, which makes
 * removal/replacement a line-based operation that leaves the rest of the
 * user's config byte-identical.
 */

import { HookRuntime } from './hookConfig';

/** Substring that identifies our hook commands inside config.toml. */
export const KIMI_HOOK_MARKER = 'emit-agent-event';

/** Beacon comment prefix placed directly above each of our [[hooks]] tables. */
export const KIMI_BEACON_PREFIX = '# office-dashboard-hook:';

const BEACON_RE = /^\s*# office-dashboard-hook:/;

/** Kimi Code hook events we subscribe to, and the argument our script expects. */
export const KIMI_HOOK_EVENTS: ReadonlyArray<{ hookEvent: string; arg: string }> = [
  { hookEvent: 'SessionStart', arg: 'session_start' },
  { hookEvent: 'SubagentStart', arg: 'agent_start' },
  { hookEvent: 'SubagentStop', arg: 'agent_stop' },
  { hookEvent: 'Stop', arg: 'session_stop' },
  // Fires when Kimi blocks on a tool approval (the Claude `Notification` analog).
  { hookEvent: 'PermissionRequest', arg: 'agent_waiting' },
  // Fires when the user submits a prompt — clears the waiting state.
  { hookEvent: 'UserPromptSubmit', arg: 'user_prompt' },
  // Emergency-stop gate: while ~/.kimi-code/office-stop.json is active, every
  // tool call is denied (dashboard "stop" button). No-op otherwise.
  { hookEvent: 'PreToolUse', arg: 'stop_gate' },
];

/**
 * Build the shell command Kimi Code will run for a hook. `scriptPath` is
 * absolute; the command is embedded in a TOML literal string (single quotes),
 * so Windows backslashes survive verbatim.
 */
export function buildKimiHookCommand(
  runtime: HookRuntime,
  scriptPath: string,
  arg: string,
): string {
  const exe = runtime === 'py' ? 'py -3' : runtime;
  return `${exe} "${scriptPath}" ${arg} kimi`;
}

/** One beacon + [[hooks]] table for a single event. */
export function kimiHookBlock(
  runtime: HookRuntime,
  scriptPath: string,
  hookEvent: string,
  arg: string,
): string {
  return [
    `${KIMI_BEACON_PREFIX} ${hookEvent}`,
    '[[hooks]]',
    `event = "${hookEvent}"`,
    `command = '${buildKimiHookCommand(runtime, scriptPath, arg)}'`,
    'timeout = 5',
    '',
  ].join('\n');
}

interface TomlChunk {
  /** 'hooks' = a [[...]] array-of-tables chunk, 'other' = anything else. */
  kind: 'hooks' | 'other';
  text: string;
}

/**
 * Split TOML text into chunks: each section header (`[table]` or
 * `[[array-of-tables]]`) starts a new chunk that runs until the next header.
 * Good enough for locating whole `[[hooks]]` tables without a TOML parser.
 */
function splitToml(text: string): TomlChunk[] {
  const chunks: TomlChunk[] = [];
  let lines: string[] = [];
  let kind: TomlChunk['kind'] = 'other';
  const flush = () => {
    if (lines.length > 0) {
      chunks.push({ kind, text: lines.join('\n') });
      lines = [];
    }
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) {
      flush();
      kind = t.startsWith('[[') ? 'hooks' : 'other';
    }
    lines.push(line);
  }
  flush();
  return chunks;
}

function isOurs(chunk: TomlChunk): boolean {
  return chunk.kind === 'hooks' && chunk.text.includes(KIMI_HOOK_MARKER);
}

function chunkHasEvent(chunk: TomlChunk, hookEvent: string): boolean {
  return new RegExp(`^\\s*event\\s*=\\s*"${hookEvent}"\\s*$`, 'm').test(chunk.text);
}

/** True if every hook event already has an emit-agent-event registration. */
export function hasKimiOfficeHooks(configText: string): boolean {
  return kimiOfficeHookCoverage(configText) === 'full';
}

/**
 * How many of our hook events are registered. 'partial' means the user
 * installed an older extension version and new events can be merged in
 * silently — consent to our hooks was already given.
 */
export function kimiOfficeHookCoverage(configText: string): 'none' | 'partial' | 'full' {
  const ours = splitToml(configText).filter(isOurs);
  let registered = 0;
  for (const { hookEvent } of KIMI_HOOK_EVENTS) {
    if (ours.some((c) => chunkHasEvent(c, hookEvent))) registered++;
  }
  if (registered === 0) return 'none';
  return registered === KIMI_HOOK_EVENTS.length ? 'full' : 'partial';
}

/**
 * Merge our hook registrations into config.toml text. Never touches unrelated
 * tables or other [[hooks]] entries. With `replace`, existing emit-agent-event
 * tables are swapped for freshly built ones (used to switch runtime, e.g.
 * python → node). Without `replace`, a full existing registration is left
 * byte-identical.
 */
export function mergeKimiOfficeHooks(
  configText: string,
  runtime: HookRuntime,
  scriptPath: string,
  opts?: { replace?: boolean },
): { text: string; changed: boolean } {
  if (!opts?.replace && hasKimiOfficeHooks(configText)) {
    return { text: configText, changed: false };
  }

  const kept = splitToml(configText)
    .filter((c) => !isOurs(c))
    // Beacon comments are ours by definition — strip them wherever they
    // landed (a beacon directly above our table may belong to the previous,
    // unrelated chunk after splitting).
    .map((c) => ({
      ...c,
      text: c.text.split('\n').filter((l) => !BEACON_RE.test(l)).join('\n'),
    }));
  const base = kept
    .map((c) => c.text)
    .join('\n')
    .replace(/\s+$/, '');

  const blocks = KIMI_HOOK_EVENTS.map(({ hookEvent, arg }) =>
    kimiHookBlock(runtime, scriptPath, hookEvent, arg),
  ).join('\n');

  const text = base ? `${base}\n\n${blocks}` : blocks;
  return { text, changed: text !== configText };
}
