import * as assert from 'assert';
import { DEFAULT_AGENT_ROOMS, getRoomForAgent, inferRoomByName } from '../src/types';

// --- Built-in Claude Code agent types map directly ---

assert.strictEqual(getRoomForAgent('general-purpose'), 'lobby', 'general-purpose → lobby');
assert.strictEqual(getRoomForAgent('Explore'), 'lobby', 'Explore → lobby');
assert.strictEqual(getRoomForAgent('Plan'), 'directors', 'Plan → directors');
assert.strictEqual(getRoomForAgent('code-reviewer'), 'qa', 'code-reviewer → qa');

// --- Generic team names resolve via the keyword heuristic (no project profile) ---

assert.strictEqual(getRoomForAgent('backend-lead'), 'backend', 'backend-lead via heuristic');
assert.strictEqual(getRoomForAgent('ai-lead'), 'ai-lab', 'ai-lead via heuristic');
assert.strictEqual(getRoomForAgent('product-director'), 'directors', 'product-director via heuristic');

// --- customMap overrides built-in defaults ---

const custom = { 'backend-lead': 'ai-lab', 'my-dream-agent': 'frontend' };
assert.strictEqual(getRoomForAgent('backend-lead', custom), 'ai-lab', 'custom overrides default');
assert.strictEqual(getRoomForAgent('my-dream-agent', custom), 'frontend', 'custom adds new entries');
assert.strictEqual(getRoomForAgent('qa-lead', custom), 'qa', 'untouched defaults survive custom');

// --- Heuristic fallback for unknown agents ---

assert.strictEqual(inferRoomByName('finance-director'), 'directors', 'director suffix → directors');
assert.strictEqual(inferRoomByName('graphql-backend-adapter'), 'backend', 'backend token → backend');
assert.strictEqual(inferRoomByName('react-forms-specialist'), 'frontend', 'react token → frontend');
assert.strictEqual(inferRoomByName('pytest-plugin-author'), 'qa', 'pytest token → qa');
assert.strictEqual(
  inferRoomByName('auth-hardening-specialist-v2'),
  'security',
  'auth token → security',
);
assert.strictEqual(inferRoomByName('docker-guru'), 'devops', 'docker token → devops');
assert.strictEqual(inferRoomByName('llm-evaluator'), 'ai-lab', 'llm token → ai-lab');
assert.strictEqual(inferRoomByName('telegram-bot-maintainer'), 'integrations', 'telegram → integrations');

// --- IoT domain gets its own room ---

assert.strictEqual(inferRoomByName('esp32-firmware-specialist'), 'iot', 'esp32/firmware → iot');
assert.strictEqual(inferRoomByName('mqtt-broker-specialist'), 'iot', 'mqtt → iot');
assert.strictEqual(inferRoomByName('telemetry-anomaly-specialist'), 'iot', 'telemetry → iot');
assert.strictEqual(inferRoomByName('device-provisioning-specialist'), 'iot', 'device/provisioning → iot');

// --- iac is infrastructure-as-code → devops, not security ---

assert.strictEqual(inferRoomByName('iac-specialist'), 'devops', 'iac → devops');

// --- Unknown-unknowns go to lobby ---

assert.strictEqual(inferRoomByName('general-purpose'), 'lobby', 'general-purpose → lobby');
assert.strictEqual(inferRoomByName('explore'), 'lobby', 'explore → lobby');
assert.strictEqual(inferRoomByName('mystery'), 'lobby', 'unknown → lobby');

// --- Precedence: customMap > DEFAULT > heuristic ---

// Heuristic would put "docker-guru" into devops; custom moves to lobby.
assert.strictEqual(
  getRoomForAgent('docker-guru', { 'docker-guru': 'lobby' }),
  'lobby',
  'customMap beats heuristic',
);

// Custom map without the queried agent falls through to heuristic.
assert.strictEqual(
  getRoomForAgent('unknown-react-agent', { 'other-agent': 'backend' }),
  'frontend',
  'heuristic still runs when customMap does not cover the name',
);

// --- Sanity: every default mapping resolves to a known room ---

for (const [agent, room] of Object.entries(DEFAULT_AGENT_ROOMS)) {
  assert.ok(room, `room for ${agent} must be non-empty`);
}

console.log('All types tests passed.');
