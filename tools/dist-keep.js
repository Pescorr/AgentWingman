// Keeps what you set up in dist\win-unpacked across `npm run dist` (electron-builder deletes that folder):
//   node tools/dist-keep.js save      before the build: data\, and characters\ / addons\ you added
//   node tools/dist-keep.js restore   after the build: puts them back next to the new exe
// Bundled characters and addons come from the new build; only folders it does not have are put back.
// The zip is made before `restore`, so your settings never end up in it. If a build fails, the saved copy
// stays in dist-keep\ and the next run restores it (a second `save` never overwrites it).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "dist", "win-unpacked");
const KEEP = path.join(ROOT, "dist-keep");
const FOLDERS = ["characters", "addons"];

function save() {
  if (fs.existsSync(KEEP)) return console.log("dist-keep: a saved copy from an earlier build is still there; keeping it");
  if (!fs.existsSync(path.join(APP, "data"))) return console.log("dist-keep: nothing to keep (dist\\win-unpacked has no data folder)");
  fs.mkdirSync(KEEP, { recursive: true });
  fs.cpSync(path.join(APP, "data"), path.join(KEEP, "data"), { recursive: true });
  let n = 0;
  for (const name of FOLDERS) {
    const dir = path.join(APP, name);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || fs.existsSync(path.join(ROOT, name, e.name))) continue; // bundled: the build brings it
      fs.cpSync(path.join(dir, e.name), path.join(KEEP, name, e.name), { recursive: true });
      n++;
    }
  }
  console.log(`dist-keep: saved data and ${n} added character/addon folder(s)`);
}

function restore() {
  if (!fs.existsSync(KEEP)) return;
  if (!fs.existsSync(APP)) return console.log("dist-keep: no new build found; the saved copy stays in dist-keep");
  fs.cpSync(path.join(KEEP, "data"), path.join(APP, "data"), { recursive: true });
  let n = 0;
  for (const name of FOLDERS) {
    const dir = path.join(KEEP, name);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(APP, name, e))) continue;
      fs.cpSync(path.join(dir, e), path.join(APP, name, e), { recursive: true });
      n++;
    }
  }
  fs.rmSync(KEEP, { recursive: true, force: true });
  console.log(`dist-keep: restored data and ${n} added character/addon folder(s) into dist\\win-unpacked`);
}

const mode = process.argv[2];
if (mode === "save") save();
else if (mode === "restore") restore();
else { console.error("usage: node tools/dist-keep.js save|restore"); process.exit(1); }
