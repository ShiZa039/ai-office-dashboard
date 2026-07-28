/** Raw event from JSONL file */
export interface AgentEvent {
  ts: string;
  event:
    | 'session_start'
    | 'agent_start'
    | 'agent_stop'
    | 'session_stop'
    /** Claude Code `Notification` hook — the session needs the user (permission / input). */
    | 'agent_waiting'
    /** Claude Code `UserPromptSubmit` hook — the user responded; clears waiting. */
    | 'user_prompt'
    /**
     * Emitted by the PreToolUse stop_gate for every allowed tool call —
     * clears the waiting banner once the user answers a permission prompt
     * (e.g. plan-mode exit) and work resumes. No turn-level hook fires then.
     */
    | 'tool_activity';
  /** Only meaningful for agent_start/agent_stop; session-level events leave it empty. */
  agent: string;
  task?: string;
  result?: string;
  session?: string;
  /** Working directory Claude Code was invoked from; used for per-window isolation. */
  cwd?: string;
  /** Model ID of the session (e.g. "claude-fable-5"); best-effort, may be absent. */
  model?: string;
}

/** Computed agent state for display */
export interface AgentState {
  name: string;
  state: 'idle' | 'working' | 'done' | 'error';
  task?: string;
  room: string;
  lastActivity?: string;
  cwd?: string;
  /**
   * Number of concurrently running instances of this agent type. Events carry
   * no instance id, so parallel same-type agents share one entry; the badge
   * stays "working" until the count drains to zero.
   */
  activeCount?: number;
}

/** The session is blocked on the user (permission prompt / question). */
export interface SessionWaiting {
  /** Notification text from Claude Code, e.g. "Claude needs your permission to use Bash". */
  message: string;
  /** ISO timestamp of the notification. */
  since: string;
}

/** Message sent from extension to webview */
export type WebviewMessage =
  | {
      type: 'agent_update' | 'full_state';
      agents: Record<string, AgentState>;
      /** Session model ID; null until any event carries one. */
      model?: string | null;
      /** Set while an agent waits for the user; null otherwise. */
      waiting?: SessionWaiting | null;
    }
  | { type: 'usage_update'; data: { subscription: unknown; cost: unknown } }
  | { type: 'usage_error'; source: 'subscription' | 'cost'; message: string }
  /** Emergency-stop flag state for this window (dashboard button + banner). */
  | { type: 'stop_state'; active: boolean; since: string | null };

/**
 * Curated room ids with icons/labels/colors in the webview (media/icons.js,
 * office.js ROOM_META). The floor is built dynamically from the agents'
 * actual rooms, so any other id (e.g. from `.claude/office-rooms.json`)
 * also works — it gets a generated label, color and a generic icon.
 */
export const KNOWN_ROOMS = [
  'directors',
  'backend',
  'frontend',
  'qa',
  'security',
  'devops',
  'integrations',
  'ai-lab',
  'iot',
  'lobby',
] as const;

/**
 * Pseudo-agent representing the main agent session (the chat itself).
 * Working = between a user prompt and the turn's Stop; sits with the bosses
 * so it's obvious when the orchestrator grinds solo instead of delegating.
 */
export const MAIN_AGENT_NAME = 'Main agent';

/**
 * Built-in agent types of the supported CLIs (Claude Code and Kimi Code).
 * Project-specific agents are resolved by the keyword heuristic below, or
 * explicitly via `office-rooms.json` in the project (`.claude/` or
 * `.kimi-code/`) / the `aiOffice.agentRooms` setting.
 */
export const DEFAULT_AGENT_ROOMS: Record<string, string> = {
  [MAIN_AGENT_NAME]: 'directors',
  'general-purpose': 'lobby',
  claude: 'lobby',
  Explore: 'lobby',
  Task: 'lobby',
  Plan: 'directors',
  'code-reviewer': 'qa',
  'claude-code-guide': 'ai-lab',
  'statusline-setup': 'devops',
  'output-style-setup': 'frontend',
  // Kimi Code built-in sub-agents (lowercase names).
  coder: 'lobby',
  explore: 'lobby',
  plan: 'directors',
};

/**
 * Keyword-based fallback for unknown agent names (ordered: most specific
 * first — the first rule with any hit wins). A keyword matches a name token
 * exactly, or as a prefix when the keyword is ≥5 chars, so `permission` also
 * catches `permissions`, `deploy` catches `deployment`, `audit` catches
 * `auditor`. `phrases` match the squashed name with separators stripped —
 * for multi-word terms like `rate-limit` → `ratelimit`.
 */
const KEYWORD_RULES: Array<{ keywords: string[]; phrases?: string[]; room: string }> = [
  { room: 'directors', keywords: ['director', 'architect', 'planner', 'chief'] },
  {
    room: 'ai-lab',
    keywords: ['ai', 'llm', 'ml', 'rag', 'embedding', 'prompt', 'claude', 'anthropic'],
  },
  {
    // IoT is its own domain (firmware, telemetry, MQTT). Listed before
    // backend/devops/integrations so its specific tokens win. Deliberately
    // no generic tokens (device/android/provisioning) — they dragged
    // unrelated agents in and spawned an IoT room in non-IoT projects.
    room: 'iot',
    keywords: ['iot', 'mqtt', 'esp32', 'esptool', 'firmware', 'ota', 'telemetry', 'sensor'],
  },
  {
    room: 'security',
    keywords: [
      'security', 'auth', 'authentication', 'authorization', 'oauth', 'sso',
      'secret', 'permission', 'threat', 'hardening', 'audit', 'compliance',
      'dependency', 'tls', 'pki', 'injection', 'xss', 'csrf', 'crypto',
      'encryption', 'vault', 'rbac', 'acl', 'vuln', 'vulnerability', 'owasp',
      'pentest', 'gdpr', 'privacy', 'protection', '152fz', 'firewall',
    ],
  },
  {
    room: 'devops',
    keywords: [
      'devops', 'docker', 'nginx', 'ci', 'cd', 'backup', 'deploy', 'apm',
      'observability', 'alerting', 'scalability', 'iac', 'incident',
      'release', 'mcp', 'logging', 'monitor', 'metrics', 'prometheus',
      'grafana', 'kubernetes', 'k8s', 'helm', 'terraform', 'ansible',
      'infra', 'pipeline', 'provisioning', 'performance', 'profiling', 'sre',
    ],
    phrases: ['ratelimit', 'cicd'],
  },
  {
    room: 'qa',
    keywords: [
      'qa', 'test', 'testing', 'pytest', 'vitest', 'coverage', 'edge',
      'review', 'docs', 'annotations', 'lint', 'linter', 'e2e', 'regression',
      'refactor', 'quality',
    ],
    phrases: ['techdebt'],
  },
  {
    room: 'frontend',
    keywords: [
      'frontend', 'react', 'vue', 'angular', 'svelte', 'css', 'html',
      'tailwind', 'component', 'ui', 'ux', 'accessibility', 'a11y', 'i18n',
      'media', 'geo', 'maps', 'camera', 'scanner', 'mobile', 'android',
      'ios', 'layout', 'responsive',
    ],
  },
  {
    room: 'integrations',
    keywords: [
      'integration', 'webhook', 'gateway', '1c', 'telegram', 'email', 'smtp',
      'sms', 'payment', 'edo', 'ofd', 'notifications',
    ],
  },
  {
    room: 'backend',
    keywords: [
      'backend', 'django', 'fastapi', 'flask', 'orm', 'database', 'sql',
      'sqlite', 'postgres', 'mysql', 'redis', 'schema', 'cache', 'caching',
      'queue', 'kafka', 'rabbitmq', 'celery', 'service', 'signals',
      'migration', 'drf', 'serializer', 'viewset', 'fsm', 'workflow',
      'decimal', 'api', 'rest', 'graphql', 'grpc', 'crud', 'async',
      'realtime', 'websocket', 'module', 'crm', 'erp', 'payroll', 'billing',
      'invoice', 'warehouse', 'finance', 'report', 'pdf', 'weasyprint',
      'onboarding', 'approval',
    ],
  },
];

/** Keywords shorter than this match tokens exactly; longer ones also match as a prefix. */
const STEM_MIN_LENGTH = 5;

/** Infer a room from an unknown agent name by matching known keyword tokens. */
export function inferRoomByName(name: string): string {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const squashed = tokens.join('');
  for (const rule of KEYWORD_RULES) {
    const tokenHit = rule.keywords.some((kw) =>
      tokens.some((t) => t === kw || (kw.length >= STEM_MIN_LENGTH && t.startsWith(kw))),
    );
    if (tokenHit || rule.phrases?.some((p) => squashed.includes(p))) {
      return rule.room;
    }
  }
  return 'lobby';
}

/**
 * Resolve an agent to its room. Precedence:
 * 1. `customMap` (project `.claude/office-rooms.json` merged over user settings) — direct hit wins
 * 2. `DEFAULT_AGENT_ROOMS` — built-in Claude Code agent types
 * 3. `inferRoomByName` — keyword heuristic
 * 4. `'lobby'` — fallback for anything unknown
 */
export function getRoomForAgent(
  agentName: string,
  customMap?: Record<string, string>,
): string {
  if (customMap && customMap[agentName]) return customMap[agentName];
  if (DEFAULT_AGENT_ROOMS[agentName]) return DEFAULT_AGENT_ROOMS[agentName];
  return inferRoomByName(agentName);
}
