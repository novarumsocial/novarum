import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  Tray,
} from 'electron';
import electronUpdater from 'electron-updater';

// apparently i need to do this pattern bc of commonjs, thanks commonjs
const { autoUpdater } = electronUpdater;
let isQuitting = false;
let tray: Tray | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const devUrl = 'http://localhost:5173';
const appOrigin = 'app://novarum';
const resourcesPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

function isInternalUrl(value: string) {
  const url = new URL(value);
  return app.isPackaged ? url.protocol === 'app:' && url.host === 'novarum' : url.origin === devUrl;
}

function openExternalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.href);
}

const prefsFile = path.join(app.getPath('userData'), 'launch-prefs.json');
const readPrefs = () => {
  try {
    return { autoLaunch: false, startHidden: true, ...JSON.parse(readFileSync(prefsFile, 'utf8')) };
  } catch {
    return { autoLaunch: false, startHidden: true };
  }
};

function applyAutoLaunch(enabled: boolean) {
  if (!app.isPackaged) return;
  if (process.platform !== 'linux') {
    return app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  }
  // electron has no login items on linux, so use an XDG autostart entry
  const entry = path.join(os.homedir(), '.config/autostart/novarum.desktop');
  if (!enabled) return rmSync(entry, { force: true });
  mkdirSync(path.dirname(entry), { recursive: true });
  const exec = process.env.APPIMAGE ?? process.execPath;
  writeFileSync(
    entry,
    `[Desktop Entry]\nType=Application\nName=Novarum\nExec="${exec}" --hidden\nIcon=novarum\n`
  );
}

function showWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(window: BrowserWindow) {
  const icon = nativeImage
    .createFromPath(path.join(resourcesPath, 'icons/linux/icons/64x64.png'))
    .resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('Novarum');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Novarum', click: () => showWindow(window) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => showWindow(window));
}

function frontendPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'frontend')
    : path.resolve(app.getAppPath(), '../frontend/build');
}

function registerAppProtocol() {
  const root = frontendPath();

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const requested = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const relative = path.relative(root, requested);
    if (url.host !== 'novarum' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Not found', { status: 404 });
    }

    const file = existsSync(requested) && relative ? requested : path.join(root, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

function configurePermissions() {
  const allowed = (value: string) => {
    try {
      const url = new URL(value);
      return app.isPackaged
        ? url.protocol === 'app:' && url.host === 'novarum'
        : url.origin === devUrl;
    } catch {
      return false;
    }
  };
  const allowedPermission = (permission: string) =>
    permission === 'media' || permission === 'notifications';

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      allowedPermission(permission) &&
      (allowed(requestingOrigin) || allowed(webContents?.getURL() || ''))
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowedPermission(permission) && allowed(webContents.getURL()));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!allowed(request.securityOrigin)) return callback({});

    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
    });
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Share your screen',
      message: 'Choose a screen or window to share',
      buttons: [...sources.map((source) => source.name), 'Cancel'],
      cancelId: sources.length,
    });

    callback(response === sources.length ? {} : { video: sources[response] });
  });
}

function configureAutoUpdater(window: BrowserWindow) {
  if (!app.isPackaged) return;

  autoUpdater.logger = console;
  autoUpdater.channel = 'dev';
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let downloading = false;

  autoUpdater.on('update-available', async ({ version }) => {
    if (downloading) return;

    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Novarum update available',
      message: `Novarum ${version} is available.`,
      detail: 'Download it now? You can keep using Novarum while it downloads.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response !== 0) return;

    downloading = true;
    void autoUpdater.downloadUpdate().catch((error) => {
      downloading = false;
      window.setProgressBar(-1);
      console.error('Failed to download update', error);
    });
  });

  autoUpdater.on('download-progress', ({ percent }) => {
    window.setProgressBar(percent / 100);
  });

  autoUpdater.on('update-downloaded', async ({ version }) => {
    window.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Novarum update ready',
      message: `Novarum ${version} is ready to install.`,
      detail: 'Restart Novarum to finish updating.',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('error', (error) => {
    downloading = false;
    window.setProgressBar(-1);
    console.error('Auto-update failed', error);
  });

  const check = () => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error('Failed to check for updates', error);
    });
  };

  setTimeout(check, 10_000).unref();
  setInterval(check, 30 * 60_000).unref();
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Novarum',
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0c090c',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#171217',
      symbolColor: '#f5f3f5',
      height: 36,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), '.electron/preload.cjs'),
      sandbox: true,
    },
  });

  if (process.platform === 'win32') {
    window.setIcon(path.join(resourcesPath, 'icons/windows/icon.ico'));
  }
  if (process.platform === 'linux') {
    window.setIcon(path.join(resourcesPath, 'icons/linux/icons/512x512.png'));
  }

  window.on('close', (ev) => {
    if (isQuitting) return;

    ev.preventDefault();
    window.hide();
  });

  window.once('ready-to-show', () => {
    const atLogin =
      process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
    if (!(atLogin && readPrefs().startHidden)) window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;

    event.preventDefault();
    openExternalUrl(url);
  });

  const load = () => window.loadURL(app.isPackaged ? `${appOrigin}/` : devUrl).catch(() => {});
  window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (!app.isPackaged && isMainFrame) setTimeout(load, 500);
  });
  void load();

  return window;
}

app.whenReady().then(() => {
  ipcMain.on('titlebar-colors', (event, color: string, symbolColor: string) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({
      color,
      symbolColor,
      height: 36,
    });
  });

  ipcMain.handle('launch:get', readPrefs);
  ipcMain.handle('launch:set', (_event, prefs: { autoLaunch?: boolean; startHidden?: boolean }) => {
    const next = { ...readPrefs(), ...prefs };
    writeFileSync(prefsFile, JSON.stringify(next));
    applyAutoLaunch(next.autoLaunch);
    return next;
  });

  ipcMain.handle('version:get', () => app.getVersion());

  ipcMain.on('voice:get-audio-devices', async (ev) => {
    // just noticed you can do this on the native browser apis lmfao
  });

  registerAppProtocol();
  configurePermissions();
  const window = createWindow();
  createTray(window);
  configureAutoUpdater(window);

  app.on('activate', () => {
    const window = BrowserWindow.getAllWindows()[0] ?? createWindow();
    showWindow(window);
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // removing everything here because there's a tray thingy now!
});
