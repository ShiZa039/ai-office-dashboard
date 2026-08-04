// @ts-check
// noqa: secret
var vscode = acquireVsCodeApi();
var currentAgents = {};
var eventCount = 0;
var completedCount = 0;
var timelineEvents = [];
var agentRoomCache = {};
var TIMELINE_WINDOW_KEY = "aiOffice.timelineWindowMs";
var currentTimelineMs = 5 * 60 * 1000;
var lastUsage = null;
var currentWaiting = null;
var stopActive = false;
// The main chat model is visualized by the top banner, not a room figure.
var MAIN_AGENT = "Main agent";
var mainWorkingSince = null;
var HIDE_IDLE_KEY = "aiOffice.hideIdleAgents";
var hideIdle = true;

try {
  var savedHideIdle = localStorage.getItem(HIDE_IDLE_KEY);
  if (savedHideIdle !== null) hideIdle = savedHideIdle === "1";
} catch(e) { /* localStorage unavailable */ }

// ── Rooms ──
// The floor is built dynamically: a room exists only while the project has an
// agent assigned to it. Known ids carry curated labels/colors; any other id
// (e.g. a custom room from `.claude/office-rooms.json`) gets a generated
// label, a palette color picked by name hash, and a generic icon.
var ROOM_META = {
  directors:    { color: "#eab308", label: { en: "Directors",    ru: "Дирекция" } },
  backend:      { color: "#3b82f6", label: { en: "Backend",      ru: "Бэкенд" } },
  frontend:     { color: "#a855f7", label: { en: "Frontend",     ru: "Фронтенд" } },
  qa:           { color: "#22c55e", label: { en: "QA Lab",       ru: "QA-лаборатория" } },
  security:     { color: "#ef4444", label: { en: "Security",     ru: "Безопасность" } },
  devops:       { color: "#f97316", label: { en: "DevOps",       ru: "DevOps" } },
  integrations: { color: "#06b6d4", label: { en: "Integrations", ru: "Интеграции" } },
  "ai-lab":     { color: "#ec4899", label: { en: "AI Lab",       ru: "AI-лаборатория" } },
  iot:          { color: "#84cc16", label: { en: "IoT",          ru: "IoT" } },
  lobby:        { color: "#14b8a6", label: { en: "Lobby",        ru: "Лобби" } },
};
// Display order for known rooms; custom rooms sort after them alphabetically,
// the lobby always closes the floor as a full-width row.
var ROOM_ORDER = ["directors", "backend", "frontend", "qa", "security", "devops", "integrations", "ai-lab", "iot"];
var CUSTOM_ROOM_PALETTE = ["#f43f5e", "#8b5cf6", "#0ea5e9", "#10b981", "#f59e0b", "#d946ef", "#64748b", "#eab308"];

function roomColor(room) {
  if (ROOM_META[room]) return ROOM_META[room].color;
  var h = 0;
  for (var i = 0; i < room.length; i++) h = (h * 31 + room.charCodeAt(i)) >>> 0;
  return CUSTOM_ROOM_PALETTE[h % CUSTOM_ROOM_PALETTE.length];
}

function roomLabel(room) {
  var meta = ROOM_META[room];
  if (meta) return meta.label[UI_LANG] || meta.label.en;
  // "ml-pipeline" → "Ml Pipeline"
  return room.replace(/[-_]+/g, " ").replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function roomIcon(room) {
  var icons = window.__ROOM_ICONS || {};
  return icons[room] || icons._custom || icons.lobby || "";
}

// ── UI localization ──
// The extension stamps VSCode's display language into <html lang="…">.
// Chrome strings fall back to English; agent names, task texts and hook
// messages pass through in whatever language they arrive.
var UI_LOCALE = document.documentElement.getAttribute("lang") || "en";
var UI_LANG = UI_LOCALE.toLowerCase().split("-")[0];
var TIME_LOCALE;
try { new Date().toLocaleTimeString(UI_LOCALE); TIME_LOCALE = UI_LOCALE; } catch(e) { TIME_LOCALE = undefined; }

var MESSAGES = {
  en: {
    waitingForYou: "waiting for you",
    agentWaiting: "The agent is waiting for you",
    agentWorking: "The agent is working",
    agentFinished: "The agent finished the turn",
    statusActive: "{n} active",
    statusAgentWorking: "Agent working",
    statusIdle: "idle",
    statusOffline: "offline",
    events: ["event", "events"],
    idleAgents: ["idle", "idle"],
    idleTitleCollapsed: "Idle agents are collapsed into per-room “+N” chips. Click to show them.",
    idleTitleExpanded: "Click to collapse idle agents into per-room “+N” chips.",
    waitingForEvents: "waiting for events...",
    floorEmpty: "No agents in this project yet — rooms appear as agents work here",
    resetsSoon: "resets soon",
    resetsIn: "resets in {d}",
    updatedAt: "updated {t}",
    usageError: "error: {m}",
    forecast: "⚠ {label} hits 100% in ~{d} at the current pace",
    paceHot: "running hot",
    paceOnPace: "on pace",
    paceRoom: "room to spare",
    paceTickHelp: "Where the bar would be if the window were used evenly",
    blockLeft: "{d} left",
    noActiveBlock: "no active block",
    unitMin: "m",
    unitHour: "h",
    labelWorking: "working",
    labelDone: "done",
    labelErrors: "errors",
    labelTotal: "total",
    labelCompleted: "completed",
    labelTimeline: "Timeline",
    labelPlanUsage: "Plan usage",
    labelActivityLog: "Activity Log",
    labelLoading: "loading…",
    labelBlock: "5-hour block ($)",
    labelWeekly: "Weekly ($)",
    labelWeeklyOpus: "Weekly Opus ($)",
    tl5: "5 min", tl15: "15 min", tl30: "30 min", tl1h: "1 hour", tl6h: "6 hours",
    stopActive: "Emergency stop is active",
    stopHint: "All agent tool calls are blocked. Press Resume or just send the agent a new prompt.",
    stopResume: "Resume",
    stopBtnLabel: "Emergency stop",
    stopBtnHint: "Block all agent tool calls immediately",
    stopBtnTitle: "Emergency stop — block all agent tool calls now. Sessions and context survive; resume with the button or a new prompt.",
    logStopOn: "EMERGENCY STOP — agents blocked",
    logStopOff: "emergency stop released",
    drawerClose: "Close",
    drawerCloseTitle: "Close the panel (Esc)",
    drawerCurrentTask: "Current task",
    drawerHistory: "History",
    drawerLoading: "loading…",
    drawerNoHistory: "No runs recorded yet",
    drawerWorking: "in progress",
    drawerNoStart: "start not recorded",
    drawerRuns: ["run", "runs"],
    drawerErrors: ["error", "errors"],
    drawerAvg: "avg {d}",
    drawerStats: "{runs} · {errors} · {avg}",
    drawerStateIdle: "idle",
    drawerStateError: "error",
  },
  ru: {
    waitingForYou: "ждёт вашего ответа",
    agentWaiting: "Агент ждёт вас",
    agentWorking: "Агент работает",
    agentFinished: "Агент завершил ход",
    statusActive: "{n} активно",
    statusAgentWorking: "Агент работает",
    statusIdle: "без задач",
    statusOffline: "офлайн",
    events: ["событие", "события", "событий"],
    idleAgents: ["неактивный", "неактивных", "неактивных"],
    idleTitleCollapsed: "Неактивные агенты свёрнуты в чипы «+N» по комнатам. Нажмите, чтобы показать их.",
    idleTitleExpanded: "Нажмите, чтобы свернуть неактивных агентов в чипы «+N» по комнатам.",
    waitingForEvents: "ожидание событий...",
    floorEmpty: "В этом проекте пока нет агентов — комнаты появятся, когда агенты начнут здесь работать",
    resetsSoon: "скоро сброс",
    resetsIn: "сброс через {d}",
    updatedAt: "обновлено {t}",
    usageError: "ошибка: {m}",
    forecast: "⚠ {label} достигнет 100% через ~{d} при текущем темпе",
    paceHot: "горячо",
    paceOnPace: "по графику",
    paceRoom: "с запасом",
    paceTickHelp: "Где была бы полоска при равномерном расходе окна",
    blockLeft: "осталось {d}",
    noActiveBlock: "нет активного блока",
    unitMin: "м",
    unitHour: "ч",
    labelWorking: "в работе",
    labelDone: "готово",
    labelErrors: "ошибки",
    labelTotal: "всего",
    labelCompleted: "завершено",
    labelTimeline: "Таймлайн",
    labelPlanUsage: "Лимиты плана",
    labelActivityLog: "Журнал активности",
    labelLoading: "загрузка…",
    labelBlock: "Блок 5 часов ($)",
    labelWeekly: "За неделю ($)",
    labelWeeklyOpus: "Opus за неделю ($)",
    tl5: "5 мин", tl15: "15 мин", tl30: "30 мин", tl1h: "1 час", tl6h: "6 часов",
    stopActive: "Экстренная остановка активна",
    stopHint: "Все вызовы инструментов агентов блокируются. Нажмите «Продолжить» или просто отправьте агенту новый промпт.",
    stopResume: "Продолжить",
    stopBtnLabel: "Экстренная остановка",
    stopBtnHint: "Мгновенно заблокировать все действия агентов",
    stopBtnTitle: "Экстренная остановка — немедленно заблокировать все вызовы инструментов. Сессии и контекст сохраняются; возобновление кнопкой или новым промптом.",
    logStopOn: "ЭКСТРЕННАЯ ОСТАНОВКА — агенты заблокированы",
    logStopOff: "экстренная остановка снята",
    drawerClose: "Закрыть",
    drawerCloseTitle: "Закрыть панель (Esc)",
    drawerCurrentTask: "Текущая задача",
    drawerHistory: "История",
    drawerLoading: "загрузка…",
    drawerNoHistory: "Запусков пока не было",
    drawerWorking: "в работе",
    drawerNoStart: "старт не записан",
    drawerRuns: ["запуск", "запуска", "запусков"],
    drawerErrors: ["ошибка", "ошибки", "ошибок"],
    drawerAvg: "среднее {d}",
    drawerStats: "{runs} · {errors} · {avg}",
    drawerStateIdle: "без задач",
    drawerStateError: "ошибка",
  },
};
var UI_MSG = MESSAGES[UI_LANG] || MESSAGES.en;

function tr(key, vars) {
  var s = UI_MSG[key] != null ? UI_MSG[key] : MESSAGES.en[key];
  if (s == null) return key;
  if (typeof s !== "string") s = s[0];
  if (vars) s = s.replace(/\{(\w+)\}/g, function(_, k) { return vars[k] != null ? String(vars[k]) : ""; });
  return s;
}

/** "3 events" / "3 события" — picks the right plural form for the UI language. */
function trCount(key, n) {
  var forms = UI_MSG[key] != null ? UI_MSG[key] : MESSAGES.en[key];
  if (!forms) return n + " " + key;
  if (typeof forms === "string") return n + " " + forms;
  var idx;
  if (UI_LANG === "ru") {
    var m10 = n % 10, m100 = n % 100;
    idx = m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2;
  } else {
    idx = n === 1 ? 0 : 1;
  }
  return n + " " + (forms[idx] || forms[forms.length - 1]);
}

function localizeDom() {
  document.querySelectorAll("[data-i18n]").forEach(function(el) {
    el.textContent = tr(el.getAttribute("data-i18n") || "");
  });
  var count = document.getElementById("log-count");
  if (count) count.textContent = trCount("events", 0);
}

function getAgentIcon(agentName, room) {
  var avatarMap = window.__AGENT_AVATAR_MAP || {};
  var avatars = window.__AGENT_AVATARS || {};

  var avatarKey = avatarMap[agentName];
  if (avatarKey && avatars[avatarKey]) return avatars[avatarKey];

  return roomIcon(room);
}

/**
 * Sort room ids for display: curated order first, then custom rooms
 * alphabetically, lobby always last (it renders as a full-width row).
 */
function sortRooms(ids) {
  return ids.slice().sort(function(a, b) {
    if (a === "lobby") return 1;
    if (b === "lobby") return -1;
    var ia = ROOM_ORDER.indexOf(a), ib = ROOM_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Rebuild the floor so it contains exactly the given rooms, in order.
 * Cheap when nothing changed (signature check); a full rebuild otherwise —
 * agent badges are re-rendered by the caller right after.
 */
function ensureRooms(roomIds) {
  var floor = document.getElementById("floor");
  var empty = document.getElementById("floor-empty");
  if (!floor) return;

  var ordered = sortRooms(roomIds);
  var signature = ordered.join("|");
  if (floor.getAttribute("data-rooms") === signature) return;
  floor.setAttribute("data-rooms", signature);

  floor.querySelectorAll(".room").forEach(function(el) { el.remove(); });
  if (empty) empty.hidden = ordered.length > 0;

  for (var i = 0; i < ordered.length; i++) {
    var id = ordered[i];
    var room = document.createElement("div");
    room.className = "room" + (id === "lobby" ? " room--lobby" : "");
    room.setAttribute("data-room", id);
    room.style.setProperty("--room-accent", roomColor(id));

    var header = document.createElement("div");
    header.className = "room-header";
    var icon = document.createElement("span");
    icon.className = "room-icon";
    icon.innerHTML = roomIcon(id);
    var label = document.createElement("span");
    label.className = "room-label";
    label.textContent = roomLabel(id);
    header.appendChild(icon);
    header.appendChild(label);

    var agents = document.createElement("div");
    agents.className = "agents";

    room.appendChild(header);
    room.appendChild(agents);
    floor.appendChild(room);
  }
}

function shortName(name) {
  return name.replace(/-specialist$/, "").replace(/-lead$/, "").replace(/^module-/, "").replace(/-/g, " ");
}

function formatTime(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleTimeString(TIME_LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch(e) { return ""; }
}

function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = String(val);
}

/**
 * "claude-fable-5" → "Fable 5", "claude-opus-4-8" → "Opus 4.8",
 * "claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-3-5-sonnet-…" → "Sonnet 3.5".
 * Falls back to the raw ID when nothing recognizable remains.
 */
function formatModelName(id) {
  if (!id) return "";
  var parts = String(id).replace(/^.*?claude-/, "").split("-");
  var nums = [], words = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (/^\d{8}$/.test(p)) continue; // date stamp
    if (/^v\d/.test(p)) continue;    // bedrock version suffix
    if (/^\d+$/.test(p)) nums.push(p);
    else if (p) words.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  if (words.length === 0) return id;
  var name = words.join(" ");
  return nums.length > 0 ? name + " " + nums.join(".") : name;
}

function updateIdleToggle(idleCount) {
  var btn = document.getElementById("idle-toggle");
  if (!btn) return;
  btn.classList.toggle("idle-toggle--on", !hideIdle);
  btn.textContent = (hideIdle ? "□ " : "■ ") + trCount("idleAgents", idleCount);
  btn.title = hideIdle ? tr("idleTitleCollapsed") : tr("idleTitleExpanded");
}

function initIdleToggle() {
  var btn = document.getElementById("idle-toggle");
  if (!btn) return;
  btn.addEventListener("click", function() {
    hideIdle = !hideIdle;
    try { localStorage.setItem(HIDE_IDLE_KEY, hideIdle ? "1" : "0"); } catch(e) {}
    render();
  });
}

function setModel(model) {
  var el = document.getElementById("office-model");
  if (!el) return;
  if (model) {
    el.textContent = formatModelName(model);
    el.title = model;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.removeAttribute("title");
    el.hidden = true;
  }
}

// Signature of everything render() paints; full_state arrives on every hook
// event but the figures rarely change, so unchanged snapshots skip the DOM
// rebuild (avoids visible flicker). The event-log diff in the message
// handler runs before render(), so skipping here loses nothing.
var lastRenderSignature = null;

function renderSignature() {
  var parts = [
    hideIdle ? "1" : "0",
    String(completedCount),
    currentWaiting ? "1" : "0",
  ];
  Object.keys(currentAgents).sort().forEach(function(n) {
    var a = currentAgents[n];
    parts.push([n, a.state, a.room, a.task, a.activeCount, a.lastActivity]);
  });
  return JSON.stringify(parts);
}

function render() {
  var sig = renderSignature();
  if (sig === lastRenderSignature) return;
  lastRenderSignature = sig;
  // noqa: secret
  // The floor holds exactly the rooms the current agents occupy.
  var neededRooms = {};
  Object.keys(currentAgents).forEach(function(n) {
    if (n !== MAIN_AGENT) neededRooms[currentAgents[n].room || "lobby"] = true;
  });
  ensureRooms(Object.keys(neededRooms));

  document.querySelectorAll(".room .agents").forEach(function(el) { el.innerHTML = ""; }); // noqa: secret
  document.querySelectorAll(".room").forEach(function(el) { el.classList.remove("room--active"); }); // noqa: secret

  // `working` counts running instances (parallel same-type agents included);
  // `workingEntries` counts badges, for the idle-agents math.
  var working = 0, workingEntries = 0, done = 0, errors = 0, total = 0;
  var idleByRoom = {};
  var entries = Object.entries(currentAgents);

  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0], agent = entries[i][1];
    if (name === MAIN_AGENT) continue; // shown in the banner, not in a room
    total++;
    if (agent.state === "working") {
      workingEntries++;
      working += agent.activeCount > 1 ? agent.activeCount : 1;
    }
    if (agent.state === "done") done++;
    if (agent.state === "error") errors++;

    // Compact mode: idle agents collapse into a per-room "+N" chip so a big
    // roster doesn't blow up the dashboard height.
    if (hideIdle && agent.state === "idle") {
      (idleByRoom[agent.room] = idleByRoom[agent.room] || []).push(name);
      continue;
    }

    var roomEl = document.querySelector('.room[data-room="' + agent.room + '"] .agents');
    if (!roomEl) continue;

    if (agent.state === "working") {
      var rm = roomEl.closest(".room");
      if (rm) rm.classList.add("room--active");
    }

    var el = document.createElement("div");
    el.className = "agent agent--" + agent.state;

    var instances = agent.state === "working" && agent.activeCount > 1 ? agent.activeCount : 0;

    // Everything host-supplied (agent name, task, activity time) goes in via
    // textContent — same rule as the drawer. Only the avatar SVG is innerHTML,
    // and that comes from our own trusted local registry.
    var icon = document.createElement("span");
    icon.className = "agent-icon";
    icon.innerHTML = getAgentIcon(name, agent.room);
    el.appendChild(icon);

    var nameEl = document.createElement("span");
    nameEl.className = "agent-name";
    nameEl.textContent = shortName(name);
    el.appendChild(nameEl);

    if (instances) {
      var instEl = document.createElement("span");
      instEl.className = "agent-instances";
      instEl.textContent = "×" + instances;
      el.appendChild(instEl);
    }

    // Keep the .agent-tooltip wrapper (and its children) on the same CSS
    // classes so the arrow pseudo-element and hover rule still apply.
    var tooltip = document.createElement("div");
    tooltip.className = "agent-tooltip";
    var tipName = document.createElement("div");
    tipName.className = "tooltip-name";
    tipName.textContent = name + (instances ? " ×" + instances : "");
    tooltip.appendChild(tipName);
    if (agent.task) {
      var tipTask = document.createElement("div");
      tipTask.className = "tooltip-task";
      tipTask.textContent = agent.task;
      tooltip.appendChild(tipTask);
    }
    if (agent.lastActivity) {
      var tipTime = document.createElement("div");
      tipTime.className = "tooltip-time";
      tipTime.textContent = formatTime(agent.lastActivity);
      tooltip.appendChild(tipTime);
    }
    el.appendChild(tooltip);
    // `name` is a loop-scoped `var` — capture it per figure for the click.
    (function(n, room) {
      el.classList.add("agent--clickable");
      el.addEventListener("click", function() { toggleAgentDrawer(n, room); });
    })(name, agent.room);
    roomEl.appendChild(el);
  }

  Object.keys(idleByRoom).forEach(function(room) {
    var roomEl = document.querySelector('.room[data-room="' + room + '"] .agents');
    if (!roomEl) return;
    var names = idleByRoom[room];
    var chip = document.createElement("div");
    chip.className = "agent agent--idle agent--idle-count";
    chip.textContent = "+" + names.length;
    chip.title = trCount("idleAgents", names.length) + ": " + names.map(shortName).join(", ");
    roomEl.appendChild(chip);
  });

  updateIdleToggle(total - workingEntries - done - errors);

  setText("stat-working", working);
  setText("stat-done", done);
  setText("stat-errors", errors);
  setText("stat-total", total);
  setText("stat-completed", completedCount);

  var dot = document.querySelector(".status-dot");
  var statusText = document.getElementById("status-text");
  function setStatus(cls, text) {
    if (dot) {
      dot.classList.remove("status-dot--on", "status-dot--off", "status-dot--wait");
      dot.classList.add(cls);
    }
    if (statusText) statusText.textContent = text;
  }
  var mainAgent = currentAgents[MAIN_AGENT];
  if (currentWaiting) setStatus("status-dot--wait", tr("waitingForYou"));
  else if (working > 0) setStatus("status-dot--on", tr("statusActive", { n: working }));
  else if (mainAgent && mainAgent.state === "working") setStatus("status-dot--on", tr("statusAgentWorking"));
  else if (total > 0) setStatus("status-dot--off", tr("statusIdle"));
  else setStatus("status-dot--off", tr("statusOffline"));

  renderMainBanner();
  renderTimeline();
}

/**
 * The top banner tracks the MAIN model: yellow "waiting for you" wins,
 * then blue "working" (with model, duration, ×sessions), a brief green
 * "finished" flash, hidden when idle.
 */
function renderMainBanner() {
  var banner = document.getElementById("waiting-banner");
  if (!banner) return;
  var titleEl = banner.querySelector(".waiting-title");
  var msgEl = document.getElementById("waiting-msg");
  var iconEl = banner.querySelector(".waiting-hand");
  var main = currentAgents[MAIN_AGENT];

  banner.classList.remove("waiting-banner--working", "waiting-banner--done");

  if (currentWaiting) {
    if (iconEl) iconEl.textContent = "✋";
    if (titleEl) titleEl.textContent = tr("agentWaiting");
    if (msgEl) msgEl.textContent = currentWaiting.message || "";
    banner.hidden = false;
    return;
  }

  if (main && main.state === "working") {
    if (!mainWorkingSince) mainWorkingSince = Date.now();
    banner.classList.add("waiting-banner--working");
    if (iconEl) iconEl.textContent = "⚡";
    var title = tr("agentWorking");
    if (main.activeCount > 1) title += " ×" + main.activeCount;
    var mins = (Date.now() - mainWorkingSince) / 60000;
    if (mins >= 1) title += " · " + formatDuration(mins);
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = main.task ? formatModelName(main.task) : "";
    banner.hidden = false;
    return;
  }

  mainWorkingSince = null;
  if (main && main.state === "done") {
    banner.classList.add("waiting-banner--done");
    if (iconEl) iconEl.textContent = "✓";
    if (titleEl) titleEl.textContent = tr("agentFinished");
    if (msgEl) msgEl.textContent = "";
    banner.hidden = false;
    return;
  }

  banner.hidden = true;
}

function renderTimeline() {
  var canvas = document.getElementById("timeline");
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) return;
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  var W = rect.width, H = rect.height;
  ctx.clearRect(0, 0, W, H);

  if (timelineEvents.length === 0) {
    ctx.fillStyle = "#444";
    ctx.font = "8px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tr("waitingForEvents"), W / 2, H / 2 + 3);
    return;
  }

  var now = Date.now();
  var windowMs = currentTimelineMs;
  var startTime = now - windowMs;

  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(0, 2, W, H - 4);

  var activeSpans = {};
  for (var i = 0; i < timelineEvents.length; i++) {
    var ev = timelineEvents[i];
    if (ev.event === "agent_start") {
      activeSpans[ev.agent] = { start: ev.ts, room: ev.room };
    } else if (ev.event === "agent_stop" && activeSpans[ev.agent]) {
      drawSpan(ctx, W, H, startTime, now, activeSpans[ev.agent].start, ev.ts, activeSpans[ev.agent].room, false);
      delete activeSpans[ev.agent];
    }
  }
  var keys = Object.keys(activeSpans);
  for (var j = 0; j < keys.length; j++) {
    var s = activeSpans[keys[j]];
    drawSpan(ctx, W, H, startTime, now, s.start, now, s.room, true);
  }

  drawTimelineGrid(ctx, W, H, windowMs);
}

function drawTimelineGrid(ctx, W, H, windowMs) {
  ctx.fillStyle = "#555";
  ctx.font = "7px sans-serif";
  ctx.textAlign = "center";

  var totalMin = windowMs / 60000;
  var step, unit;
  if (totalMin <= 5) { step = 1; unit = "m"; }
  else if (totalMin <= 15) { step = 3; unit = "m"; }
  else if (totalMin <= 30) { step = 5; unit = "m"; }
  else if (totalMin <= 60) { step = 15; unit = "m"; }
  else { step = 60; unit = "h"; }

  for (var elapsed = step; elapsed < totalMin; elapsed += step) {
    var x = (elapsed / totalMin) * W;
    ctx.fillRect(x, 0, 0.5, H);
    var remaining = totalMin - elapsed;
    var label = unit === "h" ? "-" + Math.round(remaining / 60) + tr("unitHour") : "-" + Math.round(remaining) + tr("unitMin");
    ctx.fillText(label, x, H - 1);
  }
}

function drawSpan(ctx, W, H, startTime, now, spanStart, spanEnd, room, active) {
  var windowMs = now - startTime;
  var x1 = Math.max(0, ((spanStart - startTime) / windowMs) * W);
  var x2 = Math.min(W, ((spanEnd - startTime) / windowMs) * W);
  if (x2 <= 0 || x1 >= W) return;
  ctx.fillStyle = room ? roomColor(room) : "#888";
  ctx.globalAlpha = active ? 0.8 : 0.5;
  ctx.fillRect(x1, 3, Math.max(x2 - x1, 2), H - 6);
  ctx.globalAlpha = 1;
}

function addLogEntry(agent, event, task, room) {
  var log = document.getElementById("event-log");
  if (!log) return;
  eventCount++;
  var countEl = document.getElementById("log-count");
  if (countEl) countEl.textContent = trCount("events", eventCount);

  var isStart = event === "agent_start";
  var isError = event === "agent_stop" && task === "ERROR";
  var isMain = agent === MAIN_AGENT;
  var cls = isStart ? "start" : isError ? "error" : "stop";
  var arrow = isStart ? "▶" : isError ? "✖" : "✔";
  var label = task && task !== "ERROR" ? shortName(agent) + ": " + task : shortName(agent);
  var time = formatTime(Date.now());

  // Main-model turns still land on the timeline, but "completed" counts agents only.
  if (!isStart && !isError && !isMain) completedCount++;

  var r = room || agentRoomCache[agent] || "lobby";
  agentRoomCache[agent] = r;
  timelineEvents.push({ ts: Date.now(), agent: agent, event: event, room: r });

  var entry = document.createElement("div");
  entry.className = "event-log-entry event-log-entry--" + cls;
  entry.textContent = time + "  " + arrow + "  " + label;
  log.appendChild(entry);

  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ── Emergency stop ──
// Mirrors ~/.claude/office-stop.json (via the extension): while active, the
// stop_gate hook denies every agent tool call. The button and the banner's
// Resume both just ask the extension to toggle the flag.
function renderStop() {
  var banner = document.getElementById("stop-banner");
  if (banner) banner.hidden = !stopActive;
  var btn = document.getElementById("stop-btn");
  if (btn) {
    // While the stop is active, the red banner (with Resume) takes its place.
    btn.hidden = stopActive;
    btn.title = tr("stopBtnTitle");
  }
}

function initStopControls() {
  ["stop-btn", "stop-resume"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", function() {
      vscode.postMessage({ type: "toggle_stop" });
    });
  });
  renderStop();
}

function addStopLogEntry(on) {
  var log = document.getElementById("event-log");
  if (!log) return;
  var entry = document.createElement("div");
  entry.className = "event-log-entry event-log-entry--" + (on ? "error" : "start");
  entry.textContent = formatTime(Date.now()) + "  " + (on ? "🛑" : "▶") + "  " + tr(on ? "logStopOn" : "logStopOff");
  log.appendChild(entry);
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function addWaitingLogEntry(message) {
  var log = document.getElementById("event-log");
  if (!log) return;
  var time = formatTime(Date.now());
  var entry = document.createElement("div");
  entry.className = "event-log-entry event-log-entry--wait";
  entry.textContent = time + "  ✋  " + (message || tr("waitingForYou"));
  log.appendChild(entry);
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

var historyLoaded = false;

// ── Agent drill-down drawer ──
// Click a figure → bottom drawer with the agent's current task, run stats and
// history. The extension answers agent_detail_request and keeps pushing fresh
// details on every state change while the drawer stays open.
var drawerAgent = null;
var drawerRoom = null;
var drawerDetail = null;

function toggleAgentDrawer(name, room) {
  if (drawerAgent === name) closeAgentDrawer();
  else openAgentDrawer(name, room);
}

function openAgentDrawer(name, room) {
  drawerAgent = name;
  drawerRoom = room || null;
  drawerDetail = null;
  renderAgentDrawer();
  vscode.postMessage({ type: "agent_detail_request", name: name });
}

function closeAgentDrawer() {
  drawerAgent = null;
  drawerDetail = null;
  renderAgentDrawer();
  vscode.postMessage({ type: "agent_detail_close" });
}

function drawerStateLabel(state) {
  if (!state) return tr("drawerStateIdle");
  if (state.state === "working") return tr("labelWorking");
  if (state.state === "done") return tr("labelDone");
  if (state.state === "error") return tr("drawerStateError");
  return tr("drawerStateIdle");
}

function drawerDuration(run) {
  if (!run.startedAt) return "";
  if (!run.endedAt) return tr("drawerWorking") + "…";
  var mins = (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60000;
  if (isNaN(mins) || mins < 0) return "";
  if (mins < 1) return "<1" + tr("unitMin");
  return formatDuration(mins);
}

// Everything user-sourced (agent names, task texts) goes in via textContent.
function renderAgentDrawer() {
  var drawer = document.getElementById("agent-drawer");
  if (!drawer) return;
  if (!drawerAgent) {
    drawer.hidden = true;
    drawer.innerHTML = "";
    return;
  }
  drawer.hidden = false;
  drawer.innerHTML = "";

  var detail = drawerDetail;
  var state = detail && detail.state;
  var room = (state && state.room) || drawerRoom || "lobby";

  var header = document.createElement("div");
  header.className = "drawer-header";
  var icon = document.createElement("span");
  icon.className = "agent-icon drawer-icon";
  icon.innerHTML = getAgentIcon(drawerAgent, room); // our own SVG set, not user data
  var titleBox = document.createElement("div");
  titleBox.className = "drawer-title";
  var nameEl = document.createElement("div");
  nameEl.className = "drawer-name";
  nameEl.textContent = drawerAgent;
  var subEl = document.createElement("div");
  subEl.className = "drawer-sub";
  subEl.textContent = roomLabel(room) + " · " + drawerStateLabel(state) +
    (state && state.activeCount > 1 ? " · ×" + state.activeCount : "");
  titleBox.appendChild(nameEl);
  titleBox.appendChild(subEl);
  var closeBtn = document.createElement("button");
  closeBtn.className = "drawer-close";
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = tr("drawerCloseTitle");
  closeBtn.setAttribute("aria-label", tr("drawerClose"));
  closeBtn.addEventListener("click", closeAgentDrawer);
  header.appendChild(icon);
  header.appendChild(titleBox);
  header.appendChild(closeBtn);
  drawer.appendChild(header);

  if (state && state.task) {
    var taskLabel = document.createElement("div");
    taskLabel.className = "drawer-section-label";
    taskLabel.textContent = tr("drawerCurrentTask");
    var taskEl = document.createElement("div");
    taskEl.className = "drawer-task";
    taskEl.textContent = state.task;
    drawer.appendChild(taskLabel);
    drawer.appendChild(taskEl);
  }

  var histLabel = document.createElement("div");
  histLabel.className = "drawer-section-label";
  histLabel.textContent = tr("drawerHistory");
  drawer.appendChild(histLabel);

  if (!detail) {
    var loading = document.createElement("div");
    loading.className = "drawer-empty";
    loading.textContent = tr("drawerLoading");
    drawer.appendChild(loading);
    return;
  }

  var runs = detail.runs || [];
  if (runs.length === 0) {
    var empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = tr("drawerNoHistory");
    drawer.appendChild(empty);
    return;
  }

  var finished = runs.filter(function(r) { return r.endedAt && r.startedAt; });
  var errorCount = runs.filter(function(r) { return r.result === "error"; }).length;
  if (finished.length > 0) {
    var totalMs = finished.reduce(function(sum, r) {
      return sum + Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt));
    }, 0);
    var stats = document.createElement("div");
    stats.className = "drawer-stats";
    stats.textContent = tr("drawerStats", {
      runs: trCount("drawerRuns", runs.length),
      errors: trCount("drawerErrors", errorCount),
      avg: tr("drawerAvg", { d: formatDuration(totalMs / finished.length / 60000) }),
    });
    drawer.appendChild(stats);
  }

  var list = document.createElement("div");
  list.className = "drawer-history";
  for (var i = 0; i < runs.length; i++) {
    (function(run) {
      var row = document.createElement("div");
      row.className = "drawer-run" +
        (run.result === "error" ? " drawer-run--error" : !run.endedAt ? " drawer-run--working" : "");
      var time = document.createElement("span");
      time.className = "drawer-run-time";
      time.textContent = run.startedAt ? formatTime(run.startedAt) : tr("drawerNoStart");
      var dur = document.createElement("span");
      dur.className = "drawer-run-dur";
      dur.textContent = (run.result === "error" ? "⚠ " : "") + drawerDuration(run);
      row.appendChild(time);
      row.appendChild(dur);
      if (run.task) {
        var task = document.createElement("div");
        task.className = "drawer-run-task";
        task.textContent = run.task;
        row.appendChild(task);
      }
      list.appendChild(row);
    })(runs[i]);
  }
  drawer.appendChild(list);
}

document.addEventListener("keydown", function(e) {
  if (e.key === "Escape" && drawerAgent) closeAgentDrawer();
});

window.addEventListener("message", function(evt) { // noqa: secret
  var msg = evt.data;
  if (msg.type === "full_state") {
    var entries = Object.entries(msg.agents);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0], agent = entries[i][1];
      var prev = currentAgents[name];
      agentRoomCache[name] = agent.room;
      if (!prev && agent.state === "working") {
        addLogEntry(name, "agent_start", agent.task, agent.room);
      } else if (prev && prev.state !== agent.state) {
        if (agent.state === "working") addLogEntry(name, "agent_start", agent.task, agent.room);
        else if (agent.state === "done") addLogEntry(name, "agent_stop", agent.task, agent.room);
        else if (agent.state === "error") addLogEntry(name, "agent_stop", "ERROR", agent.room);
      }
    }
    currentAgents = msg.agents;
    if (typeof msg.model !== "undefined") setModel(msg.model);
    if (typeof msg.waiting !== "undefined") {
      if (msg.waiting && !currentWaiting) addWaitingLogEntry(msg.waiting.message);
      currentWaiting = msg.waiting || null;
    }
    render();
  } else if (msg.type === "usage_update") {
    lastUsage = msg.data;
    var subs = (msg.data && msg.data.subscription) || {};
    recordUsageSamples(subs.claude, "claude:");
    recordUsageSamples(subs.kimi, "kimi:");
    renderUsage();
  } else if (msg.type === "usage_error") {
    renderUsageError(msg.source, msg.message);
  } else if (msg.type === "stop_state") {
    var wasStopped = stopActive;
    stopActive = !!msg.active;
    if (wasStopped !== stopActive) addStopLogEntry(stopActive);
    renderStop();
  } else if (msg.type === "agent_detail") {
    if (drawerAgent && msg.detail && msg.detail.name === drawerAgent) {
      drawerDetail = msg.detail;
      renderAgentDrawer();
    }
  }
});

function initTimelineSelector() {
  var sel = document.getElementById("timeline-window");
  if (!sel) return;
  try {
    var saved = localStorage.getItem(TIMELINE_WINDOW_KEY);
    if (saved) {
      var n = parseInt(saved, 10);
      if (!isNaN(n) && n > 0) currentTimelineMs = n;
    }
  } catch(e) { /* localStorage unavailable */ }
  sel.value = String(currentTimelineMs);
  sel.addEventListener("change", function() {
    var n = parseInt(sel.value, 10);
    if (!isNaN(n) && n > 0) {
      currentTimelineMs = n;
      try { localStorage.setItem(TIMELINE_WINDOW_KEY, String(n)); } catch(e) {}
      renderTimeline();
    }
  });
}

function formatUsd(n) {
  if (n == null || isNaN(n)) return "\u2014";
  if (n < 1) return "$" + n.toFixed(2);
  if (n < 100) return "$" + n.toFixed(2);
  return "$" + n.toFixed(0);
}

function formatDuration(mins) {
  if (mins == null || isNaN(mins)) return "";
  if (mins < 60) return Math.round(mins) + tr("unitMin");
  var h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h + tr("unitHour") + (m > 0 ? " " + m + tr("unitMin") : "");
}

function fillBar(bar, pct, valueText, statusClass) {
  if (!bar) return;
  var fill = bar.querySelector(".usage-bar-fill");
  var value = bar.querySelector(".usage-bar-value");
  if (fill) {
    fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
    fill.classList.remove("usage-bar-fill--warn", "usage-bar-fill--crit");
    // Pace-aware status wins when provided; absolute thresholds are the fallback.
    var cls = statusClass || (pct >= 90 ? "usage-bar-fill--crit" : pct >= 70 ? "usage-bar-fill--warn" : null);
    if (cls) fill.classList.add(cls);
  }
  if (value) value.textContent = valueText;
}

function updateBar(kind, cost, limit, subtitle) {
  var pct = 0;
  if (limit && limit > 0) pct = Math.min(100, (cost / limit) * 100);
  var txt = formatUsd(cost);
  if (limit && limit > 0) txt += " / " + formatUsd(limit) + " (" + pct.toFixed(0) + "%)";
  if (subtitle) txt += "  \u00b7  " + subtitle;
  fillBar(document.querySelector('.usage-bar[data-kind="' + kind + '"]'), pct, txt);
}

/** Keep a usage group's caption + bar elements in sync with the reported limit kinds. */
function ensureSubscriptionBars(section, limits, caption) {
  var wantKinds = caption + "|" + limits.map(function(l) { return l.kind; }).join("|");
  if (section.getAttribute("data-kinds") === wantKinds) return;
  section.setAttribute("data-kinds", wantKinds);
  section.textContent = "";
  var cap = document.createElement("div");
  cap.className = "usage-group-caption";
  cap.textContent = caption;
  section.appendChild(cap);
  for (var i = 0; i < limits.length; i++) {
    var bar = document.createElement("div");
    bar.className = "usage-bar";
    bar.setAttribute("data-kind", limits[i].kind);
    var label = document.createElement("div");
    label.className = "usage-bar-label";
    var track = document.createElement("div");
    track.className = "usage-bar-track";
    var fill = document.createElement("div");
    fill.className = "usage-bar-fill";
    track.appendChild(fill);
    var tick = document.createElement("div");
    tick.className = "usage-bar-tick";
    tick.hidden = true;
    track.appendChild(tick);
    var value = document.createElement("div");
    value.className = "usage-bar-value";
    value.textContent = "\u2014";
    bar.appendChild(label);
    bar.appendChild(track);
    bar.appendChild(value);
    section.appendChild(bar);
  }
}

function planLabel(plan) {
  if (!plan) return "";
  return String(plan)
    .replace(/_/g, " ")
    .replace(/\b\w/g, function(ch) { return ch.toUpperCase(); });
}

function resetText(resetsAt) {
  if (!resetsAt) return "";
  var t = Date.parse(resetsAt);
  if (isNaN(t)) return "";
  var mins = (t - Date.now()) / 60000;
  if (mins <= 0) return tr("resetsSoon");
  return tr("resetsIn", { d: formatDuration(mins) });
}

// ── Usage burn-rate forecast ──
// Keeps a rolling window of utilization samples per limit kind and projects
// when the limit hits 100% at the current pace. Persisted in localStorage so
// webview reloads don't lose the trend.
var USAGE_HISTORY_KEY = "aiOffice.usageHistory";
var USAGE_HISTORY_WINDOW_MS = 90 * 60000;
var USAGE_FORECAST_MIN_SPAN_MS = 10 * 60000;
// Hard cap per limit kind: the 90-minute window alone can't bound the array
// if updates arrive pathologically often.
var USAGE_HISTORY_MAX_SAMPLES = 500;
var usageHistory = {}; // kind -> [{t, pct}]
try {
  var savedHist = localStorage.getItem(USAGE_HISTORY_KEY);
  if (savedHist) usageHistory = JSON.parse(savedHist) || {};
} catch(e) { usageHistory = {}; }

function recordUsageSamples(sub, prefix) {
  if (!sub || !sub.limits) return;
  var t = Date.parse(sub.fetchedAt || "");
  if (isNaN(t)) return;
  var changed = false;
  for (var i = 0; i < sub.limits.length; i++) {
    var lim = sub.limits[i];
    var key = prefix + lim.kind; // kinds repeat across providers ("session", "weekly")
    var arr = usageHistory[key] || (usageHistory[key] = []);
    var last = arr[arr.length - 1];
    if (last && last.t >= t) continue; // same snapshot re-broadcast
    // A big utilization drop means the window reset — old trend is meaningless.
    if (last && lim.utilization < last.pct - 5) arr.length = 0;
    arr.push({ t: t, pct: lim.utilization });
    while (arr.length > 0 && t - arr[0].t > USAGE_HISTORY_WINDOW_MS) arr.shift();
    while (arr.length > USAGE_HISTORY_MAX_SAMPLES) arr.shift();
    changed = true;
  }
  if (changed) {
    try { localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(usageHistory)); } catch(e) {}
  }
}

/** Projected epoch-ms when this limit hits 100%, or null if not burning. */
function forecastLimit(lim, historyKey) {
  var arr = usageHistory[historyKey];
  if (!arr || arr.length < 2) return null;
  var first = arr[0], last = arr[arr.length - 1];
  var span = last.t - first.t;
  if (span < USAGE_FORECAST_MIN_SPAN_MS) return null;
  var rate = (last.pct - first.pct) / span;
  if (rate <= 0 || last.pct >= 100) return null;
  return last.t + (100 - last.pct) / rate;
}

function renderForecast(subs) {
  var el = document.getElementById("usage-forecast");
  if (!el) return;
  var worst = null;
  var providers = [
    { snap: subs && subs.claude, prefix: "claude:", name: "Claude Code" },
    { snap: subs && subs.kimi, prefix: "kimi:", name: "Kimi Code" },
  ];
  for (var p = 0; p < providers.length; p++) {
    var sub = providers[p].snap;
    if (!sub || !sub.limits) continue;
    for (var i = 0; i < sub.limits.length; i++) {
      var lim = sub.limits[i];
      var hitAt = forecastLimit(lim, providers[p].prefix + lim.kind);
      if (hitAt == null) continue;
      var resetAt = lim.resetsAt ? Date.parse(lim.resetsAt) : NaN;
      if (!isNaN(resetAt) && hitAt >= resetAt) continue; // window resets first — safe
      if (!worst || hitAt < worst.hitAt) {
        worst = { label: providers[p].name + " " + lim.label, hitAt: hitAt };
      }
    }
  }
  var mins = worst ? (worst.hitAt - Date.now()) / 60000 : 0;
  if (!worst || mins <= 0) {
    el.hidden = true;
    return;
  }
  el.textContent = tr("forecast", { label: worst.label, d: formatDuration(mins) });
  el.classList.toggle("usage-forecast--crit", mins < 60);
  el.hidden = false;
}

/** Render one provider's subscription section; returns fetchedAt for the "updated" line. */
function renderSubSection(sectionId, sub, providerName) {
  var section = document.getElementById(sectionId);
  if (!(section instanceof HTMLElement)) return null;
  if (!sub || !sub.limits || sub.limits.length === 0) {
    section.hidden = true;
    return null;
  }
  section.hidden = false;
  var caption = providerName;
  var plan = planLabel(sub.plan);
  if (plan) caption += "  \u00b7  " + plan;
  ensureSubscriptionBars(section, sub.limits, caption);
  for (var i = 0; i < sub.limits.length; i++) {
    var lim = sub.limits[i];
    var bar = section.querySelector('.usage-bar[data-kind="' + lim.kind + '"]');
    if (!bar) continue;
    var labelEl = bar.querySelector(".usage-bar-label");
    if (labelEl) labelEl.textContent = lim.label;
    var txt = lim.utilization.toFixed(0) + "%";
    var reset = resetText(lim.resetsAt);
    if (reset) txt += "  \u00b7  " + reset;
    var paceKeys = { hot: "paceHot", on_pace: "paceOnPace", room: "paceRoom" };
    if (lim.pace && paceKeys[lim.pace]) txt += "  ·  " + tr(paceKeys[lim.pace]);
    // Pace tick: where the fill would be if the window were used evenly.
    var tick = bar.querySelector(".usage-bar-tick");
    if (tick) {
      if (typeof lim.expectedPct === "number") {
        tick.hidden = false;
        tick.style.left = Math.max(0, Math.min(100, lim.expectedPct)).toFixed(1) + "%";
        tick.title = tr("paceTickHelp");
      } else {
        tick.hidden = true;
      }
    }
    var statusClass = null;
    if (lim.paceStatus === "critical" || lim.paceStatus === "depleted") statusClass = "usage-bar-fill--crit";
    else if (lim.paceStatus === "warning") statusClass = "usage-bar-fill--warn";
    fillBar(bar, lim.utilization, txt, statusClass);
  }
  return sub.fetchedAt || null;
}

function renderUsage() {
  if (!lastUsage) return;
  var subs = lastUsage.subscription || {};
  var cost = lastUsage.cost;

  var costSection = document.getElementById("usage-cost");
  var upd = document.getElementById("usage-updated");

  var fetched = renderSubSection("usage-subscription", subs.claude, "Claude Code");
  var kimiFetched = renderSubSection("usage-kimi", subs.kimi, "Kimi Code");
  if (kimiFetched && (!fetched || kimiFetched > fetched)) fetched = kimiFetched;
  renderForecast(subs);

  if (cost) {
    if (costSection instanceof HTMLElement) costSection.hidden = false;
    var blockSubtitle = "";
    if (cost.block) {
      if (cost.block.isActive && cost.block.remainingMinutes != null) {
        blockSubtitle = tr("blockLeft", { d: formatDuration(cost.block.remainingMinutes) });
      } else if (!cost.block.isActive) {
        blockSubtitle = tr("noActiveBlock");
      }
    }
    updateBar("block", cost.block ? cost.block.costUSD : 0, cost.limits.block, blockSubtitle);
    updateBar("weekly", cost.weekly ? cost.weekly.totalCost : 0, cost.limits.weekly, "");
    updateBar("weekly-opus", cost.weekly ? cost.weekly.opusCost : 0, cost.limits.weeklyOpus, "");
    if (upd) upd.textContent = tr("updatedAt", { t: formatTime(fetched || cost.fetchedAt) });
  } else if (costSection instanceof HTMLElement) {
    costSection.hidden = true;
    if (upd && fetched) upd.textContent = tr("updatedAt", { t: formatTime(fetched) });
  }
}

function renderUsageError(source, message) {
  // Don't let one provider's hiccup wipe live data from the others.
  var subs = (lastUsage && lastUsage.subscription) || {};
  if (source === "cost") {
    if (subs.claude || subs.kimi || (lastUsage && lastUsage.cost)) return;
  } else if (subs[source]) return;
  var upd = document.getElementById("usage-updated");
  if (upd) upd.textContent = tr("usageError", { m: message });
}

localizeDom();
initTimelineSelector();
initIdleToggle();
initStopControls();
vscode.postMessage({ type: "webview_ready" });
// A retained-but-hidden webview can miss messages (e.g. the stop-flag
// auto-release), so ask for a full replay every time we're shown again.
document.addEventListener("visibilitychange", function() {
  if (!document.hidden) vscode.postMessage({ type: "webview_ready" });
});
setInterval(function() { renderTimeline(); renderMainBanner(); }, 2000); // banner: keep "· Nm" duration fresh
setInterval(function() { renderUsage(); }, 30000); // keep "resets in …" countdown fresh
