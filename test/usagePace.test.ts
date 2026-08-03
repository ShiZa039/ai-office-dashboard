import * as assert from 'assert';
import {
  burnRate,
  nextAlertLevel,
  paceStatus,
  percentTimeElapsed,
  usagePace,
  withPace,
} from '../src/usagePace';
import { parseUsageResponse } from '../src/subscriptionUsage';
import { parseKimiUsageResponse } from '../src/kimiUsage';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const HOUR = 3600_000;

/** 5h window with `hoursLeft` until reset → elapsed = (5 − hoursLeft)/5. */
function sessionEntry(utilization: number, hoursLeft: number) {
  return {
    utilization,
    resetsAt: new Date(NOW + hoursLeft * HOUR).toISOString(),
    windowMinutes: 300,
  };
}

// --- percentTimeElapsed ---

assert.strictEqual(percentTimeElapsed(sessionEntry(50, 2.5), NOW), 50, 'half the window elapsed');
assert.strictEqual(percentTimeElapsed(sessionEntry(50, 5), NOW), 0, 'window just started');
assert.strictEqual(
  percentTimeElapsed(sessionEntry(50, -1), NOW),
  null,
  'reset in the past → stale, no pace',
);
assert.strictEqual(
  percentTimeElapsed(sessionEntry(50, 6), NOW),
  null,
  'reset beyond the window → inconsistent, no pace',
);
assert.strictEqual(
  percentTimeElapsed({ resetsAt: null, windowMinutes: 300 }, NOW),
  null,
  'no resetsAt → null',
);
assert.strictEqual(
  percentTimeElapsed({ resetsAt: new Date(NOW + HOUR).toISOString() }, NOW),
  null,
  'no windowMinutes → null',
);
assert.strictEqual(
  percentTimeElapsed({ resetsAt: 'not a date', windowMinutes: 300 }, NOW),
  null,
  'unparseable resetsAt → null',
);

// --- burnRate ---

assert.strictEqual(burnRate(sessionEntry(50, 2.5), NOW), 1, '50% used at 50% elapsed → on schedule');
assert.strictEqual(burnRate(sessionEntry(75, 2.5), NOW), 1.5, '75/50 → 1.5');
assert.strictEqual(burnRate(sessionEntry(10, 5), NOW), null, 'elapsed 0 → no rate');

// --- usagePace ---

assert.strictEqual(usagePace(sessionEntry(52, 2.5), NOW), 'on_pace', 'within ±5 p.p. → on_pace');
assert.strictEqual(usagePace(sessionEntry(56, 2.5), NOW), 'hot', 'above tolerance → hot');
assert.strictEqual(usagePace(sessionEntry(30, 2.5), NOW), 'room', 'below tolerance → room');
assert.strictEqual(usagePace(sessionEntry(50, -1), NOW), null, 'stale window → null');

// --- paceStatus ---

assert.strictEqual(paceStatus(sessionEntry(100, 2.5), NOW), 'depleted', '100% → depleted');
assert.strictEqual(paceStatus(sessionEntry(85, 0.5), NOW), 'critical', '<20% left → critical');
assert.strictEqual(
  paceStatus(sessionEntry(55, 3.5), NOW),
  'warning',
  'burn 55/30≈1.83 with 45% left → early hot warning',
);
assert.strictEqual(
  paceStatus(sessionEntry(40, 4), NOW),
  'ok',
  'hot pace (burn 40/20=2.0) but >50% left → no warning yet',
);
assert.strictEqual(paceStatus(sessionEntry(50, 2.5), NOW), 'ok', 'on schedule → ok');
assert.strictEqual(
  paceStatus({ utilization: 30, resetsAt: null }, NOW),
  'ok',
  'no window data, low usage → ok',
);

// --- nextAlertLevel ---

assert.strictEqual(nextAlertLevel('ok', 'warning'), 'warning', 'degradation alerts');
assert.strictEqual(nextAlertLevel('warning', 'depleted'), 'depleted', 'skips levels');
assert.strictEqual(nextAlertLevel('critical', 'ok'), null, 'improvement stays silent');
assert.strictEqual(nextAlertLevel('warning', 'warning'), null, 'no repeat at same level');
assert.strictEqual(nextAlertLevel('depleted', 'critical'), null, 'recovery stays silent');

// --- withPace fills the snapshot in place ---

{
  const snap = parseUsageResponse(
    {
      five_hour: {
        utilization: 75,
        resets_at: new Date(NOW + 2.5 * HOUR).toISOString(),
      },
      seven_day: {
        utilization: 10,
        resets_at: new Date(NOW + 3.5 * 24 * HOUR).toISOString(),
      },
    },
    'max',
    new Date(NOW).toISOString(),
  );
  assert.ok(snap, 'fixture parses');
  withPace(snap!, NOW);
  const [session, weekly] = snap!.limits;
  assert.strictEqual(session.windowMinutes, 300, 'session window = 5h');
  assert.strictEqual(session.expectedPct, 50, 'session half elapsed');
  assert.strictEqual(session.pace, 'hot', '75 used vs 50 elapsed → hot');
  assert.strictEqual(session.paceStatus, 'ok', 'hot but >50% left → still ok');
  assert.strictEqual(weekly.windowMinutes, 7 * 24 * 60, 'weekly window = 7d');
  assert.strictEqual(weekly.pace, 'room', '10 used vs 50 elapsed → room');
}

// --- parsers fill windowMinutes ---

{
  const kimi = parseKimiUsageResponse(
    {
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: { used: '30', limit: '100', resetTime: new Date(NOW + HOUR).toISOString() },
        },
      ],
      usage: { used: '500', limit: '1000', resetTime: new Date(NOW + 24 * HOUR).toISOString() },
      user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
    },
    new Date(NOW).toISOString(),
  );
  assert.ok(kimi, 'kimi fixture parses');
  assert.strictEqual(kimi!.limits[0].windowMinutes, 300, 'kimi session window from API');
  assert.strictEqual(kimi!.limits[1].windowMinutes, 7 * 24 * 60, 'kimi weekly window = 7d');
}

console.log('All usagePace tests passed.');
