# Протоколы провайдеров квот — конспект донора ClaudeBar

Конспект протоколов и боевого опыта проекта **ClaudeBar**
(https://github.com/tddworks/ClaudeBar) — macOS-монитора квот AI-провайдеров.
Идеи и протоколы адаптированы для AI Office; код не копировался. Зафиксировано
здесь, потому что локальная копия донора не входит в репозиторий.

> Источники в доноре указаны по состоянию на 2026-08. Эндпоинты третьих
> сторон могут меняться — сверяться с актуальным поведением CLI
> (`gotcha-llm-stale-configs`).

## 1. Claude (Pro/Max) — OAuth API

Реализовано в `src/subscriptionUsage.ts`.

- `GET https://api.anthropic.com/api/oauth/usage`
- Заголовки: `Authorization: Bearer <accessToken>`,
  `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<ver>`
  (чужой UA попадает в строгий rate-бакет).
- Креды: `~/.claude/.credentials.json` → ключ `claudeAiOauth`
  (accessToken/refreshToken/expiresAt/subscriptionType); macOS — keychain
  service `Claude Code-credentials`; env `CLAUDE_CODE_OAUTH_TOKEN` —
  setup-token с урезанным scope (без квот).
- Ответ: предпочтителен массив `limits[]` (`kind`, `percent`, `resets_at`,
  у `weekly_scoped` модель в `scope.model.display_name` — так появляются
  лимиты новых моделей без правок кода); фолбэк — плоские поля
  `five_hour` / `seven_day` / `seven_day_sonnet` / `seven_day_opus`
  (`utilization` 0–100 + `resets_at`). Дополнительно `extra_usage`/`spend`
  (деньги: `used_credits`/`monthly_limit` или `amount_minor`+`exponent`) —
  не используем.

### Боевой опыт донора (ClaudeBar: ClaudeAPIUsageProbe.swift)

- Эндпоинт **агрессивно троттлит** (наблюдали `Retry-After` на час;
  anthropics/claude-code#30930). Обязательны: honouring `Retry-After`,
  экспоненциальный фолбэк, кэш снапшота ~15 мин, спокойный поллинг
  (рекомендация: `aiOffice.usage.pollSeconds` ≥ 300 для Claude).
- `Retry-After: 0` — наблюдавшийся баг сервера, значение игнорировать.
- У нас рефреша токена нет: истёкший токен рефрешит любой запущенный
  Claude Code. У донора рефреш самостоятельный (см. DEFERRED).

## 2. Kimi — два известных эндпоинта

Реализовано в `src/kimiUsage.ts` (вариант A).

- **A. Наш (CLI /usage):** `GET https://api.kimi.com/coding/v1/usages`,
  Bearer из `~/.kimi-code/credentials/*.json` (токены живут ~15 мин,
  рефрешит CLI). Ответ: `limits[]` — rate-окна (5-часовое =
  `window.timeUnit=="TIME_UNIT_MINUTE" && window.duration==300`), `usage` —
  недельная квота; **числа приходят строками**. План —
  `user.membership.level` (`LEVEL_INTERMEDIATE` → `intermediate`).
- **B. Донорский (веб):** `POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages`,
  тело `{"scope":["FEATURE_CODING"]}`, заголовки `Authorization: Bearer`,
  `Cookie: kimi-auth=<token>`, `connect-protocol-version: 1`,
  `x-msh-platform: web`. Токен — env `KIMI_AUTH_TOKEN` либо браузерная
  кука (macOS-only путь, не переносим). Тир по размеру недельного лимита:
  1024=Andante, 2048=Moderato, 7168=Allegretto. Справочно; переход на него
  имеет смысл только если вариант A перестанет работать.

## 3. Pace-модель (ClaudeBar: UsageQuota.swift, UsagePace.swift, QuotaStatus.swift)

Реализовано в `src/usagePace.ts`.

- `percentTimeElapsed = (windowDuration − timeUntilReset) / windowDuration`
  — доля окна, которая уже прошла (в процентах).
- `burnRate = percentUsed / percentTimeElapsed` — 1.0 = расход ровно по
  графику окна.
- Темп: |used − elapsed| ≤ 5 п.п. → по графику; used > elapsed → «горячо»;
  иначе «с запасом».
- Статус (pace-aware): абсолютные предохранители всегда — 100% → depleted,
  осталось <20% → critical; warning если burnRate > 1.5 **и** осталось
  <50% (раннее предупреждение, пока абсолютные пороги не сработали).
- UI-приём: pace tick — маркер на прогресс-баре, где должна быть полоска
  при равномерном расходе окна.

## 4. Прочий боевой опыт донора

- **Дедуп токенов по `(message.id, requestId)`, last-wins** — Claude Code
  дублирует `message.usage` в JSONL транскриптах при стриминге/параллельных
  тулколах; без дедупа суммы раздуты в разы (их issue #207). Актуально,
  только если появится подсчёт токенов из транскриптов.
- **Фоновые пробы сами триггерят хуки** — их фоновый `claude /usage`
  порождал сессионные события; фильтруют по cwd пробы. У нас фонового
  опроса CLI нет; если появится — фильтровать так же
  (`gotcha-probe-self-trigger`).
- **Энергосбережение поллинга**: пол 60с, дефолт 10 мин, фоновые тики
  дешевле интерактивных, пауза при спящем дисплее. Частично перенесено
  (backoff), остальное — по потребности.
- **Мультимодельные квоты как открытый набор**: kind'ы не перечислимы
  раз и навсегда — новые модели приходят через generic `limits[]`; UI
  обязан рендерить неизвестные kind'ы, не зная их имён (у нас так и есть:
  бары строятся динамически).

## DEFERRED (условия активации)

| Что | Условие активации |
|---|---|
| Самостоятельный рефреш Claude-токена (`POST platform.claude.com/v1/oauth/token`, официальный client_id Claude Code `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, scope `user:profile user:inference user:sessions:claude_code`, запись рефрешнутого токена обратно в credentials) | Пользователи массово видят протухшие квоты между сессиями CLI. Риск: пишем в чужие credentials |
| Дедуп `(message.id, requestId)` + таблица цен моделей (USD/1M, prefix-matching, фолбэк на Sonnet-цену) | Появится фича подсчёта токенов/стоимости из транскриптов (альтернатива ccusage) |
| Пробы других провайдеров (Codex: `~/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage`; Gemini: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`; Copilot: `api.github.com/copilot_internal/user` + PAT) | В расширении появилась поддержка сессий этого CLI (как было с Kimi). Непроверенный парсер без аккаунта — пассив |
| Угадывание тира Kimi по размеру лимита | Вариант B эндпоинта станет основным |

## OUT (не переносим)

- **Curl-хуки через localhost HTTP-сервер** (донор шлёт события
  `curl -X POST` в свой NWListener вместо файла): ломает паритет py/js и
  офлайн-семантику `stop_gate` — файловый флаг читается без запущенного
  VS Code, HTTP-сервер требует живого приложения. Наш файловый транспорт
  строго надёжнее.
- **Браузерные куки / SweetCookieKit** — macOS-специфика.
- **SwiftTerm-терминал для `claude /usage`** — в VS Code проще API-проб.
