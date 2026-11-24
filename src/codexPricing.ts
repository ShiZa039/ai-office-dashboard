import type { ModelPrice } from './pricing';

// Public Standard text rates per million tokens for short-context requests.
// https://developers.openai.com/api/docs/pricing
// Cache writes use the default 30-minute retention where supported.
const RATES = new Map<string, ModelPrice>([
  ['gpt-6.2-astra', { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }],
  ['gpt-6.2-sol', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  ['gpt-6-astra', { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ['gpt-6.1-sol', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  ['gpt-6.1-terra', { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }],
  ['gpt-6-sol', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['gpt-6-luna', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  ['gpt-5.6-sol', { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }],
  ['gpt-5.6-terra', { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['gpt-5.6-luna', { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }],
  ['gpt-5.5', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 }],
  ['gpt-5.4', { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 }],
  ['gpt-5.4-mini', { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 }],
  ['gpt-5.3-codex', { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
  ['gpt-5.2-codex', { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 }],
]);

export function codexPrice(model: string): ModelPrice | undefined {
  const id = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return RATES.get(id === 'gpt-5.6' ? 'gpt-5.6-sol' : id);
}
