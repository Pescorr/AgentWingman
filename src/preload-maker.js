const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wingmanMaker", {
  save: (payload) => ipcRenderer.invoke("maker-save", payload),
  ffmpegStatus: () => ipcRenderer.invoke("ffmpeg-status"),
  ffmpegDownload: () => ipcRenderer.invoke("ffmpeg-download"),
  onFfmpegProgress: (fn) => ipcRenderer.on("ffmpeg-progress", (_e, v) => fn(v)),
  readFile: (file) => ipcRenderer.invoke("maker-read", file), // test mode only
});
