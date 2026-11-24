import type { SubscriptionSnapshot } from './subscriptionUsage';
import type { AgentEvent } from './types';

export type QuotaProvider = NonNullable<SubscriptionSnapshot['provider']>;

type HookProvider = Exclude<QuotaProvider, 'codex'>;

function hookProvider(model: string | undefined): HookProvider | null {
  if (!model) return null;
  if (/^(?:anthropic[./-])|(?:^|[./])claude(?:-|$)/i.test(model)) return 'claude';
  if (/^(?:kimi|moonshot|k\d(?:$|[-.]))/i.test(model)) return 'kimi';
  return null;
}

interface HookActivity {
  at: number;
  provider: HookProvider | null;
  model: string | null;
}

export interface CodexMainSession {
  at: number;
  model: string | null;
}

/** Use main-session starts for recency and inherit the model within a session. */
export class HookQuotaActivity {
  private readonly sessions = new Map<string, HookActivity>();
  private latest: HookActivity | null = null;

  observe(event: AgentEvent): void {
    if (!event.session) return;
    const at = Date.parse(event.ts);
    if (!Number.isFinite(at)) return;
    const prior = this.sessions.get(event.session);
    const startsSession = event.event === 'session_start' || event.event === 'user_prompt';
    if (!prior && !startsSession) return;
    const candidate = prior ?? { at, provider: null, model: null };
    const provider = hookProvider(event.model);
    if (provider) candidate.provider = provider;
    if (event.model) candidate.model = event.model;
    if (startsSession && at >= candidate.at) candidate.at = at;
    this.sessions.set(event.session, candidate);
    if (!this.latest || candidate.at >= this.latest.at) this.latest = candidate;
  }

  current(): HookActivity | null {
    return this.latest;
  }

  clear(): void {
    this.sessions.clear();
    this.latest = null;
  }
}

export function currentMainSession(hook: HookActivity | null, codex: CodexMainSession | null) {
  if (codex && (!hook || codex.at >= hook.at)) return { model: codex.model, provider: 'codex' as const };
  return hook && { model: hook.model, provider: hook.provider };
}

export function visibleQuotaProvider(
  current: QuotaProvider | null | undefined,
  snapshots: Partial<Record<QuotaProvider, SubscriptionSnapshot | null>>,
  claudeCost: boolean,
): QuotaProvider | null {
  if (current !== undefined) return current;
  const available = (['claude', 'kimi', 'codex'] as const).filter(
    (id) => snapshots[id]?.limits.length || (id === 'claude' && claudeCost),
  );
  return available.length === 1 ? available[0] : null;
}
