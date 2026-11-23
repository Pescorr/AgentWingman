// Makes the AgentWingman version of a llama-server launch .bat (used by make-bat.js and by the launcher).
// The original file is never changed. The only edit: the llama-server command gets
// "-v --log-prefix --log-colors off" and its output is piped through tap.js.
const fs = require("fs");
const path = require("path");

// real path of tap.js: inside a packaged app it is unpacked next to app.asar
const TAP = path.join(__dirname, "tap.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

function inspect(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /llama-server(\.exe)?"?(\s|\^|$)/i.test(l) && !/^\s*(rem|::|echo)\b/i.test(l));
  if (start < 0) return { kind: "not-llama", lines };
  let end = start;
  while (end < lines.length - 1 && /\^\s*$/.test(lines[end])) end++; // follow the ^ line continuations
  if (lines.slice(start, end + 1).some((l) => /tap\.js/i.test(l))) return { kind: "wingman", lines };
  return { kind: "plain", lines, start, end };
}

// kind of a .bat on disk: "plain" (llama-server, not yet AgentWingman), "wingman", or "not-llama"
function kindOf(file) {
  try { return inspect(fs.readFileSync(file, "latin1")).kind; } catch { return "not-llama"; }
}

const defaultOut = (src) => path.join(path.dirname(src), path.basename(src, path.extname(src)) + "_wingman.bat");

/**
 * @param src     the original .bat
 * @param opts.out       output path (default: <name>_wingman.bat next to the original)
 * @param opts.tapRunner how to run tap.js: { node: true } (default) or { exe: "<AgentWingman.exe>" } for machines without Node.js
 * @returns { out, status: "created" | "exists" | "already-wingman" | "not-llama" }
 */
function makeWingmanBat(src, opts = {}) {
  const text = fs.readFileSync(src, "latin1"); // keep the bytes as they are (bats are usually ANSI)
  const info = inspect(text);
  if (info.kind === "wingman") return { out: src, status: "already-wingman" };
  if (info.kind === "not-llama") return { out: null, status: "not-llama" };
  const out = opts.out || defaultOut(src);
  if (path.resolve(out) === path.resolve(src)) throw new Error("output would overwrite the original");
  if (!opts.out && fs.existsSync(out) && kindOf(out) === "wingman") return { out, status: "exists" };

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = info.lines.slice();
  const indent = (lines[info.end].match(/^\s*/) || [""])[0] || "    ";
  const exe = opts.tapRunner && opts.tapRunner.exe;
  const runner = exe ? `"${exe}" "${TAP}"` : `node "${TAP}"`;
  lines[info.end] = lines[info.end].replace(/\s*$/, "") + " ^";
  lines.splice(info.end + 1, 0, `${indent}-v --log-prefix --log-colors off 2>&1 | ${runner}`);
  const head = ["REM AgentWingman: llama-server's log goes through tap.js (shown below as usual; nothing is saved to disk)"];
  if (exe) head.push('set "ELECTRON_RUN_AS_NODE=1"'); // lets AgentWingman.exe run tap.js the way Node.js would
  lines.splice(info.start, 0, ...head);
  fs.writeFileSync(out, lines.join(eol), "latin1");
  return { out, status: "created" };
}

module.exports = { makeWingmanBat, kindOf, TAP };
