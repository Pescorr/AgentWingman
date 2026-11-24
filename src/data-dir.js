// Folder layout (portable): everything sits next to AgentWingman.exe (next to package.json in a dev checkout)
//   characters\   every character, bundled or yours (the maker saves here too)
//   addons\       every addon, bundled or yours; remove a folder and the app simply runs without it
//   data\         what the app manages itself: config.json, logs, caches, the downloaded ffmpeg
//   resources\    the program (app.asar)
// If the exe's folder cannot be written (e.g. Program Files), data, characters and addons of your own
// go to %APPDATA%\agent-wingman as in earlier versions. Shared by the mascot and the character maker,
// which must agree on it (characters, single-instance lock).
const fs = require("fs");
const path = require("path");

function appRoot(app) {
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..");
}

function legacyDir(app) {
  return path.join(app.getPath("appData"), "agent-wingman");
}

function dataDir(app) {
  const dir = path.join(appRoot(app), "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return dir;
  } catch {
    return legacyDir(app);
  }
}

// Where the user's own characters / addons go: next to the exe when portable, else under userData
// (the %APPDATA% fallback, or a test run's throwaway folder)
function userFolder(app, name) {
  const portable = path.resolve(app.getPath("userData")) === path.resolve(appRoot(app), "data");
  return portable ? path.join(appRoot(app), name) : path.join(app.getPath("userData"), name);
}

// Copies the folders inside `from` that `to` does not have yet; never overwrites
function copyMissing(from, to) {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const dest = path.join(to, e.name);
    if (fs.existsSync(dest)) continue;
    fs.cpSync(path.join(from, e.name), dest, { recursive: true });
    n++;
  }
  return n;
}

// Brings what the user made in earlier layouts into this one. Copied, not moved, from %APPDATA% (so an
// older exe still finds its files); moved from data\characters and data\addons (an early portable test
// build kept them there). Returns true if anything came from %APPDATA%.
function adoptOld(app) {
  const root = appRoot(app), data = app.getPath("userData");
  if (path.resolve(data) !== path.resolve(root, "data")) return false;
  for (const name of ["characters", "addons"]) {
    const inData = path.join(data, name);
    if (!fs.existsSync(inData)) continue;
    fs.mkdirSync(path.join(root, name), { recursive: true });
    for (const e of fs.readdirSync(inData)) {
      let dest = path.join(root, name, e);
      for (let n = 1; fs.existsSync(dest); n++) dest = path.join(root, name, `${e}-data${n > 1 ? n : ""}`); // never overwrite
      fs.renameSync(path.join(inData, e), dest);
    }
    fs.rmdirSync(inData);
  }
  const old = legacyDir(app);
  if (fs.existsSync(path.join(data, "config.json")) || !fs.existsSync(path.join(old, "config.json"))) return false;
  fs.copyFileSync(path.join(old, "config.json"), path.join(data, "config.json"));
  copyMissing(path.join(old, "tools"), path.join(data, "tools"));
  // not into a dev checkout: personal characters there could end up published with the source
  if (app.isPackaged) for (const name of ["characters", "addons"]) copyMissing(path.join(old, name), path.join(root, name));
  return true;
}

module.exports = { appRoot, dataDir, legacyDir, userFolder, adoptOld };
