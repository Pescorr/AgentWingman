// Character skins: a folder with skin.json and pose images (or one sprite sheet).
// The images only need the poses; body motion (breathing, hopping, shaking) and signs ("!", stars, sweat)
// are added by the app, so a skin stays small and easy to make with an image AI.
const fs = require("fs");
const path = require("path");

// The character folder format this version reads. A skin.json without "format" is format 1.
// Rule for future changes: only ADD optional keys while staying at 1; bump it only for a change older
// versions would misread, and keep reading every older format.
const SUPPORTED_FORMAT = 1;

const STATES = ["idle", "reading", "thinking", "writing", "running", "question", "approval", "complete", "error", "offline"];
// a state without its own images borrows these
const FALLBACK = { reading: "thinking", thinking: "idle", writing: "idle", running: "writing", question: "idle", approval: "question", complete: "idle", error: "idle", offline: "idle" };
const DEFAULT_MOTION = { idle: "breathe", reading: "scan", thinking: "breathe", writing: "breathe", running: "breathe", question: "hop", approval: "breathe", complete: "jump", error: "shake", offline: "dim" };
const DEFAULT_EFFECT = { thinking: "dots", question: "mark", complete: "stars", error: "sweat" };
const MIME = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webm": "video/webm" };
// Notepad and PowerShell may save UTF-8 with a BOM, which JSON.parse rejects
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

function listSkins(roots) {
  const found = new Map(); // a later root (the user's folder) overrides the same name in an earlier one
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      if (id.startsWith("_")) continue; // _template and other kits
      const dir = path.join(root, id), file = path.join(dir, "skin.json");
      if (!fs.existsSync(file)) continue;
      try {
        const j = readJson(file);
        found.set(id, { id, name: j.name || id, dir });
      } catch {
        found.set(id, { id, name: `${id}（skin.json の書式エラー）`, dir, broken: true });
      }
    }
  }
  return [...found.values()];
}

function loadSkin(dir) {
  const j = readJson(path.join(dir, "skin.json"));
  const format = j.format === undefined ? 1 : Number(j.format);
  if (!Number.isInteger(format) || format < 1) throw new Error(`skin.json の format が不正です（${j.format}）`);
  if (format > SUPPORTED_FORMAT) throw new Error(`新しい形式（format ${format}）のキャラクターです。AgentWingman を更新してください`);
  const warnings = [];
  // file name -> { mime }. Only names: the window reads each file itself when it is shown (a character
  // can have hundreds of frames, and reading them all up front stalled the PC at startup)
  const images = {};

  function image(rel) {
    if (images[rel]) return rel;
    const p = path.resolve(dir, rel);
    if (!p.startsWith(path.resolve(dir) + path.sep)) { warnings.push(`${rel} はキャラクターフォルダの外です`); return null; }
    if (!fs.existsSync(p)) { warnings.push(`${rel} が見つかりません`); return null; }
    images[rel] = { mime: MIME[path.extname(p).toLowerCase()] || "image/png" };
    return rel;
  }

  const sheet = j.sheet ? { image: image(j.sheet.file), cols: j.sheet.cols || 1, rows: j.sheet.rows || 1, cells: j.sheet.cells || {} } : null;

  function frame(f) {
    const o = typeof f === "string" ? { file: f } : f || {};
    let res = null;
    if (sheet && sheet.image && o.file in sheet.cells) {
      const i = sheet.cells[o.file];
      res = { image: sheet.image, cols: sheet.cols, rows: sheet.rows, col: i % sheet.cols, row: Math.floor(i / sheet.cols) };
    } else if (o.file) {
      const key = image(o.file);
      if (key) res = { image: key, cols: 1, rows: 1, col: 0, row: 0 };
    }
    if (!res) return null;
    const one = { ...res, x: o.x || 0, y: o.y || 0, scale: o.scale || 1 };
    return Array(Math.max(1, Math.floor(o.hold || 1))).fill(one); // "hold": n shows the frame n ticks
  }

  const states = {};
  for (const s of STATES) {
    const def = (j.states || {})[s];
    if (!def) continue;
    const list = Array.isArray(def) ? def : def.frames || [];
    const frames = list.flatMap((f) => frame(f) || []);
    // a looping video (e.g. transparent VP9 WebM) plays instead of the frames; the frames stay as the fallback
    const video = !Array.isArray(def) && def.video ? image(def.video) : null;
    if (!frames.length && !video) continue;
    states[s] = {
      frames,
      video,
      fps: def.fps || j.fps || 6,
      loop: def.loop !== false,
      motion: def.motion || DEFAULT_MOTION[s],
      effect: def.effect === undefined ? DEFAULT_EFFECT[s] || null : def.effect,
    };
  }
  if (!states.idle) throw new Error("idle の画像・動画がありません（skin.json の states.idle）");
  for (const s of STATES) {
    if (states[s]) continue;
    let t = FALLBACK[s];
    while (t && !states[t]) t = FALLBACK[t];
    const from = states[t || "idle"];
    states[s] = { ...from, motion: DEFAULT_MOTION[s], effect: DEFAULT_EFFECT[s] || null };
  }

  return {
    id: path.basename(dir),
    name: j.name || path.basename(dir),
    size: Array.isArray(j.size) && j.size.length === 2 ? j.size : [512, 512],
    chromaKey: typeof j.chromaKey === "string" ? j.chromaKey : null,
    chromaTolerance: j.chromaTolerance || 80,
    effects: j.effects !== false,
    states,
    images,
    warnings,
  };
}

module.exports = { listSkins, loadSkin, STATES, DEFAULT_MOTION, DEFAULT_EFFECT, SUPPORTED_FORMAT };
