import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { AgentStateStore } from '../src/agentState';
import { currentMainSession, visibleQuotaProvider } from '../src/quotaProvider';
import type { QuotaProvider } from '../src/quotaProvider';
import type { AgentEvent } from '../src/types';

const start = Date.parse('2026-11-24T12:00:00Z');
const store = new AgentStateStore();
store.setCwdFilter('/project');
const observe = (event: AgentEvent['event'], session: string, elapsed: number, model?: string, cwd = '/project') =>
  store.processEvent({ event, session, ts: new Date(start + elapsed).toISOString(), model, cwd, agent: '' });

observe('session_start', 'claude', 0);
observe('tool_activity', 'claude', 100, 'claude-sonnet-4-6');
observe('user_prompt', 'codex-other-project', 900, 'kimi-code/k3', '/elsewhere');
const codex = { at: start + 400, model: 'gpt-6.2-sol' };
assert.deepEqual(currentMainSession(store.quotaActivity.current(), codex),
  { model: 'gpt-6.2-sol', provider: 'codex' });
observe('agent_stop', 'claude', 500, 'claude-sonnet-4-6');
assert.equal(currentMainSession(store.quotaActivity.current(), codex)?.provider, 'codex');
observe('user_prompt', 'claude', 600);
assert.deepEqual(currentMainSession(store.quotaActivity.current(), codex),
  { model: 'claude-sonnet-4-6', provider: 'claude' });
observe('user_prompt', 'kimi', 700, 'kimi-code/k3');
observe('agent_stop', 'claude', 800, 'claude-opus-4-8');
assert.deepEqual(currentMainSession(store.quotaActivity.current(), codex), { model: 'kimi-code/k3', provider: 'kimi' });
observe('session_start', 'unknown', 1000);
assert.deepEqual(currentMainSession(store.quotaActivity.current(), codex), { model: null, provider: null });
store.clear();
assert.equal(currentMainSession(store.quotaActivity.current(), null), null);

const snapshot = (provider: QuotaProvider) => ({
  provider, fetchedAt: new Date(start).toISOString(), plan: null,
  limits: [{ kind: 'session', label: '5h', utilization: 25, resetsAt: null }],
});
const snapshots = { claude: snapshot('claude'), kimi: snapshot('kimi'), codex: snapshot('codex') };
assert.equal(visibleQuotaProvider('codex', snapshots, true), 'codex');
assert.equal(visibleQuotaProvider('kimi', { claude: snapshots.claude }, false), 'kimi');
assert.equal(visibleQuotaProvider(null, { claude: snapshots.claude }, false), null);
assert.equal(visibleQuotaProvider(undefined, snapshots, true), null);
assert.equal(visibleQuotaProvider(undefined, { codex: snapshots.codex }, false), 'codex');

const elements = new Map<string, { hidden: boolean; title?: string; textContent?: string }>();
const receive = new Map<string, (event: { data: unknown }) => void>();
const webview = vm.createContext({
  acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
  document: {
    documentElement: { getAttribute: () => 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  window: { addEventListener: (name: string, fn: (event: { data: unknown }) => void) => receive.set(name, fn) },
  HTMLElement: class {},
  setInterval() {},
});
vm.runInContext(fs.readFileSync('media/office.js', 'utf8'), webview);
webview.render = () => {};
const send = (data: unknown) => receive.get('message')?.({ data });
const mainBadge = { hidden: true, title: '', textContent: '' };
elements.set('office-model', mainBadge);
send({ type: 'full_state', agents: {}, model: 'gpt-6.2-sol' });
assert.deepEqual(mainBadge, { hidden: false, title: 'gpt-6.2-sol', textContent: 'GPT-6.2 Sol' });
send({ type: 'full_state', agents: {}, model: 'claude-sonnet-4-6' });
assert.equal(mainBadge.textContent, 'Sonnet 4.6');

const rendered = new Map<string, unknown>();
webview.renderSubSection = (element: string, data: unknown) => rendered.set(element, data);
let forecastProviders: string[] = [];
webview.renderForecast = (data: object) => { forecastProviders = Object.keys(data); };
for (const [quotaProvider, id] of [
  ['codex', 'usage-codex'], ['claude', 'usage-subscription'], ['kimi', 'usage-kimi'],
] as const) {
  send({ type: 'usage_update', data: { quotaProvider, subscription: snapshots } });
  assert.deepEqual([...rendered].filter(([, data]) => data).map(([element]) => element), [id]);
  assert.deepEqual(forecastProviders, [quotaProvider]);
}
send({ type: 'usage_update', data: { quotaProvider: 'codex', subscription: { claude: snapshots.claude } } });
assert.equal([...rendered.values()].some(Boolean), false);
