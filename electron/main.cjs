const { app, BrowserWindow } = require('electron');

const DEV_URL = process.env.HIERO_FRONTEND_URL || 'http://127.0.0.1:5173';
// Chromium binds this DevTools port to 127.0.0.1 only. The agent attaches over CDP to read and act on webview pages.
const SHARED_CDP_PORT = Number(process.env.HIERO_SHARED_CDP_PORT || 9333);
app.commandLine.appendSwitch('remote-debugging-port', String(SHARED_CDP_PORT));

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Hiero',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} HieroDesktop/1`);
  win.loadURL(DEV_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
