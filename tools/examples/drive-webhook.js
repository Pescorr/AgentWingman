// Example --drive script for tools/addon-harness.js: plays the part of the watched tool.
// Here: talks to the Webhook addon the way an outside program would (port from --settings, default 8765).
//   node tools/addon-harness.js addons/webhook --settings '{"port":8790}' --seconds 3 --drive tools/examples/drive-webhook.js
module.exports = async (log) => {
  const port = Number(process.env.HARNESS_PORT || 8790);
  const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  log("thinking", await post("/update", { activity: "thinking", tail: "考えています", model: "demo-model" }));
  await wait(300);
  log("writing", await post("/update", { activity: "writing", tail: "答えを書いています", tailKind: "output" }));
  await wait(300);
  log("question", await post("/signal", { kind: "question", text: "続けますか？" }));
  await wait(300);
  log("event", await post("/event", { type: "truncation" }));
  log("clear", await post("/clear", {}));
};
