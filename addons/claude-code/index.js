// Claude Code addon: receives hook events (via hook.js) and keeps one state per Claude Code session.
// The character shows the session that needs you (newest signal), otherwise the one that worked last.
const http = require("http");
const path = require("path");

const SHORT = 90;
const clip = (s, n = SHORT) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

// one line saying what a tool call does
function describeTool(name, input = {}) {
  const pick = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || "";
  const short = typeof pick === "string" && /[\\/]/.test(pick) && !input.command ? path.basename(pick) : pick;
  return clip(short ? `${name}: ${short}` : name);
}

exports.activate = (ctx) => {
  const { port, forgetIdleMinutes } = ctx.settings;
  const sessions = new Map(); // session_id -> state

  function session(e) {
    let s = sessions.get(e.session_id);
    if (!s) {
      s = { id: e.session_id, activity: "idle", signal: null, tail: "", updatedAt: 0 };
      sessions.set(e.session_id, s);
    }
    if (e.cwd) s.project = path.basename(e.cwd);
    if (e.permission_mode) s.permissionMode = e.permission_mode;
    if (e.model) s.model = typeof e.model === "string" ? e.model : e.model.display_name || e.model.id || s.model;
    return s;
  }

  function handle(e) {
    if (!e || !e.session_id || !e.hook_event_name) return;
    const at = e._receivedAt || Date.now();
    const s = session(e);
    if (at < s.updatedAt) return; // an older async hook arriving late
    s.updatedAt = at;
    const signal = (kind, text) => { s.signal = { kind, text: clip(text, 200), ts: at }; };

    switch (e.hook_event_name) {
      case "SessionStart":
        s.activity = "idle";
        if (e.source === "compact") ctx.event({ type: "truncation", text: "コンテキストを圧縮しました" });
        break;
      case "UserPromptSubmit":
        s.activity = "thinking";
        s.signal = null;
        s.tail = clip(`依頼: ${e.prompt}`, 200);
        s.tailKind = "think";
        break;
      case "PreToolUse":
        s.activity = "running";
        if (s.signal && s.signal.kind === "approval") s.signal = null;
        s.tail = describeTool(e.tool_name, e.tool_input);
        s.tailKind = null;
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        s.activity = "thinking";
        if (s.signal && s.signal.kind === "approval") s.signal = null;
        break;
      case "PermissionRequest":
        signal("approval", describeTool(e.tool_name, e.tool_input));
        break;
      case "Notification": {
        const t = e.notification_type;
        if (t === "permission_prompt") signal("approval", e.message);
        else if (t === "idle_prompt" || t === "agent_needs_input" || t === "elicitation_dialog" || t === "elicitation_url_dialog") {
          if (!(s.signal && s.signal.kind === "complete")) signal("question", e.message || "入力を待っています");
        } else if (t === "agent_completed") signal("complete", e.message);
        else if (e.message) ctx.event({ type: "notice", text: clip(e.message, 40) });
        break;
      }
      case "SubagentStart":
        ctx.event({ type: "subtask-start", text: `サブエージェント出撃！${e.agent_type ? "（" + e.agent_type + "）" : ""}` });
        break;
      case "SubagentStop":
        ctx.event({ type: "subtask-return" });
        break;
      case "PreCompact":
        ctx.event({ type: "truncation", text: e.trigger === "manual" ? "コンテキスト圧縮（手動）" : "コンテキスト圧縮…" });
        break;
      case "Stop":
        s.activity = "idle";
        signal("complete", e.last_assistant_message || "応答が終わりました");
        s.tail = "";
        break;
      case "StopFailure":
        s.activity = "idle";
        signal("error", `${e.error || "error"}${e.error_details ? ": " + e.error_details : ""}`);
        break;
      case "SessionEnd":
        sessions.delete(e.session_id);
        break;
    }
    publish();
  }

  function publish() {
    const now = Date.now();
    for (const [id, s] of sessions) { // forget sessions that went quiet long ago
      if (!s.signal && s.activity === "idle" && now - s.updatedAt > forgetIdleMinutes * 60000) sessions.delete(id);
    }
    const all = [...sessions.values()];
    const waiting = all.filter((s) => s.signal).sort((a, b) => b.signal.ts - a.signal.ts);
    const busy = all.filter((s) => s.activity !== "idle").sort((a, b) => b.updatedAt - a.updatedAt);
    const lead = waiting[0] || busy[0] || all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!lead) {
      ctx.update({ online: true, activity: "idle", signal: null, tail: "", mode: null, role: null });
      return;
    }
    const others = all.length - 1;
    ctx.update({
      online: true,
      activity: busy.length ? busy[0].activity : "idle",
      signal: lead.signal ? { ...lead.signal, text: `${lead.project ? "[" + lead.project + "] " : ""}${lead.signal.text}` } : null,
      tail: lead.tail || "",
      tailKind: lead.tailKind || null,
      mode: lead.project || null,
      role: others > 0 ? `CC +${others}` : "CC",
      model: lead.model || null,
      note: `${all.length} セッション`,
    });
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") { res.writeHead(404); res.end(); return; }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on("end", () => {
      res.writeHead(204);
      res.end();
      try { handle(JSON.parse(body)); } catch (e) { ctx.log("bad hook payload:", e.message); }
    });
  });
  server.on("error", (e) => {
    const why = e.code === "EADDRINUSE" ? "ほかのソフトが使用中" : e.code || e.message;
    ctx.update({ online: false, note: `ポート ${port} を開けません（${why}）` });
    ctx.notice(`ポート ${port} を開けません（${why}）`);
  });
  server.listen(port, "127.0.0.1", () => ctx.update({ online: true, activity: "idle", note: "フック待ち" }));
  const timer = setInterval(publish, 60000);

  return () => { clearInterval(timer); server.close(); };
};
