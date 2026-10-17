const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("photosphere", {
  platform: () => ipcRenderer.invoke("platform"),
  list: () => ipcRenderer.invoke("library:list"),
  addFiles: (files) => ipcRenderer.invoke("library:add", [...files].map((file) => webUtils.getPathForFile(file))),
  addWithDialog: () => ipcRenderer.invoke("library:add-dialog"),
  remove: (id) => ipcRenderer.invoke("library:remove", id),
  menu: (id) => ipcRenderer.invoke("library:menu", id),
  onSensors: (callback) => ipcRenderer.on("sensors", (event, data) => callback(data)),
  onLibraryChanged: (callback) => ipcRenderer.on("library-changed", (event, data) => callback(data)),
  onOpenSettings: (callback) => ipcRenderer.on("open-settings", () => callback()),
});
