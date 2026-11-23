// Addons feed the character. Each addon is a folder with addon.json and a Node module that exports
// activate(ctx). The addon reports what its tool is doing through ctx.update() / ctx.event();
// the core merges every addon's report into one view (see state.js). Addons run in the main process
// with full Node access, so only install ones you trust.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ACTIVITIES = new Set(["idle", "reading", "thinking", "writing", "running"]);
const SIGNALS = new Set(["question", "approval", "complete", "error"]);
const FIELDS = ["online", "activity", "tail", "tailKind", "role", "mode", "model", "tokS", "contextTokens", "title", "note"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

class AddonManager extends EventEmitter {
  constructor({ roots, getConfig, saveConfig, log }) {
    super();
    this.log = log || { info: () => {}, warn: () => {}, error: () => {} };
    this.roots = roots;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.found = new Map();    // id -> { id, dir, manifest, error }
    this.running = new Map();  // id -> { state, stop }
  }

  discover() {
    this.found = new Map(); // a later root (the user's folder) overrides the same id in an earlier one
    for (const root of this.roots) {
      if (!fs.existsSync(root)) continue;
      for (const id of fs.readdirSync(root)) {
        if (id.startsWith("_")) continue;
        const dir = path.join(root, id), file = path.join(dir, "addon.json");
        if (!fs.existsSync(file)) continue;
        try {
          this.found.set(id, { id, dir, manifest: readJson(file) });
        } catch (e) {
          this.found.set(id, { id, dir, manifest: { name: id }, error: `addon.json の書式エラー: ${e.message}` });
        }
      }
    }
    return [...this.found.values()];
  }

  entry(id) {
    const cfg = this.getConfig();
    cfg.addons = cfg.addons || {};
    return (cfg.addons[id] = cfg.addons[id] || {});
  }

  isEnabled(id) {
    const a = this.found.get(id);
    const e = this.getConfig().addons?.[id]?.enabled;
    return e === undefined ? !!(a && a.manifest.enabledByDefault) : !!e;
  }

  startAll() {
    this.discover();
    for (const a of this.found.values()) if (this.isEnabled(a.id)) this.activate(a.id);
    this.emit("change");
  }

  async setEnabled(id, on) {
    this.entry(id).enabled = on;
    this.log.info(`addon ${id} turned ${on ? "on" : "off"} from the tray`);
    this.saveConfig();
    if (on) await this.activate(id);
    else this.deactivate(id);
  }

  async activate(id) {
    if (this.running.has(id)) return;
    const a = this.found.get(id);
    if (!a) return;
    const m = a.manifest;
    const entry = this.entry(id);
    // settings in config.json override the addon's defaults; defaults are written back so they are easy to edit
    const settings = { ...(m.settings || {}), ...(entry.settings || {}) };
    entry.settings = settings;
    this.saveConfig();

    const state = { id, name: m.name || id, short: m.short || (m.name || id).toUpperCase().slice(0, 8), online: false, activity: null, signal: null, updatedAt: Date.now() };
    const run = { state, stop: null, active: true };
    this.running.set(id, run);

    const ctx = {
      id,
      name: state.name,
      dir: a.dir,
      settings,
      update: (patch = {}) => {
        if (!run.active) return;
        for (const k of FIELDS) if (k in patch) state[k] = patch[k];
        if (state.activity && !ACTIVITIES.has(state.activity)) state.activity = "running";
        if ("signal" in patch) {
          const s = patch.signal;
          state.signal = s && SIGNALS.has(s.kind) ? { kind: s.kind, text: s.text || "", ts: s.ts || Date.now() } : null;
        }
        state.updatedAt = Date.now();
        this.emit("change");
      },
      event: (ev = {}) => { if (run.active) this.emit("event", { type: ev.type || "custom", text: ev.text, source: id, ts: Date.now() }); },
      notice: (text) => { if (run.active) this.emit("notice", `${state.name}: ${text}`); }, // a problem the user should see (shown as a bubble, logged)
      log: (...args) => this.log.info(`[${id}]`, ...args),
    };

    if (a.error) {
      state.note = a.error;
      this.emit("notice", `アドオン「${state.name}」: ${a.error}`);
      return;
    }
    try {
      const main = path.join(a.dir, m.main || "index.js");
      for (const key of Object.keys(require.cache)) if (key.startsWith(a.dir + path.sep)) delete require.cache[key]; // reload after edits
      const mod = require(main);
      const r = await mod.activate(ctx);
      run.stop = typeof r === "function" ? r : typeof mod.deactivate === "function" ? () => mod.deactivate() : null;
      this.log.info(`addon on: ${id} (${a.dir})`);
    } catch (e) {
      state.online = false;
      state.note = e.message;
      this.log.error(`addon ${id} failed to start:`, e);
      this.emit("notice", `アドオン「${state.name}」を起動できません: ${e.message}`);
    }
    this.emit("change");
  }

  deactivate(id) {
    const run = this.running.get(id);
    if (!run) return;
    run.active = false;
    try { if (run.stop) run.stop(); } catch (e) { this.log.error(`addon ${id} stop failed:`, e); }
    this.log.info(`addon off: ${id}`);
    this.running.delete(id);
    this.emit("change");
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.deactivate(id);
  }

  states() {
    return [...this.running.values()].map((r) => r.state);
  }
}

module.exports = { AddonManager };
