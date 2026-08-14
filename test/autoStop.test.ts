import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AutoStopLatch,
  LatchEntry,
  LatchStore,
  fileLatchStore,
  memoryLatchStore,
  parseLatchState,
} from '../src/autoStop';
import { SubscriptionSnapshot, UsageLimitEntry } from '../src/subscriptionUsage';

function limit(kind: string, utilization: number, resetsAt: string | null): UsageLimitEntry {
  return { kind, label: kind, utilization, resetsAt };
}

function snap(provider: 'claude' | 'kimi', limits: UsageLimitEntry[]): SubscriptionSnapshot {
  return { fetchedAt: '2026-08-11T10:00:00Z', provider, plan: 'max', limits };
}

const T = { warn: 95, final: 99 };

// --- the main threshold fires exactly once per window ---

let latch = new AutoStopLatch();
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 80, 'r1')]), T),
  null,
  'under the threshold nothing fires',
);
let hit = latch.check(snap('claude', [limit('session', 96, 'r1')]), T);
assert.strictEqual(hit?.limit.kind, 'session', 'crossing the threshold fires');
assert.strictEqual(hit?.level, 1, 'the first crossing is level 1');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 97, 'r1')]), T),
  null,
  'the same window does not fire twice (a released stop stays released)',
);
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 98.9, 'r1')]), T),
  null,
  'the whole span up to the final threshold stays quiet',
);

// --- the final threshold gets one last shot, and only one ---

hit = latch.check(snap('claude', [limit('session', 99, 'r1')]), T);
assert.strictEqual(hit?.level, 2, 'reaching the final threshold fires the last warning');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 100, 'r1')]), T),
  null,
  'nothing fires after the last warning',
);

// --- dropping below the threshold does NOT re-arm the same window ---

assert.strictEqual(
  latch.check(snap('claude', [limit('session', 40, 'r1')]), T),
  null,
  'below the threshold nothing fires',
);
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 96, 'r1')]), T),
  null,
  'climbing back inside the same window stays quiet — the fuse is spent',
);

// --- a new reset window arms the limit again ---

hit = latch.check(snap('claude', [limit('session', 96, 'r2')]), T);
assert.strictEqual(hit?.limit.kind, 'session', 'the next window fires anew');
assert.strictEqual(hit?.level, 1, 'and starts over at level 1');

// --- straight past both thresholds at once: one hit, at level 2 ---

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('session', 99.5, 'r1')]), T);
assert.strictEqual(hit?.level, 2, 'jumping over both thresholds reports the final one');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 99.9, 'r1')]), T),
  null,
  'and the level-1 shot is consumed along with it',
);

// --- equal thresholds mean exactly one shot per window ---

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('session', 96, 'r1')]), { warn: 95, final: 95 });
assert.strictEqual(hit?.level, 2, 'with final == warn the single shot is the last one');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 100, 'r1')]), { warn: 95, final: 95 }),
  null,
  'and nothing follows it',
);

// --- exactly at the threshold counts as reached ---

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('weekly_all', 95, null)]), T);
assert.strictEqual(hit?.limit.kind, 'weekly_all', 'utilization == threshold fires');

// --- unknown reset time: re-arms only well below the threshold ---

latch = new AutoStopLatch();
latch.check(snap('kimi', [limit('session', 96, null)]), T);
assert.strictEqual(
  latch.check(snap('kimi', [limit('session', 93, null)]), T),
  null,
  'a small dip is not a new window',
);
assert.strictEqual(
  latch.check(snap('kimi', [limit('session', 96, null)]), T),
  null,
  'so climbing back does not fire',
);
latch.check(snap('kimi', [limit('session', 20, null)]), T); // clearly a fresh window
hit = latch.check(snap('kimi', [limit('session', 96, null)]), T);
assert.strictEqual(hit?.limit.kind, 'session', 'a real reset re-arms the fuse');

// --- several limits over at once: one hit, but every latch is set ---

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('session', 96, 'r1'), limit('weekly_all', 96, 'r2')]), T);
assert.strictEqual(hit?.limit.kind, 'session', 'the first crossing limit is reported');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 97, 'r1'), limit('weekly_all', 97, 'r2')]), T),
  null,
  'the sibling limit was latched along and does not re-trip the next poll',
);

// --- model-scoped weekly limits get a latch each, no ping-pong ---
// The API returns one `weekly_scoped` entry per model; they used to share a
// `provider:kind` key and overwrite each other's window on every poll.

latch = new AutoStopLatch();
const scoped = (model: string, util: number, resetsAt: string): UsageLimitEntry => ({
  kind: 'weekly_scoped',
  label: `Week (${model})`,
  utilization: util,
  resetsAt,
});
hit = latch.check(snap('claude', [scoped('Opus', 96, 'rOpus'), scoped('Sonnet', 96, 'rSonnet')]), T);
assert.strictEqual(hit?.limit.label, 'Week (Opus)', 'the first scoped limit fires');
for (let poll = 0; poll < 3; poll++) {
  assert.strictEqual(
    latch.check(snap('claude', [scoped('Opus', 97, 'rOpus'), scoped('Sonnet', 97, 'rSonnet')]), T),
    null,
    'two scoped weekly limits do not re-trip each other poll after poll',
  );
}

// --- a resetsAt that changes while the old window is still running ---

const NOW = Date.parse('2026-08-14T12:00:00Z');
const RUNNING = '2026-08-14T14:00:00Z'; // still ahead of NOW
const NEXT = '2026-08-14T19:00:00Z';

latch = new AutoStopLatch();
hit = latch.check(snap('claude', [limit('session', 96, RUNNING)]), T, NOW);
assert.strictEqual(hit?.level, 1, 'first crossing fires');
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 96, NEXT)]), T, NOW),
  null,
  'a new reset time while the old window is still running is not a reset',
);
assert.strictEqual(
  latch.check(snap('claude', [limit('session', 97, RUNNING)]), T, NOW),
  null,
  'and flipping back does not fire either',
);
{
  const afterReset = Date.parse('2026-08-14T14:30:00Z'); // past RUNNING
  hit = latch.check(snap('claude', [limit('session', 96, NEXT)]), T, afterReset);
  assert.strictEqual(hit?.level, 1, 'once the old window has really ended, the fuse re-arms');
}

// --- a resets_at flapping between two values cannot keep firing ---
// The earlier value is already in the past, so the first flip does read as a
// finished window; from then on the latch holds the furthest-forward window
// and going backwards is never a reset.

{
  const PAST = '2026-08-14T11:00:00Z';
  const AHEAD = '2026-08-14T16:00:00Z';
  latch = new AutoStopLatch();
  hit = latch.check(snap('claude', [limit('session', 97, PAST)]), T, NOW);
  assert.strictEqual(hit?.level, 1, 'first crossing fires');
  let fires = 0;
  for (let poll = 0; poll < 6; poll++) {
    const window = poll % 2 === 0 ? AHEAD : PAST;
    if (latch.check(snap('claude', [limit('session', 97, window)]), T, NOW)) fires++;
  }
  assert.strictEqual(fires, 1, 'a flapping resets_at costs one extra shot, not one per poll');
}

// --- providers do not shadow each other ---

latch = new AutoStopLatch();
latch.check(snap('claude', [limit('session', 96, 'r1')]), T);
hit = latch.check(snap('kimi', [limit('session', 96, 'r1')]), T);
assert.strictEqual(hit?.limit.kind, 'session', 'the same kind of another provider fires on its own');

// --- the latch survives a fresh instance (window reload / second window) ---

const shared = memoryLatchStore();
latch = new AutoStopLatch(shared);
hit = latch.check(snap('claude', [limit('session', 96, 'r1')]), T);
assert.strictEqual(hit?.level, 1, 'first instance fires');
const reloaded = new AutoStopLatch(shared);
assert.strictEqual(
  reloaded.check(snap('claude', [limit('session', 96, 'r1')]), T),
  null,
  'a re-created latch reading the same store does not fire again',
);

// --- file store round-trip ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-autostop-'));
const stateFile = path.join(tmpDir, 'nested', 'office-autostop.json');
const store: LatchStore = fileLatchStore(stateFile);
assert.deepStrictEqual(store.load(), {}, 'a missing file reads as an armed fuse');
latch = new AutoStopLatch(store);
hit = latch.check(snap('claude', [limit('session', 96, 'r1')]), T);
assert.strictEqual(hit?.level, 1, 'file-backed latch fires once');
assert.strictEqual(
  new AutoStopLatch(fileLatchStore(stateFile)).check(
    snap('claude', [limit('session', 96, 'r1')]),
    T,
  ),
  null,
  'and a brand-new process reading the file stays quiet',
);
const persisted = store.load();
assert.deepStrictEqual(
  persisted['claude:session:session'], // provider : kind : bar label
  { window: 'r1', level: 1 } as LatchEntry,
  'the entry is stored per limit bar with its window',
);

fs.writeFileSync(stateFile, 'not json at all', 'utf-8');
assert.deepStrictEqual(
  fileLatchStore(stateFile).load(),
  {},
  'a corrupt file degrades to an armed fuse instead of throwing',
);
fs.rmSync(tmpDir, { recursive: true, force: true });

// --- state parsing is defensive ---

assert.deepStrictEqual(parseLatchState(null), {}, 'null state is empty');
assert.deepStrictEqual(parseLatchState('nope'), {}, 'a non-object state is empty');
assert.deepStrictEqual(
  parseLatchState({ 'claude:session': { window: 'r1', level: 2 }, bad: { level: 'x' }, junk: 5 }),
  { 'claude:session': { window: 'r1', level: 2 } },
  'malformed entries are dropped, good ones survive',
);
assert.deepStrictEqual(
  parseLatchState({ 'claude:session': { level: 1 } }),
  { 'claude:session': { window: '', level: 1 } },
  'a missing window reads as unknown',
);

console.log('All autoStop tests passed.');
