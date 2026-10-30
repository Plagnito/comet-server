// Pont sécurisé renderer ↔ main : expose une petite API de bureau à l'UI Comet.
// contextIsolation reste actif ; on n'expose QUE le strict nécessaire.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cometDesktop', {
  isDesktop: true,
  getAutoStart: () => ipcRenderer.invoke('autostart:get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart:set', !!enabled),
  downloads: {
    get: () => ipcRenderer.invoke('dl:get'),
    choose: () => ipcRenderer.invoke('dl:choose'),
    clear: () => ipcRenderer.invoke('dl:clear'),
  },
  torrent: {
    get: () => ipcRenderer.invoke('torrent:get'),
    set: (opts) => ipcRenderer.invoke('torrent:set', opts),
    seed: (name, data) => ipcRenderer.invoke('torrent:seed', { name, data }),
    config: (opts) => ipcRenderer.invoke('torrent:config', opts),
    download: (magnet) => ipcRenderer.invoke('torrent:download', magnet),
  },
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb) => { const h = (_e, v) => cb(!!v); ipcRenderer.on('window:maximized', h); return () => ipcRenderer.removeListener('window:maximized', h); },
  },
  // Mise à jour automatique du shell natif : l'UI est prévenue quand une nouvelle
  // version est téléchargée et prête (installée au prochain quit, ou tout de suite).
  // Serveur Comet utilisé par l'app : lu, testé, choisi, ou à rechoisir.
  serveur: {
    get: () => ipcRenderer.invoke('serveur:get'),
    tester: (adresse) => ipcRenderer.invoke('serveur:tester', String(adresse || '')),
    utiliser: (adresse) => ipcRenderer.invoke('serveur:utiliser', String(adresse || '')),
    changer: () => ipcRenderer.invoke('serveur:changer'),
  },
  update: {
    onDownloaded: (cb) => { const h = (_e, info) => cb(info || {}); ipcRenderer.on('update:downloaded', h); return () => ipcRenderer.removeListener('update:downloaded', h); },
    install: () => ipcRenderer.invoke('update:install'),
  },
});
