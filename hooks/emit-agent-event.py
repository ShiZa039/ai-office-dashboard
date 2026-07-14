"""Emit agent event to JSONL file for Claude Office Dashboard.

Reads hook JSON from stdin, writes event to ~/.claude/agent-events.jsonl.
Usage: python emit-agent-event.py <event_type>
  event_type: session_start | agent_start | agent_stop | session_stop
            | agent_waiting | user_prompt | stop_gate

stop_gate is special: it is a PreToolUse hook, not an event emitter. While
~/.claude/office-stop.json is active it denies every tool call (emergency
stop from the dashboard); otherwise it exits instantly without touching the
events file. A user_prompt event releases the stop for its cwd.
"""
import json
import sys
import os
from datetime import datetime, timezone

TRANSCRIPT_TAIL_BYTES = 256 * 1024

STOP_REASON = (
    "Claude Office: EMERGENCY STOP activated by the user from the dashboard. "
    "Do not call any more tools. End the turn immediately."
)

def stop_flag_path():
    return os.path.join(os.path.expanduser("~"), ".claude", "office-stop.json")

def load_stop_flag():
    """Parsed active stop flag, or None (missing / malformed / inactive)."""
    try:
        with open(stop_flag_path(), encoding="utf-8-sig") as f:
            flag = json.load(f)
    except (OSError, ValueError):
        return None
    return flag if isinstance(flag, dict) and flag.get("active") else None

def stop_covers_cwd(flag, cwd):
    """True when the stop flag applies to a session running in `cwd`.

    An empty/absent cwds list means a global stop (all sessions).
    """
    cwds = flag.get("cwds")
    if not isinstance(cwds, list) or len(cwds) == 0:
        return True
    if not isinstance(cwd, str) or not cwd:
        return False
    target = os.path.normcase(os.path.normpath(cwd))
    for base in cwds:
        if not isinstance(base, str) or not base:
            continue
        b = os.path.normcase(os.path.normpath(base))
        if target == b or target.startswith(b + os.sep):
            return True
    return False

def handle_stop_gate():
    """PreToolUse gate: deny the tool call while the stop flag covers this cwd."""
    # Fast path: no flag file — allow without even reading stdin. This hook
    # runs on every tool call, so the common case must stay cheap.
    if not os.path.exists(stop_flag_path()):
        return
    flag = load_stop_flag()
    if not flag:
        return
    try:
        raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, Exception):
        data = {}
    if not stop_covers_cwd(flag, data.get("cwd", "")):
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": STOP_REASON,
        }
    }))

def release_stop_flag(cwd):
    """A new user prompt means "resume": drop the stop flag covering this cwd."""
    flag = load_stop_flag()
    if flag and stop_covers_cwd(flag, cwd):
        try:
            os.remove(stop_flag_path())
        except OSError:
            pass

def resolve_model(data):
    """Best-effort model ID for the session.

    SessionStart payloads carry `model` directly (not guaranteed); other
    events fall back to the newest assistant entry in the transcript, so a
    mid-session /model switch shows up on the next event. Returns "" when
    the model cannot be determined.
    """
    model = data.get("model")
    if isinstance(model, str) and model:
        return model
    transcript = data.get("transcript_path")
    if not isinstance(transcript, str) or not transcript:
        return ""
    try:
        size = os.path.getsize(transcript)
        with open(transcript, "rb") as f:
            f.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            tail = f.read().decode("utf-8", errors="replace")
        for line in reversed(tail.splitlines()):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # blank, partial (cut by the tail window) or non-JSON line
            if not isinstance(entry, dict):
                continue
            message = entry.get("message")
            if isinstance(message, dict):
                model = message.get("model")
                if isinstance(model, str) and model:
                    return model
    except OSError:
        pass  # transcript missing/unreadable — model stays unknown
    return ""

def main():
    event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    if event_type == "stop_gate":
        handle_stop_gate()
        return
    event_file = os.path.join(os.path.expanduser("~"), ".claude", "agent-events.jsonl")

    # Ensure directory exists
    os.makedirs(os.path.dirname(event_file), exist_ok=True)

    try:
        # utf-8-sig: tolerate a BOM from Windows shells/redirects.
        raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, Exception):
        data = {}

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    session = data.get("session_id", "unknown")
    cwd = data.get("cwd", "")

    event = {"ts": ts, "event": event_type, "session": session, "cwd": cwd}

    model = resolve_model(data)
    if model:
        event["model"] = model

    if event_type in ("agent_start", "agent_stop"):
        event["agent"] = data.get("agent_name", data.get("agent_type", "general-purpose"))
        if event_type == "agent_stop":
            msg = data.get("last_assistant_message", "")
            event["task"] = msg[:80] if msg else ""
            event["result"] = "success"
        else:
            event["task"] = data.get("agent_name", "")
    elif event_type == "agent_waiting":
        # Notification hook: carry the reason ("Claude needs your permission…").
        msg = data.get("message", "")
        event["task"] = msg[:120] if isinstance(msg, str) else ""
    # user_prompt carries no payload on purpose — the prompt text stays private.

    with open(event_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

    if event_type == "user_prompt":
        release_stop_flag(cwd)

if __name__ == "__main__":
    main()
