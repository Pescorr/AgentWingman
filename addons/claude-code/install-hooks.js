// Registers (or with --uninstall removes) the AgentWingman hooks in Claude Code's user settings.
//   node install-hooks.js [--uninstall] [--settings <path>]
// The same can be done from the tray: アドオン → Claude Code のフック.
const { apply, defaultSettings } = require("./hooks-setup");

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const i = args.indexOf("--settings");
const file = i >= 0 ? args[i + 1] : defaultSettings();

try {
  const r = apply(file, { uninstall });
  if (r.backup) console.log("バックアップ:", r.backup);
  console.log(uninstall ? `AgentWingman のフックを ${r.removed} 件外しました: ${file}` : `AgentWingman のフックを ${r.added} 件登録しました（古い登録 ${r.removed} 件は置き換え）: ${file}`);
  console.log("Claude Code を起動し直すと反映されます。");
} catch (e) {
  console.error(`${file} を読めません（JSON の書式エラーなど）。何も変更していません。\n${e.message}`);
  process.exit(1);
}
