"""Emit agent event to JSONL file for AI Office Dashboard.

Reads hook JSON from stdin, writes event to ~/.claude/agent-events.jsonl.
Usage: python emit-agent-event.py <event_type> [cli]
  event_type: session_start | agent_start | agent_stop | session_stop
            | agent_waiting | user_prompt | stop_gate
  cli: claude (default) | kimi — which agent CLI fired the hook. Kimi Code
       payloads use the same snake_case base fields (session_id, cwd) but
       different event-specific ones (agent_name+prompt/response, tool_name
       for permission waits) and carry no model/transcript, so the model
       falls back to ~/.kimi-code/config.toml.

stop_gate is special: it is a PreToolUse hook, not a turn-level event. While
the office-stop flag for THIS cli (~/.claude/office-stop.json resp.
~/.kimi-code/office-stop.json) is active it denies every tool call
(emergency stop from the dashboard). An allowed call appends a lightweight
tool_activity event instead: the first tool call after the user answers a
permission prompt (e.g. approving plan-mode exit) clears the dashboard's
"waiting" banner, which no turn-level hook would fire for. A user_prompt
event releases the stop for its
cwd — in BOTH cli flag files, so a human prompt anywhere resumes
everywhere — but only when the prompt was actually typed by the human:
harness-injected turns (task notifications, system reminders, cron fires)
also arrive via UserPromptSubmit and must not lift an emergency stop.
"""
import json
import re
import sys
import os
from datetime import datetime, timezone

TRANSCRIPT_TAIL_BYTES = 256 * 1024

STOP_REASON = (
    "AI Office: EMERGENCY STOP activated by the user from the dashboard. "
    "Do not call any more tools. End the turn immediately."
)

CLI = "kimi" if len(sys.argv) > 2 and sys.argv[2] == "kimi" else "claude"

def claude_stop_flag_path():
    return os.path.join(os.path.expanduser("~"), ".claude", "office-stop.json")

def kimi_stop_flag_path():
    return os.path.join(os.path.expanduser("~"), ".kimi-code", "office-stop.json")

def stop_flag_path():
    """The flag file gating this cli's tool calls."""
    return kimi_stop_flag_path() if CLI == "kimi" else claude_stop_flag_path()

def all_stop_flag_paths():
    """All flag files — a human prompt releases the stop for every cli at once."""
    return [claude_stop_flag_path(), kimi_stop_flag_path()]

def load_stop_flag(flag_path):
    """Parsed active stop flag, or None (missing / malformed / inactive)."""
    try:
        with open(flag_path, encoding="utf-8-sig") as f:
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
    try:
        raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}
    flag = load_stop_flag(stop_flag_path())
    if flag and stop_covers_cwd(flag, data.get("cwd", "")):
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": STOP_REASON,
            }
        }))
        return
    emit_tool_activity(data)

def emit_tool_activity(data):
    """Append a lightweight activity event for an allowed tool call.

    The first tool call after the user answers a permission prompt (e.g.
    plan-mode exit) clears the dashboard's "waiting" banner, which no
    turn-level hook would fire for.
    """
    event_file = os.path.join(os.path.expanduser("~"), ".claude", "agent-events.jsonl")
    os.makedirs(os.path.dirname(event_file), exist_ok=True)
    event = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "event": "tool_activity",
        "session": data.get("session_id", "unknown"),
        "cwd": data.get("cwd", ""),
    }
    with open(event_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

def is_automated_prompt(prompt):
    """True for prompts injected by the harness rather than typed by the user.

    Background-task notifications, system reminders and scheduled cron fires
    flow through UserPromptSubmit with these markers. Resuming from an
    emergency stop requires an explicit human action, so such prompts never
    release the flag. Keep in sync with emit-agent-event.js.
    """
    if not isinstance(prompt, str):
        return False
    p = prompt.lstrip()
    return (
        p.startswith("[SYSTEM NOTIFICATION")
        or p.startswith("<system-reminder>")
        or p.startswith("<cron-fire")
        or "<task-notification>" in p
    )

def release_stop_flag(cwd):
    """A new user prompt means "resume" — but only for this cwd.

    Overlapping entries are removed from the flag, stops on other projects
    survive. A global flag (empty cwds) has no per-project parts, so it is
    fully released. Applied to every cli's flag file so one human prompt
    resumes all agents. Keep in sync with emit-agent-event.js.
    """
    for flag_path in all_stop_flag_paths():
        flag = load_stop_flag(flag_path)
        if not flag:
            continue
        raw_cwds = flag.get("cwds")
        cwds = [c for c in raw_cwds if isinstance(c, str) and c] if isinstance(raw_cwds, list) else []
        remaining = []
        if cwds:
            if not isinstance(cwd, str) or not cwd:
                continue  # no cwd info — keep the stop
            target = os.path.normcase(os.path.normpath(cwd))
            for base in cwds:
                b = os.path.normcase(os.path.normpath(base))
                if target == b or target.startswith(b + os.sep) or b.startswith(target + os.sep):
                    continue
                remaining.append(base)
            if len(remaining) == len(cwds):
                continue  # prompt from an uncovered project
        try:
            if remaining:
                flag["cwds"] = remaining
                with open(flag_path, "w", encoding="utf-8") as f:
                    json.dump(flag, f, indent=2)
            else:
                os.remove(flag_path)
        except OSError:
            pass

def kimi_config_model():
    """Model alias from ~/.kimi-code/config.toml (`default_model = "…"`), '' if absent."""
    try:
        with open(
            os.path.join(os.path.expanduser("~"), ".kimi-code", "config.toml"),
            encoding="utf-8",
        ) as f:
            text = f.read()
    except OSError:
        return ""
    m = re.search(r'^\s*default_model\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else ""

def resolve_model(data):
    """Best-effort model ID for the session.

    Claude Code SessionStart payloads carry `model` directly (not
    guaranteed); other Claude events fall back to the newest assistant entry
    in the transcript, so a mid-session /model switch shows up on the next
    event. Kimi Code payloads carry neither, so kimi events fall back to the
    default model in ~/.kimi-code/config.toml. Returns "" when the model
    cannot be determined.
    """
    model = data.get("model")
    if isinstance(model, str) and model:
        return model
    if CLI == "kimi":
        return kimi_config_model()
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
    except Exception:
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
            # Claude Code: last_assistant_message; Kimi Code: response (preview).
            msg = data.get("last_assistant_message") or data.get("response") or ""
            event["task"] = msg[:80] if msg else ""
            event["result"] = "success"
        else:
            # Kimi Code SubagentStart carries the delegated prompt — a real
            # task label; Claude Code only has the agent name.
            prompt = data.get("prompt")
            event["task"] = (prompt if isinstance(prompt, str) and prompt else data.get("agent_name", ""))[:80]
    elif event_type == "agent_waiting":
        # Claude Code Notification: message ("Claude needs your permission…").
        # Kimi Code PermissionRequest: tool_name — build the equivalent.
        msg = data.get("message")
        if isinstance(msg, str) and msg:
            event["task"] = msg[:120]
        else:
            tool = data.get("tool_name")
            event["task"] = ("Kimi needs your permission to use " + tool)[:120] if isinstance(tool, str) and tool else ""
    # user_prompt carries no payload on purpose — the prompt text stays private.

    with open(event_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

    if event_type == "user_prompt" and not is_automated_prompt(data.get("prompt")):
        release_stop_flag(cwd)

if __name__ == "__main__":
    main()
