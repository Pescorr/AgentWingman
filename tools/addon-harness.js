// Addon test harness: runs ONE addon outside the app, prints everything it reports, checks it against the
// addon rules, and ends with PASS / FAIL. Made so that an AI agent writing an addon can verify its own work.
//
//   node tools/addon-harness.js <addon folder> [--settings '{"port":8799}'] [--seconds 10] [--drive drive.js]
//
//   --settings  JSON merged over the addon's addon.json "settings"
//   --seconds   how long to watch before stopping the addon (default 8)
//   --drive     a script that makes the watched tool do something while the addon runs (fake server, a
//               request, a UDP message...). It exports async (log) => { ... } and is awaited after start.
//   --expect-online  fail if the addon never reports online (use when the watched tool / a fake is running)
//
// Nothing here touches the user's AgentWingman settings: the config lives only in memory.
const fs = require("fs");
const path = require("path");
const { AddonManager } = require("../src/addons");
const { combine } = require("../src/state");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--settings" && args[args.indexOf(a) - 1] !== "--seconds" && args[args.indexOf(a) - 1] !== "--drive");
if (!dir) {
  console.log('usage: node tools/addon-harness.js <addon folder> [--settings \'{"key":1}\'] [--seconds 8] [--drive drive.js]');
  process.exit(2);
}
const addonDir = path.resolve(dir);
const id = path.basename(addonDir);
const seconds = Number(opt("--seconds", 8));
const results = [];
const check = (ok, what, detail = "") => { results.push({ ok, what, detail }); console.log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? " - " + detail : ""}`); };
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6) + "s";

// ---------- static checks: addon.json ----------
console.log(`== ${id} (${addonDir})`);
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(addonDir, "addon.json"), "utf8").replace(/^﻿/, "")); } catch (e) { check(false, "addon.json is readable JSON", e.message); }
if (manifest) {
  check(typeof manifest.name === "string" && manifest.name.length > 0, "addon.json has a name");
  check(typeof manifest.short === "string" && manifest.short.length > 0 && manifest.short.length <= 10, "addon.json has a short name (<= 10 chars) for the lamp", String(manifest.short));
  check(!manifest.settings || (typeof manifest.settings === "object" && !Array.isArray(manifest.settings)), "settings is an object");
  check(fs.existsSync(path.join(addonDir, manifest.main || "index.js")), "main file exists", manifest.main || "index.js");
  check(manifest.enabledByDefault !== true, "enabledByDefault is not true (users opt in)");
}
if (id.startsWith("_")) check(false, "folder name does not start with _", "folders starting with _ are never loaded");

// ---------- run it ----------
const ACTIVITIES = new Set(["idle", "reading", "thinking", "writing", "running", null, undefined]);
let settings = {};
try { settings = JSON.parse(opt("--settings", "{}")); } catch (e) { check(false, "--settings is JSON", e.message); }
const cfg = { addons: { [id]: { enabled: true, settings } } };
const manager = new AddonManager({
  roots: [path.dirname(addonDir)], getConfig: () => cfg, saveConfig: () => {},
  log: { info: (...a) => console.log(ts(), "log ", ...a), warn: (...a) => console.log(ts(), "WARN", ...a), error: (...a) => console.log(ts(), "ERR ", ...a) },
});
let updates = 0, wentOnline = false, badActivity = null, badSignal = null, events = 0, notices = 0, lastLine = "";
manager.on("change", () => {
  const s = manager.states().find((x) => x.id === id);
  if (!s) return;
  updates++;
  if (s.online) wentOnline = true;
  if (!ACTIVITIES.has(s.activity)) badActivity = s.activity;
  if (s.signal && !["question", "approval", "complete", "error"].includes(s.signal.kind)) badSignal = s.signal.kind;
  const v = combine(manager.states());
  const line = `${v.mood.padEnd(8)} online=${s.online ? "y" : "n"} activity=${s.activity}${s.signal ? ` signal=${s.signal.kind}` : ""}` +
    `${v.role ? ` role=${v.role}` : ""}${v.mode ? ` mode=${v.mode}` : ""}${v.model ? ` model=${v.model}` : ""}${v.tokS ? ` tok/s=${v.tokS}` : ""}` +
    `${v.contextTokens ? ` ctx=${v.contextTokens}` : ""}${v.tail ? ` tail="${v.tail.slice(-60)}"` : ""}${s.note ? ` note="${s.note}"` : ""}`;
  if (line !== lastLine) { console.log(ts(), "view", line); lastLine = line; }
});
manager.on("event", (e) => { events++; console.log(ts(), "evt ", e.type, e.text || ""); });
manager.on("notice", (t) => { notices++; console.log(ts(), "note", t); });

(async () => {
  console.log("-- running");
  manager.discover();
  await manager.activate(id);
  const run = manager.running.get(id);
  check(!!run && !run.state.note?.startsWith("addon.json"), "activate() ran", run && run.state.note ? run.state.note : "");
  check(!!(run && run.stop), "activate() returned a stop function (or the module exports deactivate)");
  const driver = opt("--drive", null);
  if (driver) {
    try { await require(path.resolve(driver))((...a) => console.log(ts(), "drv ", ...a)); } catch (e) { check(false, "--drive script ran", e.message); }
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));

  console.log("-- stopping");
  manager.deactivate(id);
  check(updates > 0, "reported at least once with ctx.update()", `${updates} updates`);
  if (args.includes("--expect-online") || wentOnline) check(wentOnline, "went online at some point");
  else console.log("  warn went online at some point - never online (fine if the watched tool was not running; use --expect-online to require it)");
  check(badActivity === null, "activity values are valid", badActivity ? `got "${badActivity}"` : "");
  check(badSignal === null, "signal kinds are valid", badSignal ? `got "${badSignal}"` : "");
  console.log(`   (${events} events, ${notices} notices)`);

  // a clean stop leaves nothing running: timers, servers and watchers must be closed by the stop function
  const timer = setTimeout(() => {
    check(false, "stop function cleaned up", "something is still running 3s after stopping (timer, server, socket or watcher)");
    summary();
    process.exit(1);
  }, 3000);
  timer.unref();
  process.on("beforeExit", () => {
    check(true, "stop function cleaned up", "nothing left running");
    summary();
  });
})();

let summarized = false;
function summary() {
  if (summarized) return;
  summarized = true;
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `RESULT: FAIL (${failed.length} of ${results.length} checks)` : `RESULT: PASS (${results.length} checks)`);
  process.exitCode = failed.length ? 1 : 0;
}
