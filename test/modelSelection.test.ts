import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { modelSettingsFiles, readModelFrom, readModelSelection } from '../src/modelSelection';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-model-'));
const home = path.join(tmp, 'home');
const projA = path.join(tmp, 'proj-a');
const projB = path.join(tmp, 'proj-b');

function writeSettings(dir: string, body: string): string {
  const file = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

// --- readModelFrom ---

assert.strictEqual(readModelFrom(path.join(tmp, 'nope.json')), null, 'missing file → null');

{
  const file = writeSettings(home, '{"model": "opus[1m]", "theme": "dark"}');
  assert.strictEqual(readModelFrom(file), 'opus[1m]', 'model read from settings');
}
{
  const file = writeSettings(projA, '﻿{"model": "sonnet"}');
  assert.strictEqual(readModelFrom(file), 'sonnet', 'a BOM does not break the parse');
}
{
  const file = writeSettings(projB, '{ not json');
  assert.strictEqual(readModelFrom(file), null, 'malformed settings → null');
}
{
  const file = writeSettings(projB, '{"model": 42}');
  assert.strictEqual(readModelFrom(file), null, 'a non-string model → null');
}
{
  const file = writeSettings(projB, '{"theme": "dark"}');
  assert.strictEqual(readModelFrom(file), null, 'no model key → null');
}

// --- lookup order ---

{
  const files = modelSettingsFiles([projA], home);
  assert.deepStrictEqual(
    files,
    [
      path.join(projA, '.claude', 'settings.local.json'),
      path.join(projA, '.claude', 'settings.json'),
      path.join(home, '.claude', 'settings.json'),
    ],
    'project local, then project, then user',
  );
}
assert.deepStrictEqual(
  modelSettingsFiles(null, home),
  [path.join(home, '.claude', 'settings.json')],
  'no folders → the user settings only',
);

// --- readModelSelection ---

const noEnv = {} as NodeJS.ProcessEnv;

assert.strictEqual(
  readModelSelection(null, home, noEnv),
  'opus[1m]',
  'falls back to the user-level selection',
);
assert.strictEqual(
  readModelSelection([projA], home, noEnv),
  'sonnet',
  'the project selection wins over the user one',
);
{
  const local = path.join(projA, '.claude', 'settings.local.json');
  fs.writeFileSync(local, '{"model": "haiku"}', 'utf-8');
  assert.strictEqual(
    readModelSelection([projA], home, noEnv),
    'haiku',
    'settings.local.json wins over settings.json',
  );
  fs.rmSync(local);
}
assert.strictEqual(
  readModelSelection([projA], home, { ANTHROPIC_MODEL: 'opus-4-5[1m]' } as NodeJS.ProcessEnv),
  'opus-4-5[1m]',
  'the env var wins over every file',
);
assert.strictEqual(
  readModelSelection([projB], home, noEnv),
  'opus[1m]',
  'a project whose settings name no model falls through to the user level',
);
assert.strictEqual(
  readModelSelection([path.join(tmp, 'empty')], path.join(tmp, 'no-home'), noEnv),
  null,
  'nothing anywhere → null',
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('All modelSelection tests passed.');
