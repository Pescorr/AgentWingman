// Pipe target for `llama-server ... -v --log-prefix 2>&1 | node tap.js`.
// - Shows llama-server's normal log in the console as before (debug lines are hidden).
// - Sends only the generated text and request progress to AgentWingman over local UDP.
// UDP is fire-and-forget: if AgentWingman is closed or slow, messages are simply dropped and
// llama-server is never held up. Nothing is written to disk. This process ends with llama-server.
//   node tap.js [--port 8767] [--show-debug]
const dgram = require("dgram");
const path = require("path");

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const PORT = Number(opt("--port", 8767));
const SHOW_DEBUG = argv.includes("--show-debug");

// ---------- sending (batched, never blocks) ----------
const sock = dgram.createSocket("udp4");
sock.on("error", () => {}); // e.g. nothing listening: ignore
let queue = [], flushTimer = null;
function send(msg) {
  queue.push(msg);
  if (!flushTimer) flushTimer = setTimeout(flush, 60);
}
function flush() {
  flushTimer = null;
  while (queue.length) {
    const batch = [];
    let size = 2;
    while (queue.length && size < 48000) { const s = JSON.stringify(queue[0]); size += s.length + 1; batch.push(queue.shift()); }
    sock.send(Buffer.from(JSON.stringify(batch)), PORT, "127.0.0.1", () => {});
  }
}
// ---------- reading llama-server's log ----------
let model = null;
const modelName = () => (model ? path.basename(String(model)).replace(/\.gguf$/i, "") : null);
// the heartbeat carries the model name, so AgentWingman started later still learns it
setInterval(() => send({ t: "alive", model: modelName() }), 2000);
function json(s) { try { return JSON.parse(s); } catch { return null; } }

function inspect(line) {
  // streamed chunks: "... http: streamed chunk: data: {...}" (a chunk may carry several "data:" events)
  const d = line.indexOf("data: {");
  if (d >= 0) {
    const j = json(line.slice(d + 6).trim());
    if (!j) return;
    if (j.model && j.model !== model) { model = j.model; send({ t: "model", name: modelName() }); }
    const c = (j.choices && j.choices[0]) || null;
    if (c) {
      const delta = c.delta || {};
      const r = delta.reasoning_content || delta.reasoning || "", txt = delta.content || "";
      if (r || txt) send({ t: "d", r, c: txt });
      if (c.finish_reason) send({ t: "end" });
    }
    if (j.timings) {
      const tm = j.timings;
      send({ t: "timing", tps: tm.predicted_per_second || null, ctx: (tm.prompt_n || 0) + (tm.cache_n || 0) + (tm.predicted_n || 0) || null });
    }
    return;
  }
  // the whole reply, also for non-streaming requests
  const p = line.indexOf("Parsed message: {");
  if (p >= 0) {
    const j = json(line.slice(p + 16).trim());
    if (j) send({ t: "final", r: j.reasoning_content || "", c: j.content || "" });
    return;
  }
  // a request was taken up by a slot (prompt processing starts)
  // ("processing task" alone also appears on internal queue lines for every token, so match the slot lines)
  if (/launch_slot_/.test(line)) send({ t: "start" });
  else if (/slot\s+release:/.test(line)) send({ t: "release" });
}

let level = "I", buf = "";
function onLine(raw) {
  const line = raw.replace(/\r$/, "");
  const m = line.match(/^(?:[\d.]+\s+)?([DIWE])\s/); // --log-prefix (and optional --log-timestamps)
  if (m) level = m[1];
  else if (line && !/^\s|^data:|^\{/.test(line)) level = "I"; // a plain line is ordinary output, not a debug continuation
  if (level !== "D" || SHOW_DEBUG) process.stdout.write(line + "\n");
  inspect(line);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
});
process.stdin.on("end", () => {
  if (buf) onLine(buf);
  send({ t: "bye" });
  flush();
  setTimeout(() => process.exit(0), 200);
});
