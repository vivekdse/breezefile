import { app, BrowserWindow, ipcMain, shell, Menu, protocol } from 'electron';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerIpc } from './ipc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// package.json's `name` is the npm-style slug "file-manager"; Electron
// reads that for app.getName() in dev (before the bundle is built) and
// the default `role: 'appMenu'` uses it for the About / Hide / Quit
// labels. Force the display name so the menu says "Breeze File"
// everywhere, dev and packaged alike.
app.setName('Breeze File');

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');

// In dev the renderer is served from http://localhost:<port>, which makes
// `<img src="file:///…">` a cross-origin request that Electron blocks even
// when CSP allows `img-src file:`. Register an app-scoped `asset://` scheme
// so the renderer can load local files through a proper handler with MIME
// types. Must be registered before app.whenReady.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'asset',
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
]);

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

function mimeFor(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f1114',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // fm-c2w — forward focus/blur to the renderer so the attention layer
  // can decide whether to raise a system notification (only when we're
  // backgrounded; if the user is already looking at the window the dot
  // alone is enough).
  win.on('focus', () => win?.webContents.send('app:focus', true));
  win.on('blur', () => win?.webContents.send('app:focus', false));

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

app.whenReady().then(() => {
  // asset:///<absolute-path> → stream the file from disk. We delegate to
  // Electron's `net.fetch` with a file:// URL so we get proper range-request
  // and streaming semantics for large media, then patch Content-Type.
  protocol.handle('asset', async (req) => {
    try {
      const url = new URL(req.url);
      const abs = decodeURIComponent(url.pathname);
      if (!path.isAbsolute(abs)) {
        console.warn('[asset] rejected non-absolute path:', abs);
        return new Response('bad path', { status: 400 });
      }
      const bytes = await fs.readFile(abs);
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': mimeFor(abs) },
      });
    } catch (err) {
      console.warn('[asset] read failed:', req.url, (err as Error).message);
      return new Response(`not found: ${(err as Error).message}`, { status: 404 });
    }
  });

  registerIpc();
  // fm-c2w — dock badge IPC. Renderer passes a string ('' clears, '!' or
  // a count for active attention). On non-darwin, app.dock is undefined
  // and we silently no-op.
  ipcMain.handle('app:setDockBadge', (_e, text: string) => {
    try {
      app.dock?.setBadge(text ?? '');
    } catch {
      /* ignore platform / runtime errors — badge is best-effort */
    }
  });
  buildAppMenu();
  createWindow();
});

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Custom Window menu — the default 'windowMenu' role binds ⌘W to
     // "Close Window", which stops the renderer from using ⌘W for "close
     // tab". We reassign: ⌘W → close tab (handled in useKeyboard.ts),
     // ⌘⇧W → close window.
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front' },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
  win = null;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
