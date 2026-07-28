import * as assert from 'assert';
import { parseKimiCredentials, parseKimiUsageResponse } from '../src/kimiUsage';

// --- parseKimiCredentials ---

const creds = parseKimiCredentials({
  access_token: 'eyJhbGciOiJIUzI1NiJ9.token',
  refresh_token: 'rt-abc',
  expires_at: 1785274284, // epoch seconds
  expires_in: 900,
  scope: 'kimi-code',
  token_type: 'Bearer',
});
assert.ok(creds, 'valid credentials parse');
assert.strictEqual(creds!.accessToken, 'eyJhbGciOiJIUzI1NiJ9.token');
assert.strictEqual(creds!.expiresAt, 1785274284 * 1000, 'epoch seconds → millis');

assert.strictEqual(parseKimiCredentials({}), null, 'missing access_token → null');
assert.strictEqual(parseKimiCredentials(null), null, 'null → null');
assert.strictEqual(parseKimiCredentials({ access_token: '' }), null, 'empty token → null');

const noExpiry = parseKimiCredentials({ access_token: 't' });
assert.ok(noExpiry, 'token-only credentials parse');
assert.strictEqual(noExpiry!.expiresAt, null, 'missing expires_at → null');

// --- parseKimiUsageResponse: real response shape (observed 2026-07-28) ---

const real = parseKimiUsageResponse(
  {
    user: {
      userId: 'd7l68qhg6i8qbdk3tmfg',
      region: 'REGION_OVERSEA',
      membership: { level: 'LEVEL_INTERMEDIATE' },
      businessId: '',
    },
    usage: { limit: '100', used: '23', remaining: '77', resetTime: '2026-08-03T18:19:07.671086Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '15', remaining: '85', resetTime: '2026-07-28T10:19:07.671086Z' },
      },
    ],
    parallel: { limit: '20' },
    totalQuota: {},
    authentication: { method: 'METHOD_ACCESS_TOKEN', scope: 'FEATURE_CODING' },
  },
  '2026-07-28T00:00:00.000Z',
);
assert.ok(real, 'real response parses');
assert.strictEqual(real!.plan, 'intermediate', 'LEVEL_ prefix stripped, lowercased');
assert.strictEqual(real!.limits.length, 2, 'rate window + weekly');
assert.deepStrictEqual(
  real!.limits.map((l) => l.kind),
  ['session', 'weekly'],
  'rate window first, weekly second',
);
assert.strictEqual(real!.limits[0].label, 'Session (5h)', '300 minutes → 5h label');
assert.strictEqual(real!.limits[0].utilization, 15, 'used/limit as percent');
assert.strictEqual(real!.limits[0].resetsAt, '2026-07-28T10:19:07.671086Z');
assert.strictEqual(real!.limits[1].label, 'Week');
assert.strictEqual(real!.limits[1].utilization, 23);
assert.strictEqual(real!.limits[1].resetsAt, '2026-08-03T18:19:07.671086Z');

// weekly only (no rate window reported)
const weeklyOnly = parseKimiUsageResponse(
  { usage: { limit: 100, used: 41 } },
  'now',
);
assert.ok(weeklyOnly, 'weekly-only response parses');
assert.strictEqual(weeklyOnly!.limits.length, 1);
assert.strictEqual(weeklyOnly!.limits[0].kind, 'weekly');
assert.strictEqual(weeklyOnly!.limits[0].utilization, 41, 'numeric fields accepted too');
assert.strictEqual(weeklyOnly!.limits[0].resetsAt, null, 'missing resetTime → null');
assert.strictEqual(weeklyOnly!.plan, null, 'no user block → null plan');

// rate window only, odd duration, over-limit clamp
const windowOnly = parseKimiUsageResponse(
  {
    limits: [
      { window: { duration: 90, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '150', limit: '100' } },
      { window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: 1, limit: 10 } },
      { window: null, detail: null }, // broken entry skipped
    ],
  },
  'now',
);
assert.ok(windowOnly, 'window-only response parses');
assert.strictEqual(windowOnly!.limits.length, 2, 'broken entry skipped');
assert.strictEqual(windowOnly!.limits[0].label, 'Window (90m)', 'non-hour duration in minutes');
assert.strictEqual(windowOnly!.limits[0].utilization, 100, 'clamped to 100');
assert.strictEqual(windowOnly!.limits[1].label, 'Rate window', 'non-minute unit → generic label');
assert.strictEqual(windowOnly!.limits[1].utilization, 10);

// zero limit → 0%, no division by zero
const zeroLimit = parseKimiUsageResponse({ usage: { used: '5', limit: '0' } }, 'now');
assert.strictEqual(zeroLimit!.limits[0].utilization, 0, 'zero limit → 0%');

// --- garbage in → null out ---

assert.strictEqual(parseKimiUsageResponse(null, 'now'), null, 'null body');
assert.strictEqual(parseKimiUsageResponse('nope', 'now'), null, 'string body');
assert.strictEqual(parseKimiUsageResponse({}, 'now'), null, 'no usage data at all');
assert.strictEqual(
  parseKimiUsageResponse({ usage: { used: 'lots', limit: '100' }, limits: [] }, 'now'),
  null,
  'non-numeric quota rejected',
);

console.log('All kimiUsage tests passed.');
