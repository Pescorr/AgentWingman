// Reads Zoocode (Roo Code family) task files and turns the most recently written task into a small status object.
// Read-only: never writes to the extension's storage.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const EDITORS = ["Code", "Code - Insiders", "Cursor", "VSCodium", "Windsurf"];
const EXTENSIONS = ["zoocodeorganization.zoo-code", "rooveterinaryinc.roo-cline"];

function findTasksDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  for (const ext of EXTENSIONS) {
    for (const editor of EDITORS) {
      const dir = path.join(appData, editor, "User", "globalStorage", ext, "tasks");
      if (fs.existsSync(dir)) return dir;
    }
  }
  return null;
}

// What an unanswered "ask" means for the user
const ASK_KIND = {
  followup: "question",
  command: "approval",
  tool: "approval",
  use_mcp_server: "approval",
  browser_action_launch: "approval",
  auto_approval_max_req_reached: "approval",
  completion_result: "complete",
  api_req_failed: "error",
  mistake_limit_reached: "error",
  resume_task: "idle",
  resume_completed_task: "idle",
};

// What the agent is doing when the newest message is a "say"
const SAY_ACTIVITY = {
  reasoning: "thinking",
  text: "writing",
  api_req_started: "thinking",
  command_output: "running",
  mcp_server_request_started: "running",
  mcp_server_response: "running",
  tool: "running",
  subtask_result: "running",
  user_feedback: "running",
  sliding_window_truncation: "running",
  condense_context: "running",
  error: "error",
  diff_error: "error",
  api_req_retry_delayed: "error",
  completion_result: "complete",
};

// Messages that should make the character react once
const ONE_SHOT = {
  sliding_window_truncation: "truncation",
  condense_context: "truncation",
  subtask_result: "subtask-return",
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function askText(m) {
  const t = m.text || "";
  try {
    const j = JSON.parse(t);
    if (j.question) return j.question;
    if (j.tool) return `${j.tool} ${j.path || ""}`.trim();
    if (j.toolName) return `${j.serverName || "mcp"}:${j.toolName}`;
    return t;
  } catch {
    return t; // command asks carry the bare command line
  }
}

function deriveState(messages, history = {}) {
  const last = messages[messages.length - 1];
  let pending = null;
  let activity = null;

  if (last && last.type === "ask") {
    const kind = ASK_KIND[last.ask];
    const auto = last.autoApprovalDecision === "approve";
    if (last.isAnswered === true || last.partial) {
      activity = "running"; // an approved tool or command is executing
    } else if (kind === "approval" && auto) {
      activity = "running";
    } else if (kind && kind !== "idle") {
      pending = { kind, ask: last.ask, text: askText(last), ts: last.ts };
      activity = kind;
    }
  } else if (last && last.type === "say") {
    activity = SAY_ACTIVITY[last.say] || "running";
  }

  let contextTokens = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].say !== "api_req_started") continue;
    try {
      const j = JSON.parse(messages[i].text || "{}");
      const n = (j.tokensIn || 0) + (j.tokensOut || 0) + (j.cacheReads || 0) + (j.cacheWrites || 0);
      if (n > 0) { contextTokens = n; break; }
    } catch {}
  }

  let lastText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.text && (m.say === "reasoning" || m.say === "text" || m.say === "completion_result")) {
      lastText = m.text.slice(-400);
      break;
    }
  }

  return {
    taskId: history.id || null,
    mode: history.mode || null,
    parentTaskId: history.parentTaskId || null,
    title: String(history.task || "").split("\n")[0].slice(0, 80),
    activity,
    pending,
    lastTs: last ? last.ts : null,
    contextTokens,
    lastText,
    messageCount: messages.length,
  };
}

class ZoocodeSource extends EventEmitter {
  constructor({ tasksDir, approvalGraceMs = 1500 } = {}) {
    super();
    this.dir = tasksDir;
    this.grace = approvalGraceMs;
    this.active = null;
    this.seen = new Map();       // taskId -> message count at the last read
    this.timers = new Map();
    this.parents = new Map();    // taskId -> history item (for subtask depth)
    this.state = null;
  }

  start() {
    if (!this.dir || !fs.existsSync(this.dir)) {
      this.state = { available: false, reason: "Zoocodeのタスクフォルダが見つかりません" };
      this.emit("state", this.state);
      return;
    }
    this.active = this.newestTask();
    if (this.active) this.read(this.active, true);
    else this.emit("state", (this.state = { available: true, activity: null, pending: null }));

    this.watcher = fs.watch(this.dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      const parts = file.split(/[\\/]/);
      if (parts.length < 2 || !/^(ui_messages|history_item)\.json$/.test(parts[1])) return;
      this.schedule(parts[0], 60); // let the write finish
    });
    this.watcher.on("error", (e) => this.emit("error", e));
    this.tick = setInterval(() => this.active && this.read(this.active), 5000);
  }

  stop() {
    if (this.watcher) this.watcher.close();
    clearInterval(this.tick);
    for (const t of this.timers.values()) clearTimeout(t);
  }

  schedule(taskId, ms) {
    clearTimeout(this.timers.get(taskId));
    this.timers.set(taskId, setTimeout(() => { this.timers.delete(taskId); this.read(taskId); }, ms));
  }

  newestTask() {
    let best = null, bestTime = 0;
    for (const id of fs.readdirSync(this.dir)) {
      try {
        const t = fs.statSync(path.join(this.dir, id, "ui_messages.json")).mtimeMs;
        if (t > bestTime) { bestTime = t; best = id; }
      } catch {}
    }
    return best;
  }

  depthOf(parentId) {
    let depth = 0, id = parentId;
    while (id && depth < 8) {
      depth++;
      if (!this.parents.has(id)) {
        try { this.parents.set(id, readJson(path.join(this.dir, id, "history_item.json"))); } catch { this.parents.set(id, null); }
      }
      id = this.parents.get(id) && this.parents.get(id).parentTaskId;
    }
    return depth;
  }

  read(taskId, initial = false, retry = 0) {
    const dir = path.join(this.dir, taskId);
    let messages, history = {};
    try {
      messages = readJson(path.join(dir, "ui_messages.json"));
    } catch {
      if (retry < 2) setTimeout(() => this.read(taskId, initial, retry + 1), 120); // caught mid-write
      return;
    }
    try { history = readJson(path.join(dir, "history_item.json")); } catch {}

    const isNew = !this.seen.has(taskId);
    const prev = isNew ? Math.max(0, messages.length - 1) : this.seen.get(taskId);
    this.seen.set(taskId, messages.length);
    if (!initial) {
      for (const m of messages.slice(prev)) {
        const ev = m.type === "say" && ONE_SHOT[m.say];
        if (ev) this.emit("event", { type: ev, ts: m.ts });
      }
      if (isNew && history.parentTaskId) this.emit("event", { type: "subtask-start", ts: Date.now() });
    }

    this.active = taskId; // the task written most recently is the one on screen
    const st = deriveState(messages, history);
    st.available = true;
    st.depth = history.parentTaskId ? this.depthOf(history.parentTaskId) : 0;
    // auto-approved tools are written as an ask first; only call it "waiting" if it is still open after the grace time
    if (st.pending && st.pending.kind === "approval" && Date.now() - st.pending.ts < this.grace) {
      st.pending = null;
      st.activity = "running";
      this.schedule(taskId, this.grace);
    }
    this.state = st;
    this.emit("state", st);
  }
}

module.exports = { ZoocodeSource, findTasksDir, deriveState };

// node src/zoocode.js [tasksDir] [--once]  - prints what the character would see
if (require.main === module) {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) || findTasksDir();
  console.log("tasks dir:", dir);
  const src = new ZoocodeSource({ tasksDir: dir });
  src.on("state", (s) => console.log(JSON.stringify({ ...s, lastText: (s.lastText || "").slice(-80) }, null, 1)));
  src.on("event", (e) => console.log("EVENT", e));
  src.start();
  if (process.argv.includes("--once")) setTimeout(() => { src.stop(); }, 300);
}
