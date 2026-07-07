/**
 * Pure logic for registering Claude Office hooks in ~/.claude/settings.json.
 * No vscode imports — unit-testable. Filesystem/UI glue lives in hookInstaller.ts.
 */

export type HookRuntime = 'python' | 'python3' | 'py' | 'node';

/** Substring that identifies our hook commands inside settings.json. */
export const HOOK_MARKER = 'emit-agent-event';

/** Claude Code hook events we subscribe to, and the argument our script expects. */
export const HOOK_EVENTS: ReadonlyArray<{ hookEvent: string; arg: string }> = [
  { hookEvent: 'SessionStart', arg: 'session_start' },
  { hookEvent: 'SubagentStart', arg: 'agent_start' },
  { hookEvent: 'SubagentStop', arg: 'agent_stop' },
  { hookEvent: 'Stop', arg: 'session_stop' },
  // Fires when Claude blocks on the user (permission prompt / question).
  { hookEvent: 'Notification', arg: 'agent_waiting' },
  // Fires when the user submits a prompt — clears the waiting state.
  { hookEvent: 'UserPromptSubmit', arg: 'user_prompt' },
];

export function hookScriptFileFor(runtime: HookRuntime): string {
  return runtime === 'node' ? 'emit-agent-event.js' : 'emit-agent-event.py';
}

/**
 * Build the shell command Claude Code will run for a hook.
 * `$HOME` is expanded by Claude Code itself on all platforms.
 */
export function buildHookCommand(runtime: HookRuntime, arg: string): string {
  const exe = runtime === 'py' ? 'py -3' : runtime;
  return `${exe} "$HOME/.claude/hooks/${hookScriptFileFor(runtime)}" ${arg}`;
}

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

function entryHasMarker(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(
    (h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER),
  );
}

/** True if every hook event already has an emit-agent-event registration. */
export function hasOfficeHooks(settings: unknown): boolean {
  return officeHookCoverage(settings) === 'full';
}

/**
 * How many of our hook events are registered. 'partial' means the user
 * installed an older extension version and new events can be merged in
 * silently — consent to our hooks was already given.
 */
export function officeHookCoverage(settings: unknown): 'none' | 'partial' | 'full' {
  if (!settings || typeof settings !== 'object') return 'none';
  const hooks = (settings as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== 'object') return 'none';
  let registered = 0;
  for (const { hookEvent } of HOOK_EVENTS) {
    const entries = (hooks as Record<string, unknown>)[hookEvent];
    if (Array.isArray(entries) && entries.some((e) => entryHasMarker(e as HookEntry))) {
      registered++;
    }
  }
  if (registered === 0) return 'none';
  return registered === HOOK_EVENTS.length ? 'full' : 'partial';
}

/**
 * Merge our hook registrations into a parsed settings.json object.
 * Never touches unrelated settings or other hooks. With `replace`, existing
 * emit-agent-event entries are swapped for freshly built ones (used to switch
 * runtime, e.g. python → node).
 *
 * Returns a deep-cloned object; the input is not mutated.
 */
export function mergeOfficeHooks(
  settings: Record<string, unknown> | null | undefined,
  runtime: HookRuntime,
  opts?: { replace?: boolean },
): { settings: Record<string, unknown>; changed: boolean } {
  const result: Record<string, unknown> = settings
    ? (JSON.parse(JSON.stringify(settings)) as Record<string, unknown>)
    : {};
  if (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks)) {
    result.hooks = {};
  }
  const hooks = result.hooks as Record<string, unknown>;
  let changed = false;

  for (const { hookEvent, arg } of HOOK_EVENTS) {
    let entries = hooks[hookEvent];
    if (!Array.isArray(entries)) {
      entries = [];
      hooks[hookEvent] = entries;
    }
    let list = entries as HookEntry[];

    const desired: HookEntry = {
      hooks: [{ type: 'command', command: buildHookCommand(runtime, arg), timeout: 5 }],
    };

    const ours = list.filter(entryHasMarker);
    if (ours.length === 0) {
      list.push(desired);
      changed = true;
      continue;
    }
    if (opts?.replace) {
      const already =
        ours.length === 1 &&
        JSON.stringify(ours[0]) === JSON.stringify(desired);
      if (!already) {
        list = list.filter((e) => !entryHasMarker(e));
        list.push(desired);
        hooks[hookEvent] = list;
        changed = true;
      }
    }
  }

  return { settings: result, changed };
}
