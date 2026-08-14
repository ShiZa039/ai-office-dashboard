#!/usr/bin/env node
/**
 * Emit agent event to JSONL file for AI Office Dashboard.
 * Node variant of emit-agent-event.py — used when Python 3 is not in PATH.
 *
 * Reads hook JSON from stdin, appends event to ~/.claude/agent-events.jsonl.
 * Usage: node emit-agent-event.js <event_type> [cli]
 *   event_type: session_start | agent_start | agent_stop | session_stop
 *             | agent_waiting | user_prompt | stop_gate
 *   cli: claude (default) | kimi — which agent CLI fired the hook. Kimi Code
 *        payloads use the same snake_case base fields (session_id, cwd) but
 *        different event-specific ones (agent_name+prompt/response,
 *        tool_name for permission waits) and carry no model/transcript, so
 *        the model falls back to ~/.kimi-code/config.toml.
 *
 * stop_gate is special: it is a PreToolUse hook, not a turn-level event.
 * While the office-stop flag for THIS cli (~/.claude/office-stop.json resp.
 * ~/.kimi-code/office-stop.json) is active it denies every tool call
 * (emergency stop from the dashboard). An allowed call appends a lightweight
 * tool_activity event instead: the first tool call after the user answers a
 * permission prompt (e.g. approving plan-mode exit) clears the dashboard's
 * "waiting" banner, which no turn-level hook would fire for. A user_prompt
 * event releases the stop for its
 * cwd — in BOTH cli flag files, so a human prompt anywhere resumes
 * everywhere — but only when the prompt was actually typed by the human:
 * harness-injected turns (task notifications, system reminders, cron fires)
 * also arrive via UserPromptSubmit and must not lift an emergency stop.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

const STOP_REASON =
  'AI Office: EMERGENCY STOP activated by the user from the dashboard. ' +
  'Do not call any more tools. End the turn immediately with a brief ' +
  'handoff note: what was done, what remains, and the next step to ' +
  'resume from.';

const CLI = process.argv[3] === 'kimi' ? 'kimi' : 'claude';

function claudeStopFlagPath() {
  return path.join(os.homedir(), '.claude', 'office-stop.json');
}

function kimiStopFlagPath() {
  return path.join(os.homedir(), '.kimi-code', 'office-stop.json');
}

/** The flag file gating this cli's tool calls. */
function stopFlagPath() {
  return CLI === 'kimi' ? kimiStopFlagPath() : claudeStopFlagPath();
}

/** All flag files — a human prompt releases the stop for every cli at once. */
function allStopFlagPaths() {
  return [claudeStopFlagPath(), kimiStopFlagPath()];
}

/**
 * True when the flag carries an `until` deadline that has already passed.
 *
 * The auto-stop stamps `until` with the reset time of the limit that fired:
 * once that window is over there is nothing left to protect, so the flag must
 * not block tomorrow's session. A manual stop has no `until` and never
 * expires. An unparsable value is treated as "no deadline" \u2014 blocking is the
 * safe side. Keep in sync with emit-agent-event.py / src/stopFlag.ts.
 */
function stopFlagExpired(flag) {
  if (typeof flag.until !== 'string' || !flag.until) return false;
  const deadline = Date.parse(flag.until);
  return Number.isFinite(deadline) && deadline <= Date.now();
}

/** Parsed active stop flag, or null (missing / malformed / inactive / expired). */
function loadStopFlag(flagPath) {
  try {
    // Strip a possible BOM (hand-edited flag files saved as UTF-8 with BOM).
    const flag = JSON.parse(fs.readFileSync(flagPath, 'utf-8').replace(/^\uFEFF/, '').trim());
    if (!flag || typeof flag !== 'object' || !flag.active) return null;
    return stopFlagExpired(flag) ? null : flag;
  } catch (e) {
    return null;
  }
}

function normPath(p) {
  let n = path.normalize(p);
  while (n.length > 1 && n.endsWith(path.sep)) n = n.slice(0, -1);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * True when the stop flag applies to a session running in `cwd`.
 * An empty/absent cwds list means a global stop (all sessions).
 */
function stopCoversCwd(flag, cwd) {
  const cwds = flag.cwds;
  if (!Array.isArray(cwds) || cwds.length === 0) return true;
  if (typeof cwd !== 'string' || !cwd) return false;
  const target = normPath(cwd);
  for (const base of cwds) {
    if (typeof base !== 'string' || !base) continue;
    const b = normPath(base);
    if (target === b || target.startsWith(b + path.sep)) return true;
  }
  return false;
}

/** PreToolUse gate: deny the tool call while the stop flag covers this cwd. */
function stopGate(raw) {
  const flag = loadStopFlag(stopFlagPath());
  if (!flag) return false;
  let data = {};
  try {
    const trimmed = raw.trim();
    data = trimmed ? JSON.parse(trimmed) : {};
  } catch (e) {
    data = {};
  }
  if (!stopCoversCwd(flag, data.cwd || '')) return false;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: STOP_REASON,
    },
  }) + '\n');
  return true;
}

/**
 * Allowed tool calls append a lightweight activity event: the first tool call
 * after the user answers a permission prompt (e.g. plan-mode exit) clears the
 * dashboard's "waiting" banner, which no turn-level hook would fire for.
 */
function emitToolActivity(raw) {
  let data = {};
  try {
    const trimmed = raw.trim();
    data = trimmed ? JSON.parse(trimmed) : {};
  } catch (e) {
    data = {};
  }
  const eventFile = path.join(os.homedir(), '.claude', 'agent-events.jsonl');
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  fs.appendFileSync(eventFile, JSON.stringify({
    ts: new Date().toISOString(),
    event: 'tool_activity',
    session: data.session_id || 'unknown',
    cwd: data.cwd || '',
  }) + '\n', 'utf-8');
}

/**
 * True for prompts injected by the harness rather than typed by the user:
 * background-task notifications, system reminders and scheduled cron fires
 * flow through UserPromptSubmit with these markers. Resuming from an
 * emergency stop requires an explicit human action, so such prompts never
 * release the flag. Keep in sync with emit-agent-event.py.
 */
function isAutomatedPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const p = prompt.trimStart();
  return (
    p.startsWith('[SYSTEM NOTIFICATION') ||
    p.startsWith('<system-reminder>') ||
    p.startsWith('<cron-fire') ||
    p.includes('<task-notification>')
  );
}

/**
 * A new user prompt means "resume" — but only for this cwd: overlapping
 * entries are removed from the flag, stops on other projects survive. A
 * global flag (empty cwds) has no per-project parts, so it is fully released.
 * Applied to every cli's flag file so one human prompt resumes all agents.
 */
function releaseStopFlag(cwd) {
  for (const flagPath of allStopFlagPaths()) {
    const flag = loadStopFlag(flagPath);
    if (!flag) continue;
    const cwds = Array.isArray(flag.cwds)
      ? flag.cwds.filter((c) => typeof c === 'string' && c)
      : [];
    let remaining = [];
    if (cwds.length > 0) {
      if (typeof cwd !== 'string' || !cwd) continue; // no cwd info — keep the stop
      const target = normPath(cwd);
      remaining = cwds.filter((base) => {
        const b = normPath(base);
        return target !== b && !target.startsWith(b + path.sep) && !b.startsWith(target + path.sep);
      });
      if (remaining.length === cwds.length) continue; // prompt from an uncovered project
    }
    try {
      if (remaining.length > 0) {
        fs.writeFileSync(
          flagPath,
          JSON.stringify({ ...flag, cwds: remaining }, null, 2) + '\n',
          'utf-8',
        );
      } else {
        fs.unlinkSync(flagPath);
      }
    } catch (e) { /* best effort */ }
  }
}

/** Model alias from ~/.kimi-code/config.toml (`default_model = "…"`), '' if absent. */
function kimiConfigModel() {
  try {
    const text = fs.readFileSync(
      path.join(os.homedir(), '.kimi-code', 'config.toml'),
      'utf-8',
    );
    const m = text.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

/**
 * Best-effort model ID for the session. Claude Code SessionStart payloads
 * carry `model` directly (not guaranteed); other Claude events fall back to
 * the newest assistant entry in the transcript, so a mid-session /model
 * switch shows up on the next event. Kimi Code payloads carry neither, so
 * kimi events fall back to the default model in ~/.kimi-code/config.toml.
 * Returns '' when the model cannot be determined.
 */
function resolveModel(data) {
  if (typeof data.model === 'string' && data.model) return data.model;
  if (CLI === 'kimi') return kimiConfigModel();
  const transcript = data.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return '';
  let fd;
  try {
    const size = fs.statSync(transcript).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(transcript, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch (e) {
        continue; // blank, partial (cut by the tail window) or non-JSON line
      }
      const model = entry && entry.message && entry.message.model;
      if (typeof model === 'string' && model) return model;
    }
  } catch (e) {
    // transcript missing/unreadable — model stays unknown
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
  return '';
}

function emit(raw) {
  const eventType = process.argv[2] || 'unknown';
  const eventFile = path.join(os.homedir(), '.claude', 'agent-events.jsonl');
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });

  let data = {};
  try {
    // trim() also strips a BOM from Windows shells/redirects.
    const trimmed = raw.trim();
    data = trimmed ? JSON.parse(trimmed) : {};
  } catch (e) {
    data = {};
  }

  const event = {
    ts: new Date().toISOString(),
    event: eventType,
    session: data.session_id || 'unknown',
    cwd: data.cwd || '',
  };

  const model = resolveModel(data);
  if (model) event.model = model;

  if (eventType === 'agent_start' || eventType === 'agent_stop') {
    event.agent = data.agent_name || data.agent_type || 'general-purpose';
    if (eventType === 'agent_stop') {
      // Claude Code: last_assistant_message; Kimi Code: response (preview).
      const msg = data.last_assistant_message || data.response || '';
      event.task = msg ? msg.slice(0, 80) : '';
      event.result = 'success';
    } else {
      // Kimi Code SubagentStart carries the delegated prompt — a real task
      // label; Claude Code only has the agent name.
      const prompt = typeof data.prompt === 'string' ? data.prompt : '';
      event.task = (prompt || data.agent_name || '').slice(0, 80);
    }
  } else if (eventType === 'agent_waiting') {
    // Claude Code Notification: message ("Claude needs your permission…").
    // Kimi Code PermissionRequest: tool_name (+action) — build the equivalent.
    if (typeof data.message === 'string' && data.message) {
      event.task = data.message.slice(0, 120);
    } else if (typeof data.tool_name === 'string' && data.tool_name) {
      event.task = `Kimi needs your permission to use ${data.tool_name}`.slice(0, 120);
    } else {
      event.task = '';
    }
  }
  // user_prompt carries no payload on purpose — the prompt text stays private.

  fs.appendFileSync(eventFile, JSON.stringify(event) + '\n', 'utf-8');

  if (eventType === 'user_prompt' && !isAutomatedPrompt(data.prompt)) {
    releaseStopFlag(event.cwd);
  }
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if ((process.argv[2] || '') === 'stop_gate') {
      if (!stopGate(input)) emitToolActivity(input);
    } else {
      emit(input);
    }
  } catch (e) {
    // A hook must never fail the agent CLI session.
  }
});
