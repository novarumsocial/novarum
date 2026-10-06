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
import { registerVenmicHandlers, shutdownVenmic } from './venmic';

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

function configureAutoUpdater(window: BrowserWindow) {
  if (!app.isPackaged) return;

  autoUpdater.logger = console;
  autoUpdater.channel = 'dev';
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let downloading = false;

  const download = () => {
    downloading = true;
    void autoUpdater.downloadUpdate().catch((error) => {
      downloading = false;
      window.setProgressBar(-1);
      console.error('Failed to download update', error);
    });
  };

  autoUpdater.on('update-available', async ({ version }) => {
    if (downloading) return;
    if (readPrefs().autoUpdate) return download();

    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: 'Novarum update available',
      message: `Novarum ${version} is available.`,
      detail: 'Download it now? You can keep using Novarum while it downloads.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) download();
  });

  autoUpdater.on('download-progress', ({ percent }) => {
    window.setProgressBar(percent / 100);
  });

  autoUpdater.on('update-downloaded', async ({ version }) => {
    window.setProgressBar(-1);
    // with auto-update on, the update installs the next time Novarum quits
    if (readPrefs().autoUpdate) return;
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
    if (!readPrefs().autoUpdate) return;
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

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { status: 'unsupported' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable
        ? { status: 'available', version: result.updateInfo.version }
        : { status: 'current' };
    } catch {
      return { status: 'error' };
    }
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
  shutdownVenmic();
});

app.on('window-all-closed', () => {
  // removing everything here because there's a tray thingy now!
});
