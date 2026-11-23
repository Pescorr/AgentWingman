// Strata / SyncStrata addon: engine state and the live thinking / answer text from the API monitor.
// SyncStrata (github.com/hiruhiru2005/sync-strata) runs Strata's server, so the same API works; it can
// move to another port, which it records in SYNC_HOME\run\procs.json - that port is tried too.
const fs = require("fs");
const path = require("path");
const { StrataSource } = require("./source");

const COMMON_PORTS = [8080, 8081, 3080, 3081]; // SyncStrata's own candidates when api_port is "auto"

function syncStrataUrl() {
  const home = process.env.SYNC_HOME || path.join(process.env.LOCALAPPDATA || "", "SyncStrata");
  try {
    const procs = JSON.parse(fs.readFileSync(path.join(home, "run", "procs.json"), "utf8"));
    const port = procs.engine && procs.engine.port;
    return port ? `http://127.0.0.1:${port}` : null;
  } catch {
    return null;
  }
}

exports.activate = (ctx) => {
  const { url, busyPollMs, idlePollMs } = ctx.settings;
  const candidates = () => (url === "auto"
    ? [syncStrataUrl(), ...COMMON_PORTS.map((p) => `http://127.0.0.1:${p}`)]
    : [url, syncStrataUrl()]);
  const src = new StrataSource({ candidates, busyMs: busyPollMs, idleMs: idlePollMs });

  src.on("state", (s) => {
    if (!s.online) {
      ctx.update({ online: false, activity: null, tail: "", note: url === "auto" ? "Strata / SyncStrata が見つかりません" : s.error });
      return;
    }
    const sync = s.url === syncStrataUrl();
    const writing = s.phase === "writing";
    let tail = s.busy ? (writing ? s.outputTail : s.reasoningTail) : "";
    if (s.busy && s.monitor === "off") {
      tail = sync
        ? "（SyncStrata は本文の取得に対応していないため、状態と速度だけを表示します）"
        : "（Strataのapi_monitorが無効のため本文は表示できません）";
    }
    ctx.update({
      online: true,
      activity: s.busy ? s.phase || "thinking" : "idle",
      tail,
      tailKind: writing ? "output" : "think",
      model: s.model,
      tokS: s.tokS,
      note: `${sync ? "SyncStrata" : "Strata"} ${s.url}`,
    });
  });
  src.start();
  return () => src.stop();
};
