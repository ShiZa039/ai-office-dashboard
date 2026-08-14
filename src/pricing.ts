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
 * The bill split the way it is actually charged: full-rate prompt tokens and
 * output on one side, the two discounted cache lanes on the other. Cache
 * traffic dominates the token counts but is a fraction of the money, and only
 * this split shows that.
 */
export interface CostParts {
  /** Uncached prompt tokens, at the full input rate. */
  input: number;
  /** Generated tokens, at the output rate. */
  output: number;
  /** Cache writes (1.25× input for the 5m TTL, 2× for the 1h one). */
  cacheWrite: number;
  /** Cache reads (0.1× input). */
  cacheRead: number;
  total: number;
}

export function emptyCostParts(): CostParts {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
}

/**
 * API cost in USD of the given spend on the given model, split by what is
 * billed at which rate; null when the model is unpriced.
 */
export function costPartsUsd(raw: string, t: TokenTotals): CostParts | null {
  const price = priceForModel(raw);
  if (!price) return null;
  const cache1h = Math.min(t.cacheCreate1h ?? 0, t.cacheCreate);
  const cache5m = t.cacheCreate - cache1h;
  const input = (t.input * price.input) / 1e6;
  const output = (t.output * price.output) / 1e6;
  const cacheWrite =
    (cache5m * price.input * CACHE_WRITE_5M + cache1h * price.input * CACHE_WRITE_1H) / 1e6;
  const cacheRead = (t.cacheRead * price.input * CACHE_READ) / 1e6;
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/**
 * API cost in USD of the given spend on the given model; null when the model
 * is unpriced. The 1h share of cache writes is billed at 2×, the rest at 1.25×.
 */
export function costUsd(raw: string, t: TokenTotals): number | null {
  const parts = costPartsUsd(raw, t);
  return parts ? parts.total : null;
}

/** Sum the priced share of a per-model split; null when nothing was priced. */
export function costOfModels(byModel: Record<string, TokenTotals>): number | null {
  const parts = costPartsOfModels(byModel);
  return parts ? parts.total : null;
}

/** The same sum, kept split by billing lane. */
export function costPartsOfModels(byModel: Record<string, TokenTotals>): CostParts | null {
  const sum = emptyCostParts();
  let priced = false;
  for (const [raw, totals] of Object.entries(byModel)) {
    const parts = costPartsUsd(raw, totals);
    if (!parts) continue;
    sum.input += parts.input;
    sum.output += parts.output;
    sum.cacheWrite += parts.cacheWrite;
    sum.cacheRead += parts.cacheRead;
    sum.total += parts.total;
    priced = true;
  }
  return priced ? sum : null;
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

/** Which family a model *selection* names ("opus[1m]" → "opus"); null if none. */
export function selectionFamily(selection: string): string | null {
  const lower = selection.toLowerCase();
  return FAMILIES.find((f) => lower.includes(f)) ?? null;
}

export interface ContextWindowHint {
  /**
   * The user's Claude Code model selection, e.g. `opus[1m]` from
   * `~/.claude/settings.json`. Transcripts record the resolved id
   * (`claude-opus-5`) and drop the `[1m]` marker, so the selection is the only
   * place the 1M context shows up before the prompt actually outgrows 200K.
   */
  selection?: string | null;
  /** Prompt size actually observed — a window cannot be smaller than this. */
  observedTokens?: number;
}

/**
 * Best-effort context-window size for the session gauge. Claude Code runs at
 * 200K unless the 1M context is on: explicitly (the `[1m]` id suffix), by the
 * user's model selection, or provably (a prompt that already exceeds 200K).
 * Fable and Mythos are 1M-only models. Unknown (non-Claude) ids get null — no
 * gauge.
 */
export function contextWindowTokens(raw: string, hint?: ContextWindowHint): number | null {
  const lower = raw.toLowerCase();
  const id = parseClaudeId(raw);
  if (!id) return null;
  if (lower.includes('[1m]')) return 1_000_000;
  if (id.family === 'fable' || id.family === 'mythos') return 1_000_000;
  const selection = hint?.selection ?? '';
  if (selection.toLowerCase().includes('[1m]')) {
    // Only trust the selection for the model it names: a Haiku subagent does
    // not inherit the 1M window picked for Opus.
    const family = selectionFamily(selection);
    if (!family || family === id.family) return 1_000_000;
  }
  if ((hint?.observedTokens ?? 0) > 200_000) return 1_000_000;
  return 200_000;
}
