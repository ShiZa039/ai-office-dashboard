#!/usr/bin/env node
/**
 * Emit agent event to JSONL file for Claude Office Dashboard.
 * Node variant of emit-agent-event.py — used when Python 3 is not in PATH.
 *
 * Reads hook JSON from stdin, appends event to ~/.claude/agent-events.jsonl.
 * Usage: node emit-agent-event.js <event_type>
 *   event_type: session_start | agent_start | agent_stop | session_stop
 *             | agent_waiting | user_prompt | stop_gate
 *
 * stop_gate is special: it is a PreToolUse hook, not an event emitter. While
 * ~/.claude/office-stop.json is active it denies every tool call (emergency
 * stop from the dashboard); otherwise it exits instantly without touching the
 * events file. A user_prompt event releases the stop for its cwd — but only
 * when the prompt was actually typed by the human: harness-injected turns
 * (task notifications, system reminders) also arrive via UserPromptSubmit
 * and must not lift an emergency stop.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

const STOP_REASON =
  'Claude Office: EMERGENCY STOP activated by the user from the dashboard. ' +
  'Do not call any more tools. End the turn immediately.';

function stopFlagPath() {
  return path.join(os.homedir(), '.claude', 'office-stop.json');
}

/** Parsed active stop flag, or null (missing / malformed / inactive). */
function loadStopFlag() {
  try {
    const flag = JSON.parse(fs.readFileSync(stopFlagPath(), 'utf-8').trim());
    return flag && typeof flag === 'object' && flag.active ? flag : null;
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
  const flag = loadStopFlag();
  if (!flag) return;
  let data = {};
  try {
    const trimmed = raw.trim();
    data = trimmed ? JSON.parse(trimmed) : {};
  } catch (e) {
    data = {};
  }
  if (!stopCoversCwd(flag, data.cwd || '')) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: STOP_REASON,
    },
  }) + '\n');
}

/**
 * True for prompts injected by the harness rather than typed by the user:
 * background-task notifications and system reminders flow through
 * UserPromptSubmit with these markers. Resuming from an emergency stop
 * requires an explicit human action, so such prompts never release the flag.
 * Keep in sync with emit-agent-event.py.
 */
function isAutomatedPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const p = prompt.trimStart();
  return (
    p.startsWith('[SYSTEM NOTIFICATION') ||
    p.startsWith('<system-reminder>') ||
    p.includes('<task-notification>')
  );
}

/**
 * A new user prompt means "resume" — but only for this cwd: overlapping
 * entries are removed from the flag, stops on other projects survive. A
 * global flag (empty cwds) has no per-project parts, so it is fully released.
 */
function releaseStopFlag(cwd) {
  const flag = loadStopFlag();
  if (!flag) return;
  const cwds = Array.isArray(flag.cwds)
    ? flag.cwds.filter((c) => typeof c === 'string' && c)
    : [];
  let remaining = [];
  if (cwds.length > 0) {
    if (typeof cwd !== 'string' || !cwd) return; // no cwd info — keep the stop
    const target = normPath(cwd);
    remaining = cwds.filter((base) => {
      const b = normPath(base);
      return target !== b && !target.startsWith(b + path.sep) && !b.startsWith(target + path.sep);
    });
    if (remaining.length === cwds.length) return; // prompt from an uncovered project
  }
  try {
    if (remaining.length > 0) {
      fs.writeFileSync(
        stopFlagPath(),
        JSON.stringify({ ...flag, cwds: remaining }, null, 2) + '\n',
        'utf-8',
      );
    } else {
      fs.unlinkSync(stopFlagPath());
    }
  } catch (e) { /* best effort */ }
}

/**
 * Best-effort model ID for the session. SessionStart payloads carry `model`
 * directly (not guaranteed); other events fall back to the newest assistant
 * entry in the transcript, so a mid-session /model switch shows up on the
 * next event. Returns '' when the model cannot be determined.
 */
function resolveModel(data) {
  if (typeof data.model === 'string' && data.model) return data.model;
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
      const msg = data.last_assistant_message || '';
      event.task = msg ? msg.slice(0, 80) : '';
      event.result = 'success';
    } else {
      event.task = data.agent_name || '';
    }
  } else if (eventType === 'agent_waiting') {
    // Notification hook: carry the reason ("Claude needs your permission…").
    const msg = typeof data.message === 'string' ? data.message : '';
    event.task = msg.slice(0, 120);
  }
  // user_prompt carries no payload on purpose — the prompt text stays private.

  fs.appendFileSync(eventFile, JSON.stringify(event) + '\n', 'utf-8');

  if (eventType === 'user_prompt' && !isAutomatedPrompt(data.prompt)) {
    releaseStopFlag(event.cwd);
  }
}

// stop_gate fast path: no flag file — allow without even reading stdin.
// This hook runs on every tool call, so the common case must stay cheap.
if ((process.argv[2] || '') === 'stop_gate' && !fs.existsSync(stopFlagPath())) {
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    if ((process.argv[2] || '') === 'stop_gate') stopGate(input);
    else emit(input);
  } catch (e) {
    // A hook must never fail the Claude Code session.
  }
});
