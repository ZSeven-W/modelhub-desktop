const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('api', {
  // HTTP methods proxied to main process
  get: (route) => ipcRenderer.invoke('api:get', route),
  post: (route, body) => ipcRenderer.invoke('api:post', route, body),
  delete: (route) => ipcRenderer.invoke('api:delete', route),

  // Shell operations
  launchTerminal: (modelName) => ipcRenderer.invoke('launch:terminal', modelName),
  openFolder: (path) => ipcRenderer.invoke('open:folder', path),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
});
