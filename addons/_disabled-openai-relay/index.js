// OpenAI-compatible relay: clients talk to http://127.0.0.1:<listenPort>, every request is forwarded unchanged
// to the upstream server (llama-server, LM Studio, Ollama ...), and generation responses are read on the way
// back to show the thinking and the answer as they stream.
const http = require("http");
const https = require("https");
const { ThinkSplitter } = require("../_lib/stream");

const GEN_PATH = /\/(chat\/)?completions$/;
const KEEP = 2000; // characters of thinking / answer kept per request

exports.activate = (ctx) => {
  const { listenPort, upstream, watchSlots, statusPollMs } = ctx.settings;
  const up = new URL(upstream);
  const client = up.protocol === "https:" ? https : http;
  let online = false, model = null, seq = 0, current = null, flushTimer = null;
  const running = new Set();

  // ---------- what the character shows ----------
  function publish() {
    flushTimer = null;
    const r = current;
    if (!r) {
      ctx.update({ online, activity: "idle", tail: "", model, tokS: null });
      return;
    }
    const writing = r.output.length > 0;
    // pieces received in the last 2 seconds (an average since the first token is skewed by pauses)
    const now = Date.now();
    while (r.recent.length && now - r.recent[0] > 2000) r.recent.shift();
    const live = r.recent.length >= 3 ? Math.round((r.recent.length / Math.max(0.5, (now - r.recent[0]) / 1000)) * 10) / 10 : null;
    ctx.update({
      online: true,
      activity: r.done ? "idle" : writing ? "writing" : r.reasoning ? "thinking" : "reading",
      tail: r.done ? "" : writing ? r.output.slice(-200) : r.reasoning.slice(-200),
      tailKind: writing ? "output" : "think",
      model: r.model || model,
      tokS: r.tokS || live,
      contextTokens: r.contextTokens || null,
    });
  }
  const schedule = () => { if (!flushTimer) flushTimer = setTimeout(publish, 120); };

  function track(reqJson) {
    // the model name comes from the server's reply (clients often send a placeholder such as "local-model")
    const r = { id: ++seq, model: null, reasoning: "", output: "", pieces: 0, recent: [], firstTokenAt: 0, done: false, split: new ThinkSplitter(), sse: "", raw: "" };
    running.add(r);
    current = r;
    schedule();
    return r;
  }
  function add(r, reasoning, content) {
    if (!r.firstTokenAt && (reasoning || content)) r.firstTokenAt = Date.now();
    if (reasoning || content) r.recent.push(Date.now());
    if (reasoning) { r.reasoning = (r.reasoning + reasoning).slice(-KEEP); r.pieces++; }
    if (content) {
      r.split.push(content, (think, text) => {
        if (!text) return;
        if (think) r.reasoning = (r.reasoning + text).slice(-KEEP);
        else r.output = (r.output + text).slice(-KEEP);
      });
      r.pieces++;
    }
    if (r === current) schedule();
  }
  function stats(r, j) {
    const t = j.timings;
    if (t && t.predicted_per_second) r.tokS = Math.round(t.predicted_per_second * 10) / 10;
    if (t && t.prompt_n != null) r.contextTokens = (t.prompt_n || 0) + (t.cache_n || 0) + (t.predicted_n || 0);
    else if (j.usage && j.usage.total_tokens) r.contextTokens = j.usage.total_tokens;
    if (j.model && !r.model) r.model = j.model;
  }
  function onSse(r, chunk) {
    r.sse += chunk;
    let nl;
    while ((nl = r.sse.indexOf("\n")) >= 0) {
      const line = r.sse.slice(0, nl).trim();
      r.sse = r.sse.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const c = (j.choices && j.choices[0]) || {};
        const d = c.delta || {};
        add(r, d.reasoning_content || d.reasoning || "", d.content || c.text || "");
        stats(r, j);
      } catch {}
    }
  }
  function finish(r, nonStreamBody) {
    if (nonStreamBody) {
      try {
        const j = JSON.parse(nonStreamBody);
        const msg = (j.choices && j.choices[0] && (j.choices[0].message || j.choices[0])) || {};
        add(r, msg.reasoning_content || msg.reasoning || "", msg.content || msg.text || "");
        stats(r, j);
      } catch {}
    }
    running.delete(r);
    r.done = true;
    if (r === current) {
      current = [...running].pop() || null; // another request still running? show it
      publish();
    }
  }

  // ---------- the relay ----------
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      const isGen = req.method === "POST" && GEN_PATH.test(req.url.split("?")[0]);
      let reqJson = null;
      if (isGen) try { reqJson = JSON.parse(body.toString("utf8")); } catch {}
      const headers = { ...req.headers, host: up.host, "content-length": body.length };
      if (isGen) delete headers["accept-encoding"]; // keep the reply readable (no gzip)
      const r = isGen ? track(reqJson) : null;
      const preq = client.request({ protocol: up.protocol, hostname: up.hostname, port: up.port, path: req.url, method: req.method, headers }, (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        if (!r) { pres.pipe(res); return; }
        const sse = /event-stream/i.test(pres.headers["content-type"] || "");
        pres.setEncoding("utf8");
        pres.on("data", (c) => {
          res.write(c);
          if (sse) onSse(r, c); else r.raw += c;
        });
        pres.on("end", () => { res.end(); finish(r, sse ? null : r.raw); });
        pres.on("error", () => { res.destroy(); finish(r); });
      });
      preq.on("error", (e) => {
        if (r) finish(r);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `AgentWingman relay: upstream ${upstream} unreachable (${e.code || e.message})` } }));
      });
      res.on("close", () => { if (!res.writableEnded) preq.destroy(); }); // the client gave up: stop upstream too
      preq.end(body);
    });
  });
  server.on("error", (e) => ctx.update({ online: false, note: `ポート ${listenPort} を開けません（${e.code || e.message}）` }));
  server.listen(listenPort, "127.0.0.1", () => ctx.update({ online: false, activity: "idle", note: `中継 127.0.0.1:${listenPort} → ${upstream}` }));

  // ---------- upstream status: online, model name, and work done without the relay (/slots) ----------
  async function poll() {
    try {
      const m = await fetch(upstream + "/v1/models", { signal: AbortSignal.timeout(2000) });
      online = m.ok;
      if (m.ok) { const j = await m.json(); model = (j.data && j.data[0] && j.data[0].id) || model; }
    } catch { online = false; }
    let outside = false;
    if (online && watchSlots && !current) {
      try {
        const s = await fetch(upstream + "/slots", { signal: AbortSignal.timeout(2000) });
        if (s.ok) outside = (await s.json()).some((x) => x.is_processing);
      } catch {}
    }
    if (current) return;
    ctx.update(outside
      ? { online, activity: "thinking", tail: "（リレーを通らないリクエストを処理中。本文は見えません）", tailKind: "think", model }
      : { online, activity: "idle", tail: "", model });
  }
  poll();
  const timer = setInterval(poll, statusPollMs);

  return () => { clearInterval(timer); clearTimeout(flushTimer); server.close(); };
};
