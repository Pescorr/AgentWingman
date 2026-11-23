// Makes an AgentWingman version of a llama-server launch .bat. The original is never changed.
//   node make-bat.js "<original.bat>" ["<output.bat>"]
// Default output: next to the original, named <name>_wingman.bat. (The launcher does the same when a
// llama-server .bat is dropped on it.)
const fs = require("fs");
const { makeWingmanBat } = require("./wingmanize");

const [src, out] = process.argv.slice(2);
if (!src || !fs.existsSync(src)) {
  console.error('使い方: node make-bat.js "<元のbat>" ["<出力先.bat>"]');
  process.exit(1);
}
try {
  const r = makeWingmanBat(src, { out });
  const msg = {
    created: "作成しました",
    exists: "すでにあります（そのまま使えます）",
    "already-wingman": "この bat はすでに AgentWingman 用です",
    "not-llama": "llama-server を起動する行が見つかりません",
  }[r.status];
  console.log(msg + (r.out ? ": " + r.out : ""));
  if (r.status === "created") console.log("元の bat は変更していません:", src);
  if (r.status === "not-llama") process.exit(1);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
