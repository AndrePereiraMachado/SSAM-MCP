// The bridge between the panel (ui/) and the main process: a fixed set of calls, nothing else of Node or Electron
// reaches the page. CommonJS because the preload runs in the sandbox.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('ssam', {
  getState: () => invoke('state:get'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('state', listener); return () => ipcRenderer.removeListener('state', listener); },
  setup: payload => invoke('agent:setup', payload),
  start: () => invoke('agent:start'),
  stop: () => invoke('agent:stop'),
  doctor: () => invoke('agent:doctor'),
  readLog: () => invoke('agent:log'),
  checkUpdates: () => invoke('updates:check'),
  installUpdate: () => invoke('updates:install'),
  setSettings: payload => invoke('settings:set', payload),
  pickRoot: () => invoke('root:pick'),
  openFolder: () => invoke('open:folder'),
  openLog: () => invoke('open:log'),
  openAppLog: () => invoke('open:app-log'),
  quit: () => invoke('app:quit'),
});
