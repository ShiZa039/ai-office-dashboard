/** Raw event from JSONL file */
export interface AgentEvent {
  ts: string;
  event: 'session_start' | 'agent_start' | 'agent_stop' | 'session_stop';
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
}

/** Message sent from extension to webview */
export type WebviewMessage =
  | {
      type: 'agent_update' | 'full_state';
      agents: Record<string, AgentState>;
      /** Session model ID; null until any event carries one. */
      model?: string | null;
    }
  | { type: 'usage_update'; data: { subscription: unknown; cost: unknown } }
  | { type: 'usage_error'; source: 'subscription' | 'cost'; message: string };

/** Known room ids — keep in sync with media/icons.js and office.html data-room attrs. */
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
 * Built-in Claude Code agent types. Project-specific agents are resolved by
 * the keyword heuristic below, or explicitly via `.claude/office-rooms.json`
 * in the project / the `claudeOffice.agentRooms` setting.
 */
export const DEFAULT_AGENT_ROOMS: Record<string, string> = {
  'general-purpose': 'lobby',
  claude: 'lobby',
  Explore: 'lobby',
  Task: 'lobby',
  Plan: 'directors',
  'code-reviewer': 'qa',
  'claude-code-guide': 'ai-lab',
  'statusline-setup': 'devops',
  'output-style-setup': 'frontend',
};

/** Keyword-based fallback for unknown agent names (ordered: most specific first). */
const KEYWORD_RULES: Array<{ keywords: string[]; room: string }> = [
  { room: 'directors', keywords: ['director'] },
  { room: 'ai-lab', keywords: ['ai', 'llm', 'prompt', 'claude', 'anthropic'] },
  {
    // IoT is its own domain (firmware, telemetry, MQTT, provisioning). Listed
    // before backend/devops/integrations so its specific tokens win.
    room: 'iot',
    keywords: [
      'iot', 'mqtt', 'esp32', 'esptool', 'firmware', 'ota', 'telemetry',
      'sensor', 'device', 'provisioning', 'sticker', 'android',
    ],
  },
  {
    room: 'security',
    keywords: [
      'security', 'auth', 'secret', 'permission', 'threat', 'hardening',
      'audit', 'auditor', 'compliance', 'dependency', 'tls', 'pki',
    ],
  },
  {
    room: 'devops',
    keywords: [
      'devops', 'docker', 'nginx', 'ci', 'cd', 'backup', 'deploy', 'apm',
      'observability', 'alerting', 'scalability', 'ratelimit', 'iac',
      'incident', 'release', 'mcp',
    ],
  },
  {
    room: 'qa',
    keywords: [
      'qa', 'test', 'pytest', 'vitest', 'coverage', 'edge', 'reviewer',
      'docs', 'annotations',
    ],
  },
  {
    room: 'frontend',
    keywords: [
      'frontend', 'react', 'ui', 'ux', 'accessibility', 'a11y', 'i18n',
      'media', 'geo', 'maps', 'camera', 'scanner',
    ],
  },
  {
    room: 'integrations',
    keywords: ['integration', 'webhook', '1c', 'telegram', 'email', 'payment', 'edo', 'ofd', 'notifications'],
  },
  {
    room: 'backend',
    keywords: [
      'backend', 'django', 'orm', 'database', 'sql', 'celery', 'service',
      'signals', 'migration', 'migrations', 'drf', 'serializer', 'viewset',
      'fsm', 'workflow', 'decimal',
    ],
  },
];

/** Infer a room from an unknown agent name by matching known keyword tokens. */
export function inferRoomByName(name: string): string {
  const lower = name.toLowerCase();
  const tokens = new Set(lower.split(/[-_/.]+/).filter(Boolean));
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((kw) => tokens.has(kw))) {
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
