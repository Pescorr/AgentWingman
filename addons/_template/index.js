// Addon template. Copy this folder, rename it (no leading "_"), then fill in activate().
// Full API: ADDONS.md in the AgentWingman folder.

exports.activate = (ctx) => {
  // ctx.settings holds addon.json "settings", overridden by config.json -> addons.<id>.settings
  ctx.update({ online: true, activity: "idle" });

  // Example: watch something on a timer and report it.
  const timer = setInterval(() => {
    // ctx.update({ activity: "thinking", tail: "what it is thinking about", model: "my-model" });
    // ctx.update({ signal: { kind: "question", text: "Should I continue?" } });   // stays until cleared
    // ctx.update({ signal: null });                                                 // clear it
    // ctx.event({ type: "truncation", text: "コンテキスト圧縮…" });                   // one-shot reaction
  }, ctx.settings.intervalMs);

  // Return a function that stops everything; it runs when the addon is turned off or the app quits.
  return () => clearInterval(timer);
};
