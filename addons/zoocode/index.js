// Zoocode addon: turns the newest task's files into activity, signals and one-shot events.
const { ZoocodeSource, findTasksDir } = require("./source");

const LIVE = new Set(["thinking", "writing", "running"]);

exports.activate = (ctx) => {
  const { tasksDir, staleSeconds, approvalGraceMs } = ctx.settings;
  const src = new ZoocodeSource({ tasksDir: tasksDir === "auto" ? findTasksDir() : tasksDir, approvalGraceMs });
  let last = null;

  function publish() {
    const z = last;
    if (!z) return;
    if (!z.available) {
      ctx.update({ online: false, activity: null, signal: null, note: z.reason });
      return;
    }
    const fresh = !!z.lastTs && Date.now() - z.lastTs < staleSeconds * 1000;
    let signal = z.pending ? { kind: z.pending.kind, text: z.pending.text, ts: z.pending.ts } : null;
    if (!signal && fresh && z.activity === "error") signal = { kind: "error", text: z.lastText, ts: z.lastTs };
    ctx.update({
      online: true,
      activity: fresh && LIVE.has(z.activity) ? z.activity : "idle",
      signal,
      tail: fresh ? z.lastText : "",
      tailKind: fresh ? z.lastTextKind : null,
      role: z.taskId ? (z.depth > 0 ? `SUB ${z.depth}` : "MAIN") : null,
      mode: z.mode,
      title: z.title,
      contextTokens: z.contextTokens,
      note: null,
    });
  }

  src.on("state", (s) => { last = s; publish(); });
  src.on("event", (e) => ctx.event({ type: e.type }));
  src.on("error", (e) => ctx.log("watch error:", e.message));
  src.start();
  const timer = setInterval(publish, 15000); // lets old activity fall back to idle
  return () => { clearInterval(timer); src.stop(); };
};
