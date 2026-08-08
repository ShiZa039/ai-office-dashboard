import {
  AgentEvent,
  AgentState,
  MAIN_AGENT_NAME,
  SessionWaiting,
  getRoomForAgent,
} from './types';

type RoomResolver = (agentName: string) => string;

const DONE_TIMEOUT_MS = 5000;
// Long enough that a legitimately long-running agent isn't swept mid-flight
// (session_stop no longer terminates working agents — the sweep is the only
// cleanup for orphans), short enough that stale figures don't linger forever.
const STALE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const SWEEP_INTERVAL_MS = 30 * 1000;     // sweep every 30s

/**
 * Manages the state of all known agents.
 * Processes events and produces a snapshot for the webview.
 * - Single-session model: all agents live in one registry regardless of session.
 * - Stale guard: agent_start events older than STALE_TIMEOUT_MS never mark working.
 * - Periodic sweep moves working agents to idle if their last activity is stale.
 */
function normalizeCwd(p: string | undefined | null): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class AgentStateStore {
  private agents: Map<string, AgentState> = new Map();
  private doneTimers: Map<string, NodeJS.Timeout> = new Map();
  private recentEvents: AgentEvent[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private roomResolver: RoomResolver = (name) => getRoomForAgent(name);
  private cwdFilters: string[] | null = null;
  private currentModel: string | null = null;
  private waiting: SessionWaiting | null = null;
  /** Session ids whose main turn is currently running (user_prompt → Stop). */
  private mainSessions: Set<string> = new Set();
  /** Newest session id seen for this cwd — survives session_stop (token panel). */
  private lastSession: string | null = null;

  /** Provide a custom agent→room resolver (e.g. merged user config). */
  setRoomResolver(resolver: RoomResolver): void {
    this.roomResolver = resolver;
    for (const agent of this.agents.values()) {
      agent.room = resolver(agent.name);
    }
    this.onChange?.();
  }

  /**
   * Scope this store to one or more cwds (e.g. the current VSCode window's
   * workspace folders — a multi-root `.code-workspace` has several). Events
   * whose `cwd` matches none are ignored; `session_stop` resets only agents
   * whose tracked cwd matches. Pass `null`/`[]` to disable filtering.
   */
  setCwdFilter(cwd: string | string[] | null): void {
    const list = (Array.isArray(cwd) ? cwd : [cwd])
      .map((c) => normalizeCwd(c))
      .filter(Boolean);
    this.cwdFilters = list.length > 0 ? list : null;
  }

  /**
   * Pre-register agents (e.g. the project roster from `.claude/agents/`)
   * as idle so the office is populated before any events arrive. Existing
   * agents are left untouched.
   */
  seedAgents(names: string[]): void {
    let changed = false;
    for (const name of names) {
      if (!name || this.agents.has(name)) continue;
      this.agents.set(name, {
        name,
        state: 'idle',
        room: this.roomResolver(name),
      });
      changed = true;
    }
    if (changed) this.onChange?.();
  }

  /** Returns true if event.cwd is under any of this store's cwd filters. */
  private matchesCwd(eventCwd: string | undefined): boolean {
    if (!this.cwdFilters) return true;
    const normalized = normalizeCwd(eventCwd);
    if (!normalized) return false;
    return this.cwdFilters.some(
      (f) => normalized === f || normalized.startsWith(f + '/'),
    );
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  processEvent(event: AgentEvent): void {
    // cwd-scoped store drops events from other windows/projects entirely.
    if (!this.matchesCwd(event.cwd)) return;

    // Any event may carry the session model (session_start directly, others
    // via the transcript) — remember the newest one seen.
    if (event.model) {
      this.currentModel = event.model;
    }

    if (event.session) {
      this.lastSession = event.session;
    }

    if (event.event === 'agent_start' || event.event === 'agent_stop') {
      this.recentEvents.push(event);
      if (this.recentEvents.length > 200) {
        this.recentEvents = this.recentEvents.slice(-200);
      }
    }

    // Waiting is session-level: a Notification raises it, any other activity
    // (user answered, agents resumed, session ended) clears it. Historical
    // notifications replayed on startup never resurrect the banner.
    if (event.event === 'agent_waiting') {
      if (!this.isStale(event.ts)) {
        this.waiting = { message: event.task ?? '', since: event.ts };
      }
      return;
    }
    this.waiting = null;

    switch (event.event) {
      case 'user_prompt': {
        // The user submitted a prompt — the main model starts its turn.
        if (this.isStale(event.ts)) break;
        if (event.session) this.mainSessions.add(event.session);
        this.clearDoneTimer(MAIN_AGENT_NAME);
        this.agents.set(MAIN_AGENT_NAME, {
          name: MAIN_AGENT_NAME,
          state: 'working',
          task: this.currentModel ?? undefined,
          room: this.roomResolver(MAIN_AGENT_NAME),
          lastActivity: event.ts,
          cwd: event.cwd,
          activeCount: Math.max(1, this.mainSessions.size),
        });
        break;
      }

      case 'agent_start': {
        this.touchMain(event);
        // Guard: if this start is older than STALE_TIMEOUT, don't resurrect working state.
        if (this.isStale(event.ts)) {
          if (!this.agents.has(event.agent)) {
            this.agents.set(event.agent, {
              name: event.agent,
              state: 'idle',
              room: this.roomResolver(event.agent),
              lastActivity: event.ts,
              cwd: event.cwd,
            });
          }
          break;
        }
        this.clearDoneTimer(event.agent);
        // Parallel same-type agents share one entry (events carry no instance
        // id) — count instances so one finishing doesn't hide the rest.
        const existing = this.agents.get(event.agent);
        const activeCount =
          existing?.state === 'working' ? (existing.activeCount ?? 1) + 1 : 1;
        this.agents.set(event.agent, {
          name: event.agent,
          state: 'working',
          task: event.task,
          room: this.roomResolver(event.agent),
          lastActivity: event.ts,
          cwd: event.cwd,
          activeCount,
        });
        break;
      }

      case 'agent_stop': {
        this.touchMain(event);
        const existing = this.agents.get(event.agent);
        const remaining =
          existing?.state === 'working' ? (existing.activeCount ?? 1) - 1 : 0;
        if (existing && remaining > 0) {
          // Other instances of this agent type are still running.
          this.agents.set(event.agent, {
            ...existing,
            activeCount: remaining,
            lastActivity: event.ts,
          });
          break;
        }
        const state = event.result === 'error' ? 'error' : 'done';
        this.agents.set(event.agent, {
          name: event.agent,
          state,
          task: event.task,
          room: this.roomResolver(event.agent),
          lastActivity: event.ts,
          cwd: event.cwd,
        });
        this.scheduleDoneTimer(event.agent);
        break;
      }

      case 'tool_activity': {
        // Waiting was already cleared above: the banner lifts on the first
        // tool call after the user answers a permission prompt. Nothing else
        // to track — per-tool state would be noise.
        break;
      }

      case 'session_stop': {
        // The `Stop` hook fires when the MAIN turn ends — background subagents
        // may well still be running (their own agent_stop arrives later), so
        // never kill working agents here. Only tidy finished badges; orphaned
        // "working" agents (killed session, lost stop event) are reclaimed by
        // the periodic stale sweep.
        for (const [name, agent] of this.agents) {
          if (agent.state === 'done' || agent.state === 'error') {
            this.clearDoneTimer(name);
            agent.state = 'idle';
            agent.task = undefined;
            agent.activeCount = undefined;
          }
        }
        // The main model finished this session's turn.
        if (event.session) this.mainSessions.delete(event.session);
        const main = this.agents.get(MAIN_AGENT_NAME);
        if (main && main.state === 'working') {
          main.lastActivity = event.ts;
          if (this.mainSessions.size > 0) {
            main.activeCount = this.mainSessions.size;
          } else {
            main.state = 'done';
            main.task = undefined;
            main.activeCount = undefined;
            this.scheduleDoneTimer(MAIN_AGENT_NAME);
          }
        }
        break;
      }
    }
  }

  getSnapshot(): Record<string, AgentState> {
    const result: Record<string, AgentState> = {};
    for (const [name, state] of this.agents) {
      result[name] = { ...state };
    }
    return result;
  }

  getRecentEvents(): AgentEvent[] {
    return [...this.recentEvents];
  }

  /** Model ID last seen for this (cwd-scoped) session, or null if unknown. */
  getModel(): string | null {
    return this.currentModel;
  }

  /** Set while an agent waits for the user (permission / input), null otherwise. */
  getWaiting(): SessionWaiting | null {
    return this.waiting;
  }

  /** Id of the newest session seen in this store's cwd, or null. */
  getLastSession(): string | null {
    return this.lastSession;
  }

  clear(): void {
    for (const timer of this.doneTimers.values()) {
      clearTimeout(timer);
    }
    this.doneTimers.clear();
    this.agents.clear();
    this.recentEvents = [];
    this.currentModel = null;
    this.waiting = null;
    this.mainSessions.clear();
    this.lastSession = null;
  }

  /**
   * Agent traffic proves the session's main turn is still alive — refresh the
   * main figure's activity so a long orchestration isn't swept mid-flight.
   * A stop from an already-finished turn (background agent outliving the
   * turn) is a no-op because the session is no longer in mainSessions.
   */
  private touchMain(event: AgentEvent): void {
    if (!event.session || !this.mainSessions.has(event.session)) return;
    const main = this.agents.get(MAIN_AGENT_NAME);
    if (main && main.state === 'working') {
      main.lastActivity = event.ts;
    }
  }

  private isStale(ts: string): boolean {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return false;
    return Date.now() - t > STALE_TIMEOUT_MS;
  }

  private sweepStale(): void {
    let changed = false;
    const now = Date.now();
    // A waiting banner nobody acted on for 10 min is noise, not a signal —
    // the user likely answered in the terminal without triggering our hooks.
    if (this.waiting && this.isStale(this.waiting.since)) {
      this.waiting = null;
      changed = true;
    }
    for (const [name, agent] of this.agents) {
      if (agent.state !== 'working' || !agent.lastActivity) continue;
      const t = Date.parse(agent.lastActivity);
      if (!Number.isNaN(t) && now - t > STALE_TIMEOUT_MS) {
        this.clearDoneTimer(name);
        agent.state = 'idle';
        agent.task = undefined;
        agent.activeCount = undefined;
        if (name === MAIN_AGENT_NAME) this.mainSessions.clear();
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  private scheduleDoneTimer(agentName: string): void {
    this.clearDoneTimer(agentName);
    const timer = setTimeout(() => {
      const agent = this.agents.get(agentName);
      if (agent && (agent.state === 'done' || agent.state === 'error')) {
        agent.state = 'idle';
        agent.task = undefined;
        this.onChange?.();
      }
      this.doneTimers.delete(agentName);
    }, DONE_TIMEOUT_MS);
    this.doneTimers.set(agentName, timer);
  }

  private clearDoneTimer(agentName: string): void {
    const existing = this.doneTimers.get(agentName);
    if (existing) {
      clearTimeout(existing);
      this.doneTimers.delete(agentName);
    }
  }

  /** Callback for timer-driven state changes */
  onChange?: () => void;
}
