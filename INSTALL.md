# Installing AI Office

**Language:** **English** · [Русский](INSTALL.ru.md)

The extension visualizes Claude Code and Kimi Code CLI subagent activity as an "office with rooms". It consists of two parts:

1. **CLI hooks** (Claude Code and/or Kimi Code) — write events to `~/.claude/agent-events.jsonl`. **Since v0.9.0 they are installed automatically** by the extension.
2. **The VSCode extension** — reads the JSONL and renders the dashboard.

---

## Quick install (recommended)

### Requirements

- VSCode ≥ 1.85
- Claude Code CLI with hook support (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`) and/or Kimi Code CLI — both are supported simultaneously
- Python 3 **or** Node.js in `PATH` (for the hook script — the extension finds whichever is available)

### Steps

1. Install the extension:

   ```powershell
   # Windows
   & 'C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' `
     --install-extension 'D:\path\to\ai-office-dashboard-0.16.0.vsix' --force
   ```

   ```bash
   # Linux/macOS
   code --install-extension /path/to/ai-office-dashboard-0.16.0.vsix --force
   ```

2. `Ctrl+Shift+P` → **Developer: Reload Window**.
3. A notification appears: *"Claude Code hooks are not set up… Install them automatically?"* → click **Install**.

   What happens:
   - `emit-agent-event.py` and `emit-agent-event.js` are copied into `~/.claude/hooks/`;
   - seven hooks are added to `~/.claude/settings.json`: `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` (agent events), `Notification` (the "Claude is waiting for you" banner), `UserPromptSubmit` (turn start + auto-release of the stop), `PreToolUse` (the emergency-stop gate). Existing file contents and third-party hooks are left untouched; a `settings.json.ai-office.bak` backup is created before writing;
   - if Kimi Code CLI is present, the same scripts are copied into `~/.kimi-code/hooks/` and `[[hooks]]` blocks are merged into `~/.kimi-code/config.toml` (each block tagged with a `# office-dashboard-hook: <Event>` beacon comment; a `config.toml.office-dashboard.bak` backup is created);
   - when the extension updates, the hook scripts and the set of registrations are updated automatically.

4. Done. Start a Claude Code or Kimi Code session in a project and spawn any subagent — a figure appears on the dashboard.

If you dismissed the notification — `Ctrl+Shift+P` → **AI Office: Install Agent Hooks**.

### Which CLIs get hooks — `aiOffice.hooks.targets`

By default (`auto`) hooks are installed into every CLI whose home directory exists (`~/.claude` / `~/.kimi-code`); if neither exists, both are configured. To restrict installation, set `"aiOffice.hooks.targets"` to `"claude"`, `"kimi"` or `"both"`. The **AI Office: Install Agent Hooks** command installs into all selected targets.

### Plan usage panel (subscription limits)

Works out of the box if you are logged into Claude Code with a Pro/Max subscription: the extension reads the OAuth token from `~/.claude/.credentials.json` (Keychain on macOS) and polls the same endpoint the `/usage` command in Claude Code uses. It shows:

- **Session (5h)** — percentage of the 5-hour window + when it resets;
- **Week (all)** — the weekly limit across all models;
- **Week (Opus)** — the weekly Opus limit (Max plans only);
- a plan badge (Pro / Max).

The token is used only for the request to `api.anthropic.com` and is never sent anywhere else. This panel (like the ccusage $-bars below) is Claude Code only — Kimi Code has no equivalent local API.

If you work with an API key (no subscription) there are no limits; you can enable $-cost estimates instead:

```json
{
  "aiOffice.usage.costSource": "ccusage",
  "aiOffice.usage.limitBlockUsd": 50,
  "aiOffice.usage.limitWeeklyUsd": 200,
  "aiOffice.usage.limitWeeklyOpusUsd": 100
}
```

(`npx` must be in PATH; `ccusage@latest` is used).

---

## Per-project configuration

In most cases **no configuration is needed**:

- the dashboard filters events by the current workspace `cwd` (`aiOffice.scope = workspace` by default);
- project agents from `.claude/agents/**/*.md` show up immediately as idle figures (`aiOffice.roster.enabled`);
- the room is picked by keyword heuristics on the agent name (`react-*` → frontend, `*-director` → directors, `mqtt/esp32` → iot, etc.).

Customization is only needed when the heuristics miss.

### Your agents → your rooms

Known rooms: `directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`.

Option 1 — a `.claude/office-rooms.json` file in the project (committed with the repo, highest priority):

```json
{
  "my-custom-billing-agent": "backend",
  "release-lead": "devops"
}
```

Option 2 — VSCode settings (`Ctrl+,` → Workspace → `aiOffice.agentRooms`):

```json
{
  "aiOffice.agentRooms": {
    "ux-research-agent": "frontend",
    "compliance-checker": "security"
  }
}
```

Priority: **`.claude/office-rooms.json` > `aiOffice.agentRooms` > built-in Claude Code agents > heuristics > lobby**. Changes are picked up on the fly.

### Disabling per-window isolation

To see events from all VSCode windows at once:

```json
{ "aiOffice.scope": "global" }
```

---

## Manual hook installation (fallback)

Only needed when automatic installation doesn't fit (e.g. `settings.json` is generated by another tool).

1. Copy `hooks/emit-agent-event.py` **and** `hooks/emit-agent-event.js` from the repository into `~/.claude/hooks/`.
2. Add to `~/.claude/settings.json` (the full set — seven events):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" session_start", "timeout": 5 } ] }
    ],
    "SubagentStart": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" agent_start", "timeout": 5 } ] }
    ],
    "SubagentStop": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" agent_stop", "timeout": 5 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" session_stop", "timeout": 5 } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" agent_waiting", "timeout": 5 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" user_prompt", "timeout": 5 } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "python \"$HOME/.claude/hooks/emit-agent-event.py\" stop_gate", "timeout": 5 } ] }
    ]
  }
}
```

For the Node variant replace `python "...emit-agent-event.py"` with `node "...emit-agent-event.js"`. Claude Code expands `$HOME` itself on all platforms.

Without `Notification`/`UserPromptSubmit` there is no "Claude is waiting for you" banner and no main-model indicator; without `PreToolUse` the emergency stop 🛑 won't work (the button sets the flag, but nothing blocks the tool calls).

3. Verify: spawn a subagent and check the tail of the events file:

```powershell
Get-Content "$env:USERPROFILE\.claude\agent-events.jsonl" -Tail 5   # Windows
```

```bash
tail -5 ~/.claude/agent-events.jsonl                                 # Linux/macOS
```

---

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Dashboard is empty, only idle figures | Hooks not installed / not writing | `Ctrl+Shift+P` → **AI Office: Install Agent Hooks**; check whether `~/.claude/agent-events.jsonl` is growing |
| `agent-events.jsonl` is empty | Hooks not registered | Check `~/.claude/settings.json` (the `hooks` section), restart Claude Code |
| The install notification never appears | "Don't ask again" was clicked earlier | The **AI Office: Install Agent Hooks** command installs manually |
| Events arrive but nothing shows | The cwd filter drops everything | Look for the `cwd filter` line in Output (`View → Output → AI Office`); to test, set `aiOffice.scope = global` |
| An agent always lands in the Lobby | Its name doesn't match the heuristics | Add it to `.claude/office-rooms.json` or `aiOffice.agentRooms` |
| Plan usage: `no Claude Code login found` | No `~/.claude/.credentials.json` | Log into Claude Code (`claude` → subscription login) |
| Plan usage: stale data | Token expired | Expiry is silent now — run any Claude Code session and the token refreshes itself |
| Plan usage: `HTTP 429` | Endpoint rate limit | Passes on its own; you can raise `usage.pollSeconds` |
| Cyrillic in `task` breaks | Old `emit-agent-event.py` | Hook scripts update automatically with `hooks.autoSetup = true`; otherwise reinstall via the command |
| 🛑 doesn't block agents | The `PreToolUse` hook is not registered (old hook set) | **AI Office: Install Agent Hooks** — missing events get merged in |
| Tools are blocked though you never enabled the stop | A stale stop flag remains | Click "Resume" on the dashboard, send a new prompt, or delete `~/.claude/office-stop.json` and `~/.kimi-code/office-stop.json` |

---

## Updating the extension

```powershell
& 'C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' `
  --install-extension 'D:\path\to\ai-office-dashboard-X.Y.Z.vsix' --force
```

Then **Developer: Reload Window**. Hook scripts update themselves on the next activation (with `aiOffice.hooks.autoSetup = true`).
