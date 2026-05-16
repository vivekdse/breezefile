import { app, BrowserWindow, ipcMain, shell, Menu, protocol, Notification as ElectronNotification } from 'electron';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { registerIpc } from './ipc';
import { startApiServer } from './api-server';
import { startScheduler } from './scheduler';
import { setBreezeHost } from './core/host';
import { ElectronBreezeHost } from './core/electron-host';
import { restoreSources } from './sources';
import { registerBreezeMcp } from './mcp-register';
import { registerBreezeHooks } from './hooks-register';
import { platform } from './platform';
// Side-effect import: registers built-in agent runners (Claude) so the
// scheduler / run-now endpoints can dispatch by id (epic fm-zf3m).
import './agents';

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

  // Only forward real external links to the OS. A naive forward calls
  // shell.openExternal('about:blank') for empty / placeholder anchors
  // (target="_blank" with an empty/missing href, javascript: links,
  // markdown placeholders), which produces the macOS "no application
  // set to open about:blank" dialog. Allowlist the schemes we actually
  // want to hand off and silently deny everything else.
  const EXTERNAL_SCHEMES = /^(https?:|mailto:|tel:|x-apple\.|file:)/i;
  const handLinkToOS = (url: string, source: string) => {
    if (!EXTERNAL_SCHEMES.test(url)) {
      console.log(`[link] ignored (${source}): ${url.slice(0, 200)}`);
      return;
    }
    console.log(`[link] opening (${source}): ${url.slice(0, 200)}`);
    shell.openExternal(url).catch((err) => {
      console.error(`[link] openExternal failed for ${url}:`, err);
    });
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    handLinkToOS(url, 'window-open');
    return { action: 'deny' };
  });
  // Same guard for in-page navigations (link without target=_blank).
  // Without this, clicking such a link would navigate the renderer
  // away from the app shell.
  win.webContents.on('will-navigate', (e, url) => {
    // Allow internal dev-server / app-shell navigations.
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return;
    e.preventDefault();
    handLinkToOS(url, 'will-navigate');
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
  // Inject the Electron host before any task subsystem runs so
  // tasks.ts/scheduler.ts broadcast to windows + raise notifications
  // exactly as before the P1 core extraction (breezed injects a
  // headless host instead).
  setBreezeHost(ElectronBreezeHost);
  startApiServer();
  // fm-zf3m — auto-executor for tasks with auto_mode=1 / cron set.
  // Starts after the API server so the scheduler can rely on agent
  // registration (electron/agents has already been side-effect imported).
  startScheduler();
  // Reconnect previously-connected remote breezed daemons (best-effort,
  // never blocks startup).
  restoreSources();
  // fm-fc0 — best-effort: register breeze-mcp into ~/.claude/settings.json
  // on every launch. Idempotent — does nothing if already present and
  // up-to-date. Failures (file unreadable, no MCP binary) are logged
  // and ignored; never block app startup.
  try {
    const result = registerBreezeMcp();
    if (result === 'written') {
      console.log('[mcp-register] added breeze entry to ~/.claude/settings.json');
    }
  } catch (e) {
    console.warn('[mcp-register] failed:', (e as Error).message);
  }
  // fm-z7v — register UserPromptSubmit/Stop hooks so Claude Code reports
  // working/idle state per pty. Idempotent; failures are logged and
  // ignored.
  try {
    const result = registerBreezeHooks();
    if (result === 'written') {
      console.log('[hooks-register] updated ~/.claude/settings.json');
    }
  } catch (e) {
    console.warn('[hooks-register] failed:', (e as Error).message);
  }
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
  ipcMain.handle('app:playAttentionSound', () => {
    platform().playAttentionSound();
  });
  // Attention notifications routed via main process so the click handler
  // is reliable on Linux libnotify daemons (the web Notification API
  // delivered clicks unreliably across daemons, and any "View" button
  // surfaced by the daemon was a no-op). On click: focus the window and
  // tell the renderer which tab to select.
  ipcMain.handle(
    'app:showAttentionNotification',
    (_e, opts: { title: string; body: string; tabId: string }) => {
      try {
        if (!ElectronNotification.isSupported()) return;
        const n = new ElectronNotification({
          title: opts.title,
          body: opts.body,
          silent: true,
        });
        n.on('click', () => {
          const w =
            BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ?? null;
          if (w) {
            if (w.isMinimized()) w.restore();
            w.show();
            w.focus();
            w.webContents.send('app:notification-clicked', { tabId: opts.tabId });
          }
          try { n.close(); } catch { /* already gone */ }
        });
        n.show();
      } catch (e) {
        console.warn('[notify] show failed:', (e as Error).message);
      }
    },
  );
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
