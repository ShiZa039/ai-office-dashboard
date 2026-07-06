#!/usr/bin/env node
/**
 * Emit agent event to JSONL file for Claude Office Dashboard.
 * Node variant of emit-agent-event.py — used when Python 3 is not in PATH.
 *
 * Reads hook JSON from stdin, appends event to ~/.claude/agent-events.jsonl.
 * Usage: node emit-agent-event.js <event_type>
 *   event_type: session_start | agent_start | agent_stop | session_stop
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

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
  }

  fs.appendFileSync(eventFile, JSON.stringify(event) + '\n', 'utf-8');
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    emit(input);
  } catch (e) {
    // A hook must never fail the Claude Code session.
  }
});
