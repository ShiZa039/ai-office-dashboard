# Signe_server (вывески): интеграция в Claude Office Dashboard

> **Статус v0.8.0 (2026-06-03):** большая часть долга закрыта в расширении.
> - ✅ п. 2.1 — добавлена комната `iot` (KNOWN_ROOMS, office.html, icons.js, office.css, office.js).
> - ✅ п. 2.3 — `iac` перенесён из `security` в `devops`.
> - ✅ п. 2.4 — эвристика расширена под Signe-стек; IoT-токены (`mqtt/esp32/firmware/ota/telemetry/sensor/device/provisioning/sticker/android`) теперь ведут в `iot`.
> - ✅ п. 2.5 — INSTALL.md обновлён.
> - ⮕ п. 2.2 — вместо полноценных профилей сделан лёгкий вариант: проектный файл `.claude/office-rooms.json` (приоритет выше VSCode-настроек, мерджится для multi-root). Полноценные профили — по-прежнему открытый вопрос.
>
> **Следующий шаг на стороне Signe_server:** переустановить `claude-office-dashboard-0.8.0.vsix`, затем проредить `Signe_server/.vscode/settings.json` — большинство IoT-специалистов уедут в `iot` сами; остаток перенести в `Signe_server/.claude/office-rooms.json`.

Заметка для будущих сессий Claude Code. Описывает:
1. Текущее **временное** решение (workspace-маппинг агентов).
2. Что нужно довести до ума в самом расширении, чтобы поддержка проекта стала "родной", как у BAZA_CRM.

Проект: `D:\Code projects\Signe_server` (он же `Signe_server.code-workspace`).

---

## 1. Текущее временное решение (применено)

В `D:\Code projects\Signe_server\.vscode\settings.json` лежит `claudeOffice.agentRooms`, который мерджится поверх `DEFAULT_AGENT_ROOMS` из [src/types.ts](src/types.ts). Затрагивает только workspace Signe_server — на BAZA_CRM не влияет (per-window isolation через `claudeOffice.scope = workspace`, активна по умолчанию).

Покрывает всех агентов из `Signe_server/.claude/agents/{leads,specialists/**}`, которых нет в дефолтном маппинге и которые не ловятся keyword-эвристикой.

**Компромиссы временного решения:**
- Нет отдельной комнаты `iot` — захардкожен список `KNOWN_ROOMS` в [src/types.ts:30-40](src/types.ts#L30-L40), DOM и иконки в webview. IoT-агенты распределены по `integrations` (протоколы/устройства), `devops` (прошивки ESP32), `backend` (телеметрия, сенсоры).
- `release-lead` временно в `devops` (не в `directors`) — решили при настройке.
- `iac-specialist` руками пересажен из `security` в `devops`: в keyword-правиле [src/types.ts:107-109](src/types.ts#L107-L109) токен `iac` сидит в security-ветке, что похоже на ошибку копипасты.

---

## 2. Что стоит сделать в расширении (долг)

### 2.1. Добавить комнату `iot`

IoT — это отдельный домен (MQTT, прошивки, телеметрия, provisioning, андроид-технический клиент). Текущее распихивание по `integrations/devops/backend` — компромисс. Правильно завести отдельную комнату.

Задеть придётся:
- [src/types.ts:30-40](src/types.ts#L30-L40) — добавить `'iot'` в `KNOWN_ROOMS`.
- [src/types.ts:103-134](src/types.ts#L103-L134) — добавить keyword-правило для `iot`. Кандидаты в токены: `iot`, `mqtt`, `esp32`, `esptool`, `firmware`, `ota`, `telemetry`, `sensor`, `device`, `provisioning`.
- [media/office.html](media/office.html) — разметка новой комнаты с `data-room="iot"`.
- [media/icons.js](media/icons.js) — иконка/стиль комнаты. Сверяемся с существующими `ai-lab`, `integrations` как ближайшими по смыслу.
- Проверить стили в `media/*.css` (сетка офиса, позиционирование).

После этого workspace-настройки в Signe_server должны поредеть — большая часть IoT-специалистов уйдёт в `iot` автоматически по keyword-эвристике.

### 2.2. Профили проектов вместо одного `DEFAULT_AGENT_ROOMS`

Сейчас в [src/types.ts:43-100](src/types.ts#L43-L100) зашит маппинг "под BAZA.CRM profile" (так и подписано в комментарии). Для Signe_server и будущих проектов разумно ввести понятие профиля:

- Например, `claudeOffice.profile = "baza-crm" | "signe-server" | "auto"`.
- Либо набор профилей как `Record<profileName, Record<agent, room>>` в отдельном файле (`src/profiles/baza-crm.ts`, `src/profiles/signe-server.ts`).
- `auto` — детектим по наличию `.claude/agents/**/*` агентов, уникальных для профиля (например, `iot-lead` → signe-server).

Альтернатива попроще: вынести маппинг в JSON-файл рядом с проектом (`.claude/office-rooms.json`) и читать его как приоритет 0 (выше custom map из VS Code settings). Тогда профиль живёт в самом проекте, а не в расширении.

### 2.3. Починить keyword `iac`

[src/types.ts:107-109](src/types.ts#L107-L109) — `iac` сейчас тянет агентов в `security`. По смыслу (Infrastructure as Code) это `devops`. Проверить, не зависят ли от текущего поведения какие-то BAZA_CRM-агенты (беглый `grep -R iac` по `BAZA_CRM/.claude/agents`), затем переложить в `devops`-ветку.

### 2.4. Расширить keyword-эвристику под Signe-стек

Кандидаты на добавление (минимизируют будущий ручной маппинг):
- `frontend`: `geo`, `maps`, `camera`, `scanner`.
- `qa`: `vitest`, `reviewer`, `docs`, `annotations`, `type` (осторожно — `type` слишком общее, лучше `typing` или `annotations`).
- `security`: `audit`, `compliance`, `dependency`, `auditor`, `tls`, `pki`.
- `devops`: `iac`, `incident`, `release`, `mcp`, `esp32`, `firmware`, `ota`, `esptool`.
- `integrations`: `mqtt`, `device`, `provisioning`, `sync`, `android`, `sticker`.
- `backend` (или новая `iot`): `telemetry`, `sensor`, `analytics`, `realtime`, `websocket`, `redis`, `postgres`.

Сначала решить вопрос п. 2.1/2.2, потом чистить эвристику — иначе правила снова придётся переписывать.

### 2.5. Сверка с INSTALL.md

В [INSTALL.md:147](INSTALL.md#L147) перечислены "известные комнаты" — после добавления `iot` обновить этот список и пример кастомного маппинга.

---

## 3. Порядок работ, когда дойдут руки

1. Добавить комнату `iot` (п. 2.1) + расширить эвристику под IoT (подмножество п. 2.4).
2. Удалить из `Signe_server/.vscode/settings.json` всё, что стало попадать куда надо само. Остаток, если есть, оставить как локальную специфику.
3. Решить по профилям (п. 2.2): нужно ли вообще, или хватает keyword + workspace overrides.
4. Почистить `iac` (п. 2.3) и добавить оставшиеся keyword-правила (остаток п. 2.4).
5. Бампнуть версию расширения, пересобрать `.vsix`, обновить INSTALL.md (п. 2.5).

---

## 4. Полный список агентов Signe_server на момент написания

Для справки, чтобы при рефакторинге быстро сверить покрытие.

```
leads/
  backend-lead            (default → backend)
  frontend-lead           (default → frontend)
  iot-lead                (temp → integrations; target → iot)
  platform-director       (keyword "director" → directors)
  release-lead            (temp → devops)

specialists/backend/
  analytics-reporting-specialist     (temp → backend)
  auth-jwt-specialist                (keyword "auth" → security)
  fastapi-backend-specialist         (keyword → backend)
  notifications-specialist           (keyword → integrations)
  realtime-websocket-specialist      (temp → backend)
  redis-caching-specialist           (temp → backend)

specialists/frontend/
  accessibility-specialist           (keyword → frontend)
  geo-maps-specialist                (temp → frontend)
  i18n-specialist                    (keyword → frontend)
  react-frontend-specialist          (keyword → frontend)
  ux-designer                        (keyword "ux" → frontend)
  web-camera-scanner-specialist      (temp → frontend)

specialists/infra/
  mcp-docker-health                  (keyword "docker" → devops)
  migrations-specialist              (default → backend)
  nginx-specialist                   (default → devops)
  postgres-schema-specialist         (temp → backend)

specialists/iot/
  android-technician-app-specialist  (temp → integrations)
  contract-first-sync-specialist     (temp → integrations)
  device-provisioning-specialist     (temp → integrations)
  device-simulator-specialist        (temp → integrations)
  esp32-firmware-specialist          (temp → devops)
  esp32-ota-specialist               (temp → devops)
  esptool-automation-specialist      (temp → devops)
  label-sticker-specialist           (temp → integrations)
  mqtt-broker-specialist             (temp → integrations)
  mqtt-client-specialist             (temp → integrations)
  sensor-calibration-specialist      (temp → backend)
  service-center-tool-specialist     (temp → integrations)
  telemetry-anomaly-specialist       (temp → backend)
  telemetry-storage-specialist       (temp → backend)

specialists/quality/
  code-reviewer                      (temp → qa)
  docs-writer                        (temp → qa)
  edge-case-hunter                   (default/keyword → qa)
  performance-load-testing-specialist (keyword "test" → qa)
  pytest-specialist                  (default → qa)
  test-coverage-analyst              (default → qa)
  type-annotations-specialist        (temp → qa)
  vitest-specialist                  (temp → qa)

specialists/security/
  audit-compliance-specialist        (temp → security)
  container-hardening-specialist     (keyword → security)
  dependency-auditor                 (temp → security)
  secrets-management-specialist      (keyword → security)
  tls-pki-specialist                 (temp → security)

specialists/sre/
  backup-recovery-specialist         (default → devops)
  ci-cd-specialist                   (keyword → devops)
  iac-specialist                     (temp → devops; см. п. 2.3)
  incident-response-specialist       (temp → devops)
  observability-specialist           (keyword → devops)
```
