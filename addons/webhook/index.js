// Webhook addon: a local-only HTTP endpoint so any tool can drive the character.
//   POST /update  {"activity":"thinking","tail":"...","model":"...","mode":"...","role":"MAIN","tokS":42}
//   POST /signal  {"kind":"question|approval|complete|error","text":"..."}   (send {} to clear)
//   POST /event   {"type":"truncation","text":"吹き出しの文"}
//   POST /clear   {}
// Requests must be Content-Type: application/json, which also keeps web pages from posting here.
const http = require("http");

const HELP = `AgentWingman webhook
POST /update  {"activity":"idle|reading|thinking|writing|running","tail":"text","tailKind":"think|output","model":"...","mode":"...","role":"MAIN","tokS":0,"contextTokens":0}
POST /signal  {"kind":"question|approval|complete|error","text":"..."}   ({} clears it)
POST /event   {"type":"truncation|subtask-start|subtask-return|any","text":"bubble text"}
POST /clear   {}
Header: Content-Type: application/json
`;
const UPDATE_KEYS = ["activity", "tail", "tailKind", "role", "mode", "model", "tokS", "contextTokens", "title"];

exports.activate = (ctx) => {
  const { port, idleAfterSeconds } = ctx.settings;
  let idleTimer = null;

  // without news for a while, fall back to idle (a crashed client must not leave the character "thinking")
  function armIdle() {
    clearTimeout(idleTimer);
    if (idleAfterSeconds > 0) idleTimer = setTimeout(() => ctx.update({ activity: "idle", tail: "" }), idleAfterSeconds * 1000);
  }

  function handle(url, j) {
    if (url === "/update") {
      const patch = {};
      for (const k of UPDATE_KEYS) if (k in j) patch[k] = j[k];
      if ("signal" in j) patch.signal = j.signal;
      ctx.update(patch);
      armIdle();
    } else if (url === "/signal") {
      ctx.update({ signal: j.kind ? { kind: j.kind, text: j.text || "" } : null });
    } else if (url === "/event") {
      ctx.event({ type: j.type || "custom", text: j.text });
    } else if (url === "/clear") {
      ctx.update({ signal: null, activity: "idle", tail: "" });
    } else {
      return false;
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(HELP);
      return;
    }
    if (req.method !== "POST" || !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      res.writeHead(415, { "Content-Type": "text/plain" });
      res.end("POST with Content-Type: application/json\n");
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      let j;
      try { j = JSON.parse(body || "{}"); } catch { res.writeHead(400); res.end("invalid JSON\n"); return; }
      if (!handle(url, j || {})) { res.writeHead(404); res.end("unknown path\n"); return; }
      res.writeHead(204);
      res.end();
    });
  });
  server.on("error", (e) => {
    const why = e.code === "EADDRINUSE" ? "ほかのソフトが使用中" : e.code || e.message;
    ctx.update({ online: false, note: `ポート ${port} を開けません（${why}）` });
    ctx.notice(`ポート ${port} を開けません（${why}）。config.json の port を変えてください`);
  });
  server.listen(port, "127.0.0.1", () => ctx.update({ online: true, activity: "idle", note: null }));

  return () => { clearTimeout(idleTimer); server.close(); };
};
