# AI Office

**Language:** **English** В· [Р СѓСЃСЃРєРёР№](README.ru.md)

> A VSCode extension that visualizes Claude Code and Kimi Code CLI activity as an office floor map. Every subagent shows up as a figure in its own "room" (Backend, Frontend, QA, Security, DevOps, AI-lab, etc.), pulses while working, and gets a checkmark when done. On top: a main-model indicator, subscription usage limits, and an emergency stop button.

**Current version:** `v0.18.1` В· zero-config: dual CLI support (Claude Code + Kimi Code), automatic hook installation, agent auto-discovery, dynamic rooms, real Pro/Max plan limits, token & cost counters, agent emergency stop, en/ru UI.

---

## Why

When you orchestrate several subagents in parallel, you lose track of who is doing what and how long is left. The extension works with both Claude Code and Kimi Code CLI at the same time вЂ” agents from both CLIs appear on the same map. This dashboard gives you:

- **An office map** вЂ” who is working right now and in which module. Rooms are built dynamically from the project's actual agent roster (`.claude/agents/`, `.kimi-code/agents/`, `.agents/agents/` + session events).
- **A main-model indicator** вЂ” a banner at the top: вњ‹ yellow "Claude is waiting for you", вљЎ blue "working В· Fable 5 В· 3m", вњ“ green flash "finished the turn".
- **An emergency stop рџ›‘** вЂ” one button blocks all agent tool calls via a `PreToolUse` hook; the session and its context are preserved. Release it with the button or simply by sending a new prompt.
- **A status bar item** вЂ” вњ‹ waiting / рџ›‘ stop / N working / errors, even while the panel is closed.
- **A timeline** (Canvas) вЂ” who ran when, with a configurable window (5 min вЂ” 6 hours).
- **An activity log** вЂ” the last 50 start/stop/waiting/stop-toggle events.
- **Plan usage** вЂ” real subscription limits: the 5-hour session window and weekly limits, with percentages, reset times, a burn-pace indicator ("running hot / on pace / room to spare") with an even-pace tick on each bar, a forecast like "hits 100% in ~2h at the current pace", and quota degradation alerts. Same API as `/usage` in Claude Code; Kimi Code limits come from the Kimi Code API.
- **Token counters** вЂ” incoming (prompt + cache write + cache read) and outgoing tokens for the current CLI session and for the project as a whole, read straight from the local transcripts (`~/.claude/projects/`) вЂ” no subprocess, no network. The project total spans every session ever recorded there and survives transcript pruning. Hovering a counter breaks it down by kind (prompt / cache write / cache read) and by model вЂ” Opus, Sonnet, the Haiku behind background tasks, or whatever else the CLI logged.
- **API-equivalent cost ($)** вЂ” a third column next to the token counters prices the session and the project at public API list rates (cache writes Г—1.25/Г—2 by TTL, cache reads Г—0.1), with a per-model cost breakdown in the tooltip. Below, a summary line compares the last 30 days against your subscription price вЂ” "30 days в‰€ $142 at API prices В· Max $100/mo вЂ” subscription saves Г—1.4". The subscription price comes from `aiOffice.usage.subscriptionUsd`, or is guessed from your plan when unset. Models without a known price (e.g. Kimi) are excluded rather than counted as zero.
- **Context gauge** вЂ” how full the current session's context window is: the prompt size of the latest request vs the model's window (200K, or 1M for `[1m]` models), with yellow/red thresholds at 70/90%. Subagent (sidechain) requests have their own context and don't move the gauge.
- **Burn sparkline** вЂ” the session's token rate (tokens/min) over the last 30 minutes: outgoing as a green area, incoming (cache included) as a blue line.
- **Per-window isolation** вЂ” each VSCode window only sees its own sessions (filtered by workspace `cwd`).
- **Localization** вЂ” en/ru UI, language taken from the OS (configurable).

## Installation вЂ” zero config

1. Install the `.vsix`:

   ```
   code --install-extension ai-office-dashboard-0.18.1.vsix --force
   ```

2. Reload Window в†’ a house icon appears in the Activity Bar.
3. On first launch the extension offers to install the hooks itself (**Install** in the notification). That's it: scripts are copied into `~/.claude/hooks/`, and the registration is carefully merged into `~/.claude/settings.json` (existing settings and third-party hooks are left untouched; a `settings.json.ai-office.bak` backup is created). If Kimi Code CLI is present, the scripts also go into `~/.kimi-code/hooks/` and `[[hooks]]` blocks are merged into `~/.kimi-code/config.toml` (backup `config.toml.office-dashboard.bak`). Which CLIs get hooks is controlled by `aiOffice.hooks.targets` (`auto` by default). Hooks are updated automatically when the extension updates.

Nothing is tied to a specific project: open any project and the dashboard shows its agents and its Claude Code session events.

Manual hook installation and troubleshooting вЂ” [INSTALL.md](INSTALL.md).

## Migration from Claude Office Dashboard

If you used the extension under its old name (в‰¤ v0.13.x):

- The extension is now released as **AI Office** (`ai-office-dashboard`). The old `claude-office-dashboard` build does not update automatically вЂ” install the new `.vsix` (the old extension can be uninstalled afterwards).
- All settings and commands were renamed `claudeOffice.*` в†’ `aiOffice.*`. Values migrated automatically through v0.16.0; the deprecated aliases are removed in later builds вЂ” if you are upgrading from the `claude-office-dashboard` era, run v0.16.0 once first.
- Custom keybindings bound to `claudeOffice.*` commands are not migrated вЂ” update them manually in `keybindings.json`.

## How it works

```
Claude Code hooks в”Ђв”ђ
                   в”њв”Ђв†’ ~/.claude/agent-events.jsonl в”Ђв†’ VSCode extension в”Ђв†’ Webview
Kimi Code hooks  в”Ђв”Ђв”          в†‘                              в†‘
                  emit-agent-event.py|.js            fs.watch + polling
        PreToolUse stop_gate в†ђ ~/.claude/office-stop.json + ~/.kimi-code/office-stop.json (рџ›‘ button)
```

1. Seven Claude Code hooks (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `UserPromptSubmit`, `PreToolUse`) run `~/.claude/hooks/emit-agent-event.py` (or `.js` if Python is not in PATH) вЂ” the script appends a JSONL event. Kimi Code registers its own set in `~/.kimi-code/config.toml` with the same script: `SessionStart`в†’`session_start`, `SubagentStart`в†’`agent_start` (the delegated prompt lands in `task` вЂ” even more informative than Claude's), `SubagentStop`в†’`agent_stop` (task = reply preview), `Stop`в†’`session_stop`, `PermissionRequest`в†’`agent_waiting` (Kimi's counterpart of the "waiting for permission" Notification, with a message like "Kimi needs your permission to use \<tool\>"), `UserPromptSubmit`в†’`user_prompt`, `PreToolUse`в†’`stop_gate`. The script's second argument selects the CLI: `emit-agent-event.js <event_type> [claude|kimi]`.
2. The extension watches the file (`fs.watch` + 1-second polling) and keeps agent state in memory.
3. The webview renders the map, the timeline, and the counters; updates flow through `postMessage`, and the panel resyncs when it becomes visible again.
4. The cwd filter (`aiOffice.scope = workspace`) drops events from other VSCode windows.
5. The Plan usage panel polls `api.anthropic.com/api/oauth/usage` with the OAuth token of your Claude Code login (`~/.claude/.credentials.json`; Keychain on macOS) and `api.kimi.com/coding/v1/usages` with your Kimi Code login (`~/.kimi-code/credentials/`). Tokens are never sent anywhere except the providers' APIs. The ccusage $-bars are Claude Code only.
6. The emergency stop writes two flags вЂ” `~/.claude/office-stop.json` and `~/.kimi-code/office-stop.json`; the `PreToolUse` gate rejects every tool call while the flag covers the session's cwd, so one button stops both CLIs at once. Without the flag the gate exits instantly (a single file-existence check).
7. The session model name comes from the hook payload/transcript for Claude; for Kimi sessions it falls back to `default_model` from `~/.kimi-code/config.toml`.

## Emergency stop

The рџ›‘ button on the dashboard (or the `AI Office: Emergency Stop / Resume Agents` command):

- blocks **new** tool calls of the main agent and all subagents in the current window's projects; an already-running long command (e.g. a Bash build) finishes on its own;
- the session and its context are preserved вЂ” it's a pause, not a kill;
- the stop is **per-project**: the flag stores the workspace folders, so sessions of other projects are unaffected. The same project in another window/terminal stops too;
- a window with no open folder (or `scope = global`) sets a **global** stop вЂ” a confirmation dialog is shown first;
- release: the "Resume" button (releases only its own folders вЂ” stops set by other windows survive), or automatically by a new prompt in the stopped project. Only human-typed prompts count: system injections (background-task completion notifications, `system-reminder`, cron-fire) pass through the same `UserPromptSubmit` hook but do not release the stop. The stop covers both CLIs at once: the button writes `~/.claude/office-stop.json` and `~/.kimi-code/office-stop.json`, and a human prompt in either CLI releases the stop in both (the hook scripts mirror the release to both flag files).

## Rooms and agent mapping

Rooms are built dynamically: only rooms with at least one agent are rendered. Curated rooms (`directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`) have their own icons and colors; any custom id from the mapping creates its own room (color derived from a hash).

Where an agent goes (by priority):

1. **`.claude/office-rooms.json` / `.kimi-code/office-rooms.json`** in the project вЂ” explicit mapping, committed with the repo (on name conflicts the Kimi file wins).
2. **`aiOffice.agentRooms`** in VSCode settings.
3. **Built-in Claude Code agents** вЂ” `general-purpose`, `Explore`, `Plan`, `code-reviewer`, etc.
4. **Keyword heuristics** on the name (stem matching, ~100 tokens) вЂ” `react-*` в†’ frontend, `*-director` в†’ directors, `postgres/schema` в†’ backend, `docker/ci/deploy` в†’ devops, and so on.
5. **Lobby** вЂ” everything unrecognized.

For most projects the heuristics are enough вЂ” no configuration needed.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aiOffice.language` | `system` | UI language: `system` (OS language) / `vscode` / `en` / `ru` |
| `aiOffice.hooks.autoSetup` | `true` | Offer automatic hook installation and keep hook scripts updated |
| `aiOffice.hooks.targets` | `auto` | Which CLIs get hooks: `auto` (every CLI whose home dir exists вЂ” `~/.claude` / `~/.kimi-code`; both if none) / `claude` / `kimi` / `both` |
| `aiOffice.statusBar.enabled` | `true` | Status bar item (waiting / stop / working / errors) |
| `aiOffice.roster.enabled` | `true` | Show project agents from `.claude/agents/`, `.kimi-code/agents/`, `.agents/agents/` immediately (idle) |
| `aiOffice.scope` | `workspace` | `workspace` = this window only (cwd filter); `global` = all windows |
| `aiOffice.agentRooms` | `{}` | Custom agent-to-room mapping |
| `aiOffice.eventsFile` | `~/.claude/agent-events.jsonl` | Path to the JSONL events file (shared by both CLIs) |
| `aiOffice.usage.enabled` | `true` | Plan usage panel (real subscription limits) |
| `aiOffice.usage.pollSeconds` | `90` | Usage refresh interval |
| `aiOffice.usage.costSource` | `off` | `ccusage` = extra $-bars via `npx ccusage` |
| `aiOffice.usage.tokens` | `true` | Token counters (this session / project total) read from the local transcripts |
| `aiOffice.usage.subscriptionUsd` | `0` | Monthly subscription price ($) for the "API cost vs subscription" line; 0 = guess from the plan (Pro в‰€ $20, Max в‰€ $100/$200) |
| `aiOffice.usage.limitBlockUsd` | `0` | $ limit per 5-hour block (ccusage bars only) |
| `aiOffice.usage.limitWeeklyUsd` | `0` | $ limit per week (ccusage bars only) |
| `aiOffice.usage.limitWeeklyOpusUsd` | `0` | $ limit per week for Opus (ccusage bars only) |
| `aiOffice.usage.degradationAlerts` | `true` | Warn when a plan quota degrades (running hot / critically low / depleted) |
| `aiOffice.autoStop.enabled` | `true` | Trip the emergency stop by itself when a plan limit reaches the threshold. One-shot per limit window: it fires at the threshold, once more at the final threshold, then stays quiet until the limit resets |
| `aiOffice.autoStop.thresholdPercent` | `95` | Plan-limit utilization (%) that trips the auto-stop |
| `aiOffice.autoStop.finalThresholdPercent` | `99` | Utilization (%) of the last warning for that window; equal to the main threshold = a single shot |

## Commands

- `AI Office: Show Dashboard` вЂ” focus the Activity Bar panel
- `AI Office: Open Dashboard in Editor` вЂ” open as a regular tab (alongside the sidebar)
- `AI Office: Emergency Stop / Resume Agents` вЂ” рџ›‘ stop/resume agents
- `AI Office: Install Agent Hooks` вЂ” install/repair hooks manually (into every CLI selected by `aiOffice.hooks.targets`)
- `AI Office: Clear Events` вЂ” reset the event cache
- `AI Office: Open Settings` вЂ” VS Code Settings editor filtered to this extension (also the вљ™ button in the dashboard header)

The installed extension version is shown in the bottom-right corner of the dashboard.

## Development

```bash
git clone https://github.com/ShiZa039/ai-office-dashboard.git
cd ai-office-dashboard
npm install
npm run compile        # tsc в†’ out/
npm test               # unit tests (parser, types, state, hooks, usage, roster, stop)
npx @vscode/vsce package  # build the .vsix
```

Release history and plans вЂ” [ROADMAP.md](ROADMAP.md) (in Russian).

## Requirements

- VSCode в‰Ґ 1.85
- Claude Code CLI with hook support (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`) and/or Kimi Code CLI вЂ” both are supported simultaneously
- Python 3 **or** Node.js in `PATH` (for the hook script; the extension picks whichever is available)
- For the Plan usage panel вЂ” a Claude Code subscription login (Pro/Max) and/or a Kimi Code login. When Claude Code runs on an API key, its limits panel is unavailable; you can enable $-estimates via `aiOffice.usage.costSource = "ccusage"`.

## Known limitations

- `SubagentStart` does not pass `description`/`prompt` ([anthropics/claude-code#19170](https://github.com/anthropics/claude-code/issues/19170)) вЂ” the `task` field is filled from `last_assistant_message` on `agent_stop`.
- The subscription limits endpoint is undocumented (the same one `/usage` in Claude Code uses) вЂ” the format may change; the parser is resilient to missing fields.
- The emergency stop does not interrupt a tool call that is already running вЂ” only subsequent calls are blocked.
- Kimi Code does not fire hooks in non-interactive mode (`kimi --print` / `kimi -p`) вЂ” neither dashboard events nor the emergency stop apply to such runs (verified on kimi 1.30.0).
- The Plan usage limits panel works for both CLIs (Claude Code and Kimi Code); the ccusage $-bars are Claude Code only.
- Sound effects are not planned.

## License

[MIT](LICENSE)
