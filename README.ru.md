# AI Office

**Язык:** [English](README.md) · **Русский**

> VSCode-расширение, визуализирующее работу Claude Code и Kimi Code CLI как карту офиса с комнатами. Каждый субагент появляется фигуркой в своей «комнате» (Backend, Frontend, QA, Security, DevOps, AI-lab и т.д.), пульсирует пока работает, и отмечается галочкой по завершении. Сверху — индикатор главной модели, лимиты подписки и кнопка экстренной остановки.

**Текущая версия:** `v0.16.0` · zero-config: поддержка двух CLI (Claude Code + Kimi Code), автоустановка хуков, авто-обнаружение агентов, динамические комнаты, реальные лимиты Pro/Max, экстренная остановка агентов, UI en/ru.

---

## Зачем это

Когда оркестрируешь несколько субагентов параллельно — теряешь представление о том, кто чем занят и сколько ещё ждать. Расширение работает с обоими CLI одновременно — Claude Code и Kimi Code — агенты обоих появляются на одной карте. Этот дашборд даёт:

- **Карту офиса** — кто работает прямо сейчас и в каком модуле. Комнаты строятся динамически из фактического состава агентов проекта (`.claude/agents/`, `.kimi-code/agents/`, `.agents/agents/` + события сессий).
- **Индикатор главной модели** — плашка сверху: ✋ жёлтая «Claude ждёт вас», ⚡ синяя «работает · Fable 5 · 3m», ✓ зелёная вспышка «ход завершён».
- **Экстренную остановку 🛑** — одна кнопка блокирует все вызовы инструментов агентов через `PreToolUse`-хук; сессия и контекст сохраняются. Снятие — кнопкой или просто новым промптом.
- **Статус-бар** — ✋ waiting / 🛑 stop / N working / errors, даже когда панель закрыта.
- **Timeline** (Canvas) — кто запускался когда, окно настраивается (5 мин — 6 часов).
- **Activity log** — последние 50 событий start/stop/waiting/stop-toggle.
- **Plan usage** — реальные лимиты подписки: 5-часовая сессия, недельные лимиты — с процентами, временем сброса, индикатором темпа расхода («горячо / по графику / с запасом») с тиком равномерного расхода на каждом баре, прогнозом «достигнет 100% через ~2ч при текущем темпе» и предупреждениями о деградации квот. Тот же API, что и `/usage` в Claude Code; лимиты Kimi Code — из API Kimi Code.
- **Счётчики токенов** — входящие (запрос + запись кэша + чтение кэша) и исходящие токены за текущую сессию CLI и за весь проект, считаются прямо по локальным транскриптам (`~/.claude/projects/`) — без подпроцессов и без сети. Итог по проекту охватывает все сессии за всё время и переживает удаление старых транскриптов. При наведении на счётчик — разбивка по видам (запрос / запись кэша / чтение кэша) и по моделям: Opus, Sonnet, Haiku из фоновых задач и всё остальное, что записал CLI.
- **Per-window isolation** — каждое окно VSCode видит только свои сессии (фильтр по `cwd` workspace).
- **Локализация** — интерфейс en/ru, язык берётся из ОС (настраивается).

## Установка — zero config

1. Установи `.vsix`:

   ```
   code --install-extension ai-office-dashboard-0.16.0.vsix --force
   ```

2. Reload Window → в Activity Bar появится иконка домика.
3. При первом запуске расширение само предложит установить хуки (**Install** в уведомлении). Всё: скрипты копируются в `~/.claude/hooks/`, регистрация аккуратно мерджится в `~/.claude/settings.json` (существующие настройки и чужие хуки не трогаются, создаётся бэкап `settings.json.ai-office.bak`). Если установлен Kimi Code CLI, скрипты также копируются в `~/.kimi-code/hooks/`, а в `~/.kimi-code/config.toml` мерджатся блоки `[[hooks]]` (бэкап `config.toml.office-dashboard.bak`). Куда ставить хуки, управляет настройка `aiOffice.hooks.targets` (по умолчанию `auto`). При обновлении расширения хуки обновляются автоматически.

Никакой привязки к проекту: открой любой проект — дашборд покажет его агентов и события его Claude Code сессий.

Ручная установка хуков и troubleshooting — [INSTALL.ru.md](INSTALL.ru.md).

## Миграция с Claude Office Dashboard

Если вы пользовались расширением под старым именем (≤ v0.13.x):

- Расширение теперь выпускается как **AI Office** (`ai-office-dashboard`). Старая сборка `claude-office-dashboard` автоматически не обновится — установите новый `.vsix` (старое расширение после этого можно удалить).
- Все настройки и команды переименованы `claudeOffice.*` → `aiOffice.*`. Значения мигрировали автоматически вплоть до v0.16.0; deprecated-алиасы в более поздних сборках удалены — если обновляетесь с эпохи `claude-office-dashboard`, сначала один раз запустите v0.16.0.
- Пользовательские кейбиндинги на команды `claudeOffice.*` не мигрируют — обновите их вручную в `keybindings.json`.

## Как это работает

```
Claude Code hooks ─┐
                   ├─→ ~/.claude/agent-events.jsonl ─→ VSCode extension ─→ Webview
Kimi Code hooks  ──┘          ↑                              ↑
                  emit-agent-event.py|.js            fs.watch + polling
        PreToolUse stop_gate ← ~/.claude/office-stop.json + ~/.kimi-code/office-stop.json (🛑 кнопка)
```

1. Семь хуков Claude Code (`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`, `UserPromptSubmit`, `PreToolUse`) запускают `~/.claude/hooks/emit-agent-event.py` (или `.js`, если Python нет в PATH) — скрипт дописывает JSONL-событие. Kimi Code регистрирует свой набор в `~/.kimi-code/config.toml` с тем же скриптом: `SessionStart`→`session_start`, `SubagentStart`→`agent_start` (в `task` попадает текст делегированного prompt — даже информативнее, чем у Claude), `SubagentStop`→`agent_stop` (task = превью ответа), `Stop`→`session_stop`, `PermissionRequest`→`agent_waiting` (аналог клодовского Notification «ждёт разрешения», сообщение вида «Kimi needs your permission to use \<tool\>»), `UserPromptSubmit`→`user_prompt`, `PreToolUse`→`stop_gate`. Второй аргумент скрипта выбирает CLI: `emit-agent-event.js <event_type> [claude|kimi]`.
2. Расширение слушает файл (`fs.watch` + polling 1 сек) и держит in-memory стейт агентов.
3. Webview рисует карту, timeline и счётчики; обновления через `postMessage`, при возврате видимости панель пересинхронизируется.
4. Cwd-фильтр (`aiOffice.scope = workspace`) отбрасывает события из других окон VSCode.
5. Панель Plan usage опрашивает `api.anthropic.com/api/oauth/usage` с OAuth-токеном твоего логина Claude Code (`~/.claude/.credentials.json`; на macOS — Keychain) и `api.kimi.com/coding/v1/usages` с логином Kimi Code (`~/.kimi-code/credentials/`). Токены никуда не отправляются, кроме API провайдеров. $-бары ccusage — только для Claude Code.
6. Экстренная остановка пишет два флага — `~/.claude/office-stop.json` и `~/.kimi-code/office-stop.json`; `PreToolUse`-гейт отклоняет каждый вызов инструмента, пока флаг накрывает cwd сессии, так что одна кнопка останавливает оба CLI разом. Без флага гейт выходит мгновенно (одна проверка существования файла).
7. Модель сессии для Claude берётся из payload/transcript как раньше; для Kimi — fallback на `default_model` из `~/.kimi-code/config.toml`.

## Экстренная остановка

Кнопка 🛑 на дашборде (или команда `AI Office: Emergency Stop / Resume Agents`):

- блокирует **новые** вызовы инструментов главного агента и всех сабагентов в проектах текущего окна; уже запущенная длинная команда (например, Bash-сборка) дорабатывает;
- сессия и контекст сохраняются — это пауза, а не kill;
- остановка **проектная**: флаг хранит папки workspace, сессии других проектов не задеваются. Тот же проект в другом окне/терминале тоже остановится;
- окно без открытой папки (или `scope = global`) ставит **глобальный** стоп — перед этим показывается подтверждение;
- снятие: кнопка «Продолжить» (снимает только свои папки — стопы других окон переживают), либо автоматически новым промптом в остановленном проекте. Считается только промпт, набранный человеком: системные инъекции (уведомления о завершении фоновых задач, `system-reminder`, cron-fire) проходят через тот же хук `UserPromptSubmit`, но остановку не снимают. Остановка накрывает оба CLI разом: кнопка пишет `~/.claude/office-stop.json` и `~/.kimi-code/office-stop.json`, а человеческий промпт в любом из CLI снимает остановку в обоих (хук-скрипты зеркалят release на оба файла).

## Комнаты и маппинг агентов

Комнаты строятся динамически: рендерятся только те, где есть хоть один агент. Кураторские комнаты (`directors`, `backend`, `frontend`, `qa`, `security`, `devops`, `integrations`, `ai-lab`, `iot`, `lobby`) имеют свои иконки и цвета; любые кастомные id из маппинга создают собственные комнаты (цвет по хэшу).

Куда попадает агент (по приоритету):

1. **`.claude/office-rooms.json` / `.kimi-code/office-rooms.json`** в проекте — явный маппинг, коммитится вместе с репо (при конфликте имён выигрывает kimi-файл).
2. **`aiOffice.agentRooms`** в настройках VSCode.
3. **Встроенные агенты Claude Code** — `general-purpose`, `Explore`, `Plan`, `code-reviewer` и т.п.
4. **Keyword-эвристика** по имени (стем-матчинг, ~100 токенов) — `react-*` → frontend, `*-director` → directors, `postgres/schema` → backend, `docker/ci/deploy` → devops и т.д.
5. **Лобби** — всё неопознанное.

Для большинства проектов эвристики достаточно — ничего настраивать не нужно.

## Конфигурация

| Setting | Default | Описание |
|---------|---------|----------|
| `aiOffice.language` | `system` | Язык UI: `system` (язык ОС) / `vscode` / `en` / `ru` |
| `aiOffice.hooks.autoSetup` | `true` | Предлагать автоустановку хуков и обновлять хук-скрипты |
| `aiOffice.hooks.targets` | `auto` | Куда ставить хуки: `auto` (все CLI, чья домашняя директория существует — `~/.claude` / `~/.kimi-code`; если нет ни одной — в оба) / `claude` / `kimi` / `both` |
| `aiOffice.statusBar.enabled` | `true` | Айтем в статус-баре (waiting / stop / working / errors) |
| `aiOffice.roster.enabled` | `true` | Показывать агентов проекта из `.claude/agents/`, `.kimi-code/agents/`, `.agents/agents/` сразу (idle) |
| `aiOffice.scope` | `workspace` | `workspace` = только это окно (фильтр по cwd); `global` = все окна |
| `aiOffice.agentRooms` | `{}` | Кастомный маппинг агентов в комнаты |
| `aiOffice.eventsFile` | `~/.claude/agent-events.jsonl` | Путь к JSONL-файлу событий (общий для обоих CLI) |
| `aiOffice.usage.enabled` | `true` | Панель Plan usage (реальные лимиты подписки) |
| `aiOffice.usage.pollSeconds` | `90` | Интервал обновления usage |
| `aiOffice.usage.costSource` | `off` | `ccusage` = дополнительные $-бары через `npx ccusage` |
| `aiOffice.usage.tokens` | `true` | Счётчики токенов (текущая сессия / всего по проекту) по локальным транскриптам |
| `aiOffice.usage.limitBlockUsd` | `0` | Лимит $ на 5-часовой блок (только для ccusage-баров) |
| `aiOffice.usage.limitWeeklyUsd` | `0` | Лимит $ на неделю (только для ccusage-баров) |
| `aiOffice.usage.limitWeeklyOpusUsd` | `0` | Лимит $ на неделю Opus (только для ccusage-баров) |
| `aiOffice.usage.degradationAlerts` | `true` | Предупреждения о деградации квот (горячо / критически мало / исчерпана) |

## Команды

- `AI Office: Show Dashboard` — фокус на панель в Activity Bar
- `AI Office: Open Dashboard in Editor` — открыть как обычную вкладку (параллельно sidebar)
- `AI Office: Emergency Stop / Resume Agents` — 🛑 остановить/возобновить агентов
- `AI Office: Install Agent Hooks` — установить/починить хуки вручную (во все CLI, выбранные в `aiOffice.hooks.targets`)
- `AI Office: Clear Events` — сброс кэша событий
- `AI Office: Открыть настройки` — Settings-редактор VS Code с фильтром по расширению (также кнопка ⚙ в шапке дашборда)

Установленная версия расширения показывается в правом нижнем углу дашборда.

## Разработка

```bash
git clone https://github.com/ShiZa039/ai-office-dashboard.git
cd ai-office-dashboard
npm install
npm run compile        # tsc → out/
npm test               # unit-тесты (parser, types, state, hooks, usage, roster, stop)
npx @vscode/vsce package  # собрать .vsix
```

История релизов и планы — [ROADMAP.md](ROADMAP.md) (на русском).

## Системные требования

- VSCode ≥ 1.85
- Claude Code CLI с поддержкой хуков (`SubagentStart`/`SubagentStop`/`Stop`/`Notification`/`UserPromptSubmit`/`PreToolUse`) и/или Kimi Code CLI — оба поддерживаются одновременно
- Python 3 **или** Node.js в `PATH` (для хук-скрипта; расширение само выберет доступный)
- Для панели Plan usage — логин Claude Code по подписке (Pro/Max) и/или логин Kimi Code. При работе Claude Code по API-ключу его панель лимитов недоступна; можно включить $-оценки через `aiOffice.usage.costSource = "ccusage"`.

## Известные ограничения

- `SubagentStart` не передаёт `description`/`prompt` ([anthropics/claude-code#19170](https://github.com/anthropics/claude-code/issues/19170)) — поле `task` заполняется из `last_assistant_message` в `agent_stop`.
- Эндпоинт лимитов подписки недокументирован (тот же, что использует `/usage` в Claude Code) — формат может измениться; парсер устойчив к отсутствующим полям.
- Экстренная остановка не прерывает уже выполняющийся вызов инструмента — блокируются только следующие.
- Kimi Code не вызывает хуки в неинтерактивном режиме (`kimi --print` / `kimi -p`) — на такие запуски не распространяются ни события дашборда, ни экстренная остановка (проверено на kimi 1.30.0).
- Панель лимитов Plan usage работает для обоих CLI (Claude Code и Kimi Code); $-бары ccusage — только для Claude Code.
- Звуковые эффекты не планируются.

## Лицензия

[MIT](LICENSE)
