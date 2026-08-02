import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeOfficeHooks } from '../src/hookConfig';

/**
 * Tests for the vscode-independent parts of src/hookInstaller.ts:
 * resolveTargets (CLI dir auto-detection) and checkHookStatus (script and
 * registration state). Functions that touch the vscode API (installHooks,
 * ensureHooksOnActivation, configuredTargets) are not covered — they need a
 * running extension host.
 */

// hookInstaller imports 'vscode', which only resolves inside the extension
// host. Stub it before requiring the module; the functions under test never
// touch it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad(request, parent, isMain);
};

// Point the home dir at a sandbox: hookInstaller resolves ~/.claude and
// ~/.kimi-code via os.homedir(), which reads these env vars dynamically.
// Both vars so it works on Windows and POSIX.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hooks-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { resolveTargets, checkHookStatus } =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../src/hookInstaller') as typeof import('../src/hookInstaller');

const claudeDir = path.join(home, '.claude');
const kimiDir = path.join(home, '.kimi-code');

// --- resolveTargets: explicit settings ---

assert.deepStrictEqual(resolveTargets('claude'), ['claude'], 'explicit claude');
assert.deepStrictEqual(resolveTargets('kimi'), ['kimi'], 'explicit kimi');
assert.deepStrictEqual(resolveTargets('both'), ['claude', 'kimi'], 'explicit both');

// --- resolveTargets: auto detection by existing home dirs ---

assert.deepStrictEqual(
  resolveTargets('auto'),
  ['claude', 'kimi'],
  'auto with neither dir falls back to both',
);

fs.mkdirSync(claudeDir, { recursive: true });
assert.deepStrictEqual(resolveTargets('auto'), ['claude'], 'auto detects only .claude');

fs.mkdirSync(kimiDir, { recursive: true });
assert.deepStrictEqual(resolveTargets('auto'), ['claude', 'kimi'], 'auto detects both dirs');

fs.rmSync(claudeDir, { recursive: true, force: true });
assert.deepStrictEqual(resolveTargets('auto'), ['kimi'], 'auto detects only .kimi-code');

fs.rmSync(kimiDir, { recursive: true, force: true });

// --- checkHookStatus against a sandboxed home ---

const repoRoot = path.resolve(__dirname, '..', '..');
const bundledHooksDir = path.join(repoRoot, 'hooks');
assert.ok(
  fs.existsSync(path.join(bundledHooksDir, 'emit-agent-event.js')),
  'bundled hooks dir exists',
);

const hooksDir = path.join(claudeDir, 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });

// Nothing registered, no scripts installed.
let status = checkHookStatus(bundledHooksDir, ['claude']);
assert.strictEqual(status.settingsOk, false, 'no registrations -> settingsOk false');
assert.strictEqual(status.scriptsOk, false, 'missing scripts -> scriptsOk false');
assert.deepStrictEqual(status.coveredTargets, [], 'nothing registered -> not covered');

// Scripts installed, identical to the bundled ones.
for (const name of ['emit-agent-event.py', 'emit-agent-event.js']) {
  fs.copyFileSync(path.join(bundledHooksDir, name), path.join(hooksDir, name));
}
status = checkHookStatus(bundledHooksDir, ['claude']);
assert.strictEqual(status.scriptsOk, true, 'identical scripts -> scriptsOk true');
assert.strictEqual(status.settingsOk, false, 'scripts alone do not fix settings');

// One script outdated (diverged from the bundled version).
fs.appendFileSync(path.join(hooksDir, 'emit-agent-event.js'), '// outdated\n');
status = checkHookStatus(bundledHooksDir, ['claude']);
assert.strictEqual(status.scriptsOk, false, 'outdated script -> scriptsOk false');
fs.copyFileSync(
  path.join(bundledHooksDir, 'emit-agent-event.js'),
  path.join(hooksDir, 'emit-agent-event.js'),
);

// Full registration: all hook events present in settings.json.
const merged = mergeOfficeHooks({}, 'node');
assert.ok(merged.changed, 'precondition: merge into empty settings registers hooks');
fs.writeFileSync(
  path.join(claudeDir, 'settings.json'),
  JSON.stringify(merged.settings, null, 2),
);
status = checkHookStatus(bundledHooksDir, ['claude']);
assert.strictEqual(status.settingsOk, true, 'all events registered -> settingsOk true');
assert.strictEqual(status.scriptsOk, true, 'scripts still ok');
assert.deepStrictEqual(status.coveredTargets, ['claude'], 'fully registered -> covered');

// Partial registration: only one hook event left (older extension version).
const partial = JSON.parse(JSON.stringify(merged.settings)) as {
  hooks: Record<string, unknown>;
};
const hookEventKeys = Object.keys(partial.hooks);
assert.ok(hookEventKeys.length > 1, 'precondition: more than one hook event');
for (const key of hookEventKeys.slice(1)) {
  delete partial.hooks[key];
}
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(partial, null, 2));
status = checkHookStatus(bundledHooksDir, ['claude']);
assert.strictEqual(status.settingsOk, false, 'partial registration -> settingsOk false');
assert.deepStrictEqual(
  status.coveredTargets,
  ['claude'],
  'partial registration still counts as covered',
);

fs.rmSync(home, { recursive: true, force: true });
console.log('All hookInstaller tests passed.');
