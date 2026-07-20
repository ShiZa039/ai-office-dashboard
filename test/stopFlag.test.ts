import * as assert from 'assert';
import * as path from 'path';
import {
  activateStopFlag,
  deactivateStopFlag,
  parseStopFlag,
  stopAppliesToWindow,
  StopFlag,
} from '../src/stopFlag';

// --- parseStopFlag ---

assert.strictEqual(parseStopFlag(null), null, 'null raw');
assert.strictEqual(parseStopFlag(''), null, 'empty raw');
assert.strictEqual(parseStopFlag('not json'), null, 'malformed json');
assert.strictEqual(parseStopFlag('{"active": false}'), null, 'inactive flag reads as null');
assert.strictEqual(parseStopFlag('[1,2]'), null, 'non-object json');

{
  const flag = parseStopFlag('{"active": true, "cwds": ["/a", "", 42], "since": "2026-07-14T10:00:00Z"}');
  assert.ok(flag, 'active flag parsed');
  assert.deepStrictEqual(flag!.cwds, ['/a'], 'non-string / empty cwds filtered out');
  assert.strictEqual(flag!.since, '2026-07-14T10:00:00Z');
}

{
  const flag = parseStopFlag('{"active": true}');
  assert.ok(flag, 'flag without cwds parsed');
  assert.deepStrictEqual(flag!.cwds, [], 'missing cwds → global stop');
}

// --- activateStopFlag ---

const NOW = '2026-07-14T12:00:00.000Z';

{
  const flag = activateStopFlag(null, ['/proj/a'], NOW);
  assert.deepStrictEqual(flag, { active: true, cwds: ['/proj/a'], since: NOW }, 'fresh workspace stop');
}

{
  const flag = activateStopFlag(null, null, NOW);
  assert.deepStrictEqual(flag.cwds, [], 'global scope → global stop');
}

{
  const existing: StopFlag = { active: true, cwds: ['/proj/a'], since: 'T0' };
  const flag = activateStopFlag(existing, ['/proj/b', '/proj/a'], NOW);
  assert.deepStrictEqual(flag.cwds, ['/proj/a', '/proj/b'], 'cwd union without duplicates');
  assert.strictEqual(flag.since, 'T0', 'original activation time kept');
}

{
  const existing: StopFlag = { active: true, cwds: [], since: 'T0' };
  const flag = activateStopFlag(existing, ['/proj/a'], NOW);
  assert.deepStrictEqual(flag.cwds, [], 'existing global stop stays global');
}

{
  const existing: StopFlag = { active: true, cwds: ['/proj/a'], since: 'T0' };
  const flag = activateStopFlag(existing, null, NOW);
  assert.deepStrictEqual(flag.cwds, [], 'new global stop widens a workspace stop');
}

// --- deactivateStopFlag ---

const A = path.join(path.sep, 'proj', 'a');
const A_SUB = path.join(A, 'packages', 'core');
const B = path.join(path.sep, 'proj', 'b');

assert.strictEqual(deactivateStopFlag(null, [A]), null, 'no flag → nothing to release');

{
  const existing: StopFlag = { active: true, cwds: [A, B], since: 'T0' };
  const flag = deactivateStopFlag(existing, [A]);
  assert.deepStrictEqual(
    flag,
    { active: true, cwds: [B], since: 'T0' },
    'only own project released, other window stop survives',
  );
}

{
  const existing: StopFlag = { active: true, cwds: [A, B], since: 'T0' };
  assert.strictEqual(
    deactivateStopFlag(existing, [A, B]),
    null,
    'all covered projects released → flag gone',
  );
}

{
  const existing: StopFlag = { active: true, cwds: [A_SUB, B], since: 'T0' };
  const flag = deactivateStopFlag(existing, [A]);
  assert.deepStrictEqual(flag!.cwds, [B], 'overlap by containment counts as ours');
}

{
  const existing: StopFlag = { active: true, cwds: [], since: 'T0' };
  assert.strictEqual(
    deactivateStopFlag(existing, [A]),
    null,
    'global flag released entirely by any window',
  );
}

{
  const existing: StopFlag = { active: true, cwds: [A, B], since: 'T0' };
  assert.strictEqual(
    deactivateStopFlag(existing, null),
    null,
    'global-scope window releases everything',
  );
}

// --- stopAppliesToWindow ---

assert.strictEqual(stopAppliesToWindow(null, [A]), false, 'no flag → not stopped');
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [], since: '' }, [A]),
  true,
  'global flag applies to any window',
);
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [A], since: '' }, null),
  true,
  'global-scope window sees any flag',
);
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [A], since: '' }, [A]),
  true,
  'exact folder match',
);
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [A], since: '' }, [A_SUB]),
  true,
  'window inside the stopped folder',
);
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [A_SUB], since: '' }, [A]),
  true,
  'stopped folder inside the window',
);
assert.strictEqual(
  stopAppliesToWindow({ active: true, cwds: [A], since: '' }, [B]),
  false,
  'unrelated window not affected',
);

if (process.platform === 'win32') {
  assert.strictEqual(
    stopAppliesToWindow({ active: true, cwds: ['D:\\Proj\\A'], since: '' }, ['d:\\proj\\a\\']),
    true,
    'case / trailing-slash insensitive on Windows',
  );
}

console.log('All stopFlag tests passed.');
