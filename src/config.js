// User settings, kept as JSON in the app's user-data folder so the program folder stays read-only.
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  sound: true,
  character: "builtin",                     // "builtin" or a folder name under characters\
  characterDirs: [],                        // more folders to look in for characters (tray: キャラクターを探すフォルダを追加)
  show: {                                   // what is on screen
    character: true,                        // the character itself (signals still show as a bubble)
    panel: true,                            // the task window (the panel left of the character) as a whole
    tags: true,                             // MAIN / mode / model
    state: true,                            // the state label and tok/s
    thinking: true,                         // live thinking / answer text
    footer: true,                           // context size and addon lamps
  },
  tailLines: 2,                             // lines of live text in the panel
  launcher: {                               // shortcut tiles shown in a bubble while nothing is running
    enabled: true,
    autoShow: true,                         // open by itself after idleSeconds; otherwise only by clicking the character
    idleSeconds: 30,
    wingmanizeLlamaBats: true,              // a dropped llama-server .bat is registered as its AgentWingman version
    items: [],                              // { label, path } - apps, files, shortcuts or folders
  },
  overlay: {                                // full-screen, click-through layer (styles from kusa_commenter)
    enabled: false,
    routes: {                               // which style each kind of content uses: scroll / toast / chatlog / banner / off
      thinking: "scroll",
      work: "scroll",                       // the panel's gray line: what the agent is doing (e.g. the tool it runs)
      output: "chatlog",
      signal: "banner",                     // question / approval / complete / error
      event: "toast",                       // context compression, subtasks, addon events
      status: "off",                        // state changes (思考中, 待機中 ...)
    },
    lanes: 9,                               // scroll: rows of flowing comments
    scrollSpeed: 400,                       // scroll: pixels per second (±30% each)
    fontSize: 26,
    opacity: 0.9,
    maxChars: 40,                           // live text is cut into pieces of about this length
    toastBottom: 230,                       // toast: distance from the bottom of the screen (clears the character)
    chatlogWidth: 800,
    chatlogLines: 12,
    chatlogHoldSeconds: 2,                  // chat lines stay this long ...
    chatlogFadeSeconds: 6,                  // ... then fade out over this long (0 = stay until pushed out)
    chatlogOpacity: 0.85,                   // chat lines are this much fainter than the rest
  },
  alwaysOnTopLevel: "screen-saver",         // stays above borderless-fullscreen games
  addons: {},                               // <id>: { enabled, settings } - see ADDONS.md
  position: null,                           // {x, y} after you drag the character
  size: null,                               // {width, height} after you resize the panel
};

// Settings from before addons existed move into the addons that now own them.
function migrate(saved) {
  const addons = { ...(saved.addons || {}) };
  if ("strataUrl" in saved && !addons.strata) {
    addons.strata = saved.strataUrl ? { enabled: true, settings: { url: saved.strataUrl } } : { enabled: false };
  }
  if ("zoocodeTasksDir" in saved && !addons.zoocode) {
    const settings = { tasksDir: saved.zoocodeTasksDir };
    if (saved.staleSeconds) settings.staleSeconds = saved.staleSeconds;
    if (saved.approvalGraceMs) settings.approvalGraceMs = saved.approvalGraceMs;
    addons.zoocode = { enabled: false, settings };
  }
  const out = { ...saved, addons };
  for (const k of ["strataUrl", "zoocodeTasksDir", "staleSeconds", "approvalGraceMs"]) delete out[k];
  return out;
}

function loadConfig(file) {
  try {
    const saved = migrate(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))); // tolerate a BOM from Notepad
    return {
      ...DEFAULTS, ...saved,
      show: { ...DEFAULTS.show, ...(saved.show || {}) },
      launcher: { ...DEFAULTS.launcher, items: [], ...(saved.launcher || {}) },
      overlay: { ...DEFAULTS.overlay, ...(saved.overlay || {}), routes: { ...DEFAULTS.overlay.routes, ...((saved.overlay || {}).routes || {}) } },
    };
  } catch {
    return {
      ...DEFAULTS, show: { ...DEFAULTS.show }, launcher: { ...DEFAULTS.launcher, items: [] }, addons: {},
      overlay: { ...DEFAULTS.overlay, routes: { ...DEFAULTS.overlay.routes } },
    };
  }
}

// returns null when saved, otherwise the error (the caller logs it and tells the user)
function saveConfig(file, cfg) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file); // a crash mid-write never leaves a half-written config.json
    return null;
  } catch (e) {
    return e;
  }
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
