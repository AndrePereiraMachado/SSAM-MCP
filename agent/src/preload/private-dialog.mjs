import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('ssamPrivate', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('private-dialog:bootstrap'),
  submit: values => ipcRenderer.invoke('private-dialog:submit', values),
  resize: height => ipcRenderer.invoke('private-dialog:resize', height),
  cancel: () => ipcRenderer.invoke('private-dialog:cancel'),
  onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('private-dialog:state', listener); return () => ipcRenderer.removeListener('private-dialog:state', listener); },
}));
