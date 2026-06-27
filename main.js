'use strict';

/**
 * Electron main process (Node side). All file I/O + library calls live here; the renderer only
 * talks to these via the preload bridge. Reuses the existing engine in src/ unchanged.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { applyMerge, previewMerge } = require('./src/applyMerge');

function loadConfig(game) {
  const p = path.join(__dirname, 'config', `${game}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Default Madden save folder, to pre-seed the file dialog.
function defaultSaveDir() {
  const home = app.getPath('home');
  const candidates = [
    path.join(home, 'Documents', 'Madden NFL 26', 'settings'),
    path.join(home, 'Documents', 'Madden NFL 26'),
  ];
  return candidates.find(fs.existsSync) || app.getPath('documents');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    title: 'Madden NFL 26 Offline Franchise Merge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // renderer can't reach Node/Electron internals
      nodeIntegration: false,   // no require() in the renderer
      sandbox: true,            // renderer runs in an OS sandbox
      webSecurity: true,        // enforce same-origin + CSP (default, set explicitly)
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- IPC handlers ---

ipcMain.handle('pick-save', async (_evt, title) => {
  const res = await dialog.showOpenDialog({
    title: title || 'Select a save file',
    defaultPath: defaultSaveDir(),
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('pick-output', async (_evt, suggestedName) => {
  const res = await dialog.showSaveDialog({
    title: 'Save merged file as',
    defaultPath: path.join(defaultSaveDir(), suggestedName || 'CAREER-MERGED'),
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('preview', async (_evt, { baseline, host, guest, game }) => {
  try {
    const config = loadConfig(game || 'madden26');
    if (!baseline || !guest) throw new Error('Pick the shared starting save and the partner save.');
    const res = await previewMerge({ baseline, guest, config });
    return { ok: true, ...res, host };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply', async (_evt, { baseline, host, guest, out, game }) => {
  try {
    const config = loadConfig(game || 'madden26');
    if (!baseline || !host || !guest || !out) throw new Error('All files (and output path) are required.');
    const res = await applyMerge({ baseline, host, guest, out, config });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Match the installer's AppUserModelID so Windows links the running window's taskbar button to the
// installed shortcut (correct icon, grouping, pinning, and notifications). Must equal build.appId.
app.setAppUserModelId('com.maddenfranchisemerge.app');

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
