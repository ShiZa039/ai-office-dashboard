import * as assert from 'assert';
import {
  parseCredentials,
  parseUsageResponse,
  SubscriptionUsageWatcher,
  throttleDelayMs,
  UsageProviderConfig,
} from '../src/subscriptionUsage';

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

// --- throttleDelayMs (429 backoff policy, docs/USAGE-PROVIDERS.md §1) ---

assert.strictEqual(throttleDelayMs('120', 0), 120_000, 'honours Retry-After seconds');
assert.strictEqual(throttleDelayMs('0', 0), 60_000, 'Retry-After: 0 (server bug) → fallback');
assert.strictEqual(throttleDelayMs(null, 0), 60_000, 'no header → start at 60s');
assert.strictEqual(throttleDelayMs(null, 60_000), 120_000, 'fallback doubles on repeat');
assert.strictEqual(throttleDelayMs(null, 30 * 60_000), 30 * 60_000, 'fallback capped at 30 min');
assert.strictEqual(throttleDelayMs('99999', 0), 30 * 60_000, 'Retry-After capped at 30 min too');
{
  const httpDate = new Date(Date.now() + 90_000).toUTCString();
  const d = throttleDelayMs(httpDate, 0);
  assert.ok(d > 60_000 && d <= 90_000, 'HTTP-date Retry-After honoured');
}

// --- watcher stays silent inside the Retry-After window ---

async function watcherBackoffScenario(): Promise<void> {
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response('{}', { status: 429, headers: { 'retry-after': '600' } });
  }) as typeof fetch;
  try {
    const cfg: UsageProviderConfig = {
      id: 'claude',
      url: 'https://example.test/usage',
      headers: () => ({}),
      readCredentials: () => ({ accessToken: 't', expiresAt: null, plan: null }),
      parse: () => null,
      messages: { noCredentials: null, expired: null, unauthorized: 'x' },
    };
    const w = new SubscriptionUsageWatcher(cfg, {
      intervalMs: 3_600_000,
      onUpdate: () => assert.fail('no update expected on 429'),
      onError: () => {},
    });
    // tick() is private; the test reaches it structurally, like the interval does.
    const tick = (w as unknown as { tick(): Promise<void> }).tick.bind(w);
    await tick();
    assert.strictEqual(fetchCalls, 1, 'first tick hits the endpoint');
    await tick();
    assert.strictEqual(fetchCalls, 1, 'second tick stays silent within the Retry-After window');
  } finally {
    globalThis.fetch = realFetch;
  }
}

watcherBackoffScenario()
  .then(() => console.log('All subscriptionUsage tests passed.'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
