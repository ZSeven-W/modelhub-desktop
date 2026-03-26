const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const axios = require('axios');

// ─── Constants ────────────────────────────────────────────────────────────────
const API_PORT = 3357;
const API_BASE = `http://localhost:${API_PORT}`;
const PYTHON_SCRIPT = path.join(__dirname, 'server.py');

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let serverProcess = null;
let tray = null;

// ─── Server Management ────────────────────────────────────────────────────────
function startPythonServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [PYTHON_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg.includes('Running on')) resolve();
      console.log('[server]', msg);
    });

    proc.stderr.on('data', (data) => {
      console.error('[server:err]', data.toString().trim());
    });

    proc.on('error', (err) => reject(err));
    serverProcess = proc;

    // Give it 3 seconds to start
    setTimeout(() => resolve(), 3000);
  });
}

function stopPythonServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // macOS traffic lights
  mainWindow.setWindowButtonVisibility(true);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('minimize', (e) => {
    // Keep in dock on minimize (don't hide)
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  // Create a 16x16 blue dot as tray icon
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ModelHub', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);

  tray.setToolTip('ModelHub-Desktop');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
function setupIpcHandlers() {
  // Proxy all API calls from renderer to Python backend
  ipcMain.handle('api:get', async (_, route) => {
    try {
      const resp = await axios.get(`${API_BASE}${route}`);
      return resp.data;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('api:post', async (_, route, body) => {
    try {
      const resp = await axios.post(`${API_BASE}${route}`, body);
      return resp.data;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('api:delete', async (_, route) => {
    try {
      const resp = await axios.delete(`${API_BASE}${route}`);
      return resp.data;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // OS Notifications
  ipcMain.handle('notification:show', async (_, { title, body: bodyText }) => {
    if (!Notification.isSupported()) return { success: false, error: 'Notifications not supported' };
    const n = new Notification({
      title,
      body: bodyText,
      icon: path.join(__dirname, 'public', 'icon.png'),
    });
    n.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
    return { success: true };
  });

  // Launch model in Terminal
  ipcMain.handle('launch:terminal', async (_, modelName) => {
    const script = `tell application "Terminal" to do script "ollama run ${modelName}"`;
    return new Promise((resolve) => {
      exec(`osascript -e '${script}'`, (err) => {
        resolve({ success: !err, error: err ? err.message : null });
      });
    });
  });

  // Open folder in Finder
  ipcMain.handle('open:folder', async (_, folderPath) => {
    shell.openPath(folderPath);
    return { success: true };
  });

  // Open URL in browser
  ipcMain.handle('open:url', async (_, url) => {
    shell.openExternal(url);
    return { success: true };
  });
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  console.log('Starting ModelHub-Desktop...');
  await startPythonServer();
  createWindow();
  setupIpcHandlers();
});

app.on('window-all-closed', () => {
  stopPythonServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopPythonServer();
});
