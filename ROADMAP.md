# Roadmap — AI Office

История релизов и план развития. Текущая версия — `v0.15.0`.

> This file is maintained in Russian only (internal dev history). User-facing docs are bilingual: [README.md](README.md) / [README.ru.md](README.ru.md), [INSTALL.md](INSTALL.md) / [INSTALL.ru.md](INSTALL.ru.md).

---

## Сделано

### v0.1.0 — MVP (commit `caef998`)
- VSCode extension scaffold (TypeScript)
- Хук-скрипт `emit-agent-event.py` (Python, JSONL)
- `eventWatcher.ts` — `fs.watch` + polling 1 сек
- `eventParser.ts` — парсинг JSONL
- `agentState.ts` — Map<agentName, AgentState> + recentEvents (200 макс)
- `provider.ts` — `WebviewViewProvider` с CSP nonce
- `office.html` — карта 9 комнат через CSS Grid
- `office.js` — postMessage, обновление DOM, базовый timeline
- Тестирование: backend-lead/frontend-lead/qa-lead параллельно

### Полировка (commit `9176565`, `609404a`)
- 30+ SVG-аватарок агентов + маппинг
- Анимации (`agentAppear`, `pulse`, `shake`, `blink`, `tooltipIn`, `logSlide`)
- Тултипы (имя, задача, время)
- Счётчик: working / done / errors / total / completed
- Auto-scroll лог событий (50 записей)
- Timeline canvas (5 мин окно)
- Room accent colors + `room--active` подсветка
- Status dot

### v0.2.0 (commit `74f3d2a`)
- Откат поддержки multi-session — слишком шумно при пересечениях
- TTL stale-агентов (10 мин) + periodic sweep 30 сек

### Hotfix (commit `2c047ee`)
- UTF-8 stdin в `emit-agent-event.py` — кириллица в `task` ломалась на Windows из-за cp1251

### v0.3.0 (commit `b5153f1`)
- Timeline window picker (5 мин / 15 / 30 / 1 ч / 6 ч) + localStorage
- Plan usage panel — 3 полосы (5h block / weekly / weekly Opus) через `ccusage CLI`
- Settings: `usage.enabled`, `usage.pollSeconds`, `usage.limitBlockUsd`, `usage.limitWeeklyUsd`, `usage.limitWeeklyOpusUsd`
- Цветные пороги (warn 70%, crit 90%), Opus полоса фиолетовая

### v0.4.0 (commit `7760bf4`)
- Activity Bar auto-start через `WebviewViewProvider` + `onStartupFinished`
- SVG-иконка домика 24×24 с `currentColor` (адаптация к теме)
- View id `claudeOffice.dashboard` в кастомном контейнере `claudeOffice`
- VSCode сам помнит состояние панели между перезапусками

### v0.5.0 (commit `360c6a3`)
- Команда `claudeOffice.openInEditor` — открыть дашборд параллельно как editor tab
- Кнопка `$(link-external)` в заголовке view
- `OfficeDashboardProvider` держит `viewSlot` + `panelSlot`, broadcast в оба
- `lastState`/`lastUsage` кэшируются и шлются при `webview_ready`

### v0.6.0 (commit `321ba4b`)
- Portable режим — хуки на user-level (`~/.claude/hooks/` + `~/.claude/settings.json`)
- Убрано из проектного `settings.local.json` — теперь любой проект автоматом шлёт события
- Setting `claudeOffice.agentRooms` — JSON-словарь, мерджится с `DEFAULT_AGENT_ROOMS`
- Эвристика `inferRoomByName` по токенам (director/ai/llm/security/auth/docker/ci/qa/test/react/ui/webhook/telegram/backend/django/…)
- `AgentStateStore.setRoomResolver()` + `onDidChangeConfiguration` — live-обновление маппинга

### v0.7.0 (commit `b172707`)
- Multi-window isolation: хук пишет `cwd` в событие
- `AgentStateStore.setCwdFilter()` scopes store к workspace folder
- Нормализация path (backslash→slash, lowercase, strip trailing `/`), `startsWith` для подпапок
- Strict mode: события без `cwd` отбрасываются если фильтр активен
- Setting `claudeOffice.scope` = `workspace` (default) / `global` (legacy)
- Тесты: `test/agentState.test.ts` с 7 сценариями
- Документация: [INSTALL.md](INSTALL.md) с troubleshooting

### v0.9.0 (commit `18ee849`) — universal zero-config rewrite
- Авто-установка/ремонт хуков из расширения (`hookInstaller` + чистая логика в `hookConfig`),
  runtime-детект python→python3→py→node, merge в `~/.claude/settings.json` с бэкапом
- Roster discovery: агенты из `.claude/agents/**/*.md` сидируются idle при активации
- Реальные лимиты подписки через `api.anthropic.com/api/oauth/usage` (логин Claude Code),
  ccusage-бары переведены в opt-in (`usage.costSource`)
- Node-вариант хука (`emit-agent-event.js`) для машин без Python
- Убраны все проектные дефолты — расширение ставится в любой проект без настройки

### v0.10.0 — «Claude ждёт тебя» + статус-бар + прогноз лимитов
- Хуки `Notification`/`UserPromptSubmit` → события `agent_waiting`/`user_prompt`
- Баннер ✋ «Claude is waiting for you» + жёлтая статус-точка + запись в лог
- Тихий апгрейд хуков при обновлении расширения (`officeHookCoverage`: partial → merge без промпта)
- Статус-бар айтем: ✋ waiting (warning bg) / ⚠ errors / N working / idle; настройка `statusBar.enabled`
- Прогноз исчерпания лимитов: история utilization в webview, «hits 100% in ~2h at the current pace»
  (только если лимит кончится раньше своего резета)
- Фигурка главной модели «Claude (main)» в Directors: работает между `user_prompt` и `Stop`,
  ×N при нескольких сессиях в проекте, тултип с моделью — видно, когда оркестратор пашет сам
  вместо делегирования (ходы главной модели не считаются в completed)

### v0.10.1 — главная модель в плашке вместо фигурки
- Верхняя плашка стала индикатором главной модели с тремя состояниями:
  ✋ жёлтая «waiting for you» > ⚡ синяя «working · Fable 5 · 3m · ×N» (пульс, длительность хода)
  > ✓ зелёная вспышка «finished the turn» на 5 сек > скрыта в покое
- Фигурка Claude (main) убрана из комнат и счётчиков working/total; спан на таймлайне
  и запись в логе остались
- Статус-бар: главная модель отдельным сигналом — `$(pulse) Claude`, когда она работает
  без делегирования агентам
- Фикс: параллельные агенты одного типа больше не схлопываются — счётчик инстансов
  (`activeCount`, бейдж ×N), состояние working держится, пока не завершатся все
- Фикс: `EventWatcher` больше не теряет недописанную строку при конкурентной записи хуков
  (буфер хвоста до `\n`)
- Фикс: конец хода главного агента (`Stop` → session_stop) больше не сбрасывает работающих
  фоновых сабагентов — он лишь прибирает done/error-бейджи; осиротевшие working-агенты
  убираются периодическим sweep (таймаут поднят 10 → 20 мин, чтобы не резать долгих агентов)
- Локализация UI (en/ru): `src/locale.ts` определяет язык ОС (реестр/env/Intl),
  настройка `claudeOffice.language` (system / vscode / en / ru); LICENSE (MIT)

### v0.11.0 — динамические комнаты
- Офис строится из фактического состава агентов проекта: комната рендерится, только пока
  в ней есть хоть один агент (ростер или события); статичная разметка комнат удалена
- Кастомные id комнат из `.claude/office-rooms.json` теперь создают собственные комнаты
  (раньше такие агенты молча не отображались) — лейбл из id, цвет по хэшу, generic-иконка
- Кураторские комнаты (Directors, Backend, … Lobby) сохраняют свои иконки/цвета и порядок;
  кастомные — после них по алфавиту, Lobby всегда замыкает во всю ширину
- Лейблы комнат локализованы (en/ru); пустой офис показывает заглушку
  «комнаты появятся, когда Claude Code начнёт здесь работать»
- Эвристика `inferRoomByName` переработана: стем-матчинг (`permissions`→`permission`,
  `deployment`→`deploy`, `secrets`→`secret`), склеенные фразы (`rate-limit`→`ratelimit`,
  `tech-debt`), словарь расширен (~60 новых токенов: postgres/schema/cache/api/module/
  report/async/logging/injection/gdpr/152fz/…) — типовые агенты больше не сваливаются
  в Лобби; из IoT убраны общие токены (device/provisioning/android/sticker), чтобы
  комната IoT не появлялась в не-IoT проектах

### v0.12.0 — экстренная остановка агентов
- Кнопка 🛑 на дашборде (+ команда `claudeOffice.emergencyStop`, кнопка в заголовке view):
  пишет флаг `~/.claude/office-stop.json` со списком cwd окна (scope=global → стоп для всех)
- Новый хук `PreToolUse` → `emit-agent-event stop_gate`: пока флаг активен, каждый вызов
  инструмента отклоняется (`permissionDecision: deny`) — главный агент и все сабагенты
  сворачиваются на первом же следующем действии; сессия и контекст сохраняются
- Быстрый путь: без флага гейт выходит мгновенно (одна проверка существования файла,
  stdin не читается) — оверхед на tool call ограничен запуском интерпретатора
- Возобновление: повторное нажатие кнопки/Resume в красном баннере, либо автоматически —
  новый промпт пользователя (`user_prompt` в hook-скрипте снимает флаг для своего cwd)
- Статус-бар: красный «🛑 Claude» с приоритетом над waiting; лог дашборда пишет
  включение/снятие остановки; синхронизация между окнами через `fs.watchFile` флага
- Честное ограничение: уже запущенная длинная команда (например, Bash-сборка)
  не прерывается — блокируются только новые вызовы инструментов
- `src/stopFlag.ts` (чистая логика + fs), тесты: `stopFlag.test.ts`, сценарии stop_gate
  в `emitAgentEvent.test.ts`, регистрация PreToolUse в `hookConfig.test.ts`

### v0.12.1–0.12.2 — фикс вечно видимых баннеров + версия в UI
- Фикс: атрибут `hidden` перебивался CSS-правилами `display: flex` — баннеры «экстренная
  остановка» и «Claude ждёт вас» рендерились всегда, независимо от состояния; глобальное
  `[hidden] { display: none !important }` теперь выигрывает у любых display-правил
- Пересинхронизация webview при возврате видимости (replay кэшированного состояния на
  `onDidChangeVisibility` / `onDidChangeViewState` + повторный `webview_ready` со стороны
  страницы) — retained-but-hidden webview больше не может залипнуть с устаревшим стейтом
- Версия расширения в правом нижнем углу дашборда (инжектится из `package.json`) —
  сразу видно, какая сборка реально запущена

### v0.13.0 — проектное снятие остановки + подтверждение глобального стопа
- Снятие остановки стало проектным: кнопка «Продолжить» вычитает из флага только папки
  текущего окна (`deactivateStopFlag`), стопы других окон переживают; файл удаляется,
  только когда список cwd опустел
- Авто-снятие новым промптом — так же: промпт в проекте A убирает из флага только A,
  остановка проекта B продолжает действовать (hooks js/py синхронно)
- Глобальный флаг (пустой `cwds`) по-прежнему снимается целиком любым способом
- Перед активацией глобального стопа (нет открытой папки или `scope=global`) — модальное
  подтверждение: «заблокируются все сессии Claude Code на этой машине»
- Тесты: `deactivateStopFlag` (частичное снятие, вложенные пути, глобальные случаи),
  интеграционные сценарии частичного release в `emitAgentEvent.test.ts`

### v0.13.1 — заметная кнопка экстренной остановки
- Кнопка 🛑 переехала из шапки (маленькая серая иконка) в полноширинную «аварийную»
  кнопку под шапкой: красная рамка, подпись «Экстренная остановка» + пояснение
  «мгновенно заблокировать все действия агентов» (en/ru)
- Пока стоп активен, кнопка скрыта — её место занимает красный баннер с «Продолжить»,
  так что управление остановкой всегда в одном и том же месте дашборда

### v0.13.2 — стоп не снимается системными уведомлениями
- Фикс: task-notification о завершении фонового субагента проходит через
  `UserPromptSubmit` как обычный промпт и снимал экстренную остановку — стоп
  «сбрасывался сам» без действия пользователя (найдено при живом тесте кнопки)
- В обоих хуках (js/py) добавлен фильтр `isAutomatedPrompt`: промпты с маркерами
  `[SYSTEM NOTIFICATION`, `<system-reminder>`, `<task-notification>` больше
  не снимают флаг; событие `user_prompt` при этом эмитится как раньше
  (waiting-статус и активность на дашборде не ломаются)
- Промпт без поля `prompt` в payload (старые Claude Code) сохраняет прежнее
  поведение — снимает стоп; человеческий промпт с маркером в середине текста
  автоматикой не считается
- Тесты: сценарии автоматических промптов в `emitAgentEvent.test.ts`

### v0.14.0 — ребрендинг в AI Office + поддержка Kimi Code CLI (dual CLI)
- Ребрендинг: расширение переименовано в **AI Office** (id `ai-office-dashboard`),
  репозиторий — `github.com/ShiZa039/ai-office-dashboard`; команды и настройки
  `claudeOffice.*` → `aiOffice.*` (старые ключи оставлены deprecated, значения
  мигрируют автоматически при первом запуске; пользовательские кейбиндинги на
  `claudeOffice.*` обновляются вручную); команда «Install Claude Code Hooks» →
  «AI Office: Install Agent Hooks»; главный псевдо-агент «Claude (main)» → «Main agent»;
  суффикс бэкапа хук-инсталлера `.claude-office.bak` → `.ai-office.bak`
- Фикс залипания баннера «агент ждёт вас»: stop_gate (PreToolUse) в разрешающей
  ветке дописывает лёгкое событие `tool_activity` — первый вызов инструмента
  после ответа на permission-промпт (например, апрув выхода из планмода)
  снимает баннер, не дожидаясь конца хода
- Двойная поддержка агентских CLI: Claude Code и Kimi Code одновременно
- Установка хуков в оба CLI: Claude — как раньше (`~/.claude/hooks/` + merge в
  `~/.claude/settings.json`, бэкап `settings.json.ai-office.bak`); Kimi — скрипты в
  `~/.kimi-code/hooks/`, блоки `[[hooks]]` в `~/.kimi-code/config.toml` с комментарием-маяком
  `# office-dashboard-hook: <Event>`, бэкап `config.toml.office-dashboard.bak`
- Настройка `aiOffice.hooks.targets`: `auto` (по умолчанию — все CLI, чья домашняя
  директория существует: `~/.claude` / `~/.kimi-code`; если нет ни одной — оба) /
  `claude` / `kimi` / `both`; команда Install Hooks ставит во все выбранные цели
- Маппинг событий Kimi: `SessionStart`→session_start, `SubagentStart`→agent_start
  (в `task` — текст делегированного prompt), `SubagentStop`→agent_stop (task = превью
  ответа), `Stop`→session_stop, `PermissionRequest`→agent_waiting (аналог клодовского
  Notification), `UserPromptSubmit`→user_prompt, `PreToolUse`→stop_gate
- Экстренная остановка пишет два флага: `~/.claude/office-stop.json` и
  `~/.kimi-code/office-stop.json` — кнопка останавливает оба CLI разом; человеческий
  промпт в любом из CLI снимает остановку в обоих (хук-скрипты зеркалят release на оба
  файла), автоматические промпты (cron-fire, system-reminder, task-notification) — нет
- Хук-скрипт принимает второй аргумент CLI: `emit-agent-event.js <event_type> [claude|kimi]`
- Ростер: сканируются `.claude/agents/`, `.kimi-code/agents/`, `.agents/agents/` каждой
  папки workspace; room-map читается из `.claude/office-rooms.json` и
  `.kimi-code/office-rooms.json` (при конфликте имён выигрывает kimi-файл)
- Модель сессии для Kimi — fallback на `default_model` из `~/.kimi-code/config.toml`;
  файл событий общий (`~/.claude/agent-events.jsonl`, путь не менялся ради совместимости)
- Usage-панели (Plan usage / ccusage) остаются Claude-only — у Kimi нет эквивалентного
  локального API лимитов

### v0.15.0 — drill-down по агенту + волна по итогам код-обзора (review wave)
- Drill-down: клик на фигурку агента открывает drawer с его историей прогонов
  (пары start/stop, FIFO при параллельных инстансах) и текущей задачей
  (`src/agentDetail.ts`, коммит `e3ce594`)
- Экстренная остановка: `STOP_REASON` теперь велит агенту завершить ход краткой
  handoff-заметкой (что сделано / что осталось / следующий шаг) — под стопом файлы
  писать нельзя, а финальное сообщение сохраняется в логе задачи (проверено живым
  боевым тестом: 4 агента без предупреждений остановились по тексту причины)
- Паритет хук-скриптов py/js: JS научился терпеть BOM в `office-stop.json`,
  Python получил верхний try/catch («хук никогда не должен ронять сессию CLI»)
- `eventWatcher.ts`: ротация журнала событий на старте (файл > 5 МБ → оставляется
  хвост 1 МБ с выравниванием по границе строки), детект пересоздания файла по
  dev/ino (сброс позиции чтения), инжектируемые опции (pollMs, rotate-капы)
- Webview: тултип фигурки пересобран на `textContent` (host-данные больше не идут
  через `innerHTML`), удалены осиротевшие стили селектора сессий (~60 строк),
  кэп 500 семплов в `usageHistory`, `render()` пропускает пересборку фигурок при
  неизменной JSON-подписи состояния (нет мерцания на каждое событие)
- Тип `agent_update` удалён из `WebviewMessage` (всегда шлётся `full_state`)
- Тесты: новый интеграционный `emitAgentEventPy.test.ts` (Python-хук прогоняется
  по тем же сценариям, что и JS — страховка от дрейфа реализаций; skip без
  Python 3), `eventWatcher.test.ts` (offset/leftover/UTF-8/truncate/recreate/
  ротация), `hookInstaller.test.ts` (resolveTargets, checkHookStatus);
  фикс `stopFlag.test.ts` (console.log переехал в конец файла)
- ESLint покрывает теперь `src`, `test` и `hooks` (scoped overrides)
- Документация код-обзора в репозитории: `ARCH-REVIEW.md`, `TEST-ANALYSIS.md`,
  `UI-REVIEW.md`, `HOOKS-DESIGN.md` (на русском, для разработчиков)
- Известное ограничение задокументировано: Kimi Code не вызывает хуки в
  неинтерактивном режиме (`kimi --print`) — стоп и события на такие запуски не
  действуют

### Unreleased — pace-модель квот + перенос опыта ClaudeBar
_(коммит-SHA проставляется при коммите — ритуал двухфазного закрытия)_

- Pace-модель квот (`src/usagePace.ts`, идея и пороги — ClaudeBar,
  github.com/tddworks/ClaudeBar): burn rate = used% / elapsed% окна; темп
  «горячо / по графику / с запасом» (±5 п.п.), раннее предупреждение
  (burnRate > 1.5 и осталось <50%), абсолютные предохранители (<20%, 100%)
- Вебвью: pace tick на каждом баре лимитов (где была бы полоска при
  равномерном расходе окна), лейбл темпа, pace-aware цвет бара (абсолютные
  пороги 70/90 — фолбэк)
- Алерты на деградацию квоты (ok→warning→critical→depleted, один раз на
  переход; настройка `aiOffice.usage.degradationAlerts`); квоты
  `5h 12% · 7d 34%` в tooltip статус-бара
- 429-backoff в `SubscriptionUsageWatcher`: honouring `Retry-After`
  (секунды и HTTP-date; `Retry-After: 0` — известный баг сервера,
  игнорируется), экспоненциальный фолбэк 60с→30макс
- `UsageLimitEntry` += `windowMinutes` (session=300, weekly=7d; у Kimi —
  из `window.duration` ответа API)
- `docs/USAGE-PROVIDERS.md` — протокольный конспект донора ClaudeBar с
  атрибуцией (OAuth-эндпоинты, pace-формулы, дедуп токенов, DEFERRED/OUT)
- Тесты: `usagePace.test.ts` (границы окна, статусы, переходы алертов),
  backoff-сценарий в `subscriptionUsage.test.ts` (молчание в окне
  Retry-After)
- Docs-drift: README обоих языков утверждали «usage — только Claude Code»,
  хотя Kimi-панель уже работала — исправлено

---

## В планах

### Полировка перед публикацией

- [x] **Лицензия и LICENSE-файл** — MIT, файл добавлен в v0.10.1 (2026-07-28).
- [ ] **README badges** — VS Code Marketplace, install count, version, license.
- [ ] **Скриншоты/GIF** в README — карта офиса в работе, timeline, usage panel.
- [ ] **Иконка расширения** для Marketplace (128×128 PNG, не SVG).
- [ ] **CHANGELOG.md** — извлечь из git log, поддерживать вручную.

### v1.0 — стабильность

- [x] Документация на английском (для Marketplace) — README.md / INSTALL.md переведены, русские версии в `*.ru.md` с переключателем языка (2026-07-20).
- [x] CI: GitHub Actions — lint + `npm test` (ubuntu/windows) + smoke-сборка `vsce package` с артефактом `.vsix` (2026-07-20).
- [x] Бандлинг esbuild: `vscode:prepublish` собирает один минифицированный `out/src/extension.js`, из `out/` в пакет идёт только он (2026-07-20).
- [x] Локализация package.json (`package.nls.json` / `package.nls.ru.json`): команды и описания настроек en/ru в UI VSCode (2026-07-20).
- [x] ESLint-конфиг (`.eslintrc.json`) — `npm run lint` раньше падал без конфигурации; сейчас проходит чисто (2026-07-20).
- [ ] Smoke-тест: установка `.vsix` в headless VSCode.
- [x] Покрытие тестами `eventWatcher.ts` — сделано в v0.15.0 (`test/eventWatcher.test.ts`: offset/leftover/UTF-8/truncate/recreate/ротация).

### Идеи на потом

- [x] **Drill-down по агенту** — сделано в v0.15.0: клик на фигурку → drawer с историей прогонов агента и текущей задачей (`src/agentDetail.ts`).
- [ ] **Иерархия агентов** — кто кого заспавнил (оркестратор + сабагенты), если хуки дадут parent id.
- [ ] **Replay дня** — ползунок перемотки офиса по JSONL-логу.
- [ ] **Метрики агентов** — среднее время работы, success/error rate, топ занятых комнат.
- [ ] **Webview-панель «debug»** — сырые JSONL-события с подсветкой синтаксиса.
- [ ] **Экспорт сессии** в Markdown/HTML — отчёт о работе агентов за период.
- [x] **Поддержка кастомных комнат** — сделано в v0.11.0 через динамические комнаты: любой id комнаты в `.claude/office-rooms.json` / `agentRooms` создаёт свою комнату.
- [x] **Переименование расширения в нейтральное** — сделано в v0.14.0: **AI Office** (`ai-office-dashboard`, настройки/команды `aiOffice.*`, старые ключи `claudeOffice.*` deprecated с автомиграцией значений).
- [ ] **Dark/light theme tweaks** — отдельные палитры для room accent colors.
- [ ] **WebSocket-режим** — если хуки эволюционируют до push-нотификаций, заменить `fs.watch` на сокет.

### Marketplace — отложено в самый конец

- [ ] Регистрация `publisher` на marketplace.visualstudio.com.
- [ ] `vsce publish` pipeline — GitHub Action на тег `v*`.
- [ ] Open VSX Registry — параллельная публикация для VSCodium / Cursor / Theia.
- [ ] Описание категорий, теги (`claude`, `agents`, `monitoring`).

### Откатано / отклонено

- ❌ Звуковые эффекты — раздражают (2026-04-17).
- ❌ Multi-session UI (вкладки, цвета по сессиям) — откачено в v0.2.0, single-session понятнее.

---

## Цикл релиза

1. Бамп `version` в `package.json`.
2. `npm test` + ручной smoke-тест в VSCode.
3. `npx @vscode/vsce package` → `.vsix` рядом с проектом.
4. `git commit -m "feat(vX.Y.Z): ..."` + `git tag vX.Y.Z`.
5. `git push origin master --tags`.
6. (после v0.9.x) GitHub Release + автоматический `vsce publish`.

См. [INSTALL.ru.md → Обновление расширения](INSTALL.ru.md#обновление-расширения).
