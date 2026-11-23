// A small app log: startup, settings, addons, skins and errors. Never conversation content.
// Kept in <userData>/logs/wingman.log; at 512 KB it moves to wingman.1.log and a new file starts.
const fs = require("fs");
const path = require("path");

const MAX = 512 * 1024;
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "wingman.log");
  } catch {
    file = null;
  }
  return file;
}

function write(level, args) {
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `${new Date().toISOString()} ${level} ${text}\n`;
  if (level === "ERROR") process.stderr.write(line); else process.stdout.write(line);
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX) fs.renameSync(file, file.replace(/\.log$/, ".1.log"));
    fs.appendFileSync(file, line);
  } catch {}
}

module.exports = {
  init,
  info: (...a) => write("INFO", a),
  warn: (...a) => write("WARN", a),
  error: (...a) => write("ERROR", a),
  get file() { return file; },
};
