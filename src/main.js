// AgentWingman: a small always-on-top character above the taskbar that shows what AI agents and
// local model servers are doing, and signals when you are needed.

// `AgentWingman.exe --agent-wingman-hook`: Claude Code hook forwarder for machines without Node.js.
// It only relays the hook's stdin to the running AgentWingman and exits: no window, no tray, no lock.
if (process.argv.includes("--agent-wingman-hook")) {
  require("../addons/claude-code/hook.js");
  return; // (CommonJS: stops loading the rest of the app)
}
// `AgentWingman.exe --maker`: the character maker, a separate process that shares no code with the mascot
if (process.argv.includes("--maker")) {
  require("./maker-main");
  return;
}

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { loadConfig, saveConfig } = require("./config");
const { AddonManager } = require("./addons");
const { combine, DEMO_STATES } = require("./state");
const skins = require("./skins");
const log = require("./log");
const wingmanize = require("../addons/llama-log/wingmanize");
const ccHooks = require("../addons/claude-code/hooks-setup");

const BASE_W = 440, BASE_H = 200;     // layout size at zoom 1
const MIN_H = 140, MAX_H = 720;       // the window's height sets the zoom (everything scales with it)
const MIN_LAYOUT_W = 330;             // pilot plus a narrow panel, in layout pixels
const APP_DIR = path.join(__dirname, "..");
// rows of the task window (the panel left of the character)
const PANEL_ROWS = [
  ["tags", "タスク情報（MAIN・モード・モデル）"],
  ["state", "状態（タスク完了など）"],
  ["thinking", "リアルタイム思考内容"],
  ["footer", "コンテキスト量・接続状態"],
];

const DEMO = process.argv.includes("--demo");
const SNAPSHOT = process.argv.includes("--snapshot");
const EXPORT_GUIDE = process.argv.includes("--export-guide");
const SNAPSHOT_OVERLAY = process.argv.includes("--snapshot-overlay");
const OVERLAY_MATRIX = process.argv.includes("--overlay-matrix");
const OVERLAY_E2E = process.argv.includes("--overlay-e2e");
const argValue = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

let win, tray, cfg, cfgFile, addons, overlay = null, overlayPrev = null;
let drag = null, resize = null, skinWatcher = null, skinReady = null;

// the same settings folder for the dev build and the packaged exe (whose product name differs);
// --snapshot / --export-guide runs get a throwaway one, so tests never touch (or lock) the user's settings
const TOOL_RUN = SNAPSHOT || EXPORT_GUIDE || SNAPSHOT_OVERLAY || OVERLAY_MATRIX || OVERLAY_E2E;
app.setPath("userData", TOOL_RUN
  ? path.join(require("os").tmpdir(), "agent-wingman-tool-run")
  : path.join(app.getPath("appData"), "agent-wingman"));
// files written by those runs: inside the program folder only in a dev checkout
const OUT_DIR = app.isPackaged ? app.getPath("userData") : APP_DIR;

if (!TOOL_RUN && !app.requestSingleInstanceLock()) app.quit();

// the character maker (a separate process) reports a new character through the single-instance lock
app.on("second-instance", (_e, _argv, _cwd, data) => {
  if (!data || data.wingmanMaker !== "skin-created" || !data.id) return;
  log.info("character made by the maker:", data.id);
  setCharacter(data.id);
  send("notice", "新しいキャラクターに切り替えました");
});

function launchMaker() {
  // dev: electron.exe <app folder> --maker / packaged: AgentWingman.exe --maker
  const args = app.isPackaged ? ["--maker"] : [APP_DIR, "--maker"];
  require("child_process").spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
  log.info("character maker started");
}

// copies a folder; works out of the packaged app.asar too (fs.cpSync does not)
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.writeFileSync(b, fs.readFileSync(a));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// saves config.json; a failure is logged and shown, never silent
let persistFailed = false;
function persist() {
  const err = saveConfig(cfgFile, cfg);
  if (err) {
    log.error("config save failed:", cfgFile, err.code || "", err.message);
    if (!persistFailed) send("notice", `設定を保存できませんでした（${err.code || err.message}）`);
    persistFailed = true;
  } else if (persistFailed) {
    log.info("config saved again after an earlier failure");
    persistFailed = false;
  }
  return !err;
}

process.on("uncaughtException", (e) => log.error("uncaught:", e));
process.on("unhandledRejection", (e) => log.error("unhandled rejection:", e));

// ---------- window size, zoom and position ----------
function windowSize() {
  const s = cfg.size || {};
  const height = clamp(s.height || BASE_H, MIN_H, MAX_H);
  const zoom = height / BASE_H;
  const width = clamp(s.width || BASE_W * zoom, MIN_LAYOUT_W * zoom, 2400);
  return { width: Math.round(width), height: Math.round(height), zoom };
}

function defaultPosition(width, height) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - width - 8, y: wa.y + wa.height - height };
}

function onSomeScreen(p, width) {
  return p && screen.getAllDisplays().some(({ workArea: a }) =>
    p.x + width > a.x + 40 && p.x < a.x + a.width - 40 && p.y >= a.y - 20 && p.y < a.y + a.height - 40);
}

function applyBounds() {
  const { width, height, zoom } = windowSize();
  const pos = onSomeScreen(cfg.position, width) ? cfg.position : defaultPosition(width, height);
  win.setBounds({ x: pos.x, y: pos.y, width, height });
  win.webContents.setZoomFactor(zoom);
}

function createWindow() {
  const { width, height, zoom } = windowSize();
  const pos = onSomeScreen(cfg.position, width) ? cfg.position : defaultPosition(width, height);
  win = new BrowserWindow({
    width, height, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, cfg.alwaysOnTopLevel);
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through except over the character and panel
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(zoom));
  win.webContents.on("console-message", (e, level, message) => {
    const lv = e.level ?? level, msg = e.message ?? message; // Electron 33 passes (event, level, message, ...)
    if (lv === "error" || lv === 3) log.error("[renderer]", msg);
    else if (lv === "warning" || lv === 2) log.warn("[renderer]", msg);
  });
  win.webContents.on("render-process-gone", (_e, d) => log.error("renderer gone:", d.reason, d.exitCode));
  win.webContents.on("will-navigate", (e) => e.preventDefault()); // a dropped file must never replace the page
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.showInactive()); // never steal focus from a game
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendSettings(extra = {}) {
  send("settings", { sound: cfg.sound, show: cfg.show, tailLines: cfg.tailLines, ...extra });
}

// ---------- addons (the data sources) ----------
function pushView() {
  if (!addons) return;
  const v = combine(addons.states());
  send("view", v);
  feedOverlay(v);
}

// ---------- screen overlay (kusa_commenter-style comments across the screen) ----------
const OVERLAY_STYLES = [["scroll", "ニコニコ風（流れる）"], ["toast", "通知（右下）"], ["chatlog", "チャット欄（左下）"], ["banner", "大きく（画面中央）"], ["off", "出さない"]];
const OVERLAY_CONTENT = [["thinking", "思考内容"], ["output", "回答"], ["signal", "合図（質問・承認・完了・エラー）"], ["event", "出来事（圧縮・サブタスクなど）"], ["status", "状態の変化"]];
const SIGNAL_MOODS = new Set(["question", "approval", "complete", "error"]);
const EVENT_TEXT = { truncation: "コンテキスト圧縮…", "subtask-start": "サブタスク出撃！", "subtask-return": "サブタスク帰還" };

function sendOverlay(channel, payload) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
}

function overlayConfig(extra = {}) {
  const { routes, enabled, ...rest } = cfg.overlay;
  return { ...rest, ...extra };
}

function createOverlay(bounds = screen.getPrimaryDisplay().bounds) {
  if (overlay) return;
  overlay = new BrowserWindow({
    ...bounds, frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload-overlay.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, cfg.alwaysOnTopLevel);
  overlay.setIgnoreMouseEvents(true); // never catches a click
  overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlay.once("ready-to-show", () => overlay && overlay.showInactive());
  overlay.on("closed", () => { overlay = null; });
}

// one sample in every style, so you can see the overlay works even while nothing is running
function overlayTest() {
  sendOverlay("item", { style: "scroll", kind: "think", text: "ニコニコ風：思考内容はこう流れます" });
  sendOverlay("item", { style: "toast", kind: "event", text: "通知：出来事はここに出ます" });
  sendOverlay("item", { style: "chatlog", kind: "output", text: "チャット欄：回答はここに積み上がります" });
  sendOverlay("item", { style: "banner", kind: "complete", title: "画面オーバーレイ", text: "合図はこの帯で大きく出ます" });
}

function applyOverlay() {
  if (cfg.overlay.enabled) createOverlay();
  else if (overlay) overlay.destroy();
  sendOverlay("config", overlayConfig());
}

// newly generated text: the part of `next` that follows the end of `prev` (both are tails of a growing text)
function appended(prev, next) {
  if (!prev) return next;
  if (next === prev) return "";
  const anchor = prev.slice(-24);
  const i = next.lastIndexOf(anchor);
  return i >= 0 ? next.slice(i + anchor.length) : next;
}

function feedOverlay(v) {
  const p = overlayPrev;
  overlayPrev = v;
  if (!overlay) return;
  const r = cfg.overlay.routes;
  if (!p || p.mood !== v.mood) {
    if (SIGNAL_MOODS.has(v.mood)) sendOverlay("item", { style: r.signal, kind: v.mood, title: v.label, text: v.tail });
    else if (p) sendOverlay("item", { style: r.status, kind: "status", text: v.label });
  }
  if ((v.tailKind === "think" || v.tailKind === "output") && v.tail) {
    // compared with the last text fed of the same kind, not the previous view: when two addons take turns
    // leading (e.g. Zoocode and Strata), the previous view may be the other addon's and everything was resent
    const key = v.tailKind === "think" ? "thinking" : "output";
    const added = appended(lastFed[v.tailKind] || "", v.tail);
    lastFed[v.tailKind] = v.tail;
    if (added) sendOverlay("feed", { style: r[key], kind: v.tailKind, text: added });
  }
  if (!v.tail || quietMoods.has(v.mood)) lastFed = {}; // a new request starts from scratch
}
let lastFed = {};
const quietMoods = new Set(["idle", "offline"]);

function overlayEvent(e) {
  const text = e.text || EVENT_TEXT[e.type];
  if (text) sendOverlay("item", { style: cfg.overlay.routes.event, kind: "event", text });
}

let overlayGreet = false; // greet with a sample once the user turns the overlay on
ipcMain.on("overlay-ready", () => {
  sendOverlay("config", overlayConfig({ snapshot: SNAPSHOT_OVERLAY }));
  if (overlayGreet) { overlayGreet = false; overlayTest(); }
});

// Renders the overlay styles into snapshots/overlay/*.png (in a 1280x720 window with a dark background)
// --overlay-matrix: every kind of content in every style, fed the way real use feeds it (live text arrives
// in many small pieces). Prints how much of the time something was actually visible on the overlay.
async function runOverlayMatrix() {
  createOverlay({ x: 40, y: 40, width: 1280, height: 720 });
  const ready = () => new Promise((r) => ipcMain.once("overlay-ready", r));
  await ready();
  const visible = () => overlay.webContents.executeJavaScript("window.awOverlayVisible()");
  const feeds = {
    thinking: (style) => ({ stream: "think", style }),
    output: (style) => ({ stream: "output", style }),
    signal: (style) => ({ items: [{ style, kind: "question", title: "質問があります", text: "UTC固定とローカル時刻、どちらに統一しますか？" }] }),
    event: (style) => ({ items: [{ style, kind: "event", text: "コンテキスト圧縮…" }] }),
    status: (style) => ({ items: [{ style, kind: "status", text: "思考中" }, { style, kind: "status", text: "回答作成中" }] }),
  };
  const words = "重複していた formatDate を src/utils/date.ts に集約しました。呼び出し元の3ファイルも置き換えて、テストを実行します。42件すべて通過しました。";
  const rows = [];
  for (const [content, make] of Object.entries(feeds)) {
    for (const style of ["scroll", "toast", "chatlog", "banner"]) {
      const plan = make(style);
      const t0 = Date.now();
      let samples = 0, seen = 0;
      const sampler = setInterval(async () => { samples++; if ((await visible()) > 0) seen++; }, 100);
      if (plan.stream) {
        for (let i = 0; i < words.length; i += 3) { sendOverlay("feed", { style, kind: plan.stream, text: words.slice(i, i + 3) }); await wait(60); }
      } else {
        for (const it of plan.items) { sendOverlay("item", it); await wait(700); }
      }
      await wait(1500);
      clearInterval(sampler);
      rows.push(`${content.padEnd(9)} ${style.padEnd(8)} visible ${String(Math.round((seen / Math.max(1, samples)) * 100)).padStart(3)}% of ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      overlay.webContents.executeJavaScript("window.awOverlayClear()");
      await ready();
    }
  }
  console.log(rows.join("\n"));
  app.quit();
}

// --overlay-e2e: the real path (llama-log addon -> combine -> feedOverlay -> overlay) for the answer text,
// in each style. A fake tap.js sends thinking, then the answer, over UDP like llama-server's log would.
async function runOverlayE2E() {
  const dgram = require("dgram");
  const port = 8788;
  cfg.addons = { "llama-log": { enabled: true, settings: { port } } };
  cfg.overlay.enabled = true;
  createOverlay({ x: 40, y: 40, width: 1280, height: 720 });
  await new Promise((r) => ipcMain.once("overlay-ready", r));
  startAddons();
  await wait(500);
  const sock = dgram.createSocket("udp4");
  const tap = (msgs) => new Promise((r) => sock.send(Buffer.from(JSON.stringify(msgs)), port, "127.0.0.1", r));
  const count = () => overlay.webContents.executeJavaScript(
    `({ scroll: document.querySelectorAll(".scroll.k-output").length, toast: document.querySelectorAll(".toast.k-output").length,
        chat: document.querySelectorAll(".chat.k-output").length, banner: document.getElementById("banner").classList.contains("show") })`);
  const answer = "17と23と41の合計は81で、平均は27です。計算の手順も書いておきます。まず17と23を足して40、そこに41を足して81になります。";
  for (const style of ["scroll", "toast", "chatlog", "banner"]) {
    cfg.overlay.routes = { thinking: "off", output: style, signal: "off", event: "off", status: "off" };
    await tap([{ t: "alive" }, { t: "start" }]);
    for (let i = 0; i < 6; i++) { await tap([{ t: "d", r: "考えています。", c: "" }]); await wait(80); }
    let seen = { scroll: 0, toast: 0, chat: 0, banner: false };
    for (let i = 0; i < answer.length; i += 2) {
      await tap([{ t: "d", r: "", c: answer.slice(i, i + 2) }]);
      await wait(70);
      const c = await count();
      seen = { scroll: Math.max(seen.scroll, c.scroll), toast: Math.max(seen.toast, c.toast), chat: Math.max(seen.chat, c.chat), banner: seen.banner || c.banner };
    }
    await tap([{ t: "end" }]);
    await wait(1800);
    const c = await count();
    seen = { scroll: Math.max(seen.scroll, c.scroll), toast: Math.max(seen.toast, c.toast), chat: Math.max(seen.chat, c.chat), banner: seen.banner || c.banner };
    await wait(3000); // live text must not leave a backlog: everything gone a few seconds after the answer ends
    const after = await count();
    const left = after.scroll + after.toast + (after.banner ? 1 : 0);
    console.log(`output -> ${style.padEnd(8)} seen on overlay: ${JSON.stringify(seen)} | still on screen 4.8s after the end: ${style === "chatlog" ? after.chat + " chat line(s), fading" : left}`);
    overlay.webContents.executeJavaScript("window.awOverlayClear()");
    await new Promise((r) => ipcMain.once("overlay-ready", r));
  }
  sock.close();
  addons.stopAll();
  app.quit();
}

async function runOverlaySnapshot() {
  const dir = path.join(OUT_DIR, "snapshots", "overlay");
  fs.mkdirSync(dir, { recursive: true });
  createOverlay({ x: 40, y: 40, width: 1280, height: 720 }); // same path as normal use: it shows itself once loaded
  await new Promise((r) => ipcMain.once("overlay-ready", r));
  await wait(500);
  console.log("overlay visible:", overlay.isVisible());
  const shoot = async (name) => fs.writeFileSync(path.join(dir, name + ".png"), (await overlay.webContents.capturePage()).toPNG());
  overlayTest();
  await wait(900);
  await shoot("test");
  await wait(3500); // let the test samples clear
  const think = "The user wants the duplicated helpers merged. formatDate exists in three files, and the api one pins UTC. I should check which callers rely on that before changing anything. Then run the tests.";
  for (let i = 0; i < think.length; i += 24) sendOverlay("feed", { style: "scroll", kind: "think", text: think.slice(i, i + 24) });
  sendOverlay("feed", { style: "chatlog", kind: "output", text: "重複していた formatDate を src/utils/date.ts に集約しました。呼び出し元の3ファイルも置き換え済みです。" });
  sendOverlay("item", { style: "chatlog", kind: "status", text: "回答作成中" });
  sendOverlay("item", { style: "toast", kind: "event", text: "コンテキスト圧縮…" });
  sendOverlay("item", { style: "toast", kind: "event", text: "サブタスク出撃！" });
  sendOverlay("item", { style: "scroll", kind: "question", text: "質問：UTC固定とローカル時刻、どちらに統一しますか？" });
  await wait(2200);
  await shoot("mixed");
  sendOverlay("item", { style: "banner", kind: "complete", title: "タスク完了", text: "重複関数を統合し、テスト42件すべて通過しました。" });
  await wait(900);
  await shoot("banner-complete");
  await wait(2400);
  sendOverlay("item", { style: "banner", kind: "question", title: "質問があります", text: "UTC固定とローカル時刻、どちらに統一しますか？" });
  await wait(900);
  await shoot("banner-question");
  app.quit();
}

function startAddons() {
  addons = new AddonManager({
    roots: [path.join(APP_DIR, "addons"), path.join(app.getPath("userData"), "addons")],
    getConfig: () => cfg,
    saveConfig: () => persist(),
    log,
  });
  let pending = null; // addons may report many times a second; redraw at most every 50ms
  addons.on("change", () => { if (!pending) pending = setTimeout(() => { pending = null; pushView(); }, 50); });
  addons.on("event", (e) => { send("event", e); overlayEvent(e); });
  addons.on("notice", (text) => { log.warn("addon notice:", text); send("notice", text); });
  addons.startAll();
  setInterval(pushView, 15000); // lets an old "complete" fade out
}

// ---------- launcher (shortcut tiles shown while nothing is running) ----------
async function launcherView(items = cfg.launcher.items) {
  const tiles = await Promise.all(items.map(async (it) => {
    let icon = null;
    try { icon = (await app.getFileIcon(it.path, { size: "large" })).toDataURL(); } catch {}
    return { label: it.label, path: it.path, icon, missing: !fs.existsSync(it.path) };
  }));
  return { enabled: cfg.launcher.enabled, autoShow: cfg.launcher.autoShow, idleSeconds: cfg.launcher.idleSeconds, items: tiles };
}

async function sendLauncher() {
  send("launcher", await launcherView());
}

function saveLauncher() {
  persist();
  sendLauncher();
}

function addLauncherPaths(paths) {
  for (let p of paths) {
    if (!p) continue;
    // a llama-server .bat is registered as its AgentWingman version (made next to it; the original is untouched)
    if (cfg.launcher.wingmanizeLlamaBats && /\.(bat|cmd)$/i.test(p)) {
      try {
        const r = wingmanize.makeWingmanBat(p, { tapRunner: scriptRunner() });
        if (r.status === "created" || r.status === "exists") {
          log.info("llama bat for the launcher:", r.status, r.out);
          send("notice", r.status === "created" ? "llama.cpp 用の Wingman 版を作って登録しました" : "既存の Wingman 版を登録しました");
          p = r.out;
        }
      } catch (e) {
        log.error("could not make the Wingman bat:", p, e.message);
        send("notice", `Wingman 版を作れませんでした（${e.code || e.message}）`);
      }
    }
    if (cfg.launcher.items.some((it) => it.path === p)) continue;
    cfg.launcher.items.push({ label: path.basename(p).replace(/\.(lnk|exe|url|bat|cmd)$/i, "") || p, path: p });
  }
  saveLauncher();
}

async function pickLlamaBat() {
  const r = await dialog.showOpenDialog({ title: "Wingman 版にする llama-server の bat", properties: ["openFile"], filters: [{ name: "バッチファイル", extensions: ["bat", "cmd"] }] });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    const res = wingmanize.makeWingmanBat(r.filePaths[0], { tapRunner: scriptRunner() });
    log.info("llama bat from the tray:", res.status, res.out);
    const msg = { created: "Wingman 版を作りました", exists: "Wingman 版はすでにあります", "already-wingman": "この bat はすでに Wingman 版です", "not-llama": "llama-server を起動する行が見つかりませんでした" }[res.status];
    send("notice", msg);
    if (res.out) shell.showItemInFolder(res.out);
  } catch (e) {
    log.error("could not make the Wingman bat:", e.message);
    send("notice", `Wingman 版を作れませんでした（${e.code || e.message}）`);
  }
}

// tap.js and the Claude Code hook are small Node scripts: run them with Node.js when it is installed,
// otherwise (packaged build) with AgentWingman.exe itself in Node mode, so users need not install Node
let nodeOnPath = null;
function hasNode() {
  if (nodeOnPath === null) {
    try { nodeOnPath = require("child_process").spawnSync("where", ["node"], { windowsHide: true }).status === 0; } catch { nodeOnPath = false; }
  }
  return nodeOnPath;
}
function scriptRunner() {
  return hasNode() || !app.isPackaged ? { node: true } : { exe: process.execPath };
}

async function pickLauncherPaths(kind) {
  const r = await dialog.showOpenDialog({
    title: kind === "folder" ? "ランチャーに追加するフォルダ" : "ランチャーに追加するアプリ・ファイル",
    properties: [kind === "folder" ? "openDirectory" : "openFile", "multiSelections"],
  });
  if (!r.canceled) addLauncherPaths(r.filePaths);
}

function moveLauncherItem(i, by) {
  const items = cfg.launcher.items, j = i + by;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  saveLauncher();
}

ipcMain.on("launcher-open", async (_e, i) => {
  const it = cfg.launcher.items[i];
  if (!it) return;
  const err = await shell.openPath(it.path);
  if (err) send("notice", `開けませんでした: ${it.label}`);
});
ipcMain.on("launcher-add", () => {
  Menu.buildFromTemplate([
    { label: "アプリ・ファイル・ショートカットを追加…", click: () => pickLauncherPaths("file") },
    { label: "フォルダを追加…", click: () => pickLauncherPaths("folder") },
  ]).popup({ window: win });
});
ipcMain.on("launcher-drop", (_e, paths) => addLauncherPaths(paths));
ipcMain.on("launcher-menu", (_e, i) => {
  const it = cfg.launcher.items[i];
  if (!it) return;
  Menu.buildFromTemplate([
    { label: `「${it.label}」を開く`, click: () => shell.openPath(it.path) },
    { label: "保存場所を開く", click: () => shell.showItemInFolder(it.path) },
    { type: "separator" },
    { label: "左へ移動", enabled: i > 0, click: () => moveLauncherItem(i, -1) },
    { label: "右へ移動", enabled: i < cfg.launcher.items.length - 1, click: () => moveLauncherItem(i, 1) },
    { type: "separator" },
    { label: "ランチャーから外す", click: () => { cfg.launcher.items.splice(i, 1); saveLauncher(); } },
  ]).popup({ window: win });
});

function openUserFolder(name) {
  const dir = path.join(app.getPath("userData"), name);
  fs.mkdirSync(dir, { recursive: true });
  const kit = path.join(dir, "_template");
  if (!fs.existsSync(kit)) copyDir(path.join(APP_DIR, name, "_template"), kit);
  shell.openPath(dir);
}

// ---------- character skins ----------
// Where characters are looked for; a later folder wins when two have a character with the same name.
// The packaged exe carries a copy of the characters that existed when it was built, so characters added
// later must live in one of the other folders (next to the exe, a folder added from the tray, or userData).
function skinRoots() {
  const roots = [path.join(APP_DIR, "characters")];
  if (app.isPackaged) roots.push(path.join(path.dirname(process.execPath), "characters"));
  for (const d of cfg.characterDirs || []) if (typeof d === "string" && d) roots.push(d);
  roots.push(path.join(app.getPath("userData"), "characters"));
  return roots;
}

async function addCharacterDir() {
  const r = await dialog.showOpenDialog({ title: "キャラクターを探すフォルダ（キャラクターのフォルダが入っている場所）", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  let dir = r.filePaths[0], pick = null;
  // a character folder itself was chosen (it has skin.json): look in its parent and switch to it
  if (fs.existsSync(path.join(dir, "skin.json"))) { pick = path.basename(dir); dir = path.dirname(dir); }
  cfg.characterDirs = [...new Set([...(cfg.characterDirs || []), dir])];
  persist();
  const found = skins.listSkins([dir]);
  log.info("character folder added:", dir, `${found.length} found`);
  send("notice", found.length ? `キャラクターが ${found.length} 体見つかりました` : "このフォルダにキャラクターは見つかりませんでした");
  if (pick && found.some((s) => s.id === pick)) setCharacter(pick);
  refreshTray();
}

function removeCharacterDir(dir) {
  cfg.characterDirs = (cfg.characterDirs || []).filter((d) => d !== dir);
  persist();
  log.info("character folder removed:", dir);
  refreshTray();
}

function applySkin(id) {
  if (skinWatcher) { skinWatcher.close(); skinWatcher = null; }
  const done = new Promise((r) => { skinReady = r; });
  if (!id || id === "builtin") { send("skin", null); return done; }
  const found = skins.listSkins(skinRoots()).find((s) => s.id === id);
  if (!found) {
    log.warn("skin not found:", id);
    send("skin", null);
    send("notice", `キャラクター「${id}」が見つかりません`);
    return done;
  }
  try {
    const skin = skins.loadSkin(found.dir);
    log.info("skin loaded:", id, `${Object.keys(skin.images).length} files`, skin.warnings.length ? "warnings: " + skin.warnings.join(" / ") : "");
    send("skin", skin);
    if (skin.warnings.length) send("notice", skin.warnings[0]);
  } catch (e) {
    log.error("skin load failed:", id, e.message);
    send("skin", null);
    send("notice", `キャラクター読込失敗: ${e.message}`);
  }
  // edits to the images or skin.json show up right away
  try {
    let t;
    skinWatcher = fs.watch(found.dir, () => { clearTimeout(t); t = setTimeout(() => applySkin(id), 400); });
  } catch {}
  return done;
}

function setCharacter(id) {
  cfg.character = id;
  persist();
  applySkin(id);
  refreshTray();
}

// ---------- demo / snapshot / guide export ----------
async function runDemo() {
  const names = Object.keys(DEMO_STATES);
  for (let i = 0; ; i = (i + 1) % names.length) {
    const v = DEMO_STATES[names[i]];
    send("view", v);
    feedOverlay(v);
    if (v.demoEvent) { send("event", { type: v.demoEvent, ts: Date.now() }); overlayEvent({ type: v.demoEvent }); }
    await wait(4500);
  }
}

async function runSnapshot() {
  const skinId = argValue("--skin") || "builtin";
  const hide = (argValue("--hide") || "").split(",").filter(Boolean); // e.g. --hide character,footer
  const show = { ...cfg.show };
  for (const k of hide) show[k] = false;
  const dir = path.join(OUT_DIR, "snapshots", skinId + (hide.length ? "-hide-" + hide.join("-") : ""));
  fs.mkdirSync(dir, { recursive: true });
  sendSettings({ sound: false, snapshot: true, show });
  await applySkin(skinId);
  // --frames N: N shots per state, 0.25s apart (name_00.png ...), to check that a skin really animates
  const frames = Math.max(1, parseInt(argValue("--frames") || "1", 10) || 1);
  const shoot = async (file) => fs.writeFileSync(path.join(dir, file), (await win.webContents.capturePage()).toPNG());
  for (const [name, v] of Object.entries(DEMO_STATES)) {
    send("view", v);
    if (v.demoEvent) send("event", { type: v.demoEvent, ts: Date.now() });
    await wait(1400);
    await win.webContents.executeJavaScript(`window.awSnapReady(${frames === 1})`);
    if (frames === 1) await shoot(name + ".png");
    else for (let i = 0; i < frames; i++) { await shoot(`${name}_${String(i).padStart(2, "0")}.png`); await wait(250); }
    if (v.demoEvent) await wait(3600); // let the one-shot reaction finish so it does not show up in the next state
  }
  // the launcher, with sample tiles from Windows itself
  const sample = [
    { label: "エクスプローラー", path: path.join(process.env.WINDIR || "C:\\Windows", "explorer.exe") },
    { label: "メモ帳", path: path.join(process.env.WINDIR || "C:\\Windows", "System32", "notepad.exe") },
    { label: "AgentWingman", path: APP_DIR },
    { label: "README", path: path.join(APP_DIR, "README.md") },
    { label: "見つからない例", path: "Z:\\missing\\tool.exe" },
  ];
  send("view", DEMO_STATES.idle);
  send("launcher", { ...(await launcherView(sample)), enabled: true, forceOpen: true });
  await wait(1200);
  fs.writeFileSync(path.join(dir, "launcher.png"), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

// Renders the built-in pilot in every pose: transparent guides for image AIs (characters/_template/guide)
// and a green-screen copy used by the example image skin (characters/pilot-sprite).
async function exportGuide() {
  const g = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await g.loadFile(path.join(__dirname, "renderer", "guide.html"));
  const guideDir = path.join(OUT_DIR, "characters", "_template", "guide");
  const spriteDir = path.join(OUT_DIR, "characters", "pilot-sprite");
  fs.mkdirSync(guideDir, { recursive: true });
  fs.mkdirSync(spriteDir, { recursive: true });
  const poses = await g.webContents.executeJavaScript("POSES");
  for (const green of [false, true]) {
    for (const pose of poses) {
      await g.webContents.executeJavaScript(`setPose(${JSON.stringify(pose)}, ${green})`);
      await wait(200);
      const img = await g.webContents.capturePage();
      fs.writeFileSync(path.join(green ? spriteDir : guideDir, pose + ".png"), img.toPNG());
    }
  }
  g.setSize(1024, 768);
  await g.webContents.executeJavaScript("showSheet()");
  await wait(400);
  fs.writeFileSync(path.join(guideDir, "_all_poses.png"), (await g.webContents.capturePage()).toPNG());
  console.log("guides written to", guideDir, "and", spriteDir);
  app.quit();
}

// ---------- tray ----------
function trayIcon() {
  // 16x16 amber ring drawn in code so the app ships without image files
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5), o = (y * size + x) * 4;
      if (d < 7.2 && (d > 4.6 || d < 2.4)) { buf[o] = 0x0c; buf[o + 1] = 0xa2; buf[o + 2] = 0xf2; buf[o + 3] = 255; }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ---------- Claude Code hooks from the tray (edits ~/.claude/settings.json, so always ask first) ----------
async function claudeHooks(uninstall) {
  const st = ccHooks.status();
  const answer = await dialog.showMessageBox({
    type: "question",
    buttons: [uninstall ? "外す" : "登録する", "やめる"],
    defaultId: 0, cancelId: 1, noLink: true,
    title: "Claude Code のフック",
    message: uninstall ? "Claude Code から AgentWingman のフックを外しますか？" : "Claude Code に AgentWingman のフックを登録しますか？",
    detail: `${st.file} を変更します（変更前のバックアップを同じ場所に作ります）。` +
      (uninstall ? "" : "\n承認待ち・入力待ち・完了などを、このキャラクターに知らせるためのものです。" +
        (scriptRunner().exe ? "\nNode.js が見つからないため、AgentWingman.exe をフックの実行に使います（exe を移動したら登録し直してください）。" : "")) +
      "\n反映には Claude Code の再起動が必要なことがあります。",
  });
  if (answer.response !== 0) return;
  try {
    const r = ccHooks.apply(undefined, { uninstall, runner: scriptRunner() });
    log.info("claude code hooks", uninstall ? "removed" : "installed", JSON.stringify(r));
    send("notice", uninstall ? `フックを外しました（${r.removed}件）` : `フックを登録しました（${r.added}件）`);
  } catch (e) {
    log.error("claude code hooks failed:", e.message);
    dialog.showErrorBox("Claude Code のフック", `${st.file} を変更できませんでした。何も変更していません。\n${e.message}`);
  }
  refreshTray();
}

// 表示項目: the character, and the task window (one switch for the whole panel) with its rows under it.
// Something always stays on screen: the last visible part cannot be switched off.
function showMenu() {
  const s = cfg.show;
  const rowsOn = PANEL_ROWS.filter(([k]) => s[k]).length;
  const panelVisible = s.panel && rowsOn > 0;
  const toggle = (key) => (i) => { s[key] = i.checked; persist(); sendSettings(); refreshTray(); };
  return [
    { label: "キャラクター", type: "checkbox", checked: s.character, enabled: !(s.character && !panelVisible), click: toggle("character") },
    { label: "タスクウィンドウ（キャラクター左の情報）", type: "checkbox", checked: s.panel, enabled: !(panelVisible && !s.character), click: toggle("panel") },
    ...PANEL_ROWS.map(([key, label]) => ({
      label: `　　└ ${label}`, type: "checkbox", checked: s[key],
      enabled: s.panel && !(s[key] && rowsOn === 1 && !s.character),
      click: toggle(key),
    })),
  ];
}

function trayMenu() {
  const list = skins.listSkins(skinRoots());
  const found = addons ? addons.discover() : [];
  const hooks = ccHooks.status();
  return Menu.buildFromTemplate([
    { label: `AgentWingman ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: win.isVisible() ? "一時的にすべて隠す" : "表示を戻す", click: toggleVisible },
    { label: "表示項目", submenu: showMenu() },
    {
      label: "キャラクターの種類",
      submenu: [
        { label: "標準（パイロット）", type: "radio", checked: cfg.character === "builtin", click: () => setCharacter("builtin") },
        ...list.map((s) => ({ label: s.name, type: "radio", checked: cfg.character === s.id, enabled: !s.broken, click: () => setCharacter(s.id) })),
        { type: "separator" },
        { label: "動画からキャラクターを作る…（キャラクターメーカー）", click: launchMaker },
        { label: "キャラクターを探すフォルダを追加…", click: addCharacterDir },
        ...((cfg.characterDirs || []).length ? [{
          label: "追加したフォルダ",
          submenu: cfg.characterDirs.map((d) => ({ label: `外す: ${d}`, click: () => removeCharacterDir(d) })),
        }] : []),
        { label: "ユーザー用キャラクターフォルダを開く", click: () => openUserFolder("characters") },
        { label: "一覧を更新", click: refreshTray },
      ],
    },
    {
      label: "アドオン",
      submenu: [
        ...found.map((a) => ({
          label: a.manifest.name || a.id, type: "checkbox", checked: addons.isEnabled(a.id),
          click: async (i) => { await addons.setEnabled(a.id, i.checked); refreshTray(); },
        })),
        ...(found.length ? [{ type: "separator" }] : []),
        {
          label: `Claude Code のフック（${hooks.installed ? "登録済み" : "未登録"}）`,
          submenu: [
            { label: hooks.installed ? "登録し直す…" : "登録する…", click: () => claudeHooks(false) },
            { label: "外す…", enabled: hooks.installed > 0, click: () => claudeHooks(true) },
          ],
        },
        { label: "llama.cpp の bat を Wingman 版にする…", click: pickLlamaBat },
        { type: "separator" },
        { label: "アドオンフォルダを開く", click: () => openUserFolder("addons") },
        { label: "設定を開く（config.json の addons）", click: () => shell.openPath(cfgFile) },
        { label: "すべて再読み込み", click: () => { addons.stopAll(); addons.startAll(); refreshTray(); } },
      ],
    },
    {
      label: "ランチャー",
      submenu: [
        { label: "使う", type: "checkbox", checked: cfg.launcher.enabled, click: (i) => { cfg.launcher.enabled = i.checked; saveLauncher(); } },
        { label: `何も動いていないとき自動で出す（${cfg.launcher.idleSeconds}秒後）`, type: "checkbox", checked: cfg.launcher.autoShow, click: (i) => { cfg.launcher.autoShow = i.checked; saveLauncher(); } },
        { label: "llama.cpp の bat は Wingman 版にして登録", type: "checkbox", checked: cfg.launcher.wingmanizeLlamaBats, click: (i) => { cfg.launcher.wingmanizeLlamaBats = i.checked; saveLauncher(); } },
        { type: "separator" },
        { label: "アプリ・ファイルを追加…", click: () => pickLauncherPaths("file") },
        { label: "フォルダを追加…", click: () => pickLauncherPaths("folder") },
      ],
    },
    {
      label: "画面オーバーレイ",
      submenu: [
        {
          label: "使う", type: "checkbox", checked: cfg.overlay.enabled,
          click: (i) => { cfg.overlay.enabled = i.checked; overlayGreet = i.checked; persist(); applyOverlay(); refreshTray(); },
        },
        { label: "テスト表示（全スタイル）", enabled: cfg.overlay.enabled, click: overlayTest },
        { type: "separator" },
        ...OVERLAY_CONTENT.map(([key, label]) => ({
          label,
          submenu: OVERLAY_STYLES.map(([style, styleLabel]) => ({
            label: styleLabel, type: "radio", checked: cfg.overlay.routes[key] === style,
            click: () => { cfg.overlay.routes[key] = style; persist(); refreshTray(); },
          })),
        })),
      ],
    },
    { label: "サウンド", type: "checkbox", checked: cfg.sound, click: (i) => { cfg.sound = i.checked; persist(); sendSettings(); } },
    { label: "大きさと位置を元に戻す", click: () => { cfg.size = null; cfg.position = null; persist(); applyBounds(); } },
    {
      label: "Windows の起動時に起動", type: "checkbox", visible: app.isPackaged, // a dev checkout would register electron.exe itself
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); log.info("start with Windows:", i.checked); },
    },
    { type: "separator" },
    { label: "設定ファイルを開く", click: () => shell.openPath(cfgFile) },
    { label: "ログを開く", click: () => log.file && shell.openPath(log.file) },
    { label: "終了", click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(trayMenu());
}

// right-clicking the character or the task window opens the same menu as the tray icon
ipcMain.on("show-menu", () => {
  if (win && !win.isDestroyed()) trayMenu().popup({ window: win });
});

function toggleVisible() {
  win.isVisible() ? win.hide() : win.showInactive();
  refreshTray();
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("AgentWingman");
  refreshTray();
  tray.on("click", toggleVisible);
}

// ---------- renderer messages ----------
ipcMain.on("ready", () => {
  sendSettings();
  if (SNAPSHOT) return runSnapshot();
  sendLauncher();
  applySkin(cfg.character);
  if (DEMO) runDemo();
  else pushView();
});
ipcMain.on("skin-ready", () => { if (skinReady) { skinReady(); skinReady = null; } });
// Click-through: the window takes the mouse only over the character, panel, bubble or launcher.
// The cursor is polled instead of relying on mouse-enter events, because Windows sends none while a file
// is being dragged in from Explorer - the drop would otherwise fall through to the window behind.
let hitRects = [], ignoring = true;
ipcMain.on("hit-rects", (_e, rects) => { hitRects = Array.isArray(rects) ? rects : []; });
function setIgnore(on) {
  if (on === ignoring) return;
  ignoring = on;
  win.setIgnoreMouseEvents(on, { forward: true });
}
setInterval(() => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (drag || resize) return setIgnore(false);
  const c = screen.getCursorScreenPoint(), b = win.getBounds(), z = win.webContents.getZoomFactor() || 1;
  const x = (c.x - b.x) / z, y = (c.y - b.y) / z; // screen DIPs -> page CSS pixels
  setIgnore(!hitRects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
}, 50);

ipcMain.on("drag-start", () => {
  const c = screen.getCursorScreenPoint(), [x, y] = win.getPosition();
  drag = { dx: c.x - x, dy: c.y - y };
  drag.timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - drag.dx, p.y - drag.dy);
  }, 16);
});
ipcMain.on("drag-end", () => {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  const [x, y] = win.getPosition();
  cfg.position = { x, y };
  persist();
});

// The window is anchored at its bottom-right corner. The top edge changes the height, which scales
// everything (zoom); the left edge changes the width, which gives the panel more room.
ipcMain.on("resize-start", (_e, edge) => {
  if (resize) return;
  const b = win.getBounds(), start = screen.getCursorScreenPoint();
  const right = b.x + b.width, bottom = b.y + b.height;
  resize = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    let height = b.height, width = b.width;
    if (edge.includes("t")) height = clamp(b.height - (p.y - start.y), MIN_H, MAX_H);
    const zoom = height / BASE_H;
    if (edge.includes("l")) width = b.width - (p.x - start.x);
    else width = b.width * (height / b.height); // top edge alone keeps the panel's proportions
    width = clamp(Math.round(width), Math.ceil(MIN_LAYOUT_W * zoom), 2400);
    height = Math.round(height);
    win.setBounds({ x: right - width, y: bottom - height, width, height });
    win.webContents.setZoomFactor(zoom);
  }, 16);
});
ipcMain.on("resize-end", () => {
  if (!resize) return;
  clearInterval(resize);
  resize = null;
  const b = win.getBounds();
  cfg.size = { width: b.width, height: b.height };
  cfg.position = { x: b.x, y: b.y };
  persist();
});

app.whenReady().then(() => {
  if (EXPORT_GUIDE) return exportGuide();
  cfgFile = path.join(app.getPath("userData"), "config.json");
  cfg = loadConfig(cfgFile);
  if (SNAPSHOT_OVERLAY) return runOverlaySnapshot();
  if (OVERLAY_MATRIX) return runOverlayMatrix();
  if (OVERLAY_E2E) return runOverlayE2E();
  if (SNAPSHOT) cfg = { ...cfg, size: null, position: null };
  else {
    log.init(path.join(app.getPath("userData"), "logs"));
    log.info(`AgentWingman ${app.getVersion()} start (electron ${process.versions.electron}, ${app.isPackaged ? "packaged" : "dev"})`, "app:", APP_DIR);
    log.info("config:", cfgFile, "| addons:", Object.entries(cfg.addons || {}).map(([k, v]) => `${k}=${v.enabled ? "on" : "off"}`).join(", ") || "none");
    // write it back once: fills in new defaults, converts older formats, and proves saving works
    if (persist()) log.info("config saved");
  }
  createWindow();
  if (!DEMO && !SNAPSHOT) startAddons();
  if (!SNAPSHOT) { buildTray(); applyOverlay(); }
});
app.on("before-quit", () => { if (addons) addons.stopAll(); });
app.on("window-all-closed", () => app.quit());
