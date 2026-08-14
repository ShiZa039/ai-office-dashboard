import * as assert from 'assert';
import {
  contextWindowTokens,
  costOfModels,
  costPartsOfModels,
  costPartsUsd,
  costUsd,
  priceForModel,
} from '../src/pricing';
import { TokenTotals } from '../src/tokenUsage';

function totals(t: Partial<TokenTotals>): TokenTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cacheCreate1h: 0, ...t };
}

// --- priceForModel ---

assert.deepStrictEqual(priceForModel('claude-fable-5'), { input: 10, output: 50 }, 'fable tier');
assert.deepStrictEqual(priceForModel('claude-mythos-5'), { input: 10, output: 50 }, 'mythos = fable tier');
assert.deepStrictEqual(priceForModel('claude-opus-5'), { input: 5, output: 25 }, 'current opus');
assert.deepStrictEqual(priceForModel('claude-opus-4-8'), { input: 5, output: 25 }, 'opus 4.8');
assert.deepStrictEqual(
  priceForModel('claude-opus-4-5-20251101'),
  { input: 5, output: 25 },
  'opus 4.5 got the cheaper tier; the date stamp is not a version',
);
assert.deepStrictEqual(priceForModel('claude-opus-4-1-20250805'), { input: 15, output: 75 }, 'old opus tier');
assert.deepStrictEqual(priceForModel('claude-sonnet-5'), { input: 3, output: 15 }, 'sonnet tier');
assert.deepStrictEqual(priceForModel('claude-3-5-sonnet-20241022'), { input: 3, output: 15 }, 'old sonnet, version first');
assert.deepStrictEqual(priceForModel('claude-haiku-4-5-20251001'), { input: 1, output: 5 }, 'haiku 4.5');
assert.deepStrictEqual(priceForModel('claude-3-5-haiku-20241022'), { input: 0.8, output: 4 }, 'haiku 3.5');
assert.deepStrictEqual(priceForModel('claude-3-haiku-20240307'), { input: 0.25, output: 1.25 }, 'haiku 3');
assert.deepStrictEqual(priceForModel('claude-opus-5[1m]'), { input: 5, output: 25 }, 'context suffix is the same model');
assert.strictEqual(priceForModel('kimi-k2-turbo-preview'), null, 'non-Claude models are unpriced');
assert.strictEqual(priceForModel(''), null, 'unknown model is unpriced');
assert.strictEqual(priceForModel('<synthetic>'), null, 'placeholders are unpriced');

// --- costUsd ---

assert.strictEqual(
  costUsd('claude-opus-5', totals({ input: 1_000_000 })),
  5,
  '1M plain input tokens at $5/MTok',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ output: 1_000_000 })),
  25,
  '1M output tokens at $25/MTok',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ cacheRead: 1_000_000 })),
  0.5,
  'cache reads are 0.1x the input rate',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ cacheCreate: 1_000_000 })),
  6.25,
  'cache writes default to the 5m rate (1.25x)',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ cacheCreate: 1_000_000, cacheCreate1h: 1_000_000 })),
  10,
  'the 1h share of cache writes bills at 2x',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ cacheCreate: 1_000_000, cacheCreate1h: 400_000 })),
  0.6 * 6.25 + 0.4 * 10,
  'mixed TTLs split the write cost',
);
// A pre-v0.18 persisted state has no cacheCreate1h at all.
assert.strictEqual(
  costUsd('claude-opus-5', { input: 0, output: 0, cacheCreate: 1_000_000, cacheRead: 0 }),
  6.25,
  'missing cacheCreate1h means everything is priced as 5m',
);
assert.strictEqual(
  costUsd('claude-opus-5', totals({ cacheCreate: 100, cacheCreate1h: 500 })),
  (100 * 5 * 2) / 1e6,
  'a 1h share larger than the total is clamped, never negative',
);
assert.strictEqual(costUsd('kimi-k2', totals({ input: 1e6 })), null, 'unpriced model → null, not 0');

// --- costOfModels ---

assert.strictEqual(costOfModels({}), null, 'empty split has no cost');
assert.strictEqual(
  costOfModels({ 'kimi-k2': totals({ input: 1e6 }), '': totals({ output: 1e6 }) }),
  null,
  'nothing priceable → null',
);
assert.strictEqual(
  costOfModels({
    'claude-opus-5': totals({ input: 1_000_000 }),
    'claude-haiku-4-5-20251001': totals({ output: 1_000_000 }),
    'kimi-k2': totals({ input: 5_000_000 }),
  }),
  10,
  'priced models sum ($5 opus input + $5 haiku output); unpriced ones are skipped',
);

// --- contextWindowTokens ---

assert.strictEqual(contextWindowTokens('claude-opus-5'), 200_000, 'Claude Code default window');
assert.strictEqual(contextWindowTokens('claude-opus-5[1m]'), 1_000_000, 'explicit 1m suffix');
assert.strictEqual(contextWindowTokens('claude-fable-5'), 1_000_000, 'fable is a 1M-only model');
assert.strictEqual(contextWindowTokens('claude-haiku-4-5-20251001'), 200_000, 'haiku window');
assert.strictEqual(contextWindowTokens('kimi-k2'), null, 'unknown model → no gauge');

// The transcript records the resolved id without the marker, so the user's
// selection has to carry the 1M window over to it.
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { selection: 'opus[1m]' }),
  1_000_000,
  'the selected 1M context applies to the model it names',
);
assert.strictEqual(
  contextWindowTokens('claude-haiku-4-5-20251001', { selection: 'opus[1m]' }),
  200_000,
  'a Haiku subagent does not inherit the 1M window picked for Opus',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { selection: 'claude-opus-5[1m]' }),
  1_000_000,
  'a full id as the selection works too',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { selection: '[1m]' }),
  1_000_000,
  'a selection naming no family is taken at face value',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { selection: 'opus' }),
  200_000,
  'a selection without the marker changes nothing',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { selection: null }),
  200_000,
  'no selection changes nothing',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { observedTokens: 240_000 }),
  1_000_000,
  'a prompt bigger than 200K proves the window is bigger, whatever the settings say',
);
assert.strictEqual(
  contextWindowTokens('claude-opus-5', { observedTokens: 199_000 }),
  200_000,
  'a prompt that fits proves nothing',
);

// --- costPartsUsd: what is billed at which rate ---

{
  const parts = costPartsUsd(
    'claude-opus-5',
    totals({ input: 1_000_000, output: 1_000_000, cacheCreate: 1_000_000, cacheRead: 1_000_000 }),
  );
  assert.ok(parts, 'opus is priced');
  assert.strictEqual(parts!.input, 5, 'full-price prompt at $5/MTok');
  assert.strictEqual(parts!.output, 25, 'output at $25/MTok');
  assert.strictEqual(parts!.cacheWrite, 6.25, '5m cache writes at 1.25×');
  assert.strictEqual(parts!.cacheRead, 0.5, 'cache reads at 0.1×');
  assert.strictEqual(parts!.total, 36.75, 'the parts add up to the total');
  assert.strictEqual(
    costUsd('claude-opus-5', totals({ input: 1_000_000, output: 1_000_000, cacheCreate: 1_000_000, cacheRead: 1_000_000 })),
    parts!.total,
    'costUsd is the same number as the sum of the parts',
  );
}

{
  const parts = costPartsUsd(
    'claude-opus-5',
    totals({ cacheCreate: 1_000_000, cacheCreate1h: 1_000_000 }),
  );
  assert.strictEqual(parts!.cacheWrite, 10, '1h cache writes at 2×');
}

assert.strictEqual(costPartsUsd('kimi-k2', totals({ input: 10 })), null, 'unpriced model → null');

// --- costPartsOfModels ---

{
  const parts = costPartsOfModels({
    'claude-opus-5': totals({ input: 1_000_000 }),
    'claude-haiku-4-5-20251001': totals({ output: 1_000_000 }),
    'kimi-k2-turbo-preview': totals({ input: 5_000_000 }),
  });
  assert.strictEqual(parts!.input, 5, 'only priced input counted');
  assert.strictEqual(parts!.output, 5, 'haiku output at $5/MTok');
  assert.strictEqual(parts!.total, 10, 'total matches costOfModels');
  assert.strictEqual(
    costOfModels({
      'claude-opus-5': totals({ input: 1_000_000 }),
      'claude-haiku-4-5-20251001': totals({ output: 1_000_000 }),
      'kimi-k2-turbo-preview': totals({ input: 5_000_000 }),
    }),
    parts!.total,
    'costOfModels agrees with the split',
  );
}

assert.strictEqual(
  costPartsOfModels({ 'kimi-k2': totals({ input: 10 }) }),
  null,
  'nothing priceable → null, not a zeroed split',
);

console.log('pricing.test: OK');
