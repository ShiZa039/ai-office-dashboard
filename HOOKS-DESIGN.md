# Архитектура хуков AI Office Dashboard

Глубокий разбор механизма, через который расширение наблюдает за сессиями
Claude Code и Kimi Code: хук-скрипты `hooks/emit-agent-event.py` и
`hooks/emit-agent-event.js`, их регистрация в пользовательских конфигах
(`~/.claude/settings.json` и `~/.kimi-code/config.toml`) модулями
`src/hookConfig.ts` и `src/hookConfigKimi.ts`, схема событий JSONL и логика
аварийной остановки `stop_gate`.

> Актуализировано 2026-08-02: новый текст `STOP_REASON` (handoff-заметка),
> уравнены BOM-терпимость и верхнеуровневая обработка ошибок в обоих
> скриптах, добавлен интеграционный тест `test/emitAgentEventPy.test.ts`.

## 1. Общая картина

```
┌──────────────┐   hook (stdin JSON)   ┌───────────────────────┐
│  Claude Code │ ────────────────────▶ │ emit-agent-event.py   │
│  / Kimi Code │                       │ emit-agent-event.js   │
└──────────────┘                       └──────────┬────────────┘
                                                  │ append
                                                  ▼
                                  ~/.claude/agent-events.jsonl
                                                  │
                                                  ▼
                                  src/eventWatcher.ts + eventParser.ts
                                                  │
                                                  ▼
                                       вебвью-дашборд
```

Поток данных:

1. Agent CLI (Claude Code или Kimi Code) при наступлении события жизненного
   цикла (старт сессии, запуск сабагента, ожидание разрешения и т.д.)
   вызывает зарегистрированную hook-команду и передаёт ей JSON с деталями
   события через **stdin**.
2. Хук-скрипт (Python- или Node-вариант — функционально идентичные) читает
   JSON, нормализует его в компактное событие и **дописывает одну строку** в
   `~/.claude/agent-events.jsonl` (единый файл для обоих CLI).
3. Расширение следит за этим файлом (`src/eventWatcher.ts`), парсит события
   (`src/eventParser.ts`) и обновляет состояние агентов на дашборде.

Ключевые проектные решения:

- **Никакой сети и IPC** — связь только через файловую систему: hook-скрипт
  не зависит от того, запущен ли VSCode, и не может «уронить» сессию агента.
- **Два параллельных скрипта** — Python предпочтителен (исторически), Node —
  запасной вариант для машин без Python 3 в PATH. Оба скрипта копируются в
  каталог хуков каждого CLI, а какой из них вызывать — решается при
  регистрации (см. §4–§6).
- **Один JSONL-файл на оба CLI** — события Kimi и Claude попадают в
  `~/.claude/agent-events.jsonl` независимо от источника.
- **Хук никогда не должен падать с ненулевым кодом** — все ошибки чтения
  stdin/файлов подавляются; в обоих вариантах точка входа завёрнута в общий
  try/catch (try/except) с комментарием «A hook must never fail the agent CLI
  session».

## 2. Файлы и их роли

| Файл | Роль |
|------|------|
| `hooks/emit-agent-event.py` | Python-вариант хук-скрипта (288 строк) |
| `hooks/emit-agent-event.js` | Node-вариант хук-скрипта (321 строка) |
| `src/hookConfig.ts` | Чистая логика регистрации хуков в `~/.claude/settings.json` |
| `src/hookConfigKimi.ts` | Чистая логика регистрации хуков в `~/.kimi-code/config.toml` |
| `src/hookInstaller.ts` | Файловый/UI-клей: копирование скриптов, выбор рантайма, запись конфигов |
| `test/hookConfig.test.ts`, `test/hookConfigKimi.test.ts`, `test/emitAgentEvent.test.ts`, `test/stopFlag.test.ts` | Юнит-тесты логики регистрации и скриптов |
| `test/emitAgentEventPy.test.ts` | Интеграционный тест Python-скрипта: порт сценариев `emitAgentEvent.test.ts`, прогоняет реальный `emit-agent-event.py`; пропускается, если Python 3 не найден в PATH |

Оба `hookConfig*.ts` намеренно не импортируют `vscode` — это чистые функции,
юнит-тестируемые без среды VSCode; вся работа с файловой системой и UI
вынесена в `hookInstaller.ts`.

## 3. Типы событий и аргументы командной строки

Оба скрипта вызываются одинаково:

```
<runtime> emit-agent-event.{py|js} <event_type> [cli]
```

- `event_type` — первый позиционный аргумент (`sys.argv[1]` / `process.argv[2]`).
- `cli` — необязательный второй аргумент: `kimi` или отсутствует (по умолчанию
  `claude`). В Python: `CLI = "kimi" if len(sys.argv) > 2 and sys.argv[2] == "kimi"
  else "claude"`; в Node: `CLI = process.argv[3] === 'kimi' ? 'kimi' : 'claude'`.

Полный набор типов событий (идентичен в обоих скриптах):

| `event_type` | Hook-событие CLI | Когда срабатывает |
|---|---|---|
| `session_start` | `SessionStart` | Запуск новой сессии агента |
| `agent_start` | `SubagentStart` | Запуск сабагента (Task/Agent) |
| `agent_stop` | `SubagentStop` | Завершение сабагента |
| `session_stop` | `Stop` | Завершение основного хода агента |
| `agent_waiting` | `Notification` (Claude) / `PermissionRequest` (Kimi) | Агент заблокирован в ожидании действия пользователя (разрешение, вопрос) |
| `user_prompt` | `UserPromptSubmit` | Пользователь отправил промпт — снимает состояние «waiting» и флаг аварийной остановки |
| `stop_gate` | `PreToolUse` | Перед каждым вызовом инструмента — гейт аварийной остановки (см. §8) |

`stop_gate` — особый случай: это не событие «уровня хода», а блокирующий
PreToolUse-хук, который может запретить вызов инструмента. Он обрабатывается
отдельной веткой до общей логики эмиссии события.

### Различия payload'ов Claude Code и Kimi Code

Базовые поля совпадают (`session_id`, `cwd` — snake_case в обоих CLI), но
событийно-специфичные различаются:

- **agent_start**: Kimi `SubagentStart` передаёт `agent_name` и `prompt`
  (делегированная задача — настоящая метка); Claude передаёт только
  `agent_type`, поэтому меткой становится имя агента.
- **agent_stop**: Claude передаёт `last_assistant_message`, Kimi — `response`
  (превью ответа).
- **agent_waiting**: Claude `Notification` передаёт `message`
  («Claude needs your permission…»); Kimi `PermissionRequest` — `tool_name`,
  из которого скрипт строит эквивалентную строку
  «Kimi needs your permission to use <tool>».
- **Модель**: Claude `SessionStart` может нести `model` напрямую; остальные
  Claude-события читают модель из транскрипта (`transcript_path`). Kimi не
  передаёт ни того, ни другого — модель берётся из `~/.kimi-code/config.toml`.

## 4. JSONL-схема событий

Все события дописываются по одной JSON-строке в
`~/.claude/agent-events.jsonl` (`ensure_ascii=False` / обычный
`JSON.stringify` — Unicode не экранируется). Базовые поля присутствуют всегда:

```json
{
  "ts": "2026-08-02T10:12:35.000Z",
  "event": "agent_start",
  "session": "<session_id или \"unknown\">",
  "cwd": "<рабочий каталог или \"\">"
}
```

- `ts` — UTC-время. Python форматирует как
  `%Y-%m-%dT%H:%M:%S.000Z` (миллисекунды всегда `.000`), Node использует
  `new Date().toISOString()` (реальные миллисекунды). Для парсера обе формы —
  валидный ISO 8601.
- `session` — `session_id` из payload; при отсутствии — `"unknown"`.
- `cwd` — `cwd` из payload; при отсутствии — `""`.

Опциональные поля по типам событий:

| Поле | Типы событий | Источник |
|---|---|---|
| `model` | любые | см. ниже «Определение модели»; добавляется только если удалось определить |
| `agent` | `agent_start`, `agent_stop` | `agent_name` → `agent_type` → `"general-purpose"` |
| `task` | `agent_start` | `prompt` (Kimi) иначе `agent_name`, обрезка до 80 символов |
| `task` | `agent_stop` | `last_assistant_message` \|\| `response`, обрезка до 80 символов |
| `result` | `agent_stop` | всегда `"success"` |
| `task` | `agent_waiting` | `message` (Claude) либо собранная строка из `tool_name` (Kimi), обрезка до 120 символов |

`user_prompt`, `session_start` и `session_stop` намеренно не несут
дополнительного payload: текст промпта пользователя в JSONL не попадает
(приватность), хотя поле `prompt` из stdin читается — только для проверки
`is_automated_prompt` (см. §8).

Событие `tool_activity` (эмитируется только из `stop_gate` при разрешённом
вызове инструмента) содержит лишь базовые поля:

```json
{"ts": "…", "event": "tool_activity", "session": "…", "cwd": "…"}
```

Его назначение: первый вызов инструмента после того, как пользователь ответил
на permission-промпт (например, подтвердил выход из plan mode), сбрасывает
баннер «waiting» на дашборде — ни одно хук-событие уровня хода для этого не
срабатывает.

### Определение модели (`resolve_model` / `resolveModel`)

Приоритеты:

1. Поле `model` из stdin-payload (Claude `SessionStart`, не гарантировано).
2. Для `cli == kimi` — алиас `default_model` из `~/.kimi-code/config.toml`
   (регулярка `^\s*default_model\s*=\s*"([^"]+)"`, без TOML-парсера).
3. Для Claude — чтение последних **256 КБ** (`TRANSCRIPT_TAIL_BYTES`)
   транскрипта `transcript_path`: строки JSONL перебираются с конца, берётся
   `message.model` из самой свежей валидной записи ассистента. Битые/обрезанные
   хвостовым окном строки пропускаются. Благодаря этому смена модели
   командой `/model` посреди сессии отражается уже на следующем событии.
4. Иначе — модель неизвестна, поле в событие не добавляется.

## 5. Регистрация в `~/.claude/settings.json` (`src/hookConfig.ts`)

Модуль экспортирует чистые функции над распарсенным объектом settings.json.

### Подписки (`HOOK_EVENTS`)

Семь регистраций, по одной на hook-событие Claude Code (см. таблицу §3):
`SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, `Notification`,
`UserPromptSubmit`, `PreToolUse`. Идентификация «наших» записей — по
подстроке-маркеру `emit-agent-event` (`HOOK_MARKER`) внутри `command`.

### Команда хука (`buildHookCommand`)

```
python "$HOME/.claude/hooks/emit-agent-event.py" session_start
node   "$HOME/.claude/hooks/emit-agent-event.js" stop_gate
```

- Тип `HookRuntime = 'python' | 'python3' | 'py' | 'node'`; для `py`
  исполняемый файл разворачивается в `py -3` (Windows-лаунчер).
- Файл скрипта выбирается по рантайму (`hookScriptFileFor`): `.py` для всех
  Python-вариантов, `.js` для `node`.
- Путь использует `$HOME` — его разворачивает сам Claude Code на всех
  платформах, поэтому в settings.json нет машинно-зависимых абсолютных путей.
- В команду Kimi-CLI аргумент `kimi` здесь **не** добавляется: settings.json
  обслуживает только Claude (CLI по умолчанию).

### Проверка покрытия (`officeHookCoverage` / `hasOfficeHooks`)

Возвращает `'none' | 'partial' | 'full'` — сколько из семи событий уже имеет
запись с маркером. `'partial'` трактуется как «пользователь ставил старую
версию расширения»: согласие на хуки уже дано, и недостающие события
домерживаются молча (см. `ensureHooksOnActivation` в §7).

### Мерж (`mergeOfficeHooks`)

- Глубоко клонит вход (исходный объект не мутируется), создаёт `hooks: {}`
  при отсутствии.
- Для каждого из семи событий гарантирует массив записей и строит эталонную
  запись `{ hooks: [{ type: 'command', command: <buildHookCommand>, timeout: 5 }] }`.
- Если своих записей нет — добавляет (`changed = true`).
- С опцией `replace` существующие «наши» записи заменяются на свежие, если
  отличаются от эталона (переключение рантайма python → node). Без `replace`
  существующие регистрации не трогаются.
- Чужие хуки и прочие настройки никогда не изменяются.

## 6. Регистрация в `~/.kimi-code/config.toml` (`src/hookConfigKimi.ts`)

Kimi Code читает хуки из TOML-таблиц `[[hooks]]` (`event` / `matcher` /
`command` / `timeout`). TOML **не парсится**: свои таблицы находятся по
маркеру `emit-agent-event` в `command` и по строке-маяку
`# office-dashboard-hook: <Event>` прямо перед каждой таблицей. Это делает
удаление/замену построчной операцией, оставляющей остальной конфиг
байт-в-байт неизменным.

### Подписки (`KIMI_HOOK_EVENTS`)

Те же семь `event_type`, но `agent_waiting` вешается на `PermissionRequest`
(аналог Claude `Notification`), остальные события совпадают по именам.

### Команда хука (`buildKimiHookCommand`)

```
python "D:\abs\path\to\emit-agent-event.py" session_start kimi
```

Отличия от Claude-варианта:

- Путь к скрипту — **абсолютный** (TOML не разворачивает `$HOME`), передаётся
  параметром `scriptPath` из `hookInstaller.ts`.
- Команда встраивается в **TOML literal string** (одинарные кавычки), поэтому
  Windows-обратные слэши в пути выживают дословно.
- В конец добавляется аргумент `kimi` — так скрипт узнаёт CLI-источник.

### Блок регистрации (`kimiHookBlock`)

```toml
# office-dashboard-hook: SessionStart
[[hooks]]
event = "SessionStart"
command = 'python "C:\Users\…\.kimi-code\hooks\emit-agent-event.py" session_start kimi'
timeout = 5
```

### Разбиение TOML (`splitToml`)

Текст режется на куски: каждый заголовок секции (`[table]` или
`[[array-of-tables]]`) начинает новый кусок, тянущийся до следующего
заголовка. Кусок «наш», если он `[[...]]` и содержит маркер. Достаточно для
поиска целых таблиц `[[hooks]]` без полноценного TOML-парсера.

### Покрытие и мерж (`kimiOfficeHookCoverage` / `mergeKimiOfficeHooks`)

- Покрытие считается по «нашим» кускам: для каждого из семи событий ищется
  строка `event = "<HookEvent>"` (регулярка с многострочным флагом).
- `mergeKimiOfficeHooks` без `replace` при полном покрытии возвращает текст
  без изменений (байт-идентично).
- При мерже все «наши» куски выбрасываются, из оставшихся построчно
  вычищаются строки-маяки (маяк мог «прилипнуть» к предыдущему чужому куску
  при разбиении), затем семь свежих блоков дописываются в конец файла.
  Хвостовые пробельные символы базы обрезаются, блоки отделяются пустой
  строкой.
- Чужие таблицы `[[hooks]]` и любые другие настройки сохраняются как есть.

## 7. Установщик (`src/hookInstaller.ts`) — кратко

Файловый и UI-клей вокруг чистых модулей:

- `resolveTargets` — цели установки из настройки `aiOffice.hooks.targets`
  (`claude` / `kimi` / `both` / `auto`); в `auto` целью становится каждый CLI,
  чей домашний каталог существует (при отсутствии обоих — оба, чтобы позднее
  установленный CLI подхватил хуки).
- `detectRuntime` — поиск рантайма по порядку `python` → `python3` → `py` →
  `node` через `<cmd> --version` с проверкой вывода (`Python 3` / `v\d+`);
  алиас Python из Windows Store отсекается ненулевым кодом выхода.
- `copyHookScripts` — копирует **оба** скрипта из bundled-каталога расширения
  в `~/.claude/hooks/` и `~/.kimi-code/hooks/`.
- `installHooks` — для каждой цели вызывает соответствующий merge и пишет
  конфиг, предварительно делая бэкап (`settings.json.ai-office.bak`,
  `config.toml.office-dashboard.bak`). Нечитаемый/битый конфиг не
  перезаписывается — показывается ошибка с просьбой исправить вручную.
- `ensureHooksOnActivation` — нулевоконфигурационный путь при старте:
  молча обновляет устаревшие скрипты до bundled-версии; при частичной
  регистрации (старая версия расширения) молча домерживает новые события;
  при полном отсутствии хуков один раз предлагает установку с кнопками
  Install / Later / Don't ask again.

## 8. Логика `stop_gate` (PreToolUse) и аварийная остановка

### Файлы-флаги

Аварийная остановка управляется JSON-флагом на каждый CLI:

- `~/.claude/office-stop.json` — гейтит вызовы инструментов Claude Code;
- `~/.kimi-code/office-stop.json` — гейтит вызовы инструментов Kimi Code.

Скрипт выбирает флаг по аргументу `cli` (`stop_flag_path` / `stopFlagPath`),
а для снятия остановки обходит **оба** файла (`all_stop_flag_paths` /
`allStopFlagPaths`) — один человеческий промпт снимает стоп у всех агентов.

Формат флага:

```json
{
  "active": true,
  "cwds": ["D:/project-a", "D:/project-b"]
}
```

- `active: false` или битый/отсутствующий файл — флага нет
  (`load_stop_flag` / `loadStopFlag` возвращает `None`/`null`).
- `cwds` — список проектов, к которым применяется стоп. Пустой или
  отсутствующий список означает **глобальный** стоп (все сессии).

### Гейт (`handle_stop_gate` / `stopGate`)

На каждый PreToolUse:

1. Читается stdin (толерантно: UTF-8 с BOM — `utf-8-sig` в Python, `trim()`
   в Node; битый JSON → `{}`).
2. Если активный флаг покрывает `cwd` из payload (`stop_covers_cwd` /
   `stopCoversCwd`) — скрипт печатает в stdout решение-денай и завершается:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "AI Office: EMERGENCY STOP activated by the user from the dashboard. Do not call any more tools. End the turn immediately with a brief handoff note: what was done, what remains, and the next step to resume from."
  }
}
```

Причина деная (`STOP_REASON`) читается самим агентом: ему прямо велено не
вызывать больше инструментов и завершить ход **краткой handoff-заметкой** —
что сделано, что осталось и с какого шага возобновляться. Мотивация: под
активным стопом агент не может записать заметку в файл (любой tool call будет
запрещён), а финальное сообщение хода сохраняется в логе задачи и переживает
остановку — поведение подтверждено живым тестом на реальной сессии.

3. Если стоп не покрывает этот cwd — вызов разрешён, и вместо деная в JSONL
   дописывается лёгкое событие `tool_activity` (см. §4): это механизм
   снятия баннера «waiting» после ответа пользователя на permission-промпт.

### Покрытие каталогов (`stop_covers_cwd` / `stopCoversCwd`)

- Пути нормализуются: Python — `os.path.normcase(os.path.normpath(...))`
  (на Windows normcase опускает регистр), Node — собственный `normPath`:
  `path.normalize` + срезание хвостового разделителя + `toLowerCase()` на
  `win32`.
- Флаг покрывает cwd, если целевой путь совпадает с базой из `cwds` или лежит
  внутри неё (`target.startsWith(b + sep)`).
- Пустой `cwd` в payload при непустом списке `cwds` → стоп **не** применяется
  (fail-open для неопределённого случая).

### Снятие стопа по человеческому промпту

После записи события `user_prompt` вызывается `release_stop_flag(cwd)` /
`releaseStopFlag(cwd)` — но только если промпт не автоматический:

`is_automated_prompt` / `isAutomatedPrompt` считает промпт машинным, если
после lstrip/trimStart он начинается с `[SYSTEM NOTIFICATION`,
`<system-reminder>`, `<cron-fire` либо содержит `<task-notification>`.
Уведомления фоновых задач, системные ремайндеры и срабатывания cron тоже
приходят через `UserPromptSubmit`, но не должны снимать аварийную остановку —
для возобновления требуется явное действие человека. Списки маркеров
намеренно продублированы в обоих скриптах с комментариями «Keep in sync».

`release_stop_flag` / `releaseStopFlag` для **каждого** из двух файлов-флагов:

- Глобальный флаг (пустой `cwds`) — удаляется целиком.
- Иначе из `cwds` удаляются записи, пересекающиеся с cwd промпта в любую
  сторону: совпадение, промпт внутри стоп-каталога или стоп-каталог внутри
  промпт-каталога (`b.startswith(target + sep)`).
- Если ни одна запись не пересеклась — файл не трогается (промпт из
  непокрытого проекта); при отсутствии cwd в payload стоп тоже сохраняется.
- Если записи остались — файл перезаписывается с урезанным списком
  (`indent=2` в Python; `JSON.stringify(..., 2) + '\n'` в Node); если не
  осталось — файл удаляется.
- Ошибки ввода-вывода подавляются (best effort).

Таким образом, человеческий промпт в проекте снимает стоп этого проекта у
обоих CLI, а стопы других проектов выживают.

## 9. Пофункциональное сравнение `emit-agent-event.py` и `emit-agent-event.js`

Скрипты — параллельные реализации одного протокола; поведение спроектировано
эквивалентным. Соответствие функций:

| Python (`emit-agent-event.py`) | Node (`emit-agent-event.js`) | Назначение |
|---|---|---|
| `claude_stop_flag_path()` / `kimi_stop_flag_path()` | `claudeStopFlagPath()` / `kimiStopFlagPath()` | Пути к файлам-флагам стопа |
| `stop_flag_path()` / `all_stop_flag_paths()` | `stopFlagPath()` / `allStopFlagPaths()` | Флаг «этого» CLI / все флаги |
| `load_stop_flag(path)` | `loadStopFlag(path)` | Чтение активного флага; `None`/`null` при отсутствии/битости |
| — (внутри `normcase/normpath`) | `normPath(p)` | Нормализация путей (в Node вынесена отдельно) |
| `stop_covers_cwd(flag, cwd)` | `stopCoversCwd(flag, cwd)` | Покрывает ли флаг данный cwd |
| `handle_stop_gate()` | `stopGate(raw)` | PreToolUse-денай |
| `emit_tool_activity(data)` | `emitToolActivity(raw)` | Событие `tool_activity` для разрешённого вызова |
| `is_automated_prompt(p)` | `isAutomatedPrompt(p)` | Фильтр машинных промптов |
| `release_stop_flag(cwd)` | `releaseStopFlag(cwd)` | Снятие стопа по человеческому промпту |
| `kimi_config_model()` | `kimiConfigModel()` | Модель из `~/.kimi-code/config.toml` |
| `resolve_model(data)` | `resolveModel(data)` | Best-effort определение модели |
| `main()` | `emit(raw)` + stdin-обвязка | Точка входа, сбор и запись события |

Различия — исключительно идиоматические, не функциональные:

1. **Структура входа.** Python читает stdin внутри каждого обработчика
   (`sys.stdin.buffer.read()`), Node накапливает stdin в строку `input` по
   событиям `data`/`end` и передаёт её параметром `raw` — поэтому у
   Node-функций сигнатуры с `raw`, а парсинг JSON повторяется локально.
2. **Развязка stop_gate.** В Python `handle_stop_gate()` сам решает: денай
   или `emit_tool_activity`. В Node `stopGate(raw)` возвращает `bool`, а
   выбор «дотнуть `emitToolActivity`» делает обвязка на `end`.
3. **BOM и кодировки.** Python декодирует stdin как `utf-8-sig` (съедает BOM
   от Windows-шеллов/редиректов); Node делает `raw.trim()` — BOM уходит как
   пробельный символ. Флаг-файл обе реализации теперь читают BOM-толерантно:
   Python — как `utf-8-sig`, Node — `utf-8` со срезанием `^\uFEFF` перед
   `trim()` (защита от вручную отредактированных флагов, сохранённых как
   UTF-8 with BOM).
4. **Таймстемпы.** Python: `strftime('%Y-%m-%dT%H:%M:%S.000Z')` (миллисекунды
   всегда нулевые); Node: `new Date().toISOString()` (точные миллисекунды).
5. **Нормализация путей.** Python полагается на `os.path.normcase` (учитывает
   платформу); Node реализует эквивалент вручную: `path.normalize`, срезание
   хвостового сепаратора, lowercase только на `win32`.
6. **Чтение хвоста транскрипта.** Python: `open` + `seek` + `read` +
   `splitlines()` и обратный обход. Node: ручной `openSync/readSync/closeSync`
   с буфером, split по `\n`, обратный обход; `closeSync` в `finally`.
7. **Запись.** Python: `open(..., "a", encoding="utf-8")` +
   `json.dumps(ensure_ascii=False)`; Node: `fs.appendFileSync(..., 'utf-8')`
   + `JSON.stringify`. Оба гарантируют `\n` в конце и создают каталог
   (`os.makedirs(exist_ok=True)` / `mkdirSync(recursive: true)`).
8. **Обработка ошибок.** Обе реализации сочетают точечные перехваты (чтение
   stdin, транскрипта, флагов) с верхнеуровневой страховкой: Node оборачивает
   всю `end`-обработку в общий try/catch, Python — вызов `main()` в блоке
   `if __name__ == "__main__":` — хук не должен падать никогда («A hook must
   never fail the agent CLI session»).
9. **Косметика в комментариях.** В Node-комментарии к `agent_waiting`
   упомянут `tool_name` «(+action)», в Python — только `tool_name`; на
   поведение не влияет (`action` не используется нигде).

Протокольные инварианты, которые обязаны совпадать (и совпадают): набор
`event_type`, имена и смыслы JSONL-полей, обрезки строк (80/120 символов),
маркеры автоматических промптов, формат файла-флага, семантика глобального
стопа и per-cwd снятия, тексты `STOP_REASON`.

## 10. Куда смотреть дальше

- Приёмная сторона JSONL: `src/eventWatcher.ts` (слежение за файлом),
  `src/eventParser.ts` (разбор событий в модель агентов).
- Кто создаёт `office-stop.json`: логика кнопки «стоп» на дашборде
  (вебвью `media/office.js` + обработчик в `src/extension.ts`).
- Тесты: `test/emitAgentEvent.test.ts`, `test/stopFlag.test.ts` (скрипты и
  стоп-флаги), `test/hookConfig.test.ts`, `test/hookConfigKimi.test.ts`
  (мержи регистраций), `test/emitAgentEventPy.test.ts` (интеграционный прогон
  Python-скрипта).
- Паритет py/js страхуется тестами: `emitAgentEvent.test.ts` прогоняет
  Node-вариант, а `emitAgentEventPy.test.ts` повторяет те же сценарии против
  Python-варианта — расхождение поведения двух реализаций ловится на CI
  (тест молча пропускается только на машинах без Python 3).
