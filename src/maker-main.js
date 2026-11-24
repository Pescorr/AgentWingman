// Character maker: `AgentWingman.exe --maker` runs as its own process, so making a character never slows
// down or crashes the mascot. It shares no code with the mascot: the only contract between the two is the
// character folder format (skin.json "format": 1, PNG frames) - see characters/_template/README.md.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const FORMAT = 1;
const argValue = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const TEST_SPEC = argValue("--maker-test"); // a JSON file: { paths: { state: [file, ...] }, options: {...} }

// same settings folder as the mascot (it decides where characters are saved); tests use a throwaway one
const dataDirs = require("./data-dir");
app.setPath("userData", TEST_SPEC ? path.join(os.tmpdir(), "agent-wingman-tool-run") : dataDirs.dataDir(app));
app.setPath("sessionData", path.join(app.getPath("userData"), "cache"));

const STATE = /^(idle|reading|thinking|writing|running|question|approval|complete|error|offline)$/;
const FILE = /^[a-z]+_\d{3}\.png$/;

function folderFor(name) {
  const ascii = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const root = dataDirs.userFolder(app, "characters");
  const base = `${ascii || "chara"}-anim`;
  let dir = path.join(root, base), n = 2;
  while (fs.existsSync(dir)) dir = path.join(root, `${base}-${n++}`); // never overwrite an existing character
  return dir;
}

// ---------- ffmpeg (for transparent WebM output) ----------
// Not shipped with the app: it is found on PATH, or downloaded on request into <userData>\tools\ffmpeg.
// Chromium's own encoder (WebCodecs) cannot write video with alpha, hence ffmpeg.
const FFMPEG_DIR = () => path.join(app.getPath("userData"), "tools", "ffmpeg");
const RELEASES = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";

function probeFfmpeg(exe) {
  try {
    const v = spawnSync(exe, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    if (v.status !== 0) return null;
    const enc = spawnSync(exe, ["-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    return { path: exe, version: (v.stdout.split("\n")[0] || "").replace(/ Copyright.*/, "").trim(), vp9: /libvpx-vp9/.test(enc.stdout || "") };
  } catch {
    return null;
  }
}

function findFfmpeg() {
  const own = path.join(FFMPEG_DIR(), "ffmpeg.exe");
  if (fs.existsSync(own)) { const p = probeFfmpeg(own); if (p) return { ...p, source: "downloaded" }; }
  const where = spawnSync("where", ["ffmpeg"], { encoding: "utf8", windowsHide: true });
  for (const line of (where.stdout || "").split(/\r?\n/).filter(Boolean)) {
    const p = probeFfmpeg(line.trim());
    if (p && p.vp9) return { ...p, source: "path" };
  }
  return { source: "none" };
}

ipcMain.handle("ffmpeg-status", () => findFfmpeg());

async function download(url, file, onProgress) {
  const r = await fetch(url, { headers: { "User-Agent": "AgentWingman" } });
  if (!r.ok) throw new Error(`ダウンロードに失敗しました（HTTP ${r.status}）`);
  const total = Number(r.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash("sha256");
  let got = 0;
  for await (const chunk of r.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
    onProgress(got, total);
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  return hash.digest("hex");
}

ipcMain.handle("ffmpeg-download", async (e) => {
  const rel = await (await fetch(RELEASES, { headers: { "User-Agent": "AgentWingman" } })).json();
  const assets = rel.assets || [];
  // newest stable LGPL build (e.g. ffmpeg-n9.0-latest-win64-lgpl-9.0.zip), else the master LGPL build
  const ver = (n) => (n.match(/-n(\d+)\.(\d+)-/) || []).slice(1).map(Number);
  const stable = assets.filter((a) => /^ffmpeg-n[\d.]+-latest-win64-lgpl-[\d.]+\.zip$/.test(a.name)).sort((a, b) => {
    const [x, y] = [ver(a.name), ver(b.name)];
    return y[0] - x[0] || y[1] - x[1];
  });
  const zip = stable[0] || assets.find((a) => a.name === "ffmpeg-master-latest-win64-lgpl.zip");
  const sums = assets.find((a) => a.name === "checksums.sha256");
  if (!zip || !sums) throw new Error("配布ページにダウンロードできるファイルが見つかりませんでした");

  const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: "question", buttons: ["ダウンロードする", "やめる"], defaultId: 0, cancelId: 1, noLink: true,
    title: "ffmpeg のダウンロード",
    message: "動画で書き出すための ffmpeg をダウンロードしますか？",
    detail: `ファイル: ${zip.name}（約 ${Math.round(zip.size / 1048576)} MB）\n入手先: github.com/BtbN/FFmpeg-Builds（LGPL 版）\n` +
      `保存先: ${FFMPEG_DIR()}\nダウンロード後にチェックサム（SHA-256）を照合します。ffmpeg 本体と license 以外は削除します。`,
  });
  if (answer.response !== 0) return { cancelled: true };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-ffmpeg-"));
  try {
    const list = await (await fetch(sums.browser_download_url, { headers: { "User-Agent": "AgentWingman" } })).text();
    const line = list.split(/\r?\n/).find((l) => l.trim().endsWith(zip.name));
    if (!line) throw new Error("チェックサムの一覧にこのファイルがありません");
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    const zipFile = path.join(tmp, zip.name);
    const actual = await download(zip.browser_download_url, zipFile, (got, total) => {
      if (!e.sender.isDestroyed()) e.sender.send("ffmpeg-progress", { got, total: total || zip.size });
    });
    if (actual !== expected) throw new Error("チェックサムが一致しません（ファイルが壊れているか、すり替えられています）。保存しませんでした");
    // Windows 10 1803+ has tar.exe, which also reads zip files
    const x = spawnSync("tar", ["-xf", zipFile, "-C", tmp], { windowsHide: true, encoding: "utf8" });
    if (x.status !== 0) throw new Error("展開に失敗しました: " + (x.stderr || "").trim());
    const root = fs.readdirSync(tmp, { withFileTypes: true }).find((d) => d.isDirectory());
    const exe = root && path.join(tmp, root.name, "bin", "ffmpeg.exe");
    if (!exe || !fs.existsSync(exe)) throw new Error("展開したファイルに ffmpeg.exe が見つかりません");
    fs.rmSync(FFMPEG_DIR(), { recursive: true, force: true });
    fs.mkdirSync(FFMPEG_DIR(), { recursive: true });
    fs.copyFileSync(exe, path.join(FFMPEG_DIR(), "ffmpeg.exe"));
    const lic = path.join(tmp, root.name, "LICENSE.txt");
    if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(FFMPEG_DIR(), "LICENSE.txt"));
    fs.writeFileSync(path.join(FFMPEG_DIR(), "SOURCE.txt"), `${zip.browser_download_url}\nsha256 ${actual}\n${new Date().toISOString()}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return findFfmpeg();
});

// encodes one state's frames (in playback order) into a transparent VP9 WebM (alpha needs auto-alt-ref 0)
async function encodeWebm(ffmpeg, dir, state, order, fps) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-frames-"));
  try {
    order.forEach((name, i) => fs.copyFileSync(path.join(dir, name), path.join(tmp, `f_${String(i).padStart(4, "0")}.png`)));
    const out = path.join(dir, `${state}.webm`);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(tmp, "f_%04d.png"),
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-an", out];
    return await new Promise((resolve) => {
      const p = spawn(ffmpeg, args, { windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => p.kill(), 120000);
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 && fs.existsSync(out) ? { ok: true, file: path.basename(out) } : { ok: false, error: err.trim() || `ffmpeg exit ${code}` });
      });
      p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

ipcMain.handle("maker-save", async (_e, p) => {
  if (!p || !p.states || !p.states.idle) throw new Error("待機の素材がありません");
  const dir = folderFor(String(p.name || "chara"));
  fs.mkdirSync(dir, { recursive: true });
  const skin = {
    format: FORMAT,
    name: String(p.name || "マイキャラクター"),
    author: "AgentWingman キャラクターメーカー",
    size: [p.size, p.size],
    chromaKey: null,
    effects: true,
    states: {},
  };
  for (const [state, s] of Object.entries(p.states)) {
    if (!STATE.test(state)) continue;
    for (const f of s.files) {
      if (!FILE.test(f.name)) throw new Error(`不正なファイル名: ${f.name}`);
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.data));
    }
    // the clips carry their own body motion; offline only turns grey
    skin.states[state] = { frames: s.order, fps: p.fps, loop: true, motion: state === "offline" ? "dim-still" : "none" };
  }
  // transparent WebM per state (the PNG frames stay as the fallback the mascot uses if a video will not play)
  let videos = 0;
  const warnings = [];
  if (p.video) {
    const ff = findFfmpeg();
    if (!ff.vp9) warnings.push("ffmpeg が見つからないため、動画は作らず PNG だけにしました");
    else {
      for (const [state, s] of Object.entries(p.states)) {
        if (!skin.states[state]) continue;
        const r = await encodeWebm(ff.path, dir, state, s.order, p.fps);
        if (r.ok) { skin.states[state].video = r.file; videos++; } else warnings.push(`${state} の動画: ${r.error}`);
      }
    }
  }
  fs.writeFileSync(path.join(dir, "skin.json"), JSON.stringify(skin, null, 1));
  const id = path.basename(dir);
  tellMascot(id);
  return { id, dir, name: skin.name, videos, warnings };
});

// test mode only: the page reads its input files from disk paths given in the spec
ipcMain.handle("maker-read", (_e, file) => (TEST_SPEC ? { name: path.basename(file), data: fs.readFileSync(file) } : null));

// A running mascot holds the single-instance lock. Asking for the lock hands this message to it
// (its "second-instance" event); if no mascot is running we simply get the lock and give it back.
function tellMascot(id) {
  if (TEST_SPEC) return;
  if (app.requestSingleInstanceLock({ wingmanMaker: "skin-created", id })) app.releaseSingleInstanceLock();
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1040, height: 840, show: !TEST_SPEC, autoHideMenuBar: true,
    title: "AgentWingman キャラクターメーカー",
    webPreferences: { preload: path.join(__dirname, "preload-maker.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, "renderer", "maker.html"));
  if (!TEST_SPEC) return;
  win.webContents.on("console-message", (e, level, message) => {
    const lv = e.level ?? level, msg = e.message ?? message;
    if (lv === "error" || lv === 3) console.log("[maker page]", msg);
  });
  try {
    const spec = JSON.parse(fs.readFileSync(TEST_SPEC, "utf8"));
    const r = await win.webContents.executeJavaScript(`window.makerTest(${JSON.stringify(spec.paths)}, ${JSON.stringify(spec.options || {})})`);
    console.log("MAKER_RESULT " + JSON.stringify(r));
  } catch (e) {
    console.log("MAKER_ERROR " + e.message);
    process.exitCode = 1;
  }
  app.quit();
});
app.on("window-all-closed", () => app.quit());
