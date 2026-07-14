// @ts-check
// noqa: secret
var vscode = acquireVsCodeApi();
var currentAgents = {};
var eventCount = 0;
var completedCount = 0;
var timelineEvents = [];
var agentRoomCache = {};
var TIMELINE_WINDOW_KEY = "claudeOffice.timelineWindowMs";
var currentTimelineMs = 5 * 60 * 1000;
var lastUsage = null;
var currentWaiting = null;
var stopActive = false;
// The main chat model is visualized by the top banner, not a room figure.
var MAIN_AGENT = "Claude (main)";
var mainWorkingSince = null;
var HIDE_IDLE_KEY = "claudeOffice.hideIdleAgents";
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
    claudeWaiting: "Claude is waiting for you",
    claudeWorking: "Claude is working",
    claudeFinished: "Claude finished the turn",
    statusActive: "{n} active",
    statusClaudeWorking: "Claude working",
    statusIdle: "idle",
    statusOffline: "offline",
    events: ["event", "events"],
    idleAgents: ["idle", "idle"],
    idleTitleCollapsed: "Idle agents are collapsed into per-room “+N” chips. Click to show them.",
    idleTitleExpanded: "Click to collapse idle agents into per-room “+N” chips.",
    waitingForEvents: "waiting for events...",
    floorEmpty: "No agents in this project yet — rooms appear as Claude Code works here",
    resetsSoon: "resets soon",
    resetsIn: "resets in {d}",
    updatedAt: "updated {t}",
    usageError: "error: {m}",
    forecast: "⚠ {label} hits 100% in ~{d} at the current pace",
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
    stopHint: "All agent tool calls are blocked. Press Resume or just send Claude a new prompt.",
    stopResume: "Resume",
    stopBtnTitle: "Emergency stop — block all agent tool calls now",
    resumeBtnTitle: "Emergency stop is active — click to resume",
    logStopOn: "EMERGENCY STOP — agents blocked",
    logStopOff: "emergency stop released",
  },
  ru: {
    waitingForYou: "ждёт вашего ответа",
    claudeWaiting: "Claude ждёт вас",
    claudeWorking: "Claude работает",
    claudeFinished: "Claude завершил ход",
    statusActive: "{n} активно",
    statusClaudeWorking: "Claude работает",
    statusIdle: "без задач",
    statusOffline: "офлайн",
    events: ["событие", "события", "событий"],
    idleAgents: ["неактивный", "неактивных", "неактивных"],
    idleTitleCollapsed: "Неактивные агенты свёрнуты в чипы «+N» по комнатам. Нажмите, чтобы показать их.",
    idleTitleExpanded: "Нажмите, чтобы свернуть неактивных агентов в чипы «+N» по комнатам.",
    waitingForEvents: "ожидание событий...",
    floorEmpty: "В этом проекте пока нет агентов — комнаты появятся, когда Claude Code начнёт здесь работать",
    resetsSoon: "скоро сброс",
    resetsIn: "сброс через {d}",
    updatedAt: "обновлено {t}",
    usageError: "ошибка: {m}",
    forecast: "⚠ {label} достигнет 100% через ~{d} при текущем темпе",
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
    stopHint: "Все вызовы инструментов агентов блокируются. Нажмите «Продолжить» или просто отправьте Claude новый промпт.",
    stopResume: "Продолжить",
    stopBtnTitle: "Экстренная остановка — немедленно заблокировать все вызовы инструментов",
    resumeBtnTitle: "Экстренная остановка активна — нажмите, чтобы возобновить",
    logStopOn: "ЭКСТРЕННАЯ ОСТАНОВКА — агенты заблокированы",
    logStopOff: "экстренная остановка снята",
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

function render() {
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

    var tips = '<div class="tooltip-name">' + name + (instances ? " ×" + instances : "") + "</div>";
    if (agent.task) tips += '<div class="tooltip-task">' + agent.task + "</div>";
    if (agent.lastActivity) tips += '<div class="tooltip-time">' + formatTime(agent.lastActivity) + "</div>";

    el.innerHTML =
      '<span class="agent-icon">' + getAgentIcon(name, agent.room) + "</span>" +
      '<span class="agent-name">' + shortName(name) + "</span>" +
      (instances ? '<span class="agent-instances">×' + instances + "</span>" : "") +
      '<div class="agent-tooltip">' + tips + "</div>";
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
  else if (mainAgent && mainAgent.state === "working") setStatus("status-dot--on", tr("statusClaudeWorking"));
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
    if (titleEl) titleEl.textContent = tr("claudeWaiting");
    if (msgEl) msgEl.textContent = currentWaiting.message || "";
    banner.hidden = false;
    return;
  }

  if (main && main.state === "working") {
    if (!mainWorkingSince) mainWorkingSince = Date.now();
    banner.classList.add("waiting-banner--working");
    if (iconEl) iconEl.textContent = "⚡";
    var title = tr("claudeWorking");
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
    if (titleEl) titleEl.textContent = tr("claudeFinished");
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
  var isMain = agent === "Claude (main)";
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
    btn.classList.toggle("stop-btn--active", stopActive);
    btn.title = tr(stopActive ? "resumeBtnTitle" : "stopBtnTitle");
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
    recordUsageSamples(msg.data && msg.data.subscription);
    renderUsage();
  } else if (msg.type === "usage_error") {
    renderUsageError(msg.source, msg.message);
  } else if (msg.type === "stop_state") {
    var wasStopped = stopActive;
    stopActive = !!msg.active;
    if (wasStopped !== stopActive) addStopLogEntry(stopActive);
    renderStop();
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

function fillBar(bar, pct, valueText) {
  if (!bar) return;
  var fill = bar.querySelector(".usage-bar-fill");
  var value = bar.querySelector(".usage-bar-value");
  if (fill) {
    fill.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%";
    fill.classList.remove("usage-bar-fill--warn", "usage-bar-fill--crit");
    if (pct >= 90) fill.classList.add("usage-bar-fill--crit");
    else if (pct >= 70) fill.classList.add("usage-bar-fill--warn");
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

/** Keep #usage-subscription bar elements in sync with the reported limit kinds. */
function ensureSubscriptionBars(section, limits) {
  var wantKinds = limits.map(function(l) { return l.kind; }).join("|");
  if (section.getAttribute("data-kinds") === wantKinds) return;
  section.setAttribute("data-kinds", wantKinds);
  section.textContent = "";
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
var USAGE_HISTORY_KEY = "claudeOffice.usageHistory";
var USAGE_HISTORY_WINDOW_MS = 90 * 60000;
var USAGE_FORECAST_MIN_SPAN_MS = 10 * 60000;
var usageHistory = {}; // kind -> [{t, pct}]
try {
  var savedHist = localStorage.getItem(USAGE_HISTORY_KEY);
  if (savedHist) usageHistory = JSON.parse(savedHist) || {};
} catch(e) { usageHistory = {}; }

function recordUsageSamples(sub) {
  if (!sub || !sub.limits) return;
  var t = Date.parse(sub.fetchedAt || "");
  if (isNaN(t)) return;
  var changed = false;
  for (var i = 0; i < sub.limits.length; i++) {
    var lim = sub.limits[i];
    var arr = usageHistory[lim.kind] || (usageHistory[lim.kind] = []);
    var last = arr[arr.length - 1];
    if (last && last.t >= t) continue; // same snapshot re-broadcast
    // A big utilization drop means the window reset — old trend is meaningless.
    if (last && lim.utilization < last.pct - 5) arr.length = 0;
    arr.push({ t: t, pct: lim.utilization });
    while (arr.length > 0 && t - arr[0].t > USAGE_HISTORY_WINDOW_MS) arr.shift();
    changed = true;
  }
  if (changed) {
    try { localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(usageHistory)); } catch(e) {}
  }
}

/** Projected epoch-ms when this limit hits 100%, or null if not burning. */
function forecastLimit(lim) {
  var arr = usageHistory[lim.kind];
  if (!arr || arr.length < 2) return null;
  var first = arr[0], last = arr[arr.length - 1];
  var span = last.t - first.t;
  if (span < USAGE_FORECAST_MIN_SPAN_MS) return null;
  var rate = (last.pct - first.pct) / span;
  if (rate <= 0 || last.pct >= 100) return null;
  return last.t + (100 - last.pct) / rate;
}

function renderForecast(sub) {
  var el = document.getElementById("usage-forecast");
  if (!el) return;
  var worst = null;
  if (sub && sub.limits) {
    for (var i = 0; i < sub.limits.length; i++) {
      var lim = sub.limits[i];
      var hitAt = forecastLimit(lim);
      if (hitAt == null) continue;
      var resetAt = lim.resetsAt ? Date.parse(lim.resetsAt) : NaN;
      if (!isNaN(resetAt) && hitAt >= resetAt) continue; // window resets first — safe
      if (!worst || hitAt < worst.hitAt) worst = { label: lim.label, hitAt: hitAt };
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

function renderUsage() {
  if (!lastUsage) return;
  var sub = lastUsage.subscription;
  var cost = lastUsage.cost;

  var subSection = document.getElementById("usage-subscription");
  var costSection = document.getElementById("usage-cost");
  var planEl = document.getElementById("usage-plan");
  var upd = document.getElementById("usage-updated");

  if (sub && sub.limits && sub.limits.length > 0 && subSection instanceof HTMLElement) {
    subSection.hidden = false;
    if (planEl instanceof HTMLElement) {
      var label = planLabel(sub.plan);
      planEl.hidden = !label;
      planEl.textContent = label;
    }
    ensureSubscriptionBars(subSection, sub.limits);
    for (var i = 0; i < sub.limits.length; i++) {
      var lim = sub.limits[i];
      var bar = subSection.querySelector('.usage-bar[data-kind="' + lim.kind + '"]');
      if (!bar) continue;
      var labelEl = bar.querySelector(".usage-bar-label");
      if (labelEl) labelEl.textContent = lim.label;
      var txt = lim.utilization.toFixed(0) + "%";
      var reset = resetText(lim.resetsAt);
      if (reset) txt += "  \u00b7  " + reset;
      fillBar(bar, lim.utilization, txt);
    }
    if (upd) upd.textContent = tr("updatedAt", { t: formatTime(sub.fetchedAt) });
  }
  renderForecast(sub);

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
    if (!sub && upd) upd.textContent = tr("updatedAt", { t: formatTime(cost.fetchedAt) });
  } else if (costSection instanceof HTMLElement) {
    costSection.hidden = true;
  }
}

function renderUsageError(source, message) {
  // Don't let a cost-source hiccup wipe live subscription data (and vice versa).
  if (lastUsage && lastUsage.subscription && source === "cost") return;
  var upd = document.getElementById("usage-updated");
  if (upd) upd.textContent = tr("usageError", { m: message });
}

localizeDom();
initTimelineSelector();
initIdleToggle();
initStopControls();
vscode.postMessage({ type: "webview_ready" });
setInterval(function() { renderTimeline(); renderMainBanner(); }, 2000); // banner: keep "· Nm" duration fresh
setInterval(function() { renderUsage(); }, 30000); // keep "resets in …" countdown fresh
