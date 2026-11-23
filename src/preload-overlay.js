const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ov", {
  onConfig: (fn) => ipcRenderer.on("config", (_e, v) => fn(v)),
  onItem: (fn) => ipcRenderer.on("item", (_e, v) => fn(v)),
  onFeed: (fn) => ipcRenderer.on("feed", (_e, v) => fn(v)),
  ready: () => ipcRenderer.send("overlay-ready"),
});
