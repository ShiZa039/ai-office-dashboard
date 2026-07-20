# Claude Office Dashboard

**Language:** **English** · [Русский](README.ru.md)

> A VSCode extension that visualizes Claude Code activity as an office floor map. Every subagent shows up as a figure in its own "room" (Backend, Frontend, QA, Security, DevOps, AI-lab, etc.), pulses while working, and gets a checkmark when done. On top: a main-model indicator, subscription usage limits, and an emergency stop button.

**Current version:** `v0.13.2` · zero-config: automatic hook installation, agent auto-discovery, dynamic rooms, real Pro/Max plan limits, agent emergency stop, en/ru UI.

---

## Why

When you orchestrate several subagents in parallel, you lose track of who is doing what and how long is left. This dashboard gives you:

- **An office map** — who is working right now and in which module. Rooms are built dynamically from the project's actual agent roster (`.claude/agents/` + session events).
- **A main-model indicator** — a banner at the top: ✋ yellow "Claude is waiting for you", ⚡ blue "working · Fable 5 · 3m", ✓ green flash "finished the turn".
- **An emergency stop 🛑** — one button blocks all agent tool calls via a `PreToolUse` hook; the session and its context are preserved. Release it with the button or simply by sending a new prompt.
- **A status bar item** — ✋ waiting / 🛑 stop / N working / errors, even while the panel is closed.
- **A timeline** (Canvas) — who ran when, with a configurable window (5 min — 6 hours).
- **An activity log** — the last 50 start/stop/waiting/stop-toggle events.
- **Plan usage** — real subscription limits (Pro/Max): the 5-hour session window and weekly limits, with percentages, reset times, and a forecast like "hits 100% in ~2h at the current pace". Same API as `/usage` in Claude Code.
- **Per-window isolation** — each VSCode window only sees its own sessions (filtered by workspace `cwd`).
- **Localization** — en/ru UI, language taken from the OS (configurable).

## Installation — zero config

1. Install the `.vsix`:

   ```
   code --install-extension claude-office-dashboard-0.13.2.vsix --force
   ```

2. Reload Window → a house icon appears in the Activity Bar.
3. On first launch the extension offers to install the Claude Code hooks itself (**Install** in the notification). That's it: scripts are copied into `~/.claude/hooks/`, and the registration is carefully merged into `~/.claude/settings.json` (existing settings and third-party hooks are left untouched; a `settings.json.claude-office.bak` backup is created). Hooks are updated automatically when the extension updates.

Nothing is tied to a specific project: open any project and the dashboard shows its agents and its Claude Code session events.

Manual hook installation and troubleshooting — [INSTALL.md](INSTALL.md).

## How it works

```
Claude Code hooks → ~/.claude/agent-events.jsonl → VSCode extension → Webview
        │                     ↑                          ↑
        │        emit-agent-event.py|.js      fs.watch + polling
        └─ PreToolUse stop_gate ← ~/.claude/office-stop.json (🛑 button)
```

1. Seven Claude Code hooks (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `UserPromptSubmit`, `PreToolUse`) run `~/.claude/hooks/emit-agent-event.py` (or `.js` if Python is not in PATH) — the script appends a JSONL event.
2. The extension watches the file (`fs.watch` + 1-second polling) and keeps agent state in memory.
3. The webview renders the map, the timeline, and the counters; updates flow through `postMessage`, and the panel resyncs when it becomes visible again.
4. The cwd filter (`claudeOffice.scope = workspace`) drops events from other VSCode windows.
5. The Plan usage panel polls `api.anthropic.com/api/oauth/usage` with the OAuth token of your Claude Code login (`~/.claude/.credentials.json`; Keychain on macOS). The token is never sent anywhere except the Anthropic API.
6. The emergency stop writes a `~/.claude/office-stop.json` flag; the `PreToolUse` gate rejects every tool call while the flag covers the session's cwd. Without the flag the gate exits instantly (a single file-existence check).

## Emergency stop

The 🛑 button on the dashboard (or the `Claude Office: Emergency Stop / Resume Agents` command):

- blocks **new** tool calls of the main agent and all subagents in the current window's projects; an already-running long command (e.g. a Bash build) finishes on its own;
- the session and its context are preserved — it's a pause, not a kill;
- the stop is **per-project**: the flag stores the workspace folders, so sessions of other projects are unaffected. The same project in another window/terminal stops too;
- a window with no open folder (or `scope = global`) sets a **global** stop — a confirmation dialog is shown first;
- release: the "Resume" button (releases only its own folders — stops set by other windows survive), or automatically by a new prompt in the stopped project. Only human-typed prompts count: system injections (background-task completion notifications, `system-reminder`) pass through the same `UserPromptSubmit` hook but do not release the stop.

## Rooms and agent mapping

Rooms are built dynamically: only rooms with at least one agent are rendered. Curated rooms (`directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`) have their own icons and colors; any custom id from the mapping creates its own room (color derived from a hash).

Where an agent goes (by priority):

1. **`.claude/office-rooms.json`** in the project — explicit mapping, committed with the repo.
2. **`claudeOffice.agentRooms`** in VSCode settings.
3. **Built-in Claude Code agents** — `general-purpose`, `Explore`, `Plan`, `code-reviewer`, etc.
4. **Keyword heuristics** on the name (stem matching, ~100 tokens) — `react-*` → frontend, `*-director` → directors, `postgres/schema` → backend, `docker/ci/deploy` → devops, and so on.
5. **Lobby** — everything unrecognized.

For most projects the heuristics are enough — no configuration needed.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeOffice.language` | `system` | UI language: `system` (OS language) / `vscode` / `en` / `ru` |
| `claudeOffice.hooks.autoSetup` | `true` | Offer automatic hook installation and keep hook scripts updated |
| `claudeOffice.statusBar.enabled` | `true` | Status bar item (waiting / stop / working / errors) |
| `claudeOffice.roster.enabled` | `true` | Show project agents from `.claude/agents/` immediately (idle) |
| `claudeOffice.scope` | `workspace` | `workspace` = this window only (cwd filter); `global` = all windows |
| `claudeOffice.agentRooms` | `{}` | Custom agent-to-room mapping |
| `claudeOffice.eventsFile` | `~/.claude/agent-events.jsonl` | Path to the JSONL events file |
| `claudeOffice.usage.enabled` | `true` | Plan usage panel (real subscription limits) |
| `claudeOffice.usage.pollSeconds` | `90` | Usage refresh interval |
| `claudeOffice.usage.costSource` | `off` | `ccusage` = extra $-bars via `npx ccusage` |
| `claudeOffice.usage.limitBlockUsd` | `0` | $ limit per 5-hour block (ccusage bars only) |
| `claudeOffice.usage.limitWeeklyUsd` | `0` | $ limit per week (ccusage bars only) |
| `claudeOffice.usage.limitWeeklyOpusUsd` | `0` | $ limit per week for Opus (ccusage bars only) |

## Commands

- `Claude Office: Show Dashboard` — focus the Activity Bar panel
- `Claude Office: Open Dashboard in Editor` — open as a regular tab (alongside the sidebar)
- `Claude Office: Emergency Stop / Resume Agents` — 🛑 stop/resume agents
- `Claude Office: Install Claude Code Hooks` — install/repair hooks manually
- `Claude Office: Clear Events` — reset the event cache

The installed extension version is shown in the bottom-right corner of the dashboard.

## Development

```bash
git clone https://github.com/ShiZa039/claude-office-dashboard.git
cd claude-office-dashboard
npm install
npm run compile        # tsc → out/
npm test               # unit tests (parser, types, state, hooks, usage, roster, stop)
npx @vscode/vsce package  # build the .vsix
```

Release history and plans — [ROADMAP.md](ROADMAP.md) (in Russian).

## Requirements

- VSCode ≥ 1.85
- Claude Code CLI with hook support (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`)
- Python 3 **or** Node.js in `PATH` (for the hook script; the extension picks whichever is available)
- For the Plan usage panel — a Claude Code subscription login (Pro/Max). With an API key the limits panel is unavailable; you can enable $-estimates via `claudeOffice.usage.costSource = "ccusage"`.

## Known limitations

- `SubagentStart` does not pass `description`/`prompt` ([anthropics/claude-code#19170](https://github.com/anthropics/claude-code/issues/19170)) — the `task` field is filled from `last_assistant_message` on `agent_stop`.
- The subscription limits endpoint is undocumented (the same one `/usage` in Claude Code uses) — the format may change; the parser is resilient to missing fields.
- The emergency stop does not interrupt a tool call that is already running — only subsequent calls are blocked.
- Sound effects are not planned.

## License

[MIT](LICENSE)
