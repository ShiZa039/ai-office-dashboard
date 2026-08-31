# Архитектурный обзор AI Office Dashboard

Дата обзора: 2026-08-02. Актуализировано 2026-08-31 (v0.21.0): добавлен слой учёта расхода — `tokenUsage`, `pricing`, `modelSelection` — и `autoStop`, `repoLink`; счётчики читают транскрипты обоих CLI. Ранее (2026-08-04): pace-модель квот (`usagePace`); удалена `configMigration` — deprecated-ключи `claudeOffice.*` сняты после v0.16.0. Проект: VSCode-расширение «AI Office Dashboard» (TypeScript, `src/`, ~5300 строк кода, 22 модуля). Расширение визуализирует работу агентов CLI-инструментов (Claude Code и Kimi Code) в виде «офиса» с комнатами в webview-панели.

## 1. Общая картина

Расширение мультимодельное: оно одинаково обслуживает два агентских CLI — Claude Code и Kimi Code. Оба CLI исполняют пользовательские хуки на события жизненного цикла (старт сессии, старт/стоп субагента, конец хода, уведомление, отправка промпта, PreToolUse). Расширение устанавливает в домашние каталоги этих CLI свои хук-скрипты (`hooks/emit-agent-event.py` / `.js`), которые дописывают JSON-строки в общий файл событий `~/.claude/agent-events.jsonl`. Расширение следит за этим файлом, поддерживает модель состояния агентов и транслирует снапшоты в webview-дашборд (панель в сайдбаре и/или вкладка редактора).

Ключевые архитектурные свойства:

- **Разделение чистой логики и клея.** Модули `types.ts`, `eventParser.ts`, `agentRoster.ts`, `agentDetail.ts`, `hookConfig.ts`, `hookConfigKimi.ts`, `stopFlag.ts` (чистая часть), `subscriptionUsage.ts`, `kimiUsage.ts`, `usagePace.ts`, `pricing.ts`, `autoStop.ts`, `modelSelection.ts`, `repoLink.ts`, `tokenUsage.ts` не импортируют `vscode` и покрыты юнит-тестами в `test/`. Клей (файловая система, UI, конфигурация VSCode) собран в `extension.ts`, `hookInstaller.ts`, `webview/provider.ts`, `locale.ts`, `usageWatcher.ts`.
- **Однонаправленный поток данных.** Webview никогда не мутирует состояние, а только запрашивает действия через сообщения. Входов у расширения три, и они независимы: файл событий (хуки), периодические пробы квот и сканер транскриптов CLI — падение любого не роняет остальные.
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
| `src/usagePace.ts` | usage | Pace-модель квот: burn rate vs окно, темп, ранние алерты |
| `src/usageWatcher.ts` | usage | Стоимость через внешний `npx ccusage` (опционально) |
| `src/tokenUsage.ts` | usage | Сканер транскриптов обоих CLI: токены по сессии/проекту, сплиты по моделям и субагентам, контекст сессии |
| `src/pricing.ts` | usage | Цены моделей (Anthropic + Moonshot), разбивка стоимости, размер окна контекста |
| `src/modelSelection.ts` | usage | Выбор модели пользователем — единственный источник маркера 1M-контекста |
| `src/autoStop.ts` | emergency stop | Разовый предохранитель: когда лимит плана должен сам взвести стоп |
| `src/repoLink.ts` | инфра | Строка подвала «версия · репозиторий · лицензия» из `package.json` |
| `src/locale.ts` | инфра | Определение языка UI (система/VSCode/настройка) |
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

Модель: у каждого CLI свой файл `~/.claude/office-stop.json` и `~/.kimi-code/office-stop.json`; расширение пишет/читает **все** файлы разом — одна кнопка останавливает все CLI. Флаг: `{ active, cwds, since, until }`; пустой `cwds` = глобальная остановка, `until` — срок годности (его ставит автостоп, ручная остановка бессрочна; протухший флаг считается снятым обеими сторонами). Мерж двух флагов никогда не укорачивает срок. Многооконная семантика:

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
- Watcher: немедленный тик + интервал; защёлка `inFlight` против наложения опросов; 401/403 → сообщение «перелогиньтесь»; 429 → backoff с honouring `Retry-After` (баговый `Retry-After: 0` игнорируется), экспонента 60 с → 30 мин; истёкший токен — не ошибка UI, только лог.

### 4.12. `src/kimiUsage.ts` — лимиты плана Kimi Code

Экспорты: `parseKimiCredentials`, `readKimiCredentials`, `parseKimiUsageResponse`, `kimiUsageProvider` (конфиг для `SubscriptionUsageWatcher`).

- Endpoint: `GET api.kimi.com/coding/v1/usages` (тот же, что у `/usage` в Kimi Code CLI). Креды — OAuth-файлы из `$KIMI_CODE_HOME/credentials/*.json` (по умолчанию `~/.kimi-code/credentials/`), берётся первый читаемый.
- Ответ: `limits[]` — скользящие rate-окна (5 ч), верхнеуровневый `usage` — недельная квота; тариф из `user.membership.level` (`LEVEL_INTERMEDIATE` → `intermediate`). Квоты могут приходить строками — нормализуются через `Number()`.
- Политика ошибок отражает специфику: токен живёт ~15 минут и обновляется самим CLI, поэтому отсутствие кредов и истечение токена — `null` (молчим, держим последние данные), жалуемся только на 401/403.

### 4.13. `src/usagePace.ts` — pace-модель квот

Экспорты: типы `UsagePace`, `PaceStatus`; функции `percentTimeElapsed`, `burnRate`, `usagePace`, `paceStatus`, `nextAlertLevel`, `withPace`.

- Burn rate = used% / elapsed% окна (1.0 — точно по графику); темп `hot` / `on_pace` (±5 п.п.) / `room`. Идея и пороги адаптированы из ClaudeBar (`docs/USAGE-PROVIDERS.md` §3).
- Статус `paceStatus`: сначала абсолютные предохранители (`depleted` при 100%, `critical` при остатке <20%), затем раннее pace-предупреждение (`burnRate > 1.5` при остатке <50%) — pace никогда не понижает абсолютный статус.
- `nextAlertLevel` — монотонная эскалация (алерт один раз на уровень); `withPace` in-place обогащает лимиты снапшота полями `expectedPct`/`pace`/`paceStatus`.
- Чистый модуль без `vscode`; клей — `subscriptionUsage.ts` (обогащение) и `extension.ts` (алерты деградации, `aiOffice.usage.degradationAlerts`), отрисовка тика/лейбла — `media/office.js`.

### 4.14. `src/usageWatcher.ts` — стоимость через ccusage

Экспорты: типы `UsageBlock`, `UsageWeekly`, `UsageLimits`, `UsageSnapshot`; класс `UsageWatcher`.

Опциональный источник (`aiOffice.usage.costSource = 'ccusage'`): запускает `npx --yes ccusage@latest blocks --active --json` и `weekly --json --order desc` с таймаутом 30 с. Парсит активный 5-часовой блок (стоимость, токены, burn-rate, остаток) и текущую неделю (в т.ч. отдельно затраты на Opus через `modelBreakdowns`), скрещивает с пользовательскими лимитами из настроек (`usage.limitBlockUsd` и т.п.). Особенности: на Windows спавн через shell (`npx.cmd`, обход CVE-2024-27980), JSON извлекается срезом от первого `{` (терпимость к мусору в stdout), интервал общий с подписками (`usage.pollSeconds`, минимум 30 с).

### 4.15. `src/locale.ts` — язык интерфейса

Экспорты: `uiLocale()`, `isRussianUi()`.

Настройка `aiOffice.language`: `'vscode'` → `vscode.env.language`; явный код → как есть; `'system'` (по умолчанию) → реальная локаль ОС: env `LC_ALL/LC_MESSAGES/LANG`, на Windows — реестр `HKCU\Control Panel\International\LocaleName`, fallback — `Intl`. Кэшируется на сессию. Мотивация задокументирована: язык VSCode часто оставляют английским по привычке, а дашборд должен говорить на языке системы.

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

### 4.18. `src/tokenUsage.ts` — сканер транскриптов

Самый крупный модуль проекта (949 строк) и единственный, кто читает историю CLI напрямую. Экспорты: типы `TokenTotals`/`ModelTotals`/`AgentModelTotals`/`ContextGauge`/`TokenSnapshot`, чистые `emptyTotals`, `addTotals`, `incomingTokens`, `modelLabel`, `projectDirSlug`, тип корня `ScanRoot` и класс `TokenScanner`.

Сканер обходит **список корней**, а не один путь: `~/.claude/projects` (layout Claude Code) и `~/.kimi-code/sessions` (layout Kimi Code, при заданном `$KIMI_CODE_HOME` — оттуда). Каждый найденный файл помнит, из какого дерева он пришёл: от этого зависит и парсер, и то, как вычисляется «папка проекта» — якорь ретайра сумм при удалении сессии.

Ключевые решения:

- **Инкрементальность.** У каждого файла хранится байтовый офсет; транскрипты только растут, поэтому повторный проход читает лишь хвост. Холодный скан 236 МБ ≈ 380 мс, тёплый ≈ 2 мс.
- **Дедуп у Claude обязателен.** Одно assistant-сообщение пишется в JSONL по разу на блок контента и копируется целиком в форкнутые сессии, каждый раз повторяя кумулятивный `usage`; ключ `messageId:requestId` не даёт удвоить суммы. У Kimi дедуп не нужен: в `usage.record` нет id сообщения, а `wire.jsonl` append-only — роль дедупа играет офсет.
- **Предфильтр по cwd.** У Claude имя каталога проекта — воспроизводимый слаг (`projectDirSlug`), у Kimi — `wd_<slug>_<hash>`, где хеш невоспроизводим; поэтому для Kimi слаг только сужает обход, а авторитетный `cwd` берётся из `state.json` сессии. Оттуда читается **только** `cwd` и структура `agents`: соседние `title`/`lastPrompt` — это текст промптов (секрет-гигиена).
- **Сплиты.** `byModel` — по id модели из записи; `byAgent` — у Claude по имени файла субагента, у Kimi по каталогу агента (`main` = основная цепочка), уточняемому до `profile.bind` (типа субагента), как только эта строка попадётся в потоке.
- **Персистентность.** Снимок кладётся в `workspaceState` (`aiOffice.tokenState`), поэтому счётчик каждого окна сам собой относится к своему проекту. Формат версионирован (v1–v3); старые состояния не пересчитываются, их суммы просто попадают в «модель/агент неизвестны».

### 4.19. `src/pricing.ts` — цены и окно контекста

Чистый модуль без `vscode` и без сети: таблица цен зашита в код и правится вместе с прайсами провайдеров.

- `priceForModel(raw)` разбирает id транскрипта. Claude-ветка — по семейству и версии (Fable 10/50, Opus 4.5+ 5/25, Sonnet 3/15, Haiku 4.5 1/5 $/MTok); не разобравшийся id уходит в Kimi-ветку (`kimi-code/k3` 3/15, `kimi-for-coding` 0.95/4, `-highspeed` 1.9/8). Ничего не опознали — `null`, и модель исключается из сумм, а не оценивается наугад.
- **Две модели кэша.** У Anthropic ставки выводятся из `input`: запись ×1.25 (5m) / ×2 (1h, поле `usage.cache_creation.ephemeral_1h_input_tokens`), чтение ×0.1. У Moonshot запись билли́тся как обычный вход, а чтение идёт по плоской ставке — для этого в `ModelPrice` есть необязательные `cacheRead`/`cacheWrite`, перекрывающие множители.
- `costPartsUsd` / `costPartsOfModels` дают разбивку по статьям тарификации (вход / выход / запись кэша / чтение кэша), а не одно число, — из неё строятся тултипы, где в каждой строке и токены, и деньги.
- `contextWindowTokens` определяет размер окна для датчика: суффикс `[1m]`, 1M-only семейства (Fable, Mythos), выбор модели пользователем (`ContextWindowHint`) или доказанный факт — промпт, уже переваливший 200K. У Kimi окно фиксировано алиасом (k3 → 1M, остальные → 262K).

### 4.20. `src/modelSelection.ts` — какая модель выбрана в CLI

Маленький модуль (71 строка), закрывающий конкретную дыру: транскрипт пишет уже разрешённый id (`claude-opus-5`) и **теряет** маркер окна, так что сессия на 1M-контексте выглядит как обычная 200K. Маркер живёт только в настройках (`"model": "opus[1m]"`), и датчик контекста без него врёт втрое.

Приоритет повторяет собственный порядок Claude Code: `ANTHROPIC_MODEL` → `<project>/.claude/settings.local.json` → `<project>/.claude/settings.json` → `~/.claude/settings.json`; побеждает первый файл, назвавший модель.

### 4.21. `src/autoStop.ts` — предохранитель по лимитам плана

Решает, когда снимок квот должен сам взвести стоп-флаг. Лимиты аккаунтные, поэтому вызывающая сторона активирует **глобальную** остановку, а не проектную.

Предохранитель **разовый на окно лимита**: уровень 1 срабатывает на основном пороге (95% по умолчанию), уровень 2 — один раз на финальном (99%), после чего до реального сброса окна не стреляет ничего. Смысл — оставить пользователю остаток процентов на коммит и пуш: сняв остановку, он не должен быть остановлен снова.

Три источника ложных срабатываний закрыты явно: ключ защёлки — на **бар**, а не на `kind` (`weekly_scoped` приходит по одному на модель и раньше эти записи делили ключ); смена `resetsAt` при непрошедшем окне и всё ещё высоком проценте сбросом не считается; время сброса не ходит назад. Защёлка переживает перезапуск (`fileLatchStore`), для тестов есть `memoryLatchStore`.

### 4.22. `src/repoLink.ts` — подвал дашборда

Собирает строку `vX.Y.Z · GitHub · MIT` из `package.json`, а не из константы в разметке. `repository` приводится к https-виду (`git+`, `.git`, scp-форма `git@host:user/repo`, шорткаты `github:user/repo` и `user/repo`); всё, что не свелось к `http(s)`, отбрасывается — в `href` не должен попасть `javascript:`. Ярлык ссылки выводится из хоста, лицензия — из поля `license`, разделитель ` · ` печатается только вместе с тем, что за ним следует.

## 5. Конфигурация и внешние интерфейсы

Настройки (`aiOffice.*`, 20 ключей): `language`, `eventsFile`, `scope` (workspace/global), `agentRooms`, `hooks.autoSetup`, `hooks.targets`, `statusBar.enabled`, `roster.enabled`, `usage.enabled`, `usage.pollSeconds`, `usage.costSource`, `usage.tokens`, `usage.subscriptionUsd`, `usage.limitBlockUsd/WeeklyUsd/WeeklyOpusUsd`, `usage.degradationAlerts`, `autoStop.enabled`, `autoStop.thresholdPercent`, `autoStop.finalThresholdPercent`.

Файловые контракты:

- `~/.claude/agent-events.jsonl` — общий журнал событий (вход);
- `~/.claude/settings.json`, `~/.kimi-code/config.toml` — регистрации хуков (запись, с бэкапами);
- `~/.claude/hooks/`, `~/.kimi-code/hooks/` — копии хук-скриптов;
- `~/.claude/office-stop.json`, `~/.kimi-code/office-stop.json` — флаги остановки (двунаправленный обмен с хук-скриптами);
- `<folder>/.claude/office-rooms.json`, `<folder>/.kimi-code/office-rooms.json` — проектные карты комнат;
- `<folder>/.claude/agents`, `.kimi-code/agents`, `.agents/agents` — проектный ростер;
- `~/.claude/.credentials.json`, `~/.kimi-code/credentials/*.json` — креды для usage (только чтение);
- `~/.claude/projects/<slug>/*.jsonl`, `~/.kimi-code/sessions/<workDirKey>/<session>/agents/<agent>/wire.jsonl` — транскрипты для счётчиков токенов (только чтение, инкрементально по офсету);
- `~/.claude/settings.json`, `<folder>/.claude/settings{,.local}.json` — выбор модели для размера окна контекста (только чтение; тот же файл пишется установщиком хуков).

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
7. **Счётчики расхода зависят от чужих форматов.** `tokenUsage.ts` разбирает транскрипты двух CLI, чьи схемы никем не гарантированы: смена имени поля у любого из провайдеров тихо обнулит суммы, а не сломает сборку. Смягчается тестами на зафиксированных сэмплах (`test/tokenUsage.test.ts`) и тем, что нераспознанная запись просто не считается. Отдельная известная неточность: дневные $-суммы для 30-дневного окна держатся в памяти и пересобираются при рестарте, а удалённые транскрипты из этой цифры выпадают.
8. **Читаем каталоги за пределами проекта.** Сканер обходит домашние каталоги CLI целиком; от чужих проектов его удерживает только предфильтр по `cwd`, а у Kimi слаг каталога — лишь предположение, и окончательное решение принимается по `state.json`. Правило «не читать логи чужих проектов» здесь держится кодом, а не привычкой, — и любой рефакторинг фильтра обязан это сохранить.

## 7. Краткое резюме

Архитектура проста и последовательна: append-only журнал событий → инкрементальный watcher → лояльный парсер → конечный автомат состояний → полный снапшот в webview, плюс независимые периодические каналы usage и файловый флаг экстренной остановки, работающий в обратную сторону (расширение → хуки). Чистая доменная логика отделена от VSCode и покрыта тестами; платформенная специфика (Windows-опросы, shell-спавн, реестр локали) учтена явно. Ранее отмеченные проблемы закрыты: журнал ротируется на старте (5 МБ → хвост 1 МБ), пересоздание файла детектируется по `dev/ino`, мёртвый тип `agent_update` удалён из `WebviewMessage`, а дрейф между TS- и Python/JS-реализациями хуков ловит интеграционный тест `emitAgentEventPy.test.ts`. С v0.17.0 к трём исходным каналам добавился четвёртый — сканер транскриптов обоих CLI (токены, стоимость, окно контекста), устроенный по тому же принципу: инкрементальное чтение с офсета, лояльный разбор, состояние в `workspaceState` своего окна. Оставшиеся зоны внимания — конкурентный append в журнал без межпроцессной блокировки, принципиально тройная синхронизация логики с хук-скриптами (хоть и под тестами), хрупкая эвристика комнат, синхронный I/O на тиках, отсутствие типизированного контракта между `WebviewMessage` и `media/office.js` и зависимость счётчиков расхода от негарантированных форматов транскриптов.
