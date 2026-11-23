// llama.cpp log addon: receives what tap.js picks out of llama-server's verbose log (local UDP)
// and shows the request being processed, the thinking and the answer as they are generated.
const dgram = require("dgram");
const { ThinkSplitter } = require("../_lib/stream");

const KEEP = 2000;

exports.activate = (ctx) => {
  const { port, offlineAfterMs } = ctx.settings;
  let lastSeen = 0, model = null, r = null, flushTimer = null;

  const fresh = () => ({ reasoning: "", output: "", recent: [], split: new ThinkSplitter(), done: false, tokS: null, contextTokens: null });

  function add(reasoning, content) {
    if (!r || r.done) r = fresh();
    if (reasoning || content) r.recent.push(Date.now());
    if (reasoning) r.reasoning = (r.reasoning + reasoning).slice(-KEEP);
    if (content) r.split.push(content, (think, text) => {
      if (!text) return;
      if (think) r.reasoning = (r.reasoning + text).slice(-KEEP);
      else r.output = (r.output + text).slice(-KEEP);
    });
  }

  function handle(m) {
    switch (m.t) {
      case "start": if (!r || r.done) r = fresh(); break;
      case "d": add(m.r, m.c); break;
      case "final": // the whole reply: only needed when nothing was streamed (non-streaming requests)
        if (!r || (!r.reasoning && !r.output)) { r = fresh(); add(m.r, m.c); }
        r.done = true;
        break;
      case "end": case "release": if (r) r.done = true; break;
      case "timing": if (r) { r.tokS = m.tps ? Math.round(m.tps * 10) / 10 : r.tokS; r.contextTokens = m.ctx || r.contextTokens; } break;
      case "model": model = m.name; break;
      case "alive": if (m.model) model = m.model; break;
      case "bye": lastSeen = 0; r = null; break; // llama-server ended
    }
  }

  function publish() {
    flushTimer = null;
    const online = Date.now() - lastSeen < offlineAfterMs;
    if (!online || !r || r.done) {
      // keep the last context size on screen after a reply (it arrives with the final chunk)
      ctx.update({ online, activity: "idle", tail: "", model, tokS: null, contextTokens: online && r ? r.contextTokens : null, note: online ? null : "llama-server（ログ連携）待ち" });
      return;
    }
    const now = Date.now();
    while (r.recent.length && now - r.recent[0] > 2000) r.recent.shift();
    const live = r.recent.length >= 3 ? Math.round((r.recent.length / Math.max(0.5, (now - r.recent[0]) / 1000)) * 10) / 10 : null;
    const writing = r.output.length > 0;
    ctx.update({
      online: true,
      activity: writing ? "writing" : r.reasoning ? "thinking" : "reading",
      tail: writing ? r.output.slice(-200) : r.reasoning.slice(-200),
      tailKind: writing ? "output" : "think",
      model,
      tokS: r.tokS || live,
      contextTokens: r.contextTokens,
      note: null,
    });
  }

  const sock = dgram.createSocket("udp4");
  sock.on("message", (buf) => {
    let list;
    try { list = JSON.parse(buf.toString("utf8")); } catch { return; }
    lastSeen = Date.now();
    for (const m of Array.isArray(list) ? list : [list]) handle(m);
    if (!flushTimer) flushTimer = setTimeout(publish, 100);
  });
  sock.on("error", (e) => {
    const why = e.code === "EADDRINUSE" ? "ほかのソフトが使用中" : e.code || e.message;
    ctx.update({ online: false, note: `UDP ${port} を開けません（${why}）` });
    ctx.notice(`受信用のポート ${port} を開けません（${why}）`);
  });
  sock.bind(port, "127.0.0.1", () => publish());
  const timer = setInterval(publish, 2000); // notices when llama-server stops sending

  return () => { clearInterval(timer); clearTimeout(flushTimer); sock.close(); };
};
