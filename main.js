const { app, BrowserWindow, Menu } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
let backendProcess;

function waitForBackend(attempts = 40) {
  return new Promise((resolve, reject) => {
    const check = (remaining) => {
      const request = http.get(`${backendUrl}/api/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        if (remaining === 0) return reject(new Error(`Backend returned ${response.statusCode}`));
        setTimeout(() => check(remaining - 1), 250);
      });
      request.on('error', () => {
        if (remaining === 0) return reject(new Error('Backend did not become ready'));
        setTimeout(() => check(remaining - 1), 250);
      });
    };
    check(attempts);
  });
}

function startBackend() {
  const backendEntry = path.join(__dirname, 'backend', 'src', 'server.js');
  backendProcess = spawn('node', [backendEntry], {
    cwd: path.dirname(backendEntry),
    env: { ...process.env },
    stdio: 'inherit',
    windowsHide: true,
  });
  backendProcess.on('error', (error) => console.error('Backend process failed:', error.message));
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  startBackend();
  await waitForBackend();

  const window = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.setMenuBarVisibility(false);
  window.loadURL(backendUrl);
}

app.whenReady().then(createWindow).catch((error) => {
  console.error('Unable to start the restaurant system:', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});
