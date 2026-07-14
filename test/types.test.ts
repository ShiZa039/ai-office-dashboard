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

// --- IoT domain gets its own room (specific tokens only) ---

assert.strictEqual(inferRoomByName('esp32-firmware-specialist'), 'iot', 'esp32/firmware → iot');
assert.strictEqual(inferRoomByName('mqtt-broker-specialist'), 'iot', 'mqtt → iot');
assert.strictEqual(inferRoomByName('telemetry-anomaly-specialist'), 'iot', 'telemetry → iot');
// Generic infra tokens no longer spawn an IoT room in non-IoT projects.
assert.strictEqual(inferRoomByName('device-provisioning-specialist'), 'devops', 'provisioning → devops');
assert.strictEqual(inferRoomByName('android-app-specialist'), 'frontend', 'android is mobile → frontend');

// --- iac is infrastructure-as-code → devops, not security ---

assert.strictEqual(inferRoomByName('iac-specialist'), 'devops', 'iac → devops');

// --- Stemming: plural / derived forms match their keyword ---

assert.strictEqual(inferRoomByName('permissions'), 'security', 'permissions (plural) → security');
assert.strictEqual(inferRoomByName('integrations'), 'integrations', 'integrations (plural) → integrations');
assert.strictEqual(inferRoomByName('secrets-scanner'), 'security', 'secrets beats frontend scanner');
assert.strictEqual(inferRoomByName('deployment-strategist'), 'devops', 'deployment stems from deploy');
assert.strictEqual(inferRoomByName('reporting'), 'backend', 'reporting stems from report');
assert.strictEqual(inferRoomByName('refactoring'), 'qa', 'refactoring stems from refactor');
// Short keywords stay exact: "author" must NOT stem-match "auth".
assert.strictEqual(inferRoomByName('pytest-plugin-author'), 'qa', 'author is not auth');

// --- Squashed phrases catch multi-word terms ---

assert.strictEqual(inferRoomByName('rate-limit'), 'devops', 'rate-limit → ratelimit phrase');
assert.strictEqual(inferRoomByName('tech-debt'), 'qa', 'tech-debt → techdebt phrase');

// --- Expanded vocabulary keeps typical ERP/utility agents out of the lobby ---

assert.strictEqual(inferRoomByName('postgres-schema-specialist'), 'backend', 'postgres → backend');
assert.strictEqual(inferRoomByName('caching'), 'backend', 'caching → backend');
assert.strictEqual(inferRoomByName('api-designer'), 'backend', 'api → backend');
assert.strictEqual(inferRoomByName('crm-module'), 'backend', 'module → backend');
assert.strictEqual(inferRoomByName('async-realtime'), 'backend', 'async/realtime → backend');
assert.strictEqual(inferRoomByName('sql-injection-hunter'), 'security', 'injection beats backend sql');
assert.strictEqual(inferRoomByName('data-protection'), 'security', 'protection → security');
assert.strictEqual(inferRoomByName('152fz'), 'security', '152fz → security');
assert.strictEqual(inferRoomByName('structured-logging'), 'devops', 'logging → devops');
assert.strictEqual(inferRoomByName('performance'), 'devops', 'performance → devops');
assert.strictEqual(inferRoomByName('payment-gateway'), 'integrations', 'gateway → integrations');

// --- Names with spaces tokenize too ---

assert.strictEqual(inferRoomByName('warehouse module'), 'backend', 'space-separated name → backend');

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
