// Polls a ComfyUI server. Read-only: GET requests only, nothing is queued, cancelled or changed.
//   /api/jobs?status=in_progress  the running job (light; ComfyUI 0.3.7x and later)
//   /api/jobs?status=pending      how many are waiting (only the total is read)
//   /queue                        the running job's workflow - read once per job, it holds every queued graph
//   /history/{id}                 how a job ended (files written, error)
//   /system_stats                 finding the server, version and VRAM
// Older servers without /api/jobs: /prompt (queue_remaining) every poll and /queue when that number changes.
// Step progress is not readable: ComfyUI sends it over the WebSocket only to the client that queued the job.
const { EventEmitter } = require("events");
const { describe, result } = require("./describe");

class ComfySource extends EventEmitter {
  constructor({ candidates, busyMs = 1000, idleMs = 2000, promptChars = 40 } = {}) {
    super();
    this.candidates = candidates;
    this.busyMs = busyMs;
    this.idleMs = idleMs;
    this.promptChars = promptChars;
    this.base = null;
    this.legacy = false;
    this.running = null;           // { id, since, text, kind, model, workflowId }
    this.lastDuration = new Map(); // workflow -> ms the last finished run took (memory only)
    this.stats = null;
    this.statsAt = 0;
    this.legacySeen = { remaining: -1, at: 0, runningId: null, pending: 0 };
  }

  async get(p, ms = 3000) {
    const r = await fetch(this.base + p, { signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(ms)]) });
    if (!r.ok) {
      const e = new Error(`${p} -> HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  start() {
    this.ac = new AbortController();
    this.active = true;
    this.loop();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.ac.abort();
  }

  // the first candidate whose /system_stats answers with ComfyUI's shape ({ system, devices })
  async locate() {
    for (const u of [...new Set(this.candidates().filter(Boolean).map((x) => x.replace(/\/+$/, "")))]) {
      try {
        const r = await fetch(u + "/system_stats", { signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(1000)]) });
        const j = r.ok ? await r.json() : null;
        if (j && j.system && Array.isArray(j.devices)) {
          this.stats = j;
          this.statsAt = Date.now();
          return u;
        }
      } catch {}
    }
    return null;
  }

  async loop() {
    let delay;
    try {
      if (!this.base) {
        this.base = await this.locate();
        this.legacy = false;
      }
      if (!this.base) throw new Error("ComfyUI が見つかりません");
      delay = await this.poll();
    } catch (e) {
      if (!this.active) return;
      if (this.running) this.emit("lost", this.running); // it went away while a job was running (a crash, out of memory...)
      this.base = null;
      this.running = null;
      this.emit("state", { online: false, error: e.message });
      delay = 3000;
    }
    if (this.active) this.timer = setTimeout(() => this.loop(), delay);
  }

  async poll() {
    const q = this.legacy ? await this.queueLegacy() : await this.queueJobs();
    if (this.running && this.running.id !== q.runningId) {
      const ended = this.running;
      this.running = null;
      await this.finished(ended);
    }
    if (q.runningId && !this.running) this.running = { id: q.runningId, since: Date.now(), ...(await this.workflow(q.runningId, q.item)) };
    if (Date.now() - this.statsAt > 15000) {
      try { this.stats = await this.get("/system_stats"); } catch {}
      this.statsAt = Date.now();
    }
    const run = this.running;
    this.emit("state", {
      online: true,
      url: this.base,
      version: (this.stats && this.stats.system && this.stats.system.comfyui_version) || null,
      device: this.stats && this.stats.devices && this.stats.devices[0],
      running: run && { ...run, expectedMs: this.lastDuration.get(run.workflowId) || null },
      pending: q.pending,
    });
    return run || q.pending ? this.busyMs : this.idleMs;
  }

  async queueJobs() {
    let jobs;
    try {
      jobs = await this.get("/api/jobs?status=in_progress");
    } catch (e) {
      if (e.status !== 404) throw e;
      this.legacy = true; // a server from before the jobs API
      return this.queueLegacy();
    }
    const pending = await this.get("/api/jobs?status=pending&limit=1");
    const job = (jobs.jobs || [])[0];
    return { runningId: job ? job.id : null, workflowId: job && job.workflow_id, pending: (pending.pagination && pending.pagination.total) || 0 };
  }

  async queueLegacy() {
    const remaining = ((await this.get("/prompt")).exec_info || {}).queue_remaining || 0;
    const seen = this.legacySeen;
    // a job starting from the waiting list leaves the count unchanged, so look while nothing is known to run
    if (remaining !== seen.remaining || (remaining && !seen.runningId) || Date.now() - seen.at > 10000) {
      const q = remaining ? await this.get("/queue", 15000) : { queue_running: [], queue_pending: [] };
      const item = (q.queue_running || [])[0] || null;
      Object.assign(seen, { remaining, at: Date.now(), runningId: item ? item[1] : null, pending: (q.queue_pending || []).length, item });
    }
    return { runningId: seen.runningId, pending: seen.pending, item: seen.item };
  }

  // the running job's graph, made into a sentence; item is its /queue entry when already at hand
  async workflow(id, item) {
    try {
      if (!item) {
        const q = await this.get("/queue", 15000);
        item = (q.queue_running || []).find((x) => x[1] === id);
      }
      if (!item) return { text: "ワークフローを実行中", kind: null, model: null, workflowId: null };
      const extra = item[3] || {};
      const d = describe(item[2], { promptChars: this.promptChars });
      // same workflow id from the frontend, else the same-looking graph, so the last run's time can be offered
      const wid = extra.workflow_metadata && extra.workflow_metadata.workflow_id;
      if (wid && !this.legacy && !this.lastDuration.has(wid)) {
        try {
          const done = ((await this.get(`/api/jobs?status=completed&workflow_id=${encodeURIComponent(wid)}&limit=1`)).jobs || [])[0];
          if (done && done.execution_start_time && done.execution_end_time) this.lastDuration.set(wid, done.execution_end_time - done.execution_start_time);
        } catch {}
      }
      return { ...d, workflowId: wid || d.text };
    } catch (e) {
      if (!this.active) throw e;
      return { text: "ワークフローを実行中", kind: null, model: null, workflowId: null };
    }
  }

  async finished(job) {
    let r = { status: "unknown", files: "", last: null, error: null, ms: null };
    try {
      const h = await this.get("/history/" + encodeURIComponent(job.id), 10000);
      if (h[job.id]) r = result(h[job.id]);
    } catch (e) {
      if (!this.active) throw e;
    }
    if (!r.ms) r.ms = Date.now() - job.since;
    if (r.status === "success" && job.workflowId) this.lastDuration.set(job.workflowId, r.ms);
    this.emit("finished", { ...job, ...r });
  }
}

module.exports = { ComfySource };

// node addons/comfyui/source.js [url]   prints what it sees, Ctrl+C to stop
if (require.main === module) {
  const url = process.argv[2] || "http://127.0.0.1:8188";
  const src = new ComfySource({ candidates: () => [url] });
  for (const ev of ["state", "finished", "lost"]) src.on(ev, (s) => console.log(ev, JSON.stringify(s)));
  src.start();
}
