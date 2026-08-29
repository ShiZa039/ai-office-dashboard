# Kimi Code

Kimi-специфика проекта AI Office. Общие правила — только в `AGENTS.md`
(единая точка входа, `gotcha-two-agent-configs`); здесь — то, что касается
исключительно работы в Kimi Code CLI на этом репозитории.

## Окружение

- Конфиг CLI: `~/.kimi-code/config.toml` (не путать с `~/.claude/`).
  Хуки расширения регистрируются туда маяком `# office-dashboard-hook:`
  (`src/hookConfigKimi.ts`), установщик — `src/hookInstaller.ts`.
- Данные сессий: `~/.kimi-code/sessions/<workDirKey>/<sessionId>/`
  (`workDirKey = wd_<slug>_<hash>`). Транскрипты — `agents/<agent>/wire.jsonl`.
  Формат и цены моделей разобраны в `docs/KIMI-USAGE.md`.
- Других проектов логи (`~/.kimi-code/sessions/` чужих `wd_*`) не читать без
  явного разрешения — глобальное правило.
- Квоты подписки: `src/kimiUsage.ts` (OAuth, `api.kimi.com/coding/v1/usages`),
  протокол — `docs/USAGE-PROVIDERS.md` §2.

## Грабли

- Хуки **не вызываются** в `kimi --print` (неинтерактивный режим) — такие
  сессии видны на дашборде только через транскрипты (ROADMAP v0.15.0).
- Реальная модель сессии — только из `default_model` в `config.toml`; смена
  модели посреди сессии из хуков не видна (в отличие от Claude-транскриптов).
- `state.json` сессии содержит текст промптов (`title`, `lastPrompt`) —
  читаем из него только `cwd`, ничего не персистим (секрет-гигиена).
