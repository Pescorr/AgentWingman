const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("wingman", {
  onView: (fn) => ipcRenderer.on("view", (_e, v) => fn(v)),
  onEvent: (fn) => ipcRenderer.on("event", (_e, v) => fn(v)),
  onSettings: (fn) => ipcRenderer.on("settings", (_e, v) => fn(v)),
  onSkin: (fn) => ipcRenderer.on("skin", (_e, v) => fn(v)),
  onNotice: (fn) => ipcRenderer.on("notice", (_e, v) => fn(v)),
  hitRects: (rects) => ipcRenderer.send("hit-rects", rects),
  showMenu: () => ipcRenderer.send("show-menu"),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  resizeStart: (edge) => ipcRenderer.send("resize-start", edge),
  resizeEnd: () => ipcRenderer.send("resize-end"),
  skinReady: () => ipcRenderer.send("skin-ready"),
  onLauncher: (fn) => ipcRenderer.on("launcher", (_e, v) => fn(v)),
  launcherOpen: (i) => ipcRenderer.send("launcher-open", i),
  launcherAdd: () => ipcRenderer.send("launcher-add"),
  launcherMenu: (i) => ipcRenderer.send("launcher-menu", i),
  // one File at a time: a whole FileList does not survive the contextBridge (it arrives not iterable)
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  launcherDrop: (paths) => ipcRenderer.send("launcher-drop", paths),
  ready: () => ipcRenderer.send("ready"),
});
