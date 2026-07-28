import * as vscode from 'vscode';
import * as cp from 'child_process';

/**
 * The dashboard UI language. VSCode's display language (`vscode.env.language`)
 * is often left at English by habit, so "system" (the default) resolves the
 * real OS language instead; a `aiOffice.language` setting can pin either
 * source or an explicit language.
 */

let cachedSystemLocale: string | null = null;

/** OS user locale, e.g. "ru-RU". Cached — registry/env don't change mid-session. */
function detectSystemLocale(): string {
  // Linux/macOS (and Windows when the user sets them explicitly).
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (env && env !== 'C' && env !== 'POSIX') {
    return env.split('.')[0].replace('_', '-');
  }
  if (process.platform === 'win32') {
    try {
      const out = cp.execSync(
        'reg query "HKCU\\Control Panel\\International" /v LocaleName',
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      const m = out.match(/LocaleName\s+REG_SZ\s+([\w-]+)/i);
      if (m) return m[1];
    } catch {
      // reg.exe unavailable or key missing — fall through to Intl.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

/** Resolved UI locale per the `aiOffice.language` setting. */
export function uiLocale(): string {
  const cfg = vscode.workspace
    .getConfiguration('aiOffice')
    .get<string>('language', 'system');
  if (cfg === 'vscode') return vscode.env.language || 'en';
  if (cfg && cfg !== 'system') return cfg; // explicit language code
  if (!cachedSystemLocale) cachedSystemLocale = detectSystemLocale();
  return cachedSystemLocale;
}

export function isRussianUi(): boolean {
  return uiLocale().toLowerCase().startsWith('ru');
}
