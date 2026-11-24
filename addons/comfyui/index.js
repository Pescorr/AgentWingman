// ComfyUI addon: what the running workflow makes, how long it has taken, how many are waiting,
// and a signal when the queue is done or a job fails.
const { ComfySource } = require("./source");
const { mmss } = require("./describe");

const COMMON_PORTS = [8188, 8000, 8189]; // ComfyUI's default, the ComfyUI desktop app, a second instance

exports.activate = (ctx) => {
  const { url, busyPollMs, idlePollMs, promptChars, eventEachJob } = ctx.settings;
  const candidates = () => (url === "auto" ? COMMON_PORTS.map((p) => `http://127.0.0.1:${p}`) : [url]);
  const src = new ComfySource({ candidates, busyMs: busyPollMs, idleMs: idlePollMs, promptChars });

  // one batch = from the queue starting to the queue being empty again
  let batch = { done: 0, failed: 0, lastError: null, last: null };
  let signal = null, wasBusy = false;

  src.on("finished", (j) => {
    const took = j.ms ? mmss(j.ms) : null;
    if (j.status === "error") {
      batch.failed++;
      batch.lastError = j.error || "エラーで止まりました";
      signal = { kind: "error", text: batch.lastError, ts: Date.now() };
      ctx.update({ signal });
    } else if (j.status === "interrupted") {
      ctx.event({ type: "comfy-interrupted", text: "ComfyUI：中断しました" });
    } else {
      batch.done++;
      batch.last = j;
      if (eventEachJob) ctx.event({ type: "comfy-done", text: `1件完了${j.files ? `（${j.files}${took ? `・${took}` : ""}）` : took ? `（${took}）` : ""}` });
    }
  });

  src.on("lost", () => ctx.event({ type: "comfy-lost", text: "ComfyUI が実行中に応答しなくなりました" }));

  src.on("state", (s) => {
    if (!s.online) {
      wasBusy = false;
      ctx.update({ online: false, activity: null, signal: null, tail: "", role: null, mode: null, model: null, note: url === "auto" ? "ComfyUI が見つかりません（8188 / 8000 / 8189）" : `ComfyUI（${url}）に接続できません` });
      return;
    }
    const busy = !!s.running || s.pending > 0;
    if (busy && !wasBusy) {
      // a new batch: the last one's result has been seen or replaced
      batch = { done: 0, failed: 0, lastError: null, last: null };
      signal = null;
    }
    if (!busy && wasBusy && (batch.done || batch.failed)) {
      const n = batch.done + batch.failed;
      if (batch.failed) signal = { kind: "error", text: `${n}件中${batch.failed}件エラー：${batch.lastError}`, ts: Date.now() };
      else {
        const files = batch.last && batch.last.files;
        signal = { kind: "complete", text: `ComfyUI：${n > 1 ? `${n}件すべて` : ""}完了${files ? `（${files}${batch.last.last ? `、最後は ${batch.last.last}` : ""}）` : ""}`, ts: Date.now() };
      }
    }
    wasBusy = busy;

    const d = s.device;
    const vram = d && d.vram_total ? `・VRAM 空き ${(d.vram_free / 2 ** 30).toFixed(1)} / ${(d.vram_total / 2 ** 30).toFixed(1)} GB` : "";
    const note = `ComfyUI${s.version ? " " + s.version : ""} ${s.url}${vram}`;
    const r = s.running;
    if (!r) {
      ctx.update({ online: true, activity: busy ? "running" : "idle", signal, tail: busy ? `順番待ち ${s.pending}件` : "", tailKind: null, role: s.pending ? `待ち${s.pending}件` : null, mode: null, model: null, note });
      return;
    }
    const elapsed = Date.now() - r.since;
    ctx.update({
      online: true,
      activity: "running",
      signal,
      tail: r.text,            // changes only when the job changes, so the overlay shows it once per job
      tailKind: null,
      role: s.pending ? `待ち${s.pending}件` : "COMFY",
      mode: `経過 ${mmss(elapsed)}${r.expectedMs ? ` / 前回 ${mmss(r.expectedMs)}` : ""}`,
      model: r.model,
      note,
    });
  });

  src.start();
  return () => src.stop();
};
