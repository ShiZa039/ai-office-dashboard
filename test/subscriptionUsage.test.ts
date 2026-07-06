import * as assert from 'assert';
import { parseCredentials, parseUsageResponse } from '../src/subscriptionUsage';

// --- parseCredentials ---

const creds = parseCredentials({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-xyz',
    refreshToken: 'sk-ant-ort01-abc',
    expiresAt: 1780000000000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
});
assert.ok(creds, 'valid credentials parse');
assert.strictEqual(creds!.accessToken, 'sk-ant-oat01-xyz');
assert.strictEqual(creds!.expiresAt, 1780000000000);
assert.strictEqual(creds!.subscriptionType, 'max');

assert.strictEqual(parseCredentials({}), null, 'missing claudeAiOauth → null');
assert.strictEqual(parseCredentials(null), null, 'null → null');
assert.strictEqual(
  parseCredentials({ claudeAiOauth: { accessToken: '' } }),
  null,
  'empty token → null',
);

const minimal = parseCredentials({ claudeAiOauth: { accessToken: 't' } });
assert.ok(minimal, 'token-only credentials parse');
assert.strictEqual(minimal!.expiresAt, null);
assert.strictEqual(minimal!.subscriptionType, null);

// --- parseUsageResponse: modern `limits` array shape (observed 2026-07) ---

const modern = parseUsageResponse(
  {
    five_hour: { utilization: 46, resets_at: '2026-07-06T14:09:59+00:00' },
    seven_day: { utilization: 5, resets_at: '2026-07-12T16:59:59+00:00' },
    seven_day_opus: null,
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 46,
        severity: 'normal',
        resets_at: '2026-07-06T14:09:59+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 5,
        severity: 'normal',
        resets_at: '2026-07-12T16:59:59+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 6,
        severity: 'normal',
        resets_at: '2026-07-12T16:59:59+00:00',
        scope: { model: { id: null, display_name: 'Opus' }, surface: null },
        is_active: false,
      },
    ],
  },
  'max',
  '2026-07-06T12:00:00.000Z',
);
assert.ok(modern, 'modern response parses');
assert.strictEqual(modern!.plan, 'max');
assert.strictEqual(modern!.limits.length, 3, 'three limit bars');
assert.deepStrictEqual(
  modern!.limits.map((l) => l.label),
  ['Session (5h)', 'Week (all)', 'Week (Opus)'],
  'labels incl. dynamic model name',
);
assert.strictEqual(modern!.limits[0].utilization, 46);
assert.strictEqual(modern!.limits[2].kind, 'weekly_scoped');
assert.strictEqual(modern!.limits[2].resetsAt, '2026-07-12T16:59:59+00:00');

// scoped limit without model name still gets a generic label
const scopedNoModel = parseUsageResponse(
  { limits: [{ kind: 'weekly_scoped', percent: 10, scope: null }] },
  'pro',
  'now',
);
assert.strictEqual(scopedNoModel!.limits[0].label, 'Week (model)');

// unknown kinds pass through with a readable label; broken entries are skipped
const unknownKind = parseUsageResponse(
  {
    limits: [
      { kind: 'daily_special', percent: 150.5, resets_at: null },
      { kind: 'broken', percent: 'high' },
      { percent: 5 },
      null,
    ],
  },
  null,
  'now',
);
assert.strictEqual(unknownKind!.limits.length, 1, 'malformed entries skipped');
assert.strictEqual(unknownKind!.limits[0].label, 'daily special');
assert.strictEqual(unknownKind!.limits[0].utilization, 100, 'clamped to 100');

// --- fallback: legacy flat shape (no `limits` array) ---

const legacy = parseUsageResponse(
  {
    five_hour: { utilization: 88 },
    seven_day: { utilization: 41, resets_at: '2026-07-09T00:00:00+00:00' },
  },
  'pro',
  'now',
);
assert.ok(legacy, 'flat shape parses');
assert.strictEqual(legacy!.limits.length, 2, 'missing opus window omitted');
assert.strictEqual(legacy!.limits[0].label, 'Session (5h)');
assert.strictEqual(legacy!.limits[0].resetsAt, null, 'missing resets_at → null');
assert.strictEqual(legacy!.limits[1].utilization, 41);

// --- garbage in → null out ---

assert.strictEqual(parseUsageResponse(null, 'pro', 'now'), null, 'null body');
assert.strictEqual(parseUsageResponse('nope', 'pro', 'now'), null, 'string body');
assert.strictEqual(parseUsageResponse({}, 'pro', 'now'), null, 'no limits at all');
assert.strictEqual(
  parseUsageResponse({ five_hour: { utilization: 'high' }, limits: [] }, 'pro', 'now'),
  null,
  'non-numeric utilization rejected',
);

console.log('All subscriptionUsage tests passed.');
