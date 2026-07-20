# Claude Office Dashboard

**Язык:** [English](README.md) · **Русский**

> VSCode-расширение, визуализирующее работу Claude Code как карту офиса с комнатами. Каждый субагент появляется фигуркой в своей «комнате» (Backend, Frontend, QA, Security, DevOps, AI-lab и т.д.), пульсирует пока работает, и отмечается галочкой по завершении. Сверху — индикатор главной модели, лимиты подписки и кнопка экстренной остановки.

**Текущая версия:** `v0.13.2` · zero-config: автоустановка хуков, авто-обнаружение агентов, динамические комнаты, реальные лимиты Pro/Max, экстренная остановка агентов, UI en/ru.

---

## Зачем это

Когда оркестрируешь несколько субагентов параллельно — теряешь представление о том, кто чем занят и сколько ещё ждать. Этот дашборд даёт:

- **Карту офиса** — кто работает прямо сейчас и в каком модуле. Комнаты строятся динамически из фактического состава агентов проекта (`.claude/agents/` + события сессий).
- **Индикатор главной модели** — плашка сверху: ✋ жёлтая «Claude ждёт вас», ⚡ синяя «работает · Fable 5 · 3m», ✓ зелёная вспышка «ход завершён».
- **Экстренную остановку 🛑** — одна кнопка блокирует все вызовы инструментов агентов через `PreToolUse`-хук; сессия и контекст сохраняются. Снятие — кнопкой или просто новым промптом.
- **Статус-бар** — ✋ waiting / 🛑 stop / N working / errors, даже когда панель закрыта.
- **Timeline** (Canvas) — кто запускался когда, окно настраивается (5 мин — 6 часов).
- **Activity log** — последние 50 событий start/stop/waiting/stop-toggle.
- **Plan usage** — реальные лимиты подписки (Pro/Max): 5-часовая сессия, недельные лимиты — с процентами, временем сброса и прогнозом «достигнет 100% через ~2ч при текущем темпе». Тот же API, что и `/usage` в Claude Code.
- **Per-window isolation** — каждое окно VSCode видит только свои сессии (фильтр по `cwd` workspace).
- **Локализация** — интерфейс en/ru, язык берётся из ОС (настраивается).

## Установка — zero config

1. Установи `.vsix`:

   ```
   code --install-extension claude-office-dashboard-0.13.2.vsix --force
   ```

2. Reload Window → в Activity Bar появится иконка домика.
3. При первом запуске расширение само предложит установить хуки Claude Code (**Install** в уведомлении). Всё: скрипты копируются в `~/.claude/hooks/`, регистрация аккуратно мерджится в `~/.claude/settings.json` (существующие настройки и чужие хуки не трогаются, создаётся бэкап `settings.json.claude-office.bak`). При обновлении расширения хуки обновляются автоматически.

Никакой привязки к проекту: открой любой проект — дашборд покажет его агентов и события его Claude Code сессий.

Ручная установка хуков и troubleshooting — [INSTALL.ru.md](INSTALL.ru.md).

## Как это работает

```
Claude Code hooks → ~/.claude/agent-events.jsonl → VSCode extension → Webview
        │                     ↑                          ↑
        │        emit-agent-event.py|.js      fs.watch + polling
        └─ PreToolUse stop_gate ← ~/.claude/office-stop.json (🛑 кнопка)
```

1. Семь хуков Claude Code (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `UserPromptSubmit`, `PreToolUse`) запускают `~/.claude/hooks/emit-agent-event.py` (или `.js`, если Python нет в PATH) — скрипт дописывает JSONL-событие.
2. Расширение слушает файл (`fs.watch` + polling 1 сек) и держит in-memory стейт агентов.
3. Webview рисует карту, timeline и счётчики; обновления через `postMessage`, при возврате видимости панель пересинхронизируется.
4. Cwd-фильтр (`claudeOffice.scope = workspace`) отбрасывает события из других окон VSCode.
5. Панель Plan usage опрашивает `api.anthropic.com/api/oauth/usage` с OAuth-токеном твоего логина Claude Code (`~/.claude/.credentials.json`; на macOS — Keychain). Токен никуда не отправляется, кроме API Anthropic.
6. Экстренная остановка пишет флаг `~/.claude/office-stop.json`; `PreToolUse`-гейт отклоняет каждый вызов инструмента, пока флаг накрывает cwd сессии. Без флага гейт выходит мгновенно (одна проверка существования файла).

## Экстренная остановка

Кнопка 🛑 на дашборде (или команда `Claude Office: Emergency Stop / Resume Agents`):

- блокирует **новые** вызовы инструментов главного агента и всех сабагентов в проектах текущего окна; уже запущенная длинная команда (например, Bash-сборка) дорабатывает;
- сессия и контекст сохраняются — это пауза, а не kill;
- остановка **проектная**: флаг хранит папки workspace, сессии других проектов не задеваются. Тот же проект в другом окне/терминале тоже остановится;
- окно без открытой папки (или `scope = global`) ставит **глобальный** стоп — перед этим показывается подтверждение;
- снятие: кнопка «Продолжить» (снимает только свои папки — стопы других окон переживают), либо автоматически новым промптом в остановленном проекте. Считается только промпт, набранный человеком: системные инъекции (уведомления о завершении фоновых задач, `system-reminder`) проходят через тот же хук `UserPromptSubmit`, но остановку не снимают.

## Комнаты и маппинг агентов

Комнаты строятся динамически: рендерятся только те, где есть хоть один агент. Кураторские комнаты (`directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`) имеют свои иконки и цвета; любые кастомные id из маппинга создают собственные комнаты (цвет по хэшу).

Куда попадает агент (по приоритету):

1. **`.claude/office-rooms.json`** в проекте — явный маппинг, коммитится вместе с репо.
2. **`claudeOffice.agentRooms`** в настройках VSCode.
3. **Встроенные агенты Claude Code** — `general-purpose`, `Explore`, `Plan`, `code-reviewer` и т.п.
4. **Keyword-эвристика** по имени (стем-матчинг, ~100 токенов) — `react-*` → frontend, `*-director` → directors, `postgres/schema` → backend, `docker/ci/deploy` → devops и т.д.
5. **Лобби** — всё неопознанное.

Для большинства проектов эвристики достаточно — ничего настраивать не нужно.

## Конфигурация

| Setting | Default | Описание |
|---------|---------|----------|
| `claudeOffice.language` | `system` | Язык UI: `system` (язык ОС) / `vscode` / `en` / `ru` |
| `claudeOffice.hooks.autoSetup` | `true` | Предлагать автоустановку хуков и обновлять хук-скрипты |
| `claudeOffice.statusBar.enabled` | `true` | Айтем в статус-баре (waiting / stop / working / errors) |
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
- `Claude Office: Emergency Stop / Resume Agents` — 🛑 остановить/возобновить агентов
- `Claude Office: Install Claude Code Hooks` — установить/починить хуки вручную
- `Claude Office: Clear Events` — сброс кэша событий

Установленная версия расширения показывается в правом нижнем углу дашборда.

## Разработка

```bash
git clone https://github.com/ShiZa039/claude-office-dashboard.git
cd claude-office-dashboard
npm install
npm run compile        # tsc → out/
npm test               # unit-тесты (parser, types, state, hooks, usage, roster, stop)
npx @vscode/vsce package  # собрать .vsix
```

История релизов и планы — [ROADMAP.md](ROADMAP.md) (на русском).

## Системные требования

- VSCode ≥ 1.85
- Claude Code CLI с поддержкой хуков (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`)
- Python 3 **или** Node.js в `PATH` (для хук-скрипта; расширение само выберет доступный)
- Для панели Plan usage — логин Claude Code по подписке (Pro/Max). При работе по API-ключу панель лимитов недоступна; можно включить $-оценки через `claudeOffice.usage.costSource = "ccusage"`.

## Известные ограничения

- `SubagentStart` не передаёт `description`/`prompt` ([anthropics/claude-code#19170](https://github.com/anthropics/claude-code/issues/19170)) — поле `task` заполняется из `last_assistant_message` в `agent_stop`.
- Эндпоинт лимитов подписки недокументирован (тот же, что использует `/usage` в Claude Code) — формат может измениться; парсер устойчив к отсутствующим полям.
- Экстренная остановка не прерывает уже выполняющийся вызов инструмента — блокируются только следующие.
- Звуковые эффекты не планируются.

## Лицензия

[MIT](LICENSE)
