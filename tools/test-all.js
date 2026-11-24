// The whole check, run by `npm test` and automatically before `npm run dist`: if anything fails,
// no exe is built. Uses only temporary folders; never touches the user's settings or characters.
//   node tools/test-all.js [--quick]   (--quick skips the slower Electron checks)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ELECTRON = require("electron"); // the path of electron.exe when required from Node
const QUICK = process.argv.includes("--quick");
const TMP = path.join(os.tmpdir(), "agent-wingman-tool-run");
const results = [];

function step(name, fn) {
  const t0 = Date.now();
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || (r && r.ok); detail = (r && r.detail) || ""; } catch (e) { detail = e.message; }
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${detail ? "\n      " + detail.split("\n").join("\n      ") : ""}`);
}
const run = (cmd, args, timeoutSec = 300) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: timeoutSec * 1000, windowsHide: true });
const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? jsFiles(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);

// 1. every script parses
step("syntax of every script", () => {
  const bad = ["src", "addons", "tools"].flatMap((d) => jsFiles(path.join(ROOT, d))).filter((f) => run(process.execPath, ["--check", f], 30).status !== 0);
  return { ok: !bad.length, detail: bad.map((f) => path.relative(ROOT, f)).join(", ") };
});

// 2. every bundled character loads; a character from a newer format is refused with a clear message
step("bundled characters load (skin.json format)", () => {
  const skins = require("../src/skins");
  const list = skins.listSkins([path.join(ROOT, "characters")]);
  const out = list.map((s) => { const k = skins.loadSkin(s.dir); return `${s.id}: ${Object.keys(k.images).length} files${k.warnings.length ? ", warnings: " + k.warnings.join(" / ") : ""}`; });
  const future = fs.mkdtempSync(path.join(os.tmpdir(), "aw-future-"));
  fs.writeFileSync(path.join(future, "skin.json"), JSON.stringify({ format: skins.SUPPORTED_FORMAT + 1, states: {} }));
  let refused = "";
  try { skins.loadSkin(future); } catch (e) { refused = e.message; }
  fs.rmSync(future, { recursive: true, force: true });
  return { ok: list.length > 0 && /新しい形式/.test(refused), detail: out.join("\n") + `\nnewer format -> "${refused}"` };
});

// 3. every addon passes the harness (ports chosen so a running AgentWingman does not collide)
const ADDON_SETTINGS = { webhook: { port: 18765 }, "claude-code": { port: 18766 }, "llama-log": { port: 18767 }, strata: { url: "http://127.0.0.1:1" }, zoocode: {} };
for (const id of fs.readdirSync(path.join(ROOT, "addons")).filter((d) => !d.startsWith("_"))) {
  step(`addon harness: ${id}`, () => {
    const r = run(process.execPath, ["tools/addon-harness.js", `addons/${id}`, "--settings", JSON.stringify(ADDON_SETTINGS[id] || {}), "--seconds", "2"], 60);
    const last = (r.stdout || "").trim().split("\n").pop();
    return { ok: r.status === 0, detail: r.status === 0 ? last : (r.stdout || "") + (r.stderr || "") };
  });
}

if (!QUICK) {
  // 4. the mascot draws every state without errors
  step("mascot snapshot (every state)", () => {
    const r = run(ELECTRON, [".", "--snapshot"], 180);
    const dir = path.join(ROOT, "snapshots", "builtin");
    const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    const errors = (r.stderr || "").split("\n").filter((l) => /\[renderer\]|Error/.test(l));
    return { ok: r.status === 0 && n >= 12 && !errors.length, detail: `${n} images${errors.length ? "\n" + errors.join("\n") : ""}` };
  });

  // 5. the overlay shows live answers in every style and leaves no backlog
  step("overlay end to end", () => {
    const r = run(ELECTRON, [".", "--overlay-e2e"], 180);
    const lines = (r.stdout || "").split("\n").filter((l) => l.includes("output ->"));
    const ok = lines.length === 4 && lines.every((l) => /"(scroll|toast|chat)":[1-9]|"banner":true/.test(l)) &&
      lines.filter((l) => /toast|banner /.test(l.split("seen")[0])).every((l) => /after the end: 0/.test(l));
    const work = (r.stdout || "").split("\n").find((l) => l.includes("work line ->")) || "work line -> (missing)";
    return { ok: ok && /: 2 comment/.test(work), detail: lines.concat(work.trim()).join("\n") };
  });

  // 6. the character maker turns a transparent video and green-screen stills into a character the mascot loads
  step("character maker", () => {
    const skins = require("../src/skins");
    fs.rmSync(path.join(TMP, "characters"), { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    const c = path.join(ROOT, "characters");
    // WebM output needs ffmpeg (PATH or downloaded by the maker); without it that part is skipped, not failed
    const hasFfmpeg = spawnSync("where", ["ffmpeg"], { windowsHide: true }).status === 0 ||
      fs.existsSync(path.join(os.homedir(), "AppData", "Roaming", "agent-wingman", "tools", "ffmpeg", "ffmpeg.exe"));
    const specs = {
      video: { paths: { idle: [path.join(c, "mannequin-anim", "idle.webm")], complete: [path.join(c, "mannequin-anim", "complete.webm")] }, options: { name: "Test Video", fps: 12, video: hasFfmpeg } },
      green: { paths: { idle: [path.join(c, "pilot-sprite", "idle.png")], writing: [path.join(c, "pilot-sprite", "type1.png"), path.join(c, "pilot-sprite", "type2.png")] }, options: { name: "Test Green", fps: 12 } },
    };
    const out = [];
    let ok = true;
    for (const [name, spec] of Object.entries(specs)) {
      const f = path.join(TMP, `maker-${name}.json`);
      fs.writeFileSync(f, JSON.stringify(spec));
      const r = run(ELECTRON, [".", "--maker", "--maker-test", f], 240);
      const m = (r.stdout || "").match(/MAKER_RESULT (.*)/);
      if (!m) { ok = false; out.push(`${name}: ${(r.stdout || "").trim()} ${(r.stderr || "").trim().slice(0, 300)}`); continue; }
      const res = JSON.parse(m[1]);
      const k = skins.loadSkin(res.dir);
      const counts = Object.keys(spec.paths).map((s) => `${s}=${k.states[s].frames.length}${k.states[s].video ? "+webm" : ""}`).join(" ");
      if (Object.keys(spec.paths).some((s) => !k.states[s].frames.length)) ok = false;
      if (spec.options.video && (res.videos !== Object.keys(spec.paths).length || (res.warnings || []).length)) ok = false;
      out.push(`${name}: ${res.id} (${counts})${spec.options.video === false ? " [webm skipped: no ffmpeg]" : ""}${(res.warnings || []).length ? " warnings: " + res.warnings.join(" / ") : ""}`);
    }
    fs.rmSync(path.join(TMP, "characters"), { recursive: true, force: true });
    return { ok, detail: out.join("\n") };
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED: ${failed.length} of ${results.length}` : `ALL PASSED: ${results.length} checks`}`);
process.exit(failed.length ? 1 : 0);
