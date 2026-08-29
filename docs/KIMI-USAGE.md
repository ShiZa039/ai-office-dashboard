# Kimi Code: транскрипты, модели, цены

> Исследование 2026-08-29 по ROADMAP «Идеи на потом» → «Цены Kimi-моделей»
> (промпты №1/№2 из `KIMI-TASK-PROMPT.md`). Каждый факт подтверждён файлом на
> диске или URL. Дисковые примеры — из сессий этого репозитория
> (`~/.kimi-code/sessions/wd_office-dashbord_f38b09dfea5b/`).

## 1. Где лежат транскрипты

Kimi Code хранит сессии под `~/.kimi-code/sessions/<workDirKey>/<sessionId>/`
(или `$KIMI_CODE_HOME/sessions/...`, если переменная задана):

- `workDirKey` = `wd_<slug>_<первые 12 hex sha256>`. Наблюдаемый slug —
  нижний регистр basename'а рабочего каталога, пробелы → дефисы
  (`Office dashbord` → `wd_office-dashbord_f38b09dfea5b`;
  `AVO_Detailing` → `wd_avo_detailing_dced4bfc9b24` — подчёркивание живёт).
  Точный алгоритм не задокументирован, поэтому это только предфильтр;
  авторитетный источник cwd — `state.json` сессии.
- `state.json` — метаданные сессии: `id`, `cwd`, `agents` (см. §3), `title`,
  `lastPrompt`. **Секрет-гигиена:** `title`/`lastPrompt` — текст промптов,
  читаем только `cwd` и структуру `agents`, ничего не персистим.
- `session_index.jsonl` в корне — глобальный индекс
  (`{sessionId, sessionDir, workDir}` на строку).

Источники:
[Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
(подтверждает layout и формат workDirKey),
диск: `~/.kimi-code/sessions/wd_office-dashbord_f38b09dfea5b/session_2279a83e-…/`.

## 2. Формат транскрипта (wire.jsonl)

Транскрипт агента — `<sessionDir>/agents/<agentId>/wire.jsonl`
(`main` — основная цепочка, `agent-0`, `agent-1`, … — субагенты).
Формат — JSONL событий wire-протокола (`protocol_version: "1.5"`).

Ключевые типы записей (пример — свежая сессия этого репозитория):

- `usage.record` — расход одного LLM-запроса (usageScope всегда `"turn"`):
  ```json
  {"type":"usage.record","agentId":"main","model":"kimi-code/k3",
   "usage":{"inputOther":4090,"output":380,"inputCacheRead":19456,
   "inputCacheCreation":0},"usageScope":"turn","time":1788005058301}
  ```
  - Маппинг на наши счётчики: `inputOther`→input, `output`→output,
    `inputCacheRead`→cacheRead, `inputCacheCreation`→cacheCreate.
  - В 1205 записях этого проекта `inputCacheCreation` всегда 0 — неявный кэш
    Moonshot не выставляет отдельной цены записи (см. §4).
  - **Идентификаторов сообщения/запроса нет** — дедуп по `messageId:requestId`,
    как у Claude, не нужен и невозможен; wire.jsonl append-only, считаем
    каждую строку один раз (инкрементально по byte offset).
  - `time` — миллисекунды epoch (не ISO-строка, как у Claude).
  - `sessionId`/`cwd` в записи нет — берутся из пути (`<sessionId>` = имя
    каталога) и `state.json` рядом. Хук-ивенты несут тот же `session_id`
    (проверено по `~/.claude/agent-events.jsonl`), так что снапшот сессии
    сходится с ростером.
  - В старых записях `agentId` может отсутствовать (1168 записей без него
    против 32 с ним) — имя агента берём из каталога, не из записи.
- `token_counting.measured` — измеренный размер контекста после запроса:
  `{"type":"token_counting.measured","agentId":"main","length":2,"tokens":23926,…}`.
  Наблюдение: `tokens` = input + cacheRead + output последнего запроса.
- `llm.request` — метаданные запроса: `model:"k3"`, `modelAlias:"kimi-code/k3"`,
  `maxTokens:1048576` (эмпирическое подтверждение 1M-окна k3).
- `profile.bind` — привязка профиля агента: `agentId`, `profileName`
  (`"agent"` для main, `"explore"` для субагента), `modelAlias`.

Источники: диск (35 wire.jsonl этого проекта),
[Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html).

## 3. Субагенты

- Субагент пишет в свой каталог `<sessionDir>/agents/agent-<N>/wire.jsonl` —
  аналог `<session>/subagents/agent-*.jsonl` у Claude. Расход субагента
  **не дублируется** в `main/wire.jsonl` (в проверенной сессии у main 14
  usage.record, у agent-0 — 13, цепочки независимы), дедуп не нужен.
- Атрибуция: `state.json` сессии содержит `agents.<id>.type` (`"main"`/`"sub"`)
  и `parentAgentId`; тип агента для UI — `profileName` из `profile.bind`
  первой строкой файла (`"explore"`, `"agent"`, …), аналог `attributionAgent`.
- Удаление сессии уносит весь `<sessionDir>` целиком — ретайр по каталогу
  проекта работает как у Claude.

## 4. Модели и цены (справочные, API-эквивалент)

Подписка Kimi Code — флэт-рейт, поэтому $-цифры на панели означают «сколько
бы это стоило по прайсу API», как и для Claude.

Идентификаторы на эндпоинте Kimi Code (`api.kimi.com/coding/v1`):

| id в транскрипте | модель | input $/MTok | cache read | output | окно |
|---|---|---|---|---|---|
| `kimi-code/k3` | Kimi K3 | 3.00 | 0.30 | 15.00 | 1 048 576 |
| `kimi-code/k3-256k` | Kimi K3 (256K) | 3.00 | 0.30 | 15.00 | 262 144 |
| `kimi-code/kimi-for-coding` | Kimi K2.7 Code | 0.95 | 0.19 | 4.00 | 262 144 |
| `kimi-code/kimi-for-coding-highspeed` | K2.7 Code HighSpeed | 1.90 | н/д | 8.00 | 262 144 |

- Соответствие алиасов моделям —
  [Kimi Code Overview, таблица Model IDs](https://www.kimi.com/code/docs/en/)
  (`k3` = Kimi K3, 1M-окно от Allegretto; `kimi-for-coding` = Kimi K2.7 Code;
  `-highspeed` в 5–6× быстрее). Окна:
  [Model quickstart](https://platform.moonshot.ai/docs/pricing/kimi-k3)
  (K3 — 1M, K2.7 Code — 256K); 1M для k3 подтверждено и `maxTokens:1048576`
  в `llm.request`.
- Цены K3 ($3 / $0.30 / $15, плоские по всему окну) —
  [emergent.sh](https://emergent.sh/learn/kimi-k3-pricing),
  [spheron.network](https://www.spheron.network/blog/kimi-api-pricing-vs-self-hosted-llms-cost-privacy-2026/);
  K2.7 Code ($0.95 / $ 0.19 / $4, 262 144) —
  [explainx.ai](https://explainx.ai/blog/kimi-k2-7-code-open-source-coding-model-2026);
  HighSpeed ($1.90 / $8.00) —
  [cloudprice.net](https://cloudprice.net/models/moonshot-kimi-k2-code-highspeed).
  Официальная страница цен — [platform.moonshot.ai/docs/pricing/chat](https://platform.moonshot.ai/docs/pricing/chat)
  (числа отдаются скриптом, не извлекаются; цифры выше — агрегаторы на
  2026-08, перепроверять при расхождениях).
- **Запись в кэш не тарифицируется отдельно**: в 1205 записях
  `inputCacheCreation` всегда 0; у Anthropic-коэффициентов (1.25×/2×) аналога
  у Moonshot нет. Кодируем write = input (1×), чтение — по таблице выше.
  Для highspeed цена cache-read не опубликована — наследуем 0.1× input.

## 5. Что из этого реализовано в коде

- `src/pricing.ts` — цены и окна по таблице §4 (`priceForModel`,
  `contextWindowTokens`), подписи моделей в `modelLabel`.
- `src/tokenUsage.ts` — `TokenScanner` читает оба корня:
  `~/.claude/projects` (Claude) и `~/.kimi-code/sessions` (Kimi, формат §2),
  с тем же инкрементальным чтением по offset'ам и ретайром пруннутых сессий.
- Сплит по субагентам Kimi (`byAgent` из `profile.bind`) — промпт №2.

Известное ограничение: хуки не вызываются в `kimi --print` (ROADMAP v 0.15.0) —
неинтерактивные сессии видны только по транскриптам.
