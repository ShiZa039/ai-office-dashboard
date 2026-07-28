# Session notes — handoff (2026-07-29)

Временный файл-напоминалка для следующих сессий. Удалить, когда правки внесены.

## Текущее состояние

- Расширение: **AI Office** (`ai-office-dashboard`), v0.14.0. Ребрендинг с
  Claude Office Dashboard завершён и опубликован локально: собран
  `ai-office-dashboard-0.14.0.vsix`, установлен в VSCode, старая
  `shiza039.claude-office-dashboard` удалена.
- GitHub-репозиторий переименован пользователем в `ai-office-dashboard`
  (ссылки в package.json/README уже новые).
- Коммиты:
  - `d8e3506` — ребрендинг в AI Office + dual CLI (Claude Code & Kimi Code) +
    фикс залипания waiting (событие `tool_activity` из stop_gate).
  - следующий — feat: agent detail drill-down drawer (`src/agentDetail.ts`).

## Открытое

- **Правки от пользователя (ожидаются)** — он сказал «работает, но есть
  правки», детали озвучит в следующей сессии. Зафиксировать их здесь/в TODO
  перед работой.

## Что важно помнить

- Старые ключи `claudeOffice.*` оставлены в `package.json` deprecated на один
  релиз; миграция — `src/configMigration.ts` (запускается из `activate()`).
  Через релиз удалить ключи и миграцию.
- Вебвью мигрирует localStorage-ключи `claudeOffice.*` → `aiOffice.*`
  (`readStorageKey` в `media/office.js`).
- `tool_activity`: stop_gate (PreToolUse) в allow-ветке дописывает событие —
  снимает баннер «агент ждёт вас» после permission-аппрува (планмод). Deny
  ничего не пишет. Не менять без необходимости: это hot path каждого tool call.
- Упоминания Claude Code как продукта (`~/.claude/*`, секции usage,
  prettifier моделей) — намеренно не переименованы.
- Пересборка: `npm run compile && npm test && npm run lint && npm run bundle`,
  пакет: `npx @vscode/vsce package` (vsce нет в devDependencies),
  установка: `code --install-extension ai-office-dashboard-<ver>.vsix`.
