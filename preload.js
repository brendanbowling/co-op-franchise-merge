'use strict';

// Bridge: the renderer calls window.cfb.* which forward to main-process IPC handlers.
// The renderer never touches fs / the madden-franchise library directly.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cfb', {
  pickSave: (title) => ipcRenderer.invoke('pick-save', title),
  pickOutput: (suggestedName) => ipcRenderer.invoke('pick-output', suggestedName),
  preview: (args) => ipcRenderer.invoke('preview', args),
  apply: (args) => ipcRenderer.invoke('apply', args),
});
