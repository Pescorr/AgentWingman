// Polls a Strata server: /metrics for what the engine is doing, and the API monitor (/api/requests,
// needs "api_monitor": true in the run config) for the thinking and answer text as they are generated.
// Read-only: GET requests only.
const { EventEmitter } = require("events");

class StrataSource extends EventEmitter {
  /**
   * @param baseUrl    one fixed server, or
   * @param candidates a function returning the URLs to try in order (a server may move to another port);
   *                   the first one answering like a Strata server is used until it stops answering
   */
  constructor({ baseUrl = "http://127.0.0.1:8080", candidates = null, idleMs = 1000, busyMs = 250, tailChars = 200 } = {}) {
    super();
    this.candidates = candidates || (() => [baseUrl]);
    this.base = null;
    this.idleMs = idleMs;
    this.busyMs = busyMs;
    this.tailChars = tailChars;
    this.state = { online: false };
    this.model = null;
    this.monitor = null;   // "on" | "off" | null (not checked yet)
    this.recId = null;
    this.phase = null;
    this.lastBusy = false;
  }

  async get(p) {
    const r = await fetch(this.base + p, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      const e = new Error(`${p} -> HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  start() {
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  // the first candidate whose /metrics answers with Strata's shape ({ live: ... })
  async locate() {
    for (const u of [...new Set(this.candidates().filter(Boolean).map((x) => x.replace(/\/+$/, "")))]) {
      try {
        const r = await fetch(u + "/metrics", { signal: AbortSignal.timeout(1000) });
        if (r.ok && (await r.json()).live) return u;
      } catch {}
    }
    return null;
  }

  async loop() {
    let delay;
    try {
      if (!this.base) this.base = await this.locate();
      if (!this.base) throw new Error("no Strata server found");
      delay = await this.poll();
    } catch (e) {
      this.base = null;    // look again next time: the server may come back on another port
      this.model = null;
      this.monitor = null; // check again after the server comes back (it may have been restarted with another config)
      this.state = { online: false, error: e.message };
      this.emit("state", this.state);
      delay = 3000;
    }
    if (this.running) this.timer = setTimeout(() => this.loop(), delay);
  }

  async poll() {
    const m = await this.get("/metrics");
    if (!this.model) {
      try { this.model = ((await this.get("/v1/models")).data || [])[0]?.id || "?"; } catch { this.model = "?"; }
    }
    const live = m.live || {};
    const busy = live.state === "reading" || live.state === "generating";
    const st = {
      online: true,
      url: this.base,
      model: this.model,
      server: live.state || "unknown",
      busy,
      tokS: live.tok_s ?? null,
      generated: live.generated ?? null,
      promptTokens: live.prompt_tokens ?? null,
      monitor: this.monitor,
      phase: null,
      reasoningTail: "",
      outputTail: "",
    };
    if (busy || this.lastBusy) await this.readRecord(st); // one extra read after it finishes so the tail is complete
    if (busy) st.phase = live.state === "reading" ? "reading" : this.phase || "thinking";
    this.lastBusy = busy;
    this.state = st;
    this.emit("state", st);
    return busy ? this.busyMs : this.idleMs;
  }

  async readRecord(st) {
    if (this.monitor === "off") return;
    try {
      const list = (await this.get("/api/requests")).requests || [];
      this.monitor = st.monitor = "on";
      const newest = list[0];
      if (!newest) return;
      const rec = await this.get("/api/requests?id=" + newest.id);
      const reasoning = rec.reasoning || "", output = rec.output || "";
      if (newest.id !== this.recId) {
        this.recId = newest.id;
        this.rLen = this.oLen = 0;
        this.phase = null;
      }
      if (output.length > this.oLen) this.phase = "writing";
      else if (reasoning.length > this.rLen) this.phase = "thinking";
      this.rLen = reasoning.length;
      this.oLen = output.length;
      st.reasoningTail = reasoning.slice(-this.tailChars);
      st.outputTail = output.slice(-this.tailChars);
      st.reasoningLen = reasoning.length;
      st.outputLen = output.length;
    } catch (e) {
      if (e.status !== 404) throw e;
      this.monitor = st.monitor = "off"; // api_monitor is not enabled in this run config
    }
  }
}

module.exports = { StrataSource };

// node src/strata.js [url] [--once]
if (require.main === module) {
  const url = process.argv.slice(2).find((a) => !a.startsWith("--")) || "http://127.0.0.1:8080";
  const src = new StrataSource({ baseUrl: url });
  src.on("state", (s) => {
    console.log(JSON.stringify(s));
    if (process.argv.includes("--once")) src.stop();
  });
  src.start();
}
