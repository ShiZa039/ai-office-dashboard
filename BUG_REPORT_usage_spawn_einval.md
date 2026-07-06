# Bug — `[usage] error: spawn EINVAL` на Windows

**Дата:** 2026-04-17
**Версия:** `claude-office-dashboard-0.7.0.vsix` (и все предыдущие)
**Платформа:** Windows 11 Pro 10.0.26200, VS Code, Node.js 20.12+
**Приоритет:** низкий (не ломает остальные функции расширения)
**Статус:** ✅ ИСПРАВЛЕНО в 0.8.0 — применён вариант A (`shell: process.platform === 'win32'`) в [src/usageWatcher.ts](src/usageWatcher.ts). Аргументы код-контролируемые, экранирование не требуется.

---

## Симптом

При открытии панели **Claude Office** секция `PLAN USAGE`
(`5-HOUR BLOCK`, `WEEKLY (ALL)`, `WEEKLY (OPUS)`) не заполняется —
показывает `—`, в заголовке блока: `error: spawn EINVAL`.

В логе внизу панели:

```
Claude Office: cwd filter = d:\Code projects\Signe_server
Claude Office: watching C:\Users\s_rpk\.claude\agent-events.jsonl
[usage] error: spawn EINVAL
```

Остальные секции (timeline, activity log, watcher агентов, счётчики
workers/done/errors) работают нормально.

## Корневая причина

[src/usageWatcher.ts:149-157](src/usageWatcher.ts#L149-L157):

```ts
private runCcusage(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const full = ['--yes', 'ccusage@latest', ...args];
    const child = spawn(cmd, full, {
      shell: false,          // <-- проблема
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
```

Начиная с **Node.js 20.12 / 21.7 / 22.0** (апрельский security-релиз
против [CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)),
`child_process.spawn()` на Windows **отказывается запускать `.cmd` /
`.bat` напрямую** без `shell: true` — возвращает `EINVAL`.

Код явно передаёт `npx.cmd` с `shell: false` — это **всегда** падает
на свежем Node на Windows. VS Code 1.89+ поставляется со встроенным
Node ≥ 20.12, поэтому баг проявляется у всех пользователей Windows,
обновивших VS Code.

Стек: `spawn('npx.cmd', [...], { shell: false })` → Node внутри
валидирует executable → видит `.cmd` → возвращает `EINVAL` → обработчик
`child.on('error', …)` на строке 168 пересылает ошибку в `reject` →
панель показывает `error: spawn EINVAL`.

## Как воспроизвести

1. Windows + VS Code со встроенным Node ≥ 20.12 (проверить:
   в расширении `code --version`; у меня — 10.0.26200, встроенный Node
   свежий).
2. Установить `.vsix` любой версии 0.3.0–0.7.0.
3. Открыть панель **Claude Office**.
4. Сразу после инициализации watcher'а — красная надпись
   `error: spawn EINVAL` в блоке `PLAN USAGE`.

## Фикс (варианты)

### Вариант A — `shell: true` (минимальное изменение)

```ts
const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(cmd, full, {
  shell: process.platform === 'win32',  // true только на Windows
  windowsHide: true,
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
```

**Плюсы:** одна строка, работает сразу.
**Минусы:** аргументы теперь проходят через cmd.exe — нужно подумать
про экранирование. В нашем случае `full = ['--yes', 'ccusage@latest',
…args]` безопасен (все значения контролируются кодом, нет user input),
но как практика — стоит прогнать через `child_process.execFile`
с явным quoting или использовать вариант B.

### Вариант B — явно вызывать `cmd.exe /c npx …`

```ts
if (process.platform === 'win32') {
  child = spawn('cmd.exe', ['/c', 'npx', '--yes', 'ccusage@latest', ...args], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
} else {
  child = spawn('npx', ['--yes', 'ccusage@latest', ...args], { ... });
}
```

**Плюсы:** `shell: false` сохраняется, аргументы не интерпретируются
через shell.
**Минусы:** ветвление по платформе — шумнее.

### Вариант C — искать `npx-cli.js` напрямую через `process.execPath`

```ts
// Запускать Node из VS Code и кормить ему npx-cli.js
const nodeBin = process.execPath;                 // путь к node.exe
const npxCli = require.resolve('npm/bin/npx-cli.js');
spawn(nodeBin, [npxCli, '--yes', 'ccusage@latest', ...args], { shell: false });
```

**Плюсы:** самое чистое — `.cmd` вообще не задействован, CVE не
актуален.
**Минусы:** требует, чтобы npm был доступен через `require.resolve`;
у VS Code extension host это обычно ok, но нужно проверить.

**Рекомендация:** для 0.7.1 — **вариант A** (одна строка, низкий риск).
Для 0.8.0 можно переехать на C если хочется «правильно».

## Связанное

- Возможно, такая же проблема в других местах, где вызывается `npx` /
  `.cmd` — проверить grep'ом по проекту:
  ```
  grep -rn "\.cmd" src/
  grep -rn "spawn\|exec" src/ | grep -v "// "
  ```
- В `hooks/` (если там есть shell-скрипты, запускаемые через spawn) —
  тот же риск.

## Тест-план после фикса

1. Собрать `.vsix`, установить.
2. Открыть панель — `PLAN USAGE` должна показать три полосы с
   реальными цифрами (или `0%` если квоты не трогались).
3. В Output VS Code (`View → Output → Claude Office`) не должно быть
   `spawn EINVAL`.
4. Linux/macOS — убедиться, что ветка `process.platform !== 'win32'`
   не сломана.

## Ссылки

- [CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2) —
  Node.js отключил прямой запуск `.cmd`/`.bat` через `spawn` без
  `shell: true` на Windows.
- Node docs: `child_process.spawn()` — section «Spawning `.bat` and
  `.cmd` files on Windows».
