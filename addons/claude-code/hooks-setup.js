// Registers / removes the AgentWingman hooks in Claude Code's user settings (used by install-hooks.js and the tray).
// Keeps a timestamped backup of settings.json and touches only hooks that point at this addon's hook.js.
const fs = require("fs");
const os = require("os");
const path = require("path");

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "Notification", "SubagentStart", "SubagentStop", "PreCompact", "Stop", "StopFailure", "SessionEnd"];
const MARK = "addons/claude-code/hook.js"; // how our entries are recognised (Node form)
const EXE_FLAG = "--agent-wingman-hook";    // ... and the exe form
// real path of hook.js (inside a packaged app it is unpacked next to app.asar), with forward slashes for the shell
const HOOK = path.join(__dirname, "hook.js").replace(/app\.asar([\\/])/, "app.asar.unpacked$1").replace(/\\/g, "/");

const defaultSettings = () => path.join(os.homedir(), ".claude", "settings.json");

function read(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return raw.trim() ? JSON.parse(raw) : {}; // a syntax error throws: nothing is changed then
}

const ours = (h) => (typeof h.command === "string" && h.command.replace(/\\/g, "/").includes(MARK)) ||
  (Array.isArray(h.args) && h.args.includes(EXE_FLAG));

function status(file = defaultSettings()) {
  try {
    const hooks = read(file).hooks || {};
    let n = 0;
    for (const groups of Object.values(hooks)) for (const g of groups || []) n += (g.hooks || []).filter(ours).length;
    return { installed: n, file };
  } catch (e) {
    return { installed: 0, file, error: e.message };
  }
}

/**
 * @param opts.uninstall  remove our hooks instead of adding them
 * @param opts.runner     { node: true } (default) or { exe: "<AgentWingman.exe>" } when Node.js is not installed.
 *                        The exe form is Claude Code's "exec form" (command + args, no shell), so it works
 *                        whether hooks run under Git Bash or PowerShell.
 */
function apply(file = defaultSettings(), opts = {}) {
  const settings = read(file);
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-agent-wingman-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backup);
  }
  const hooks = (settings.hooks = settings.hooks || {});
  let removed = 0, added = 0;
  for (const ev of Object.keys(hooks)) { // drop our old entries first, so applying twice never duplicates
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    for (const g of groups) {
      const before = (g.hooks || []).length;
      g.hooks = (g.hooks || []).filter((h) => !ours(h));
      removed += before - g.hooks.length;
    }
    hooks[ev] = groups.filter((g) => (g.hooks || []).length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!opts.uninstall) {
    const exe = opts.runner && opts.runner.exe;
    const entry = exe
      ? { type: "command", command: exe.replace(/\\/g, "/"), args: [EXE_FLAG], async: true, timeout: 5 }
      : { type: "command", command: `node "${HOOK}"`, async: true, timeout: 5 };
    for (const ev of EVENTS) {
      (hooks[ev] = hooks[ev] || []).push({ hooks: [{ ...entry }] });
      added++;
    }
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return { file, backup, added, removed };
}

module.exports = { apply, status, defaultSettings, EVENTS, HOOK, EXE_FLAG };
