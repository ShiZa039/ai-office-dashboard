# Claude Office Dashboard

> VSCode-расширение, визуализирующее работу субагентов [Claude Code](https://docs.claude.com/claude-code) как карту офиса с комнатами. Каждый субагент появляется фигуркой в своей «комнате» (Backend, Frontend, QA, Security, DevOps, AI-lab, IoT и т.д.), пульсирует пока работает, и отмечается галочкой по завершении.

**Текущая версия:** `v0.9.0` · универсальный zero-config дашборд: автоустановка хуков, авто-обнаружение агентов проекта, реальные лимиты подписки Pro/Max.

---

## Зачем это

Когда оркестрируешь несколько субагентов параллельно — теряешь представление о том, кто чем занят и сколько ещё ждать. Этот дашборд даёт:

- **Карту офиса** — кто работает прямо сейчас и в каком модуле. Агенты проекта подтягиваются из `.claude/agents/` автоматически.
- **Timeline** (Canvas) — кто запускался когда, окно настраивается (5 мин — 6 часов).
- **Activity log** — последние 50 событий start/stop.
- **Plan usage** — реальные лимиты подписки (Pro/Max): 5-часовая сессия, недельный лимит, недельный Opus — с процентами и временем сброса, из того же API, что и команда `/usage` в Claude Code.
- **Per-window isolation** — каждое окно VSCode видит только свои субагенты, фильтр по `cwd` workspace.

## Установка — zero config

1. Установи `.vsix`:

   ```
   code --install-extension claude-office-dashboard-0.9.0.vsix --force
   ```

2. Reload Window → в Activity Bar появится иконка домика.
3. При первом запуске расширение само предложит установить хуки Claude Code (**Install** в уведомлении). Всё: скрипт копируется в `~/.claude/hooks/`, регистрация аккуратно мерджится в `~/.claude/settings.json` (существующие настройки и чужие хуки не трогаются, создаётся бэкап `settings.json.claude-office.bak`).

Никакой привязки к проекту: открой любой проект — дашборд покажет его агентов (из `.claude/agents/`, если есть) и события его Claude Code сессий.

Ручная установка хуков и troubleshooting — [INSTALL.md](INSTALL.md).

## Как это работает

```
Claude Code hooks → ~/.claude/agent-events.jsonl → VSCode extension → Webview
   (SubagentStart/Stop, Stop)        ↑                  ↑
       emit-agent-event.py|.js  fs.watch + polling
```

1. Хуки Claude Code запускают `~/.claude/hooks/emit-agent-event.py` (или `.js`, если Python нет в PATH) — скрипт дописывает JSONL-событие.
2. Расширение слушает файл (`fs.watch` + polling 1 сек) и держит in-memory стейт агентов.
3. Webview рисует карту, timeline и счётчики; обновления через `postMessage`.
4. Cwd-фильтр (`claudeOffice.scope = workspace`) отбрасывает события из других окон VSCode.
5. Панель Plan usage опрашивает `api.anthropic.com/api/oauth/usage` с OAuth-токеном твоего логина Claude Code (`~/.claude/.credentials.json`; на macOS — Keychain). Токен никуда не отправляется, кроме API Anthropic.

## Комнаты и маппинг агентов

Комнаты: `directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`.

Куда попадает агент (по приоритету):

1. **`.claude/office-rooms.json`** в проекте — явный маппинг, коммитится вместе с репо.
2. **`claudeOffice.agentRooms`** в настройках VSCode.
3. **Встроенные агенты Claude Code** — `general-purpose`, `Explore`, `Plan`, `code-reviewer` и т.п.
4. **Keyword-эвристика** по имени — `react-*` → frontend, `*-director` → directors, `mqtt/esp32/firmware` → iot, `docker/ci/deploy` → devops и т.д.
5. **Лобби** — всё неопознанное.

Для большинства проектов эвристики достаточно — ничего настраивать не нужно.

## Конфигурация

| Setting | Default | Описание |
|---------|---------|----------|
| `claudeOffice.hooks.autoSetup` | `true` | Предлагать автоустановку хуков и обновлять хук-скрипты |
| `claudeOffice.roster.enabled` | `true` | Показывать агентов проекта из `.claude/agents/` сразу (idle) |
| `claudeOffice.scope` | `workspace` | `workspace` = только это окно (фильтр по cwd); `global` = все окна |
| `claudeOffice.agentRooms` | `{}` | Кастомный маппинг агентов в комнаты |
| `claudeOffice.eventsFile` | `~/.claude/agent-events.jsonl` | Путь к JSONL-файлу событий |
| `claudeOffice.usage.enabled` | `true` | Панель Plan usage (реальные лимиты подписки) |
| `claudeOffice.usage.pollSeconds` | `90` | Интервал обновления usage |
| `claudeOffice.usage.costSource` | `off` | `ccusage` = дополнительные $-бары через `npx ccusage` |
| `claudeOffice.usage.limitBlockUsd` | `0` | Лимит $ на 5-часовой блок (только для ccusage-баров) |
| `claudeOffice.usage.limitWeeklyUsd` | `0` | Лимит $ на неделю (только для ccusage-баров) |
| `claudeOffice.usage.limitWeeklyOpusUsd` | `0` | Лимит $ на неделю Opus (только для ccusage-баров) |

## Команды

- `Claude Office: Show Dashboard` — фокус на панель в Activity Bar
- `Claude Office: Open Dashboard in Editor` — открыть как обычную вкладку (параллельно sidebar)
- `Claude Office: Install Claude Code Hooks` — установить/починить хуки вручную
- `Claude Office: Clear Events` — сброс кэша событий

## Разработка

```bash
git clone https://github.com/ShiZa039/claude-office-dashboard.git
cd claude-office-dashboard
npm install
npm run compile        # tsc → out/
npm test               # unit-тесты (parser, types, state, hooks, usage, roster)
npx @vscode/vsce package  # собрать .vsix
```

Дорожная карта — [ROADMAP.md](ROADMAP.md).

## Системные требования

- VSCode ≥ 1.85
- Claude Code CLI с поддержкой `SubagentStart`/`SubagentStop`/`Stop` хуков
- Python 3 **или** Node.js в `PATH` (для хук-скрипта; расширение само выберет доступный)
- Для панели Plan usage — логин Claude Code по подписке (Pro/Max). При работе по API-ключу панель лимитов недоступна; можно включить $-оценки через `claudeOffice.usage.costSource = "ccusage"`.

## Известные ограничения

- `SubagentStart` не передаёт `description`/`prompt` ([anthropics/claude-code#19170](https://github.com/anthropics/claude-code/issues/19170)) — поле `task` заполняется из `last_assistant_message` в `agent_stop`.
- Эндпоинт лимитов подписки недокументирован (тот же, что использует `/usage` в Claude Code) — формат может измениться; парсер устойчив к отсутствующим полям.
- Звуковые эффекты не планируются.

## Лицензия

TBD — см. [ROADMAP.md](ROADMAP.md).
