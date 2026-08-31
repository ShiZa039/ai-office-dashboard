# Анализ тестового покрытия AI Office Dashboard

Дата первого анализа: 2026-08-02. Актуализировано: 2026-08-31 — тестовый
ландшафт: 21 файл (добавлены `autoStop`, `tokenUsage`, `pricing`,
`modelSelection`, `repoLink`). Ранее (2026-08-04): добавлены
`hookWiring.test.ts`, `usagePace.test.ts`; удалён `configMigration.test.ts`
вместе с миграцией `claudeOffice.*` → `aiOffice.*`. Версия пакета: 0.21.0.

## 1. Общая картина

- Тестов: **21 файл** в `test/`, все — самодельные
  assert-скрипты на `node:assert`, без фреймворка (ни Mocha, ни Jest, ни
  `@vscode/test-electron`).
- Каждый файл компилируется вместе с проектом в `out/test/*.js` и запускается
  как обычный Node-скрипт; в конце печатает «All … tests passed.».
- Покрыто напрямую: **18 из 22** модулей `src/` (`hookInstaller` — частично:
  только vscode-независимые функции) + интеграционные тесты **обоих**
  хук-скриптов: `hooks/emit-agent-event.js` и `hooks/emit-agent-event.py`.
- Не покрыто: те же **4 модуля** (`usageWatcher`, `locale`, `extension`,
  `webview/provider`) — все завязаны на внешние процессы или VSCode API.
  Весь слой учёта расхода, добавленный после первой версии документа
  (`tokenUsage`, `pricing`, `modelSelection`, `autoStop`, `repoLink`),
  писался сразу с тестами, так что доля непокрытого снизилась.

## 2. Как запускаются тесты

Из `package.json` (`scripts`):

- `npm test` — единственный вход: `tsc -p ./` + последовательный запуск всех
  21 скомпилированный файл `node out/test/<name>.test.js`. Порядок в скрипте:
  eventParser → types → agentState → agentDetail → hookConfig → hookConfigKimi →
  subscriptionUsage → kimiUsage → agentRoster → emitAgentEvent →
  emitAgentEventPy → stopFlag → eventWatcher → hookInstaller → hookWiring →
  usagePace → autoStop → tokenUsage → pricing → modelSelection → repoLink.
  Падение любого файла обрывает цепочку (`&&`).
- `npm run compile` — только сборка (`tsc -p ./`), часть `npm test`.
- `npm run lint` — `eslint src test hooks scripts --ext ts,js`: линтятся и
  исходники, и тесты, и хук-скрипты, и служебные скрипты. В `.eslintrc.json` для них заведены scoped overrides:
  `test/**/*.ts` (отключены `no-var-requires`, `prefer-const`) и
  `hooks/**/*.js` (отключены `no-var-requires`,
  `explicit-module-boundary-types`).
- CI (`.github/workflows/ci.yml`): на push в `master` и PR job `test` гоняет
  `npm ci` → `npm run lint` → `npm test` на матрице ubuntu-latest +
  windows-latest (Node 20); отдельный job `package` собирает `.vsix`.

Особенности прогона:

- `emitAgentEvent.test.ts` и `emitAgentEventPy.test.ts` — интеграционные:
  поднимают реальные `hooks/emit-agent-event.js` / `.py` через `spawnSync`
  с подменённым `HOME`/`USERPROFILE` во временный каталог и проверяют
  записанные JSONL-события. Python-вариант молча скипается (exit 0), если
  интерпретатор Python 3 не найден (`python` → `python3` → `py`).
- `eventWatcher.test.ts` — асинхронный интеграционный тест на реальных
  temp-файлах с укороченным `pollMs: 50` вместо продового poll в 1 с.
- `hookInstaller.test.ts` подменяет домашний каталог через env и стабит
  импорт `vscode` через `Module._load`.
- `agentRoster.test.ts` использует реальную ФС (`fs.mkdtempSync` в `os.tmpdir()`).
- `tokenUsage.test.ts` и `modelSelection.test.ts` тоже работают по реальным
  temp-деревьям: первый раскладывает транскрипты обоих CLI в их родных
  layout'ах (`projects/<slug>/*.jsonl` и `sessions/wd_*/…/wire.jsonl`) и
  гоняет по ним сканер, второй — settings-файлы разных уровней.
- Остальные — чистые юнит-тесты в памяти, без `vscode`-рантайма
  (граница с VSCode API обходится либо чистыми функциями, либо in-memory
  doubles, как в `stopFlag.test.ts`).

## 3. Покрытие по тестовым файлам

### 3.1 `test/eventParser.test.ts` (54 строки) → `src/eventParser.ts`

- `parseLine`: валидные `agent_start` / `agent_stop` / `session_stop`;
  пустая и whitespace-строка → `null`; битый JSON → `null`;
  отсутствие обязательных полей (`event`, `session`) → `null`.
- `parseLines`: мультистрока с мусором между валидными строками, пустой ввод.

### 3.2 `test/types.test.ts` (120 строк) → `src/types.ts`

- `getRoomForAgent`: прямой маппинг встроенных типов Claude Code
  (`general-purpose`, `Explore`, `Plan`, `code-reviewer`) и субагентов Kimi Code
  (`coder`, `explore`, `plan`).
- Приоритет: customMap > `DEFAULT_AGENT_ROOMS` > эвристика.
- `inferRoomByName`: ключевые слова по доменам (backend, frontend, qa, security,
  devops, ai-lab, integrations, iot, directors), стемминг множественных форм,
  защита от ложного совпадения коротких слов (`author` ≠ `auth`), склеенные
  фразы (`rate-limit`, `tech-debt`), токенизация имён с пробелами, fallback в
  `lobby` для неизвестных.
- Санити-цикл: каждая запись `DEFAULT_AGENT_ROOMS` резолвится в непустую комнату.

### 3.3 `test/agentState.test.ts` (388 строк) → `src/agentState.ts`

Самый большой тестовый файл; покрывает `AgentStateStore`:

- cwd-фильтр: без фильтра, точное совпадение, нормализация Windows-путей
  (слэши + регистр), multi-root (`.code-workspace`), совпадение по подпапке,
  отказ при префиксе без границы каталога (`projectABC` ≠ `project`),
  отброс событий без `cwd` в строгом режиме.
- Семантика `session_stop`: не «убивает» работающих агентов, подметает
  завершённых в `idle`; регрессия с параллельными фоновыми агентами.
- Счётчики параллельных инстансов (`activeCount`): несколько `agent_start`
  одного типа, постепенный слив по `agent_stop`, orphan-stop без старта,
  сохранение счётчика при `session_stop`.
- Трекинг модели: из любого события с полем `model`, «новее побеждает»,
  уважение cwd-фильтра, сброс в `clear()`.
- Waiting-баннер: `agent_waiting` ставит, `user_prompt` / `agent_start` /
  `session_stop` / `tool_activity` снимают; устаревшие уведомления (25 мин)
  игнорируются; фильтр по проекту (чужой `user_prompt` не снимает наш баннер).
- Фигура главной модели (`MAIN_AGENT_NAME`): `user_prompt` → working в
  `directors`, две параллельные сессии, поздний `agent_stop` фонового агента
  не «воскрешает» main.

### 3.4 `test/agentDetail.test.ts` (129 строк) → `src/agentDetail.ts`

- `buildAgentRuns`: пара start/stop → закрытый прогон; `result: 'error'`;
  бэкфилл `task` из stop-события; незакрытый прогон (агент ещё работает);
  FIFO-закрытие при параллельных инстансах; orphan-stop → `startedAt: null`;
  фильтрация чужих агентов и типов событий; сортировка «новые первыми»;
  параметр `limit` обрезает историю, оставляя новейшие.

### 3.5 `test/hookConfig.test.ts` (145 строк) → `src/hookConfig.ts`

- `buildHookCommand` для рантаймов `python` / `node` / `py`.
- Реестр `HOOK_EVENTS`: наличие `SessionStart` (трекинг модели) и
  `PreToolUse` stop_gate (экстренная остановка).
- `mergeOfficeHooks`: мерж в пустые settings; идемпотентность; сохранение
  чужих ключей и чужих хуков; неизменность входного объекта;
  `replace: true` меняет рантайм без дублей и сохраняет чужие хуки;
  replace с тем же рантаймом — no-op.
- `hasOfficeHooks` (негативные кейсы) и `officeHookCoverage`:
  none / partial / full; сценарий апгрейда установки эпохи v0.9
  (без `Notification`/`UserPromptSubmit`) → partial → молчаливый домерж → full.

### 3.6 `test/hookConfigKimi.test.ts` (132 строки) → `src/hookConfigKimi.ts`

- `buildKimiHookCommand`: флаг `kimi` в конце команды, Windows-лаунчер `py -3`.
- Паритет событий с Claude-набором: `SessionStart`, `SubagentStart`,
  `SubagentStop`, `Stop`, `PermissionRequest`, `UserPromptSubmit`,
  `PreToolUse` (stop_gate).
- `mergeKimiOfficeHooks` над текстом TOML: пустой конфиг; идемпотентность
  (байт-в-байт); чужой TOML (модель, провайдеры, `api_key`, чужие хуки,
  комментарии) остаётся нетронутым в начале файла.
- `kimiOfficeHookCoverage`: none / partial / full; домерж partial до full
  ровно по одной регистрации на событие (маячки `# office-dashboard-hook:`).
- `replace`: смена рантайма python → node, удаление старых регистраций,
  no-op при том же рантайме.

### 3.7 `test/subscriptionUsage.test.ts` (137 строк) → `src/subscriptionUsage.ts`

- `parseCredentials`: полный набор OAuth-полей, минимальный (только токен),
  пустой токен / отсутствие `claudeAiOauth` / `null` → `null`.
- `parseUsageResponse`: современный формат с массивом `limits`
  (session / weekly_all / weekly_scoped, динамическое имя модели в метке);
  scoped-лимит без модели → общая метка; неизвестные kind проходят с читаемой
  меткой, битые записи пропускаются, utilization клампится к 100;
  legacy flat-формат (`five_hour` / `seven_day`) как fallback;
  мусор (`null`, строка, пустой объект, нечисловой utilization) → `null`.

### 3.8 `test/kimiUsage.test.ts` (109 строк) → `src/kimiUsage.ts`

- `parseKimiCredentials`: epoch-секунды → миллисекунды; пустой/отсутствующий
  токен → `null`; отсутствие `expires_at` → `null`.
- `parseKimiUsageResponse`: реальный ответ API (снимок 2026-07-28): план из
  `membership.level` (срез префикса `LEVEL_`, lower-case), rate-окно + недельная
  квота, метки (`Session (5h)` из 300 минут, `Week`), проценты из строковых
  чисел; варианты «только неделя», «только окна» (нестандартная длительность,
  не-минутная единица → общая метка), кламп >100%, нулевой лимит → 0%
  (без деления на ноль); мусор → `null`.

### 3.9 `test/agentRoster.test.ts` (81 строка) → `src/agentRoster.ts`

- `agentNameFromFile`: имя из frontmatter `name:` (в т.ч. в кавычках),
  fallback на имя файла, строчный якорь не цепляет `name:` внутри
  `description:`.
- `discoverProjectAgents` по реальному temp-дереву: рекурсивный обход
  `.claude/agents`, фильтр не-`.md`, сортировка; каталоги `.kimi-code/agents`
  и `.agents/agents` тоже сканируются; дедупликация одинаковых имён;
  несуществующая папка → пустой список; очистка temp-дерева в конце.

### 3.10 `test/emitAgentEvent.test.ts` (386 строк) → `hooks/emit-agent-event.js`

Интеграционный тест: реальный запуск скрипта через `spawnSync(process.execPath)`
с изолированным `HOME`/`USERPROFILE`, проверка JSONL в
`~/.claude/agent-events.jsonl`.

- Claude-режим: `session_start` (модель из payload), `agent_stop` (модель из
  хвоста транскрипта — новейшая assistant-запись, пропуск битых/не-assistant
  строк), отсутствующий транскрипт → событие без модели; `agent_waiting`
  (message → task, усечение до 120 символов); `user_prompt` не записывает
  текст промпта (приватность).
- stop_gate: без флага → allow + событие `tool_activity`; активный флаг с
  покрывающим cwd (включая подпапки) → `permissionDecision: 'deny'` с причиной
  «EMERGENCY STOP», без записи активности; флаг другого проекта и неактивный
  флаг → allow; глобальный флаг (пустой `cwds`) → deny везде.
- Снятие флага по `user_prompt`: только своего проекта, флаги других проектов
  выживают; глобальный флаг снимается любым промптом; автоматические промпты
  (`[SYSTEM NOTIFICATION …]`, `<system-reminder>`, `<task-notification>`)
  флаг НЕ снимают, но событие всё равно пишется; человеческий промпт с
  маркером в середине текста — снимает; отсутствие поля `prompt` — снимает
  (обратная совместимость).
- Kimi-режим (`argv[3] = 'kimi'`): модель из `default_model` в
  `~/.kimi-code/config.toml`; `agent_name` + `prompt`/`response` как task;
  `PermissionRequest` с `tool_name` → «Kimi needs your permission to use …»;
  stop_gate читает `~/.kimi-code/office-stop.json`, а не `~/.claude`;
  `user_prompt` снимает флаги ОБОИХ CLI; `<cron-fire …>` промпты стоп не снимают.

### 3.11 `test/stopFlag.test.ts` (168 строк) → `src/stopFlag.ts`

- `parseStopFlag`: null/пустая/битая строка, не-объект, `active: false` → null;
  фильтрация не-строковых и пустых `cwds`; отсутствие `cwds` → глобальный стоп.
- `activateStopFlag`: свежий стоп (workspace / global), union без дублей с
  сохранением исходного `since`, глобальный стоп остаётся/расширяется до
  глобального.
- `deactivateStopFlag`: снятие только своего проекта, удаление флага при
  полном снятии, совпадение по вложенности папок, глобальный флаг снимается
  целиком, окно с global-scope снимает всё.
- `stopAppliesToWindow`: точное совпадение, вложенность в обе стороны,
  незатронутые окна, Windows-кейс (регистр + trailing slash, под `win32`).
- `stopFlagPaths`: по одному флагу на CLI (`.claude` / `.kimi-code`).

### 3.12 `test/eventWatcher.test.ts` (214 строки) → `src/eventWatcher.ts`

Асинхронный интеграционный тест на реальных temp-файлах; продовый poll в 1 с
заменён инжектируемой опцией `pollMs: 50`, ожидания — через `waitFor` с
дедлайном. Модуль при этом вырос (117 → 181 строка): появились опции
конструктора и ротация лога.

- Replay существующего содержимого при старте: отдаются только завершённые
  строки; незавершённый хвост держится как leftover и доставляется после
  дозаписи.
- Инкрементальное чтение дозаписей, порядок событий сохраняется.
- Строка, разрезанная на две записи, доставляется ровно один раз.
- Multi-byte UTF-8 (кириллица, разрез внутри двухбайтового символа) не
  портится на границе чанка.
- Truncate файла: сброс offset'ов и перечитывание с начала.
- Удаление + пересоздание файла: тики по ENOENT не ломают watcher, новый
  файл читается с нуля.
- Ротация при старте, если лог превышает кап (`rotateBytes` /
  `rotateKeepBytes`): файл обрезается до keep-капа, все оставшиеся строки —
  валидный JSON (частичная первая строка отбрасывается), replay совпадает с
  оставшимся содержимым; лог под капом не трогается.

### 3.13 `test/hookInstaller.test.ts` (133 строки) → `src/hookInstaller.ts` (частично)

Покрыты vscode-независимые функции; `installHooks`, `ensureHooksOnActivation`,
`configuredTargets`, `detectRuntime` не покрыты (нужен extension host / PATH).
Техника: стаб `Module._load` для импорта `vscode` + подмена домашнего каталога
через `HOME`/`USERPROFILE` (`os.homedir()` читает их динамически).

- `resolveTargets`: явные `claude` / `kimi` / `both`; режим `auto` — по
  существованию каталогов `~/.claude` и `~/.kimi-code` (только claude, только
  kimi, оба, fallback в оба при отсутствии обоих).
- `checkHookStatus` против sandboxed-хоума: нет регистраций и скриптов →
  `settingsOk`/`scriptsOk` false; идентичные скрипты → `scriptsOk` true;
  устаревший (расходящийся с bundled) скрипт → false; полная регистрация
  (через `mergeOfficeHooks` в `settings.json`) → `settingsOk` true, цель в
  `coveredTargets`; частичная регистрация (старой версии расширения) →
  `settingsOk` false, но цель всё равно считается covered.

### 3.14 `test/emitAgentEventPy.test.ts` (420 строк) → `hooks/emit-agent-event.py`

Интеграционный порт `emitAgentEvent.test.ts` на Python-реализацию хука:
обе реализации обязаны вести себя одинаково. Интерпретатор ищется в порядке
`python` → `python3` → `py`; при отсутствии Python 3 тест молча скипается
(exit 0).

- Те же сценарии, что у JS-варианта (§3.10): модель из payload и из хвоста
  транскрипта, отсутствующий транскрипт, `agent_waiting` с усечением до 120,
  приватность `user_prompt`; stop_gate (allow + `tool_activity`, deny по
  подпапке, другой проект, неактивный флаг, глобальный флаг); снятие флага
  по `user_prompt` (свой проект, выживание чужих, глобальный снимается любым
  промптом); автоматические промпты — включая `<cron-fire …>` — стоп не
  снимают; kimi-режим целиком (модель из `config.toml`, `agent_name`,
  `PermissionRequest`, изоляция kimi-флага, двойное снятие).
- Python-специфичные проверки: формат `ts` строго ISO-8601 с фиксированными
  `.000Z`; флаг перезаписывается pretty-printed (assert по распарсенному
  содержимому, не по форматированию).

### 3.15 `test/hookWiring.test.ts` (46 строк) → `hooks/` + `src/hookConfig*.ts` + `src/types.ts`

Wiring-тест (ADR-0001, II.7): аргументы `event_type`, которые обрабатывают
оба хук-скрипта (py/js, читаются как текст), обязаны совпадать с регистрациями
хуков обоих CLI (`HOOK_EVENTS` / `KIMI_HOOK_EVENTS`), и каждый зарегистрированный
аргумент должен быть известным типом события в `src/types.ts`. Регистрация,
указывающая на неизвестный скриптам аргумент (или наоборот), иначе молча
терялась бы в рантайме.

### 3.16 `test/usagePace.test.ts` (146 строк) → `src/usagePace.ts`

Чистая pace-модель квот (burn rate = used% / elapsed% окна):

- `percentTimeElapsed`: доля окна по `windowMinutes`/`resetsAt`, зажата 0–100
  (окно ещё не началось, reset в прошлом).
- `burnRate` / `paceStatus`: темп «горячо / по графику / с запасом» по
  порогам; предохранители малых выборок (<20% окна или 100% использования
  не раздувают сигнал).
- `nextAlertLevel`: эскалация раннего предупреждения (burnRate > 1.5 и
  остаток < 50%), монотонность уровней, сброс на новом окне.
- `withPace`: обогащение снапшотов Claude и Kimi (через реальные парсеры
  `parseUsageResponse` / `parseKimiUsageResponse`), окна 5h/7d.

### 3.17 `test/autoStop.test.ts` (265 строк) → `src/autoStop.ts`

- Разовость предохранителя: пересечение основного порога стреляет уровнем 1,
  финального — уровнем 2 и больше не стреляет; `utilization == threshold`
  считается пересечением; прыжок через оба порога сразу рапортует финальный;
  при `final == warn` единственный выстрел он же и последний.
- Ключ защёлки — на **бар**, а не на `kind`: два `weekly_scoped`
  («Week (Opus)», «Week (Sonnet)») ведут независимые защёлки.
- Сброс окна: настоящий сброс `resetsAt` перевзводит предохранитель и
  начинает заново с уровня 1; «нереальный» сброс (окно не истекло, процент
  всё ещё выше порога) сбросом не считается; время сброса не ходит назад.
- Первым рапортуется лимит, пересёкший порог раньше остальных.

### 3.18 `test/tokenUsage.test.ts` (585 строк) → `src/tokenUsage.ts`

Самый большой тестовый файл. Сканер прогоняется по настоящим temp-деревьям
транскриптов обоих CLI.

- `modelLabel`: id вида `claude-opus-4-5-20251101` и `claude-3-5-haiku-…`
  → «Семейство версия», дата релиза не принимается за версию, суффикс `[1m]`
  — та же модель; алиасы Kimi получают человеческие имена, незнакомые id
  остаются как есть.
- Учёт: `incoming = prompt + обе разновидности кэша`; дубли
  `messageId:requestId` игнорируются; инкрементальный дозапись считается
  ровно один раз; недописанная строка пропускается и учитывается, когда
  дописана; TTL-сплит кэша едет вместе с суммами.
- Скоупы: чужой проект не попадает в счёт, срез сессии не смешивается с
  соседними, итог проекта охватывает все сессии; нефильтрованный скан
  проходит по всем проектам.
- Субагенты: транскрипты `subagents/agent-*.jsonl` считаются, удалённые —
  **ретайрятся, а не исчезают** (суммы переезжают в retired-корзину);
  усечённый файл перечитывается с нуля с сохранением ретайра.
- Kimi: `usage.record` из `wire.jsonl` считается, срез сессии складывается
  из `main` + субагентов, сессия чужого `wd_*` не попадает в счёт, k3
  определяется как 1M-модель.
- Миграция состояния: суммы формата v1 переживают апгрейд, состояние
  неизвестной версии отбрасывается.

### 3.19 `test/pricing.test.ts` (240 строк) → `src/pricing.ts`

- Тарифные ступени по семействам: Fable и Mythos, текущий и старый Opus,
  Sonnet (включая legacy-id `claude-3-5-sonnet-…`), Haiku; для Kimi —
  ставки Moonshot и **другая модель кэша** (запись как обычный вход,
  чтение по плоской ставке, ссылка на `docs/KIMI-USAGE.md` §4).
- Разбивка `costPartsUsd`: вход по полной цене, выход по своей, запись кэша
  ×1.25 (5m) и ×2 (1h), чтение ×0.1, сумма статей сходится с итогом;
  модель без цены не оценивается вовсе (`null`), а не считается нулём;
  `costOfModels` сходится с суммой по статьям.
- Окно контекста: `[1m]`, 1M-only семейства, k3 → 1M, `k3-256k` и
  coding-модели → 262K, неизвестный id → нет датчика.

### 3.20 `test/modelSelection.test.ts` (106 строк) → `src/modelSelection.ts`

- Чтение `"model"` из settings-файла, устойчивость к BOM, битому JSON,
  нестроковому значению и отсутствию ключа (везде `null`).
- Порядок приоритета файлов: env → проектные `settings.local.json` /
  `settings.json` → пользовательский `~/.claude/settings.json`.

### 3.21 `test/repoLink.test.ts` (110 строк) → `src/repoLink.ts`

- Нормализация `repository`: `git+`, `.git`, scp-форма, шорткаты
  `github:user/repo` и `user/repo`; всё, что не свелось к http(s),
  отбрасывается (защита от `javascript:` в `href`).
- Ярлык по хосту: известные форджи получают своё имя (в т.ч. с `www.`),
  неизвестный — свой хостнейм.
- `license`: строка читается и триммится, отсутствие и legacy-объект дают
  пустоту; разделитель ` · ` печатается только вместе со следующим элементом.

## 4. Модули src/ без прямых тестов

| Модуль | Строк | Назначение | Почему не покрыт / насколько тестируем |
|---|---|---|---|
| `src/usageWatcher.ts` | 190 | Опрос `npx ccusage` (блоки/недели), агрегация в `UsageSnapshot`, таймаут 30 с | Привязан к `spawn` внешнего процесса и конфигу vscode; парсинг ответов (`fetchBlock`, `fetchWeekly`, `pickCurrentWeek`) можно было бы вынести в чистые функции |
| `src/locale.ts` | 52 | Определение языка UI: env / реестр Windows / `Intl`, кэш | Тонкий модуль, но `detectSystemLocale` завязана на `process.env`, платформу и `reg.exe`; `uiLocale` требует vscode |
| `src/extension.ts` | 773 | Точка входа: `activate`/`deactivate`, статус-бар, команды, emergency stop, реакции на смену конфигурации | Классический «клей» поверх vscode API; тестируем только интеграционно (`@vscode/test-electron`) — такой инфраструктуры в проекте нет |
| `src/webview/provider.ts` | 265 | `OfficeDashboardProvider`: два слота webview (сайдбар + редактор), replay кэшированного состояния, HTML-шаблон с nonce/CSP | Завязан на vscode Webview API; частично тестируемой могла бы быть подстановка плейсхолдеров в `getHtml` |

Строки в таблице — на момент актуализации; `extension.ts` вырос вдвое с
первой версии документа и сам стал кандидатом на вынос логики (см. §5.2).

Оговорки к покрытию:

- `src/hookInstaller.ts` покрыт **частично** (§3.13): `resolveTargets` и
  `checkHookStatus` — да; `installHooks`, `ensureHooksOnActivation`,
  `detectRuntime`, `configuredTargets` — нет (vscode API, PATH, запись файлов).
- Косвенно не покрыт и watcher-класс в уже тестируемом модуле:
  `SubscriptionUsageWatcher` (`src/subscriptionUsage.ts`) — тестируются только
  парсеры `parseCredentials`/`parseUsageResponse`, а не опрос/refresh токена.

## 5. Пробелы, которые стоит закрыть

Закрыто с момента первой версии документа: Python-двойник хук-скрипта покрыт
интеграционно (§3.14), `eventWatcher` покрыт (§3.12), vscode-независимая часть
`hookInstaller` покрыта (§3.13), дефект `stopFlag.test.ts` устранён
(`console.log` перенесён в конец файла), eslint теперь покрывает `test/` и
`hooks/` со scoped overrides.

Остаётся, по убыванию практической ценности:

1. **Парсинг ответов `ccusage` в `usageWatcher.ts`** (`fetchBlock`,
   `fetchWeekly`, `pickCurrentWeek` — включая расчёт понедельника недели и
   суммирование opus-затрат) стоит вынести в чистые функции и покрыть по
   образцу `subscriptionUsage.test.ts`.
2. **Нет интеграционных тестов VSCode** (`extension.ts`, `webview/provider.ts`,
   статус-бар, команды). Если появится потребность — `@vscode/test-electron`;
   до тех пор разумно держать границу «чистая логика / vscode-клей» и
   выносить логику из `extension.ts` в тестируемые модули (как уже сделано с
   `stopFlag`, `hookConfig*`, `hookInstaller`, `usagePace`).
3. **Локаль `locale.ts`:** `uiLocale`/`isRussianUi` можно покрыть через
   инъекцию конфигурации (сейчас читают `vscode.workspace` напрямую) — ветки
   `system` / `vscode` / явный код языка.
4. **Процессный остаток:** `npm test` монолитен — падение одного файла
   обрывает остальные (для диагностики иногда удобнее догонять оставшиеся).
   Кроме того, `emitAgentEventPy.test.ts` молча скипается без Python 3: на
   машине без интерпретатора паритет хуков фактически не проверяется —
   стоит следить, чтобы в CI-матрице Python присутствовал.

## 6. Итог

Тестовый набор компактный, но качественный: вся чистая доменная логика
(парсинг событий, состояние агентов, комнаты, хук-конфиги, квоты и их
pace-модель, флаг остановки и автостоп, файловый watcher, установка и
проводка хуков, счётчики токенов и цены)
покрыта плотно, включая регрессионные сценарии из реальной эксплуатации и обе
платформы CLI (Claude Code и Kimi Code). Обе реализации хук-скрипта — JS и
Python — проверяются интеграционно на паритет. Непокрытым остаётся только
слой, непосредственно завязанный на VSCode API (`extension`, webview-провайдер,
`locale`) и внешний процесс `ccusage` (`usageWatcher`), для которого нет
тестовой инфраструктуры — основной резерв развития.
