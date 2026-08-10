/**
 * List prices of the models seen in CLI transcripts, and the cost math on top
 * of the token counters. Everything is $ per million tokens at the public API
 * rates — the point of the panel is "what this work would have cost on the
 * API", which is exactly the number a subscription hides.
 *
 * Cache economics (Anthropic): a cache write costs 1.25× the input rate for
 * the 5-minute TTL and 2× for the 1-hour TTL; a cache read costs 0.1×.
 * Transcripts carry the 5m/1h split in `usage.cache_creation`; when it is
 * absent everything is priced as 5m (the cheaper assumption).
 *
 * Non-Claude models (Kimi, …) are not priced yet — they return null and are
 * simply left out of the $ figures.
 *
 * No vscode imports — unit-testable.
 */
import { TokenTotals } from './tokenUsage';

/** $ per MTok. Cache rates are derived from `input` (×1.25 / ×2 / ×0.1). */
export interface ModelPrice {
  input: number;
  output: number;
}

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

/** "claude-opus-4-5-20251101" → { family: "opus", version: [4, 5] }. */
function parseClaudeId(raw: string): { family: string; version: number[] } | null {
  const parts = raw.toLowerCase().replace(/\[.*$/, '').split('-');
  if (parts[0] !== 'claude') return null;
  const families = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];
  const family = parts.findIndex((p) => families.includes(p));
  if (family === -1) return null;
  const digits = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (const p of parts.slice(from, to)) {
      if (!/^\d{1,2}$/.test(p)) break;
      out.push(Number(p));
    }
    return out;
  };
  const after = digits(family + 1, parts.length);
  const version = after.length ? after : digits(1, family);
  return { family: parts[family], version };
}

function versionNumber(version: number[]): number {
  return (version[0] ?? 0) + (version[1] ?? 0) / 10;
}

/**
 * List price for a raw transcript model id; null when we have no price we can
 * trust (non-Claude ids, or nothing recognizable).
 */
export function priceForModel(raw: string): ModelPrice | null {
  const id = parseClaudeId(raw);
  if (!id) return null;
  const v = versionNumber(id.version);
  switch (id.family) {
    case 'fable':
    case 'mythos':
      return { input: 10, output: 50 };
    case 'opus':
      // Opus 4.5 dropped the tier price from $15/$75 to $5/$25.
      return v >= 4.5 ? { input: 5, output: 25 } : { input: 15, output: 75 };
    case 'sonnet':
      return { input: 3, output: 15 };
    case 'haiku':
      if (v >= 4) return { input: 1, output: 5 };
      if (v >= 3.5) return { input: 0.8, output: 4 };
      return { input: 0.25, output: 1.25 };
    default:
      return null;
  }
}

/**
 * API cost in USD of the given spend on the given model; null when the model
 * is unpriced. The 1h share of cache writes is billed at 2×, the rest at 1.25×.
 */
export function costUsd(raw: string, t: TokenTotals): number | null {
  const price = priceForModel(raw);
  if (!price) return null;
  const cache1h = Math.min(t.cacheCreate1h ?? 0, t.cacheCreate);
  const cache5m = t.cacheCreate - cache1h;
  return (
    (t.input * price.input +
      t.output * price.output +
      cache5m * price.input * CACHE_WRITE_5M +
      cache1h * price.input * CACHE_WRITE_1H +
      t.cacheRead * price.input * CACHE_READ) /
    1e6
  );
}

/** Sum the priced share of a per-model split; null when nothing was priced. */
export function costOfModels(byModel: Record<string, TokenTotals>): number | null {
  let sum = 0;
  let priced = false;
  for (const [raw, totals] of Object.entries(byModel)) {
    const c = costUsd(raw, totals);
    if (c === null) continue;
    sum += c;
    priced = true;
  }
  return priced ? sum : null;
}

/**
 * Best-effort context-window size for the session gauge. Claude Code runs at
 * 200K unless the 1M context is explicitly on (the `[1m]` id suffix); Fable
 * and Mythos are 1M-only models. Unknown (non-Claude) ids get null — no gauge.
 */
export function contextWindowTokens(raw: string): number | null {
  const lower = raw.toLowerCase();
  const id = parseClaudeId(raw);
  if (!id) return null;
  if (lower.includes('[1m]')) return 1_000_000;
  if (id.family === 'fable' || id.family === 'mythos') return 1_000_000;
  return 200_000;
}
