// Claude Code hook command: forwards the hook's JSON (stdin) to the AgentWingman Claude Code addon.
// Registered as an async command hook, so it never slows Claude Code down. It prints nothing and always
// exits 0: stdout of some hooks (UserPromptSubmit, SessionStart) would otherwise be added to Claude's context.
// Runs under Node.js, or inside AgentWingman.exe (--agent-wingman-hook) on machines without Node.js.
const fs = require("fs");
const http = require("http");

const port = Number(process.env.AGENT_WINGMAN_PORT || 8766);

function send(body) {
  let data;
  try { data = JSON.parse(body); } catch { process.exit(0); }
  data._receivedAt = Date.now(); // async hooks may arrive out of order
  const payload = Buffer.from(JSON.stringify(data));
  const req = http.request({ host: "127.0.0.1", port, path: "/hook", method: "POST", timeout: 1500,
    headers: { "Content-Type": "application/json", "Content-Length": payload.length } }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));   // AgentWingman not running: nothing to do
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(payload);
}

if (process.versions.electron && process.type === "browser") {
  // Electron's main process on Windows gets no data events from process.stdin; read the handle directly
  let body = "";
  try { body = fs.readFileSync(0, "utf8"); } catch {}
  send(body);
} else {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { body += c; });
  process.stdin.on("end", () => send(body));
}
setTimeout(() => process.exit(0), 3000).unref();
