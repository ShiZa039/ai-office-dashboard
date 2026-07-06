"""Emit agent event to JSONL file for Claude Office Dashboard.

Reads hook JSON from stdin, writes event to ~/.claude/agent-events.jsonl.
Usage: python emit-agent-event.py <event_type>
  event_type: session_start | agent_start | agent_stop | session_stop
"""
import json
import sys
import os
from datetime import datetime, timezone

TRANSCRIPT_TAIL_BYTES = 256 * 1024

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

    with open(event_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()
