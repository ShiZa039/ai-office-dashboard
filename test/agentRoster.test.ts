import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agentNameFromFile, discoverProjectAgents } from '../src/agentRoster';

// --- agentNameFromFile ---

assert.strictEqual(
  agentNameFromFile('/x/backend-lead.md', '---\nname: backend-lead\ndescription: y\n---\nBody'),
  'backend-lead',
  'frontmatter name wins',
);
assert.strictEqual(
  agentNameFromFile('/x/my-agent.md', '---\nname: "quoted-agent"\n---\n'),
  'quoted-agent',
  'quoted frontmatter name',
);
assert.strictEqual(
  agentNameFromFile('/x/fallback-agent.md', 'no frontmatter here'),
  'fallback-agent',
  'filename fallback',
);
assert.strictEqual(
  agentNameFromFile('/x/desc-only.md', '---\ndescription: name: sneaky\n---\n'),
  'desc-only',
  'name: inside another field is not matched (line-anchored)',
);

// --- discoverProjectAgents over a real temp tree ---

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-roster-'));
const agentsDir = path.join(tmp, '.claude', 'agents');
fs.mkdirSync(path.join(agentsDir, 'specialists', 'backend'), { recursive: true });
fs.writeFileSync(
  path.join(agentsDir, 'lead.md'),
  '---\nname: team-lead\n---\nprompt',
  'utf-8',
);
fs.writeFileSync(
  path.join(agentsDir, 'specialists', 'backend', 'db-specialist.md'),
  'no frontmatter',
  'utf-8',
);
fs.writeFileSync(path.join(agentsDir, 'notes.txt'), 'not an agent', 'utf-8');

const names = discoverProjectAgents([tmp]);
assert.deepStrictEqual(names, ['db-specialist', 'team-lead'], 'recursive discovery, sorted');

// --- kimi-code and shared .agents directories are discovered too ---

fs.mkdirSync(path.join(tmp, '.kimi-code', 'agents'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, '.kimi-code', 'agents', 'reviewer.md'),
  '---\nname: kimi-reviewer\ndescription: x\n---\nbody',
  'utf-8',
);
fs.mkdirSync(path.join(tmp, '.agents', 'agents'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.agents', 'agents', 'shared.md'), 'no frontmatter', 'utf-8');
// Same name in two directories must not duplicate.
fs.writeFileSync(
  path.join(tmp, '.agents', 'agents', 'lead-copy.md'),
  '---\nname: team-lead\n---\nbody',
  'utf-8',
);

assert.deepStrictEqual(
  discoverProjectAgents([tmp]),
  ['db-specialist', 'kimi-reviewer', 'shared', 'team-lead'],
  'all cli agent directories merged, duplicates collapsed',
);

assert.deepStrictEqual(
  discoverProjectAgents([path.join(tmp, 'no-such-folder')]),
  [],
  'missing .claude/agents → empty list',
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log('All agentRoster tests passed.');
