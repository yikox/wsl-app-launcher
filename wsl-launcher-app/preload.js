"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  listApps: () => ipcRenderer.invoke("apps:list"),
  launch: (exec, name) => ipcRenderer.send("app:launch", { exec: exec, name: name }),
  selftest: () => ipcRenderer.send("app:selftest"),
  install: (pkg) => ipcRenderer.send("app:install", { pkg: pkg }),
  installTool: (id) => ipcRenderer.send("app:installTool", { id: id }),
  installIme: () => ipcRenderer.send("app:installIme"),
  imeStatus: () => ipcRenderer.invoke("ime:status"),
  toolStatus: () => ipcRenderer.invoke("tools:status"),
  installed: (pkgs) => ipcRenderer.invoke("apps:installed", pkgs),
  openFolder: (rel) => ipcRenderer.invoke("shell:openWsl", rel || ""),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  onEvent: (cb) => {
    const handler = (event, msg) => { cb(msg); };
    ipcRenderer.on("launch:event", handler);
    return () => ipcRenderer.removeListener("launch:event", handler);
  }
});
