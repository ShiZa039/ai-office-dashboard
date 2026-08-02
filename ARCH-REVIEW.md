# Архитектурный обзор AI Office Dashboard

Дата обзора: 2026-08-02. Актуализировано 2026-08-02 после волны исправлений (ротация журнала событий, детект пересоздания файла, удаление мёртвого типа `agent_update`, интеграционный тест Python-хука). Проект: VSCode-расширение «AI Office Dashboard» (TypeScript, `src/`, ~3300 строк кода, 17 модулей). Расширение визуализирует работу агентов CLI-инструментов (Claude Code и Kimi Code) в виде «офиса» с комнатами в webview-панели.

## 1. Общая картина

Расширение мультимодельное: оно одинаково обслуживает два агентских CLI — Claude Code и Kimi Code. Оба CLI исполняют пользовательские хуки на события жизненного цикла (старт сессии, старт/стоп субагента, конец хода, уведомление, отправка промпта, PreToolUse). Расширение устанавливает в домашние каталоги этих CLI свои хук-скрипты (`hooks/emit-agent-event.py` / `.js`), которые дописывают JSON-строки в общий файл событий `~/.claude/agent-events.jsonl`. Расширение следит за этим файлом, поддерживает модель состояния агентов и транслирует снапшоты в webview-дашборд (панель в сайдбаре и/или вкладка редактора).

Ключевые архитектурные свойства:

- **Разделение чистой логики и клея.** Модули `types.ts`, `eventParser.ts`, `agentRoster.ts`, `agentDetail.ts`, `hookConfig.ts`, `hookConfigKimi.ts`, `stopFlag.ts` (чистая часть), `subscriptionUsage.ts`, `kimiUsage.ts` не импортируют `vscode` и покрыты юнит-тестами в `test/`. Клей (файловая система, UI, конфигурация VSCode) собран в `extension.ts`, `hookInstaller.ts`, `webview/provider.ts`, `locale.ts`, `usageWatcher.ts`.
- **Однонаправленный поток данных.** Файл событий — единственный вход; webview никогда не мутирует состояние, а только запрашивает действия через сообщения.
- **Декларативная изоляция окон.** Каждое окно VSCode фильтрует события по `cwd` рабочих папок (`aiOffice.scope`), так что несколько окон видят каждое свой проект, несмотря на общий файл событий.

## 2. Карта модулей

| Модуль | Слой | Роль |
|---|---|---|
| `src/types.ts` | домен | Типы событий/состояний, карта комнат, эвристика `agent → room` |
| `src/eventParser.ts` | приём | Разбор строк JSONL в `AgentEvent` |
| `src/eventWatcher.ts` | приём | Наблюдение за файлом событий, инкрементальное дочитывание |
| `src/agentState.ts` | домен | `AgentStateStore` — конечный автомат состояний агентов |
| `src/agentRoster.ts` | домен | Обнаружение проектных агентов из `.claude/agents` и т.п. |
| `src/agentDetail.ts` | домен | Сопоставление start/stop в «прогоны» для drill-down |
| `src/hookConfig.ts` | установка | Чистая логика регистрации хуков в `~/.claude/settings.json` |
| `src/hookConfigKimi.ts` | установка | То же для `~/.kimi-code/config.toml` (TOML, без парсера) |
| `src/hookInstaller.ts` | установка | FS/UI-клей: копирование скриптов, проверка статуса, автонастройка |
| `src/stopFlag.ts` | emergency stop | Флаг экстренной остановки, общий с хук-скриптами |
| `src/subscriptionUsage.ts` | usage | Лимиты подписки Claude (OAuth endpoint) + универсальный watcher |
| `src/kimiUsage.ts` | usage | Лимиты плана Kimi Code (`/coding/v1/usages`) |
| `src/usageWatcher.ts` | usage | Стоимость через внешний `npx ccusage` (опционально) |
| `src/locale.ts` | инфра | Определение языка UI (система/VSCode/настройка) |
| `src/configMigration.ts` | инфра | Разовая миграция ключей `claudeOffice.*` → `aiOffice.*` |
| `src/webview/provider.ts` | представление | `OfficeDashboardProvider`: HTML, кэш состояния, двунаправленные сообщения |
| `src/extension.ts` | композиция | Точка входа: связывает всё, команды, статус-бар, реакция на конфиг |

## 3. Поток данных: от хука до пикселя

### 3.1. Генерация событий (вне расширения)

Хук-скрипты `hooks/emit-agent-event.py` / `emit-agent-event.js` (идентичные по логике, выбирается один рантайм — Python или Node) вызываются CLI на каждое событие. Они получают JSON на stdin от CLI, обогащают его (timestamp, session, cwd, model) и **дописывают одну JSON-строку** в `~/.claude/agent-events.jsonl` (путь переопределяется `aiOffice.eventsFile`). Аргумент командной строки задаёт тип события: `session_start`, `agent_start`, `agent_stop`, `session_stop`, `agent_waiting`, `user_prompt`, `stop_gate`.

Отдельный режим — `stop_gate` (PreToolUse): скрипт проверяет флаг `office-stop.json` и, если остановка активна для cwd сессии, **отклоняет вызов инструмента** (exit-код/JSON-блокировка), реализуя экстренную остановку. Событие в JSONL в этом режиме пишется как `tool_activity`.

### 3.2. Приём событий: `EventWatcher` → `eventParser`

`EventWatcher` (`src/eventWatcher.ts`):

1. При старте создаёт файл/каталог при отсутствии и **дочитывает существующее содержимое** — так при открытии окна восстанавливается история (replay).
2. Следит за файлом двумя способами одновременно: `fs.watch` (быстро, но ненадёжно на Windows) и интервальный опрос раз в 1 с (надёжно). Дубли не страшны: смещение `lastSize` делает повторное чтение пустым.
3. Инкрементально читает только новые байты (`fs.readSync` с позиции `lastSize`).
4. Обрабатывает **незавершённые строки**: байты после последнего `\n` хранятся в `leftover` (в виде Buffer, чтобы не разорвать многобайтовый UTF-8) и дополняются следующим чтением. Это защищает от чтения посреди конкурентной записи нескольких хуков.
5. Обнаруживает усечение файла (новый размер меньше `lastSize`) и сбрасывает позицию.
6. Ротирует журнал на старте: файл больше 5 МБ усекается до хвоста в 1 МБ с выравниванием по границе строки (`rotateIfNeeded`), поэтому replay ограничен независимо от того, как долго расширение не запускалось.
7. Детектирует пересоздание файла по паре `dev/ino`: при смене идентичности файла между тиками `lastSize` и `leftover` сбрасываются, и новый файл читается с начала.

Каждая полная строка проходит `parseLine` (`src/eventParser.ts`): `JSON.parse` + минимальная валидация (обязательны `event` и `session`). Невалидные строки молча пропускаются — парсер намеренно лоялен, т.к. файл пишется сторонними скриптами.

### 3.3. Модель состояния: `AgentStateStore`

`store.processEvent(event)` (`src/agentState.ts`) — центральный конечный автомат:

- **Фильтр по окну.** `matchesCwd` отбрасывает события чужих проектов (сравнение нормализованных путей: `\` → `/`, без регистра, с учётом вложенности).
- **Модель сессии.** Любое событие может нести `model` — запоминается последнее.
- **Ожидание пользователя.** `agent_waiting` выставляет `SessionWaiting` (только если событие не старше 20 мин — исторические уведомления при replay баннер не воскрешают); любое другое событие сбрасывает ожидание.
- **`user_prompt`** переводит псевдоагента `Main agent` (основная модель чата) в `working`; сессия заносится в `mainSessions`.
- **`agent_start`** → агент в `working` с задачей; параллельные однотипные агенты учитываются счётчиком `activeCount` (у событий нет id экземпляра). Старт старше 20 мин состояние не «воскрешает» — создаётся лишь idle-запись.
- **`agent_stop`** → декремент `activeCount`; при обнулении — `done` или `error` (по `result`), плюс таймер 5 с, после которого агент уходит в `idle` (бейдж «готово» не висит вечно).
- **`session_stop`** (конец хода основной модели) **не гасит** работающих субагентов — фоновые агенты могут пережить ход; лишь чистит `done`/`error` → `idle` и завершает `Main agent` для этой сессии.
- **`tool_activity`** — пустая ветка: сброс ожидания уже произошёл выше.
- **Защита от «сирот»:** раз в 30 с `sweepStale` переводит в `idle` агентов, чей `lastActivity` старше 20 минут (случай убитой сессии / потерянного `agent_stop`), и сбрасывает зависший баннер ожидания.
- `recentEvents` — кольцевой буфер последних 200 start/stop событий для drill-down.

Изменения, инициированные таймерами (sweep, done-таймер), сигналятся через `store.onChange`; изменения от событий проталкивает сам `extension.ts` после пакета событий.

### 3.4. Композиция и трансляция: `extension.ts` → `OfficeDashboardProvider`

В `activate()` (`src/extension.ts`):

1. `migrateLegacyConfiguration` — миграция настроек.
2. Создаётся `AgentStateStore`, настраиваются `setRoomResolver` (проектный `office-rooms.json` > настройка `aiOffice.agentRooms` > встроенные дефолты > эвристика) и `setCwdFilter` (папки окна, если `scope=workspace`).
3. `seedRoster` — проектные агенты из `.claude/agents`, `.kimi-code/agents`, `.agents/agents` добавляются как idle, чтобы офис не был пустым до первых событий.
4. `new EventWatcher(eventsFile, cb)`: колбэк прогоняет пакет событий через `store.processEvent` и вызывает `broadcastState()`.
5. `broadcastState()` = `provider.updateAgents(store.getSnapshot(), store.getModel(), store.getWaiting())` + `updateStatusBar()` + `pushAgentDetail()`.

`OfficeDashboardProvider` (`src/webview/provider.ts`) хранит **последнее состояние всего** (агенты, модель, ожидание, стоп-флаг, usage, ошибки usage) и поддерживает два «слота» webview: вид в сайдбаре (`resolveWebviewView`) и панель-вкладка (`openInEditor`). Оба получают одинаковый HTML из `media/office.html` с подстановкой URI ресурсов, CSP-нонса, локали и версии. Сообщения в webview:

- `full_state` — полный снапшот агентов + модель + ожидание (единственный тип состояния: вместо инкрементальных обновлений всегда шлётся полный снапшот);
- `stop_state` — состояние экстренной остановки;
- `usage_update` / `usage_error` — лимиты подписок и стоимость;
- `agent_detail` — ответ drill-down.

`replay()` пересылает весь кэш при `webview_ready` и при возвращении видимости — защита от потери сообщений скрытому webview. Обратный канал (webview → расширение): `webview_ready`, `toggle_stop`, `agent_detail_request`, `agent_detail_close`.

Статус-бар (в `extension.ts`) отражает приоритетную сводку: стоп-флаг > ожидание > ошибки > работающие агенты (с учётом `activeCount`) > «Main agent работает» > idle.

## 4. Описание модулей

### 4.1. `src/types.ts` — доменные типы и распределение по комнатам

Экспорты: интерфейсы `AgentEvent`, `AgentState`, `SessionWaiting`, `AgentRun`, `AgentDetail`, тип `WebviewMessage`, константы `KNOWN_ROOMS`, `MAIN_AGENT_NAME` (`'Main agent'`), `DEFAULT_AGENT_ROOMS`, функции `inferRoomByName`, `getRoomForAgent`.

- `AgentEvent` — сырой формат строки JSONL: 7 типов событий, поля `agent`, `task`, `result`, `session`, `cwd`, `model`.
- `AgentState` — вычисленное состояние для отображения: `idle | working | done | error`, комната, `activeCount` для параллельных экземпляров.
- `WebviewMessage` — дискриминированное объединение всех сообщений расширение → webview.
- Распределение по комнатам трёхуровневое: `customMap` (проектный файл + настройки) → `DEFAULT_AGENT_ROOMS` (встроенные типы агентов обоих CLI, включая `Main agent` в комнату `directors`) → эвристика `inferRoomByName`: упорядоченные ключевые правила (directors, ai-lab, iot, security, devops, qa, frontend, integrations, backend) с токен-матчингом и префиксным «стеммингом» для ключей длиной ≥5 символов; fallback — `lobby`. Пол здания в webview строится динамически из фактических комнат, поэтому неизвестные id комнат тоже работают.

### 4.2. `src/eventParser.ts` — разбор JSONL

Экспорты: `parseLine(line): AgentEvent | null`, `parseLines(text): AgentEvent[]`.

Минималистичный и намеренно лояльный парсер: пустые и битые строки отбрасываются, обязательны только `event` и `session`. Не проверяет допустимость значения `event` — неизвестные типы пройдут в `AgentStateStore` и будут проигнорированы switch'ем (мягкая прямая совместимость с будущими версиями хуков).

### 4.3. `src/eventWatcher.ts` — слежение за файлом событий

Экспорт: класс `EventWatcher(filePath, onEvents)` с методами `start()` / `stop()`.

Подробно разобран в §3.2. Ключевые решения: двойной механизм обнаружения (fs.watch + poll 1 с) из-за ненадёжности `fs.watch` на Windows; байтовый `leftover` против разрыва UTF-8 и чтения mid-write; обработка усечения файла; replay существующего содержимого при старте. Ошибки чтения (временные блокировки файла) глотаются — повторная попытка на следующем тике.

### 4.4. `src/agentState.ts` — хранилище состояний агентов

Экспорт: класс `AgentStateStore`.

Публичный API: `setRoomResolver`, `setCwdFilter`, `seedAgents`, `start/stop` (таймер sweep), `processEvent`, `getSnapshot`, `getRecentEvents`, `getModel`, `getWaiting`, `clear`, колбэк `onChange`.

Семантика подробно в §3.3. Важные инварианты:

- одно хранилище на окно, изоляция — только фильтром `cwd` на входе;
- `session_stop` никогда не завершает `working`-агентов — единственная уборка сирот это 20-минутный sweep;
- состояния `done`/`error` — короткоживущие (5 с) бейджи, самовосстанавливающиеся в `idle`;
- `Main agent` — псевдоагент основной модели, его «работа» это интервал `user_prompt → session_stop` с подсчётом активных сессий;
- `getSnapshot()` возвращает копии (`{...state}`), т.е. webview-слой не может случайно мутировать хранилище.

### 4.5. `src/agentRoster.ts` — обнаружение проектных агентов

Экспорты: `AGENT_DIRS` (`.claude/agents`, `.kimi-code/agents`, `.agents/agents`), `agentNameFromFile`, `discoverProjectAgents(folders)`.

Рекурсивный обход (глубина ≤4, ≤300 файлов) `.md`-файлов агентов во всех папках workspace; имя берётся из `name:` в YAML-frontmatter, иначе из имени файла. Результат — отсортированный список уникальных имён, попадающий в `seedAgents`. Лимиты глубины и количества файлов защищают от патологических деревьев (например, агентный каталог, симлинком указывающий на большое дерево — рекурсия по симлинкам впрочем не отсекается отдельно).

### 4.6. `src/agentDetail.ts` — история прогонов агента

Экспорт: `buildAgentRuns(events, agentName, limit = 50): AgentRun[]`.

Сопоставляет `agent_start`/`agent_stop` одного агента в «прогоны» FIFO (старейший открытый прогон закрывается первым) — корректно при чередовании параллельных однотипных агентов без id экземпляров. Стоп без пары (старт выпал из буфера 200 событий) даёт прогон с `startedAt: null`. Результат — новейшие сверху, открытые прогоны в начале. Питает drawer в webview.

### 4.7. `src/hookConfig.ts` — хуки Claude Code (чистая логика)

Экспорты: тип `HookRuntime` (`python | python3 | py | node`), `HOOK_MARKER`, `HOOK_EVENTS` (7 событий Claude → аргументы скрипта), `hookScriptFileFor`, `buildHookCommand`, `hasOfficeHooks`, `officeHookCoverage`, `mergeOfficeHooks`.

- Команда хука: `<runtime> "$HOME/.claude/hooks/emit-agent-event.{py,js}" <arg>` — `$HOME` раскрывает сам Claude Code.
- `officeHookCoverage` → `none | partial | full`: «partial» означает установку старой версии расширения и позволяет автонастройке **молча** домерджить новые события (согласие на хуки уже дано).
- `mergeOfficeHooks` — глубоко клонирует settings.json, добавляет недостающие регистрации (или заменяет свои при `replace`, например при смене рантайма), не трогая чужие хуки и прочие настройки. Наши записи опознаются по подстроке `emit-agent-event` в команде.

### 4.8. `src/hookConfigKimi.ts` — хуки Kimi Code (чистая логика)

Экспорты: `KIMI_HOOK_MARKER`, `KIMI_BEACON_PREFIX`, `KIMI_HOOK_EVENTS` (7 событий Kimi; аналог Claude `Notification` здесь — `PermissionRequest`), `buildKimiHookCommand`, `kimiHookBlock`, `hasKimiOfficeHooks`, `kimiOfficeHookCoverage`, `mergeKimiOfficeHooks`.

Принципиальное отличие: `config.toml` **не парсится как TOML**. Текст режется на чанки по заголовкам секций (`splitToml`), свои таблицы `[[hooks]]` находятся по маркеру `emit-agent-event` в команде и по beacon-комментарию `# office-dashboard-hook: <Event>` перед каждой таблицей. Замена — построчная операция: чужой конфиг остаётся байт-в-байт тем же. Команда хука получает абсолютный путь к скрипту и дополнительный аргумент `kimi`. Семантика coverage/merge повторяет Claude-вариант.

### 4.9. `src/hookInstaller.ts` — установка хуков (FS/UI-клей)

Экспорты: тип `HookTarget`, `resolveTargets`, `detectRuntime`, `HookStatus`, `checkHookStatus`, `installHooks`, `ensureHooksOnActivation`.

- `resolveTargets('auto')` — цели по наличию `~/.claude` / `~/.kimi-code`; если нет ни одного — обе (будущая установка CLI подхватит хуки).
- `detectRuntime()` — пробует `python`, `python3`, `py -3`, затем `node` (с защитой от псевдо-alias Python из Windows Store).
- `checkHookStatus` — две независимые проверки: регистрации в конфигах (`settingsOk`) и идентичность установленных скриптов поставляемым (`scriptsOk`, побайтовое сравнение).
- `installHooks` — копирует оба скрипта в `<target>/hooks/` и мержит регистрации; перед перезаписью конфига делает бэкап (`.ai-office.bak` / `.office-dashboard.bak`). Битый JSON `settings.json` — отказ с понятной ошибкой, файл не затирается.
- `ensureHooksOnActivation` — сценарий нулевой конфигурации: полностью настроено → ничего; скрипты устарели → молча обновить; частичная регистрация → молча домерджить; ничего нет → одноразовый dismissable-диалог «Install / Later / Don't ask again» (флаг в `globalState`).

### 4.10. `src/stopFlag.ts` — флаг экстренной остановки

Экспорты: `StopFlag`, чистые `parseStopFlag`, `activateStopFlag`, `deactivateStopFlag`, `stopAppliesToWindow` и FS-клей `stopFlagPath(s)`, `readStopFlag`, `writeStopFlag`, `clearStopFlag`, `activateStopEverywhere`, `releaseStopEverywhere`.

Модель: у каждого CLI свой файл `~/.claude/office-stop.json` и `~/.kimi-code/office-stop.json`; расширение пишет/читает **все** файлы разом — одна кнопка останавливает все CLI. Флаг: `{ active, cwds, since }`; пустой `cwds` = глобальная остановка. Многооконная семантика:

- активация мержится: глобальный флаг с любой стороны остаётся глобальным, иначе — объединение списков cwd (сравнение путей с нормализацией, на Windows — без учёта регистра);
- снятие вычитает только свои папки (`pathsOverlap` в обе стороны) — остановки, поставленные другими окнами на их проекты, выживают; пустой остаток → файл удаляется;
- `stopAppliesToWindow` — глобальный флаг применим к любому окну, иначе нужно пересечение cwd.

Симметричную логику реализуют хук-скрипты: новый пользовательский промпт в любом CLI снимает флаг (auto-release) — об этом в заголовке файла прямо сказано «keep in sync with hooks/emit-agent-event.py / .js».

### 4.11. `src/subscriptionUsage.ts` — лимиты подписки Claude + универсальный watcher

Экспорты: типы `UsageLimitEntry`, `SubscriptionSnapshot`, `OAuthCredentials`, `ProviderCredentials`, `UsageProviderConfig`, `SubscriptionWatcherOptions`; функции `parseCredentials`, `parseUsageResponse`, `readCredentials`; `claudeUsageProvider`; класс `SubscriptionUsageWatcher`.

- Источник данных — тот же OAuth-endpoint, что у команды `/usage` самого Claude Code: `GET api.anthropic.com/api/oauth/usage` с UA `claude-code/2.1.0` (другой UA попадает в строгий rate bucket).
- Креды: `~/.claude/.credentials.json`, на macOS — fallback в keychain (`security find-generic-password`). Токены расширение **не обновляет** — это делает любая сессия Claude Code.
- `parseUsageResponse` — защитный разбор: предпочитает массив `limits[]` (kind/percent/resets_at, недельные лимиты по моделям), fallback на старую плоскую форму `five_hour/seven_day/seven_day_opus`.
- `UsageProviderConfig` — точка расширения: id, URL, заголовки, чтение кредов, парсер и политика сообщений об ошибках. Благодаря этому `SubscriptionUsageWatcher` полностью провайдер-агностичен.
- Watcher: немедленный тик + интервал; защёлка `inFlight` против наложения опросов; 401/403 → сообщение «перелогиньтесь»; 429 → тихо ждём следующего тика; истёкший токен — не ошибка UI, только лог.

### 4.12. `src/kimiUsage.ts` — лимиты плана Kimi Code

Экспорты: `parseKimiCredentials`, `readKimiCredentials`, `parseKimiUsageResponse`, `kimiUsageProvider` (конфиг для `SubscriptionUsageWatcher`).

- Endpoint: `GET api.kimi.com/coding/v1/usages` (тот же, что у `/usage` в Kimi Code CLI). Креды — OAuth-файлы из `$KIMI_CODE_HOME/credentials/*.json` (по умолчанию `~/.kimi-code/credentials/`), берётся первый читаемый.
- Ответ: `limits[]` — скользящие rate-окна (5 ч), верхнеуровневый `usage` — недельная квота; тариф из `user.membership.level` (`LEVEL_INTERMEDIATE` → `intermediate`). Квоты могут приходить строками — нормализуются через `Number()`.
- Политика ошибок отражает специфику: токен живёт ~15 минут и обновляется самим CLI, поэтому отсутствие кредов и истечение токена — `null` (молчим, держим последние данные), жалуемся только на 401/403.

### 4.13. `src/usageWatcher.ts` — стоимость через ccusage

Экспорты: типы `UsageBlock`, `UsageWeekly`, `UsageLimits`, `UsageSnapshot`; класс `UsageWatcher`.

Опциональный источник (`aiOffice.usage.costSource = 'ccusage'`): запускает `npx --yes ccusage@latest blocks --active --json` и `weekly --json --order desc` с таймаутом 30 с. Парсит активный 5-часовой блок (стоимость, токены, burn-rate, остаток) и текущую неделю (в т.ч. отдельно затраты на Opus через `modelBreakdowns`), скрещивает с пользовательскими лимитами из настроек (`usage.limitBlockUsd` и т.п.). Особенности: на Windows спавн через shell (`npx.cmd`, обход CVE-2024-27980), JSON извлекается срезом от первого `{` (терпимость к мусору в stdout), интервал общий с подписками (`usage.pollSeconds`, минимум 30 с).

### 4.14. `src/locale.ts` — язык интерфейса

Экспорты: `uiLocale()`, `isRussianUi()`.

Настройка `aiOffice.language`: `'vscode'` → `vscode.env.language`; явный код → как есть; `'system'` (по умолчанию) → реальная локаль ОС: env `LC_ALL/LC_MESSAGES/LANG`, на Windows — реестр `HKCU\Control Panel\International\LocaleName`, fallback — `Intl`. Кэшируется на сессию. Мотивация задокументирована: язык VSCode часто оставляют английским по привычке, а дашборд должен говорить на языке системы.

### 4.15. `src/configMigration.ts` — миграция настроек

Экспорты: `ConfigInspection`, `ConfigReader`, `ConfigWriter`, `migrateConfigKeys`, `migrateLegacyConfiguration`.

Разовая (при активации) миграция ключей `claudeOffice.*` → `aiOffice.*` (14 ключей: language, eventsFile, hooks.*, statusBar/roster/usage.*, scope, agentRooms) по уровням global/workspace; не затирает уже заданные новые значения. Чистая часть тестируется через минимальные интерфейсы reader/writer; `require('vscode')` — ленивый, чтобы модуль грузился в plain-node тестах. Также переносится флаг `hooksPromptDismissed` из `globalState`.

### 4.16. `src/webview/provider.ts` — провайдер дашборда

Экспорт: класс `OfficeDashboardProvider` (`viewId = 'aiOffice.dashboard'`, `editorViewType = 'aiOffice.dashboardEditor'`).

Разобран в §3.4. Публичный API: колбэки `onReady`, `onToggleStop`, `onAgentDetailRequest`, `onAgentDetailClose`; методы `resolveWebviewView`, `show`, `openInEditor`, `updateAgents`, `updateStop`, `sendAgentDetail`, `updateSubscription`, `updateCost`, `reportUsageError`, `resetCost`, `isVisible`.

Заметные решения: единый `broadcast` в оба слота (сайдбар + вкладка могут существовать одновременно); кэш последнего состояния и `replay()` на готовность/восстановление видимости; `updateSubscription` сам определяет провайдера по полю `snapshot.provider`; HTML собирается подстановкой `{{cssUri}}/{{jsUri}}/{{iconsUri}}/{{avatarsUri}}/{{cspSource}}/{{nonce}}/{{lang}}/{{version}}` в шаблон `media/office.html`, ресурсы ограничены `localResourceRoots: media/`. Вся отрисовка «офиса» (ROOM_META, иконки, аватары) живёт в `media/office.js/icons.js/avatars.js` и в данный обзор не входит (не TypeScript).

### 4.17. `src/extension.ts` — точка входа и композиция

Экспорты: `activate`, `deactivate`.

Помимо главного конвейера (§3.4) здесь живут:

- **Команды:** `aiOffice.showDashboard`, `aiOffice.openInEditor`, `aiOffice.emergencyStop`, `aiOffice.installHooks` (с `replace: true` — ремонт/смена рантайма), `aiOffice.clearEvents` (очистка стора и файла + повторный seed ростера).
- **Экстренная остановка:** `toggleStop` — снятие через `releaseStopEverywhere` (с сообщением, если чужие остановки остались) или активация через `activateStopEverywhere`; при глобальной области (нет папки / `scope=global`) — модальное подтверждение, т.к. блокируются все сессии на машине. `fs.watchFile` (опрос 1,5 с) на обоих flag-файлах подхватывает изменения от других окон и auto-release из хуков — состояние кнопки/баннера/статус-бара синхронизируется.
- **Watchers использования:** `SubscriptionUsageWatcher` для Claude и Kimi запускаются всегда (если `usage.enabled`), `UsageWatcher` (ccusage) — только при `costSource=ccusage`.
- **Реакции на конфигурацию** (`onDidChangeConfiguration`): смена `agentRooms` → новый resolver; `scope`/`roster` → сброс и пересборка стора; `statusBar`/`language` → обновление статус-бара (+ подсказка перезагрузить окно — локаль запечена в HTML); `usage.*` → перезапуск соответствующих watcher'ов. Смена папок workspace — аналогичный пересбор.
- **`deactivate`** останавливает все watcher'ы и стор.

## 5. Конфигурация и внешние интерфейсы

Настройки (`aiOffice.*`): `language`, `eventsFile`, `scope` (workspace/global), `agentRooms`, `hooks.autoSetup`, `hooks.targets`, `statusBar.enabled`, `roster.enabled`, `usage.enabled`, `usage.pollSeconds`, `usage.costSource`, `usage.limitBlockUsd/WeeklyUsd/WeeklyOpusUsd`.

Файловые контракты:

- `~/.claude/agent-events.jsonl` — общий журнал событий (вход);
- `~/.claude/settings.json`, `~/.kimi-code/config.toml` — регистрации хуков (запись, с бэкапами);
- `~/.claude/hooks/`, `~/.kimi-code/hooks/` — копии хук-скриптов;
- `~/.claude/office-stop.json`, `~/.kimi-code/office-stop.json` — флаги остановки (двунаправленный обмен с хук-скриптами);
- `<folder>/.claude/office-rooms.json`, `<folder>/.kimi-code/office-rooms.json` — проектные карты комнат;
- `<folder>/.claude/agents`, `.kimi-code/agents`, `.agents/agents` — проектный ростер;
- `~/.claude/.credentials.json`, `~/.kimi-code/credentials/*.json` — креды для usage (только чтение).

Сетевые вызовы: `api.anthropic.com/api/oauth/usage`, `api.kimi.com/coding/v1/usages`, `npx ccusage` (опционально).

## 6. Наблюдения и риски

Сильные стороны:

- Чёткое разделение чистой логики и платформенного клея — почти вся нетривиальная семантика (хранилище, хуки, стоп-флаг, парсеры usage) тестируется без VSCode.
- Защитное программирование на всех внешних границах: лояльный парсер JSONL, leftover-буфер, replay состояния в webview, бэкапы конфигов, отказ от перезаписи битого settings.json, защёлки `inFlight` в опросах.
- Корректная многооконная семантика (cwd-фильтры, объединение/вычитание стоп-флагов) — редкий и правильно решённый случай для VSCode-расширений.
- Дублирование хук-скрипта на Python и Node с единой логикой снимает зависимость от конкретного рантайма на машине пользователя.

Риски и шероховатости (по убыванию значимости):

1. **Конкурентная запись в общий файл событий без межпроцессной блокировки.** Несколько CLI-сессий дописывают `agent-events.jsonl` конкурентно; короткие строки и append обычно атомарны, но строгой гарантии нет. Команда `clearEvents` затирает файл, который в этот момент может писать другой процесс. ~~Рост файла не ограничен~~ — **снято**: `EventWatcher` теперь ротирует журнал на старте (файл > 5 МБ усекается до хвоста в 1 МБ с выравниванием по границе строки, `rotateIfNeeded`), так что replay на старте ограничен независимо от того, как долго расширение не запускалось.
2. **Дублирование логики между TS и хук-скриптами.** Покрытие стоп-флага и нормализация путей реализованы трижды (`stopFlag.ts`, `emit-agent-event.py`, `emit-agent-event.js`) — принципиально это по-прежнему кандидат на расхождение, но дрейф теперь **ловится тестами**: интеграционный `test/emitAgentEventPy.test.ts` прогоняет Python-хук по тем же сценариям, что и JS-версию. Волной исправлений уже закрыты два найденных расхождения: JS-скрипт научился терпеть BOM в `office-stop.json`, а Python-скрипт получил верхнеуровневый try/catch.
3. **Эвристика комнат** в `types.ts` — большой вручную поддерживаемый список ключевых слов; порядок правил значим (IoT перед backend/devops), что хрупко при правках. Смягчается проектным `office-rooms.json`.
4. ~~**`EventWatcher` не наблюдает за пересозданием файла**~~ — **снято**: watcher запоминает пару `dev/ino` файла и при её смене (файл удалён и создан заново между тиками) сбрасывает `lastSize` и `leftover`, перечитывая новый файл с начала.
5. **Синхронный I/O в горячих точках** (`fs.readFileSync` на каждый тик опроса, `readdirSync` в ростере) — при текущих объёмах не проблема, но блокирует event loop расширения.
6. **Отсутствие теста на контракт webview-сообщений** в `src/` (типы — в `types.ts`, рендер — в `media/office.js` без типизации): несовпадение полей между `WebviewMessage` и JS-клиентом выловится только вручную.

## 7. Краткое резюме

Архитектура проста и последовательна: append-only журнал событий → инкрементальный watcher → лояльный парсер → конечный автомат состояний → полный снапшот в webview, плюс независимые периодические каналы usage и файловый флаг экстренной остановки, работающий в обратную сторону (расширение → хуки). Чистая доменная логика отделена от VSCode и покрыта тестами; платформенная специфика (Windows-опросы, shell-спавн, реестр локали) учтена явно. Ранее отмеченные проблемы закрыты: журнал ротируется на старте (5 МБ → хвост 1 МБ), пересоздание файла детектируется по `dev/ino`, мёртвый тип `agent_update` удалён из `WebviewMessage`, а дрейф между TS- и Python/JS-реализациями хуков ловит интеграционный тест `emitAgentEventPy.test.ts`. Оставшиеся зоны внимания — конкурентный append в журнал без межпроцессной блокировки, принципиально тройная синхронизация логики с хук-скриптами (хоть и под тестами), хрупкая эвристика комнат, синхронный I/O на тиках и отсутствие типизированного контракта между `WebviewMessage` и `media/office.js`.
