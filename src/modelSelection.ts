/**
 * Which model the user has actually selected in Claude Code — the piece of
 * truth the transcripts do not carry. A transcript records the resolved id
 * (`claude-opus-5`) and drops the context-window marker, so a session running
 * Opus 5 with the 1M context looks exactly like a 200K one. The marker lives
 * in the settings files instead (`"model": "opus[1m]"`), and the context gauge
 * needs it to size the bar.
 *
 * Precedence follows Claude Code's own: the ANTHROPIC_MODEL env var, then a
 * project's `.claude/settings.local.json` and `.claude/settings.json`, then the
 * user-level `~/.claude/settings.json`. First file that names a model wins.
 *
 * No vscode imports — unit-testable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `model` from one settings file, or null (missing / unreadable / malformed). */
export function readModelFrom(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
    if (!parsed || typeof parsed !== 'object') return null;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === 'string' && model ? model : null;
  } catch {
    return null;
  }
}

/**
 * The settings files that can name a model, most specific first. Exported so
 * the lookup order is testable without a home directory full of fixtures.
 */
export function modelSettingsFiles(
  cwds: string[] | null,
  homeDir: string = os.homedir(),
): string[] {
  const files: string[] = [];
  for (const cwd of cwds ?? []) {
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
    files.push(path.join(cwd, '.claude', 'settings.json'));
  }
  files.push(path.join(homeDir, '.claude', 'settings.json'));
  return files;
}

/**
 * The model selection in force for these working directories, e.g.
 * `opus[1m]`; null when nothing names one (then the transcript's own id is all
 * we have).
 */
export function readModelSelection(
  cwds: string[] | null,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.ANTHROPIC_MODEL;
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  for (const file of modelSettingsFiles(cwds, homeDir)) {
    const model = readModelFrom(file);
    if (model) return model;
  }
  return null;
}
