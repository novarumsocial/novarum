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
import type { UpdateStatus } from '../../frontend/src/lib/electron-api';
import { registerVenmicHandlers, shutdownVenmic } from './venmic';

// apparently i need to do this pattern bc of commonjs, thanks commonjs
const { autoUpdater } = electronUpdater;
let isQuitting = false;
let tray: Tray | undefined;
let mainWindow: BrowserWindow | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const devUrl = 'http://localhost:5173';
const appOrigin = 'app://novarum';
const resourcesPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

// on wayland, desktopCapturer.getSources() itself goes through the compositor's
// xdg-desktop-portal screencast picker (and, per electron's own docs, only ever
// returns that single already-chosen source when pipewire is in use) - so our own
// picker dialog below would just be a redundant second prompt on top of it.
const isWayland =
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

function isInternalUrl(value: string) {
  const url = new URL(value);
  return app.isPackaged ? url.protocol === 'app:' && url.host === 'novarum' : url.origin === devUrl;
}

function openExternalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.href);
}

const prefsFile = path.join(app.getPath('userData'), 'launch-prefs.json');
const defaultPrefs = { autoLaunch: false, startHidden: true, autoUpdate: true };
const readPrefs = () => {
  try {
    return { ...defaultPrefs, ...JSON.parse(readFileSync(prefsFile, 'utf8')) };
  } catch {
    return defaultPrefs;
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

const launchHidden = () =>
  (process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin) &&
  readPrefs().startHidden;

function showWindow(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function updateTrayMenu() {
  if (!tray || !mainWindow) return;
  const window = mainWindow;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Novarum', click: () => showWindow(window) },
      ...(update.status === 'downloaded'
        ? [{ label: `Restart to update to ${update.version}`, click: installUpdate }]
        : []),
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function createTray(window: BrowserWindow) {
  const icon = nativeImage
    .createFromPath(path.join(resourcesPath, 'icons/linux/icons/64x64.png'))
    .resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('Novarum');
  updateTrayMenu();
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
    permission === 'media' || permission === 'notifications' || permission === 'fullscreen';

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

    let source;
    if (isWayland) {
      source = sources[0];
    } else {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Share your screen',
        message: 'Choose a screen or window to share',
        buttons: [...sources.map((s) => s.name), 'Cancel'],
        cancelId: sources.length,
      });
      source = response === sources.length ? undefined : sources[response];
    }

    if (!source) return callback({});

    // system audio loopback is only wired up by chromium on windows and macos 13+
    // (via the coreaudio tap api on 14.2+) - linux has no equivalent yet, so screen
    // shares there stay video-only until chromium adds pipewire audio support.
    // note: electron validates `audio` if the key is present at all, even as
    // `undefined`, so it must be omitted entirely rather than set to undefined.
    const supportsAudioLoopback = process.platform === 'win32' || process.platform === 'darwin';
    const streams: Parameters<typeof callback>[0] = { video: source };
    if (request.audioRequested && supportsAudioLoopback) streams.audio = 'loopback';

    callback(streams);
  });
}

let update: UpdateStatus = { status: app.isPackaged ? 'idle' : 'unsupported' };
let downloading: Promise<unknown> | undefined;
let splash: BrowserWindow | undefined;

function setUpdate(next: UpdateStatus) {
  update = next;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('update:status', update);
    window.setProgressBar(update.status === 'downloading' ? (update.percent ?? 0) / 100 : -1);
  }
  updateTrayMenu();
}

function downloadUpdate() {
  if (downloading) return downloading;
  setUpdate({ status: 'downloading', version: update.version, percent: 0 });
  return (downloading = autoUpdater.downloadUpdate().finally(() => (downloading = undefined)));
}

function installUpdate() {
  // otherwise the window's close handler hides it to the tray and the install never runs
  isQuitting = true;
  autoUpdater.quitAndInstall(true, true);
}

function checkForUpdates() {
  if (update.status === 'downloading' || update.status === 'downloaded') return;
  return autoUpdater.checkForUpdates().catch((error) => {
    console.error('Failed to check for updates', error);
  });
}

function configureAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.logger = console;
  autoUpdater.channel = 'dev';
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'current' }));
  autoUpdater.on('update-available', ({ version }) => {
    setUpdate({ status: 'available', version });
    if (readPrefs().autoUpdate) void downloadUpdate().catch(() => {});
  });
  autoUpdater.on('download-progress', ({ percent }) =>
    setUpdate({ status: 'downloading', version: update.version, percent })
  );
  autoUpdater.on('update-downloaded', ({ version }) =>
    setUpdate({ status: 'downloaded', version })
  );
  autoUpdater.on('error', (error) => {
    console.error('Auto-update failed', error);
    setUpdate({ status: 'error', version: update.version });
  });

  setInterval(() => readPrefs().autoUpdate && checkForUpdates(), 30 * 60_000).unref();
}

// checks for an update before the main window opens and installs it right away,
// returns true when the app is about to restart into the new version. the splash stays
// open until the main window is ready, so there's never a moment with nothing on screen
async function updateOnLaunch() {
  splash = new BrowserWindow({
    width: 300,
    height: 320,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0c090c',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), '.electron/preload.cjs'),
      sandbox: true,
    },
  });
  void splash.loadURL(`${appOrigin}/updater`).catch(() => {});

  try {
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, 15_000));
    const result = await Promise.race([autoUpdater.checkForUpdates(), timeout]);
    if (result?.isUpdateAvailable) {
      await downloadUpdate();
      installUpdate();
      return true;
    }
  } catch (error) {
    console.error('Launch update failed', error);
  }
  return false;
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
    if (!launchHidden()) window.show();
    splash?.destroy();
    splash = undefined;
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

app.whenReady().then(async () => {
  ipcMain.on('titlebar-colors', (event, color: string, symbolColor: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === splash) return;
    window?.setTitleBarOverlay({
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

  ipcMain.handle('update:status', (event) => {
    // the splash asks once it has painted in the user's theme, which avoids a flash on first paint
    if (event.sender === splash?.webContents) splash.show();
    return update;
  });
  ipcMain.handle('update:check', async () => {
    if (app.isPackaged) await checkForUpdates();
    return update;
  });
  ipcMain.handle('update:download', () => {
    if (update.status === 'available') void downloadUpdate().catch(() => {});
  });
  ipcMain.handle('update:install', () => {
    if (update.status === 'downloaded') installUpdate();
  });

  ipcMain.handle('version:get', () => app.getVersion());
  ipcMain.handle('badge:set', (_event, count: number) => {
    app.setBadgeCount(Math.max(0, Math.floor(Number(count)) || 0));
  });

  ipcMain.on('voice:get-audio-devices', async (ev) => {
    // just noticed you can do this on the native browser apis lmfao
  });

  registerAppProtocol();
  configurePermissions();
  registerVenmicHandlers();
  configureAutoUpdater();

  const autoUpdate = app.isPackaged && readPrefs().autoUpdate;
  if (autoUpdate && !launchHidden() && (await updateOnLaunch())) return;
  if (autoUpdate && launchHidden()) setTimeout(checkForUpdates, 10_000).unref();

  const window = (mainWindow = createWindow());
  createTray(window);

  app.on('activate', () => {
    const window = BrowserWindow.getAllWindows()[0] ?? createWindow();
    showWindow(window);
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  shutdownVenmic();
});

app.on('window-all-closed', () => {
  // removing everything here because there's a tray thingy now!
});
