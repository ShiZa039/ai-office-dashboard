# Roadmap — Claude Office Dashboard

История релизов и план развития. Текущая версия — `v0.13.0`.

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

---

## В планах

### Полировка перед публикацией

- [ ] **Лицензия и LICENSE-файл** — выбрать MIT / Apache 2.0, добавить файл, обновить `package.json`.
- [ ] **README badges** — VS Code Marketplace, install count, version, license.
- [ ] **Скриншоты/GIF** в README — карта офиса в работе, timeline, usage panel.
- [ ] **Иконка расширения** для Marketplace (128×128 PNG, не SVG).
- [ ] **CHANGELOG.md** — извлечь из git log, поддерживать вручную.

### Marketplace

- [ ] Регистрация `publisher` на marketplace.visualstudio.com.
- [ ] `vsce publish` pipeline — GitHub Action на тег `v*`.
- [ ] Open VSX Registry — параллельная публикация для VSCodium / Cursor / Theia.
- [ ] Описание категорий, теги (`claude`, `agents`, `monitoring`).

### v1.0 — стабильность

- [ ] Документация настроек на английском (для Marketplace).
- [ ] CI: GitHub Actions запускает `npm test` на push/PR.
- [ ] Smoke-тест: vsce package + установка в headless VSCode.
- [ ] Покрытие тестами `eventWatcher.ts` (сейчас не покрыт — fs.watch сложно мокать).

### Идеи на потом

- [ ] **Drill-down по агенту** — клик на фигурку → панель с историей этого агента + текущей задачей.
- [ ] **Иерархия агентов** — кто кого заспавнил (оркестратор + сабагенты), если хуки дадут parent id.
- [ ] **Replay дня** — ползунок перемотки офиса по JSONL-логу.
- [ ] **Метрики агентов** — среднее время работы, success/error rate, топ занятых комнат.
- [ ] **Webview-панель «debug»** — сырые JSONL-события с подсветкой синтаксиса.
- [ ] **Экспорт сессии** в Markdown/HTML — отчёт о работе агентов за период.
- [x] **Поддержка кастомных комнат** — сделано в v0.11.0 через динамические комнаты: любой id комнаты в `.claude/office-rooms.json` / `agentRooms` создаёт свою комнату.
- [ ] **Dark/light theme tweaks** — отдельные палитры для room accent colors.
- [ ] **WebSocket-режим** — если хуки эволюционируют до push-нотификаций, заменить `fs.watch` на сокет.

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

См. [INSTALL.md → Обновление расширения](INSTALL.md#обновление-расширения).
