# Установка Claude Office Dashboard

Расширение визуализирует работу субагентов Claude Code как «офис с комнатами». Состоит из двух частей:

1. **Хуки** Claude Code — пишут события в `~/.claude/agent-events.jsonl`. **С v0.9.0 ставятся автоматически** из расширения.
2. **VSCode-расширение** — читает JSONL и рисует дашборд.

---

## Быстрая установка (рекомендуется)

### Требования

- VSCode ≥ 1.85
- Claude Code CLI с поддержкой хуков (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`)
- Python 3 **или** Node.js в `PATH` (для хук-скрипта — расширение само найдёт, что есть)

### Шаги

1. Установи расширение:

   ```powershell
   # Windows
   & 'C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' `
     --install-extension 'D:\path\to\claude-office-dashboard-0.13.0.vsix' --force
   ```

   ```bash
   # Linux/macOS
   code --install-extension /path/to/claude-office-dashboard-0.13.0.vsix --force
   ```

2. `Ctrl+Shift+P` → **Developer: Reload Window**.
3. Появится уведомление *«Claude Code hooks are not set up… Install them automatically?»* → нажми **Install**.

   Что при этом происходит:
   - `emit-agent-event.py` и `emit-agent-event.js` копируются в `~/.claude/hooks/`;
   - в `~/.claude/settings.json` добавляются семь хуков: `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop` (события агентов), `Notification` (баннер «Claude ждёт вас»), `UserPromptSubmit` (начало хода + авто-снятие остановки), `PreToolUse` (гейт экстренной остановки). Существующее содержимое файла и чужие хуки не трогаются; перед записью создаётся бэкап `settings.json.claude-office.bak`;
   - при обновлении расширения хук-скрипты и набор регистраций обновляются автоматически.

4. Готово. Запусти Claude Code сессию в проекте и спавни любой субагент — фигурка появится в дашборде.

Если уведомление было закрыто — `Ctrl+Shift+P` → **Claude Office: Install Claude Code Hooks**.

### Панель Plan usage (лимиты подписки)

Работает из коробки, если ты залогинен в Claude Code по подписке Pro/Max: расширение читает OAuth-токен из `~/.claude/.credentials.json` (macOS — Keychain) и опрашивает тот же эндпоинт, что и команда `/usage` в Claude Code. Показывает:

- **Session (5h)** — процент 5-часового окна + когда сбросится;
- **Week (all)** — недельный лимит по всем моделям;
- **Week (Opus)** — недельный лимит Opus (только Max-планы);
- бейдж плана (Pro / Max).

Токен используется только для запроса к `api.anthropic.com` и никуда больше не передаётся.

Если работаешь по API-ключу (без подписки) — лимитов нет; можно включить $-оценки расхода:

```json
{
  "claudeOffice.usage.costSource": "ccusage",
  "claudeOffice.usage.limitBlockUsd": 50,
  "claudeOffice.usage.limitWeeklyUsd": 200,
  "claudeOffice.usage.limitWeeklyOpusUsd": 100
}
```

(нужен `npx` в PATH; используется `ccusage@latest`).

---

## Настройка под проект

В большинстве случаев **ничего настраивать не нужно**:

- дашборд фильтрует события по `cwd` текущего workspace (`claudeOffice.scope = workspace` по умолчанию);
- агенты проекта из `.claude/agents/**/*.md` показываются сразу как idle-фигурки (`claudeOffice.roster.enabled`);
- комната выбирается keyword-эвристикой по имени агента (`react-*` → frontend, `*-director` → directors, `mqtt/esp32` → iot и т.д.).

Кастомизация нужна, только если эвристика промахивается.

### Свои агенты → свои комнаты

Известные комнаты: `directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`.

Вариант 1 — файл в проекте `.claude/office-rooms.json` (коммитится с репо, высший приоритет):

```json
{
  "my-custom-billing-agent": "backend",
  "release-lead": "devops"
}
```

Вариант 2 — VSCode settings (`Ctrl+,` → Workspace → `claudeOffice.agentRooms`):

```json
{
  "claudeOffice.agentRooms": {
    "ux-research-agent": "frontend",
    "compliance-checker": "security"
  }
}
```

Приоритет: **`.claude/office-rooms.json` > `claudeOffice.agentRooms` > встроенные агенты Claude Code > эвристика > лобби**. Изменения подхватываются на лету.

### Отключить per-window изоляцию

Чтобы видеть события всех окон VSCode сразу:

```json
{ "claudeOffice.scope": "global" }
```

---

## Ручная установка хуков (fallback)

Нужна только если автоустановка не подходит (например, `settings.json` генерируется другим инструментом).

1. Скопируй `hooks/emit-agent-event.py` **и** `hooks/emit-agent-event.js` из репозитория в `~/.claude/hooks/`.
2. Добавь в `~/.claude/settings.json` (полный набор — семь событий):

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

Для Node-варианта замени `python "...emit-agent-event.py"` на `node "...emit-agent-event.js"`. `$HOME` Claude Code раскрывает сам на всех платформах.

Без `Notification`/`UserPromptSubmit` не будет баннера «Claude ждёт вас» и индикатора главной модели; без `PreToolUse` не будет работать экстренная остановка 🛑 (кнопка выставит флаг, но вызовы инструментов никто не заблокирует).

3. Проверка: спавни субагент и посмотри хвост файла событий:

```powershell
Get-Content "$env:USERPROFILE\.claude\agent-events.jsonl" -Tail 5   # Windows
```

```bash
tail -5 ~/.claude/agent-events.jsonl                                 # Linux/macOS
```

---

## Troubleshooting

| Симптом | Причина | Что делать |
|---|---|---|
| Дашборд пустой, есть только idle-фигурки | Хуки не установлены/не пишут | `Ctrl+Shift+P` → **Claude Office: Install Claude Code Hooks**; проверь, растёт ли `~/.claude/agent-events.jsonl` |
| `agent-events.jsonl` пустой | Хуки не зарегистрированы | Проверь `~/.claude/settings.json` (секция `hooks`), перезапусти Claude Code |
| Уведомление об установке не появляется | Ранее нажато «Don't ask again» | Команда **Install Claude Code Hooks** ставит вручную |
| События приходят, но не отображаются | Cwd-фильтр режет всё | В Output (`View → Output → Claude Office`) строка `cwd filter`; для проверки поставь `claudeOffice.scope = global` |
| Агент всегда в Лобби | Имя не подходит под эвристику | Добавь в `.claude/office-rooms.json` или `claudeOffice.agentRooms` |
| Plan usage: `no Claude Code login found` | Нет `~/.claude/.credentials.json` | Залогинься в Claude Code (`claude` → login по подписке) |
| Plan usage: `token expired` | Токен протух | Запусти любую сессию Claude Code — токен обновится сам |
| Plan usage: `HTTP 429` | Рейт-лимит эндпоинта | Само пройдёт; можно увеличить `usage.pollSeconds` |
| Кириллица в `task` ломается | Старый `emit-agent-event.py` | Хук-скрипты обновляются автоматически при `hooks.autoSetup = true`; иначе переустанови хуки командой |
| 🛑 не блокирует агентов | `PreToolUse`-хук не зарегистрирован (старый набор хуков) | **Install Claude Code Hooks** — недостающие события домерджатся |
| Инструменты блокируются, хотя остановку не включал | Остался флаг остановки | Нажми «Продолжить» на дашборде, отправь новый промпт или удали `~/.claude/office-stop.json` |

---

## Обновление расширения

```powershell
& 'C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd' `
  --install-extension 'D:\path\to\claude-office-dashboard-X.Y.Z.vsix' --force
```

Затем **Developer: Reload Window**. Хук-скрипты обновятся сами при следующей активации (если `claudeOffice.hooks.autoSetup = true`).
