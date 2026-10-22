// The panel: one window (status, setup, updates, doctor, log) over the React page of src/renderer (the Vite dev server
// in `npm run dev`, out/renderer/index.html otherwise), isolated from Node (contextIsolation, sandbox, no
// nodeIntegration) and talking to the main process only through the preload. Closing it hides nothing but the window
// itself: the app stays in the tray.
import { BrowserWindow, shell } from 'electron';

export function createPanel({ rendererUrl = null, rendererFile, preload, iconPath = null, onReady = () => {} }) {
  let win = null;

  function open() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
    win = new BrowserWindow({ width: 600, height: 760, minWidth: 480, minHeight: 520, show: false, title: 'SSAM Agent', autoHideMenuBar: true,
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    win.setMenuBarVisibility(false);
    if (rendererUrl) win.loadURL(rendererUrl); else win.loadFile(rendererFile);
    win.once('ready-to-show', () => { win.show(); onReady(win); });
    // Links of the panel open in the browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
    win.on('closed', () => { win = null; });
    return win;
  }

  function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
  function close() { if (win && !win.isDestroyed()) win.destroy(); win = null; }

  return { open, send, close, get window() { return win; } };
}
