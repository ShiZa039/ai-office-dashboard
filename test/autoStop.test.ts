import * as assert from 'assert';
import { AutoStopLatch } from '../src/autoStop';
import { SubscriptionSnapshot, UsageLimitEntry } from '../src/subscriptionUsage';

function limit(kind: string, utilization: number, resetsAt: string | null): UsageLimitEntry {
  return { kind, label: kind, utilization, resetsAt };
}

function snap(provider: 'claude' | 'kimi', limits: UsageLimitEntry[]): SubscriptionSnapshot {
  return { fetchedAt: '2026-08-11T10:00:00Z', provider, plan: 'max', limits };
}

// --- crossing the threshold fires exactly once per window ---

let latch = new AutoStopLatch();
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 80, 'r1')]), 95),
  null,
  'under the threshold nothing fires',
);
let hit = latch.check(snap('claude', [limit('session', 96, 'r1')]), 95);
assert.strictEqual(hit?.kind, 'session', 'crossing the threshold fires');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 97, 'r1')]), 95),
  null,
  'the same window does not fire twice (a released stop stays released)',
);

// --- a new reset window arms the limit again ---

hit = latch.check(snap('claude', [limit('session', 96, 'r2')]), 95);
assert.strictEqual(hit?.kind, 'session', 'the next window fires anew');

// --- dropping below the threshold re-arms the same window ---

assert.strictEqual(
  latch.check(snap('claude', [limit('session', 40, 'r2')]), 95),
  null,
  'below the threshold nothing fires',
);
hit = latch.check(snap('claude', [limit('session', 95, 'r2')]), 95);
assert.strictEqual(hit?.kind, 'session', 'climbing back over the threshold fires again');

// --- exactly at the threshold counts as reached ---

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('weekly_all', 95, null)]), 95);
assert.strictEqual(hit?.kind, 'weekly_all', 'utilization == threshold fires');

// --- several limits over at once: one hit, but every latch is set ---

latch = new AutoStopLatch();
hit = latch.check(
  snap('claude', [limit('session', 99, 'r1'), limit('weekly_all', 96, 'r2')]),
  95,
);
assert.strictEqual(hit?.kind, 'session', 'the first crossing limit is reported');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 99, 'r1'), limit('weekly_all', 97, 'r2')]), 95),
  null,
  'the sibling limit was latched along and does not re-trip the next poll',
);

// --- providers do not shadow each other ---

latch = new AutoStopLatch();
latch.check(snap('claude', [limit('session', 96, 'r1')]), 95);
hit = latch.check(snap('kimi', [limit('session', 96, 'r1')]), 95);
assert.strictEqual(hit?.kind, 'session', 'the same kind of another provider fires on its own');

console.log('All autoStop tests passed.');
