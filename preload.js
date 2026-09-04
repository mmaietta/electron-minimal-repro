const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("updater", {
  getInfo: () => ipcRenderer.invoke("updater:info"),
  setChannel: channel => ipcRenderer.invoke("updater:set-channel", channel),
  check: () => ipcRenderer.invoke("updater:check"),
  // mode: "on-quit" | "next-launch" | "skip"
  install: mode => ipcRenderer.invoke("updater:install", mode),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("updater:event", listener)
    return () => ipcRenderer.removeListener("updater:event", listener)
  },
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
})
