import { app, BrowserWindow, ipcMain, shell, Menu, dialog, protocol, screen, Notification as ElectronNotification } from 'electron';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerIpc } from './ipc';
import { startApiServer } from './api-server';
import { startScheduler } from './scheduler';
import { setBreezeHost } from './core/host';
import { ElectronBreezeHost } from './core/electron-host';
import { setTaskNotifyVerbosity } from './core/notify-settings.mjs';
import { restoreSources } from './sources';
import { registerBreezeMcp } from './mcp-register';
import { registerBreezeHooks, ensureBreezeCli } from './hooks-register';
import { registerTypebuildAuthIpc } from './typebuild/ipc-auth';
import { registerTypebuildDetectIpc } from './typebuild/detect';
import {
  getAuthState,
  onAuthStateChanged,
} from './typebuild/auth';
import { TypeBuildTaskSource } from './sources/typebuild';
import { startExpiryClock, reconcileExpiry } from './typebuild/expiry-clock';
import {
  registerTaskSource,
  unregisterTaskSource,
} from './sources/registry';
import { platform } from './platform';
// Side-effect import: registers built-in agent runners (Claude) so the
// scheduler / run-now endpoints can dispatch by id (epic fm-zf3m).
import './agents';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prefer IPv4 when a host resolves to both A and AAAA records. Node 17+
// defaults to "verbatim" ordering, so hosts that publish AAAA first (e.g.
// Cloudflare-fronted general.typebuild.com) get an IPv6 connection attempt
// first. On a machine with no working IPv6 route, undici (fetch) connects to
// that dead address and HANGS until UND_ERR_CONNECT_TIMEOUT (10s) instead of
// falling back to IPv4 the way curl's Happy-Eyeballs does — which surfaced as
// "[typebuild-mint:unreachable] Could not reach the mint endpoint" even though
// the endpoint is up. ipv4first restores the pre-v17 behaviour: IPv4 is tried
// first, IPv6 still used when that's all a host has.
dns.setDefaultResultOrder('ipv4first');

// package.json's `name` is the npm-style slug "file-manager"; Electron
// reads that for app.getName() in dev (before the bundle is built) and
// the default `role: 'appMenu'` uses it for the About / Hide / Quit
// labels. Force the display name so the menu says "Breeze File"
// everywhere, dev and packaged alike.
app.setName('Breeze File');

// ─── Fail-soft safety net ────────────────────────────────────────────────────
// A network / TLS / auth failure deep in an async path (a TypeBuild mint or
// poll whose fetch rejects, a revoked token, a Chromium TLS handshake) must
// DEGRADE, never take the whole app down. Node treats an unhandled promise
// rejection as fatal by default, so one stray reject from a transient outage or
// a changed login mechanism would crash Breeze. We log terse, token/PHI-free
// context and keep running: the affected feature surfaces its own in-app error
// (e.g. the mint's typed signed-out / unreachable message), the rest stays up.
process.on('unhandledRejection', (reason) => {
  const e = reason as { name?: string; message?: string } | undefined;
  console.error(
    '[main] unhandled rejection (non-fatal):',
    e?.name || '',
    e?.message || String(reason),
  );
});
process.on('uncaughtException', (err) => {
  // Survive by policy (the user wants graceful degradation, not a crash). Log
  // loudly so the failure is still diagnosable in the terminal.
  console.error('[main] uncaught exception (non-fatal):', err?.name, err?.message);
});

// TLS certificate failures: surface WHICH url failed (instead of opaque
// Chromium boringssl noise) and KEEP rejecting. We deliberately do NOT bypass
// verification — Breeze fills PII (SSNs, etc.) into pages, so an untrusted cert
// MUST stay rejected. This only makes the failure observable + explicitly
// handled, so a bad cert degrades the affected page rather than spamming
// anonymous errors. callback(false) preserves Chromium's secure default.
app.on(
  'certificate-error',
  (_event, _webContents, url, error, _certificate, callback) => {
    console.error(`[main] TLS certificate rejected: ${url} (${error})`);
    callback(false);
  },
);

// ─── SPIKE (spike/playwright-cdp): expose CDP so Playwright can drive an
// embedded WebContentsView over the wire. Must be set before app is ready.
// Remove this whole block (and the spikeView code in createWindow) to revert.
app.commandLine.appendSwitch('remote-debugging-port', '9222');

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
  // Window chrome: the hidden-inset title bar, traffic-light inset, and
  // under-window vibrancy are macOS-only. On Windows/Linux they're ignored or
  // (vibrancy) unsupported, so we apply them conditionally and fall back to a
  // standard frame elsewhere. The opaque backgroundColor stands in for the
  // translucency on platforms without vibrancy.
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    // Don't paint until first frame is ready. In dev (vite-plugin-electron
    // relaunches the process on every code change) we then show the window
    // *inactive* so it reappears in place without stealing focus from
    // whatever app you're working in. Production launch focuses normally.
    // titleBarStyle/trafficLightPosition are applied mac-only in the spread
    // below (Windows/Linux get a standard frame).
    show: false,
    backgroundColor: '#0f1114',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 16 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: true,
      contextIsolation: true,
      // Electron throttles a backgrounded renderer (paused timers, dropped
      // GPU surface), which is what makes Breeze paint blank for a beat when
      // you switch back from another app. We're a foreground productivity
      // tool, not a background tab — keep rendering at full rate so refocus
      // is instant.
      backgroundThrottling: false,
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

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    // showInactive() avoids raising the window above other apps / stealing
    // keyboard focus on every dev reload. A real production launch should
    // come to the front like a normal app.
    if (VITE_DEV_SERVER_URL) win.showInactive();
    else win.show();
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    // DevTools is opt-in during dev so it stops popping on every reload.
    // Set BREEZE_DEVTOOLS=1 to auto-open it, or use the View menu /
    // Cmd-Alt-I (Ctrl-Shift-I) any time.
    if (process.env.BREEZE_DEVTOOLS === '1')
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
  // fm-b5at.2 — TypeBuild Firebase auth IPC. Registers signIn/signOut/state
  // handlers + the auth-state broadcaster, and restores any persisted
  // (encrypted) session from a prior launch. Best-effort; never blocks.
  registerTypebuildAuthIpc();
  // fm-b5at.3 — TypeBuild onboarding prerequisite detection IPC
  // (claude/chrome presence + the Claude Code install command). Used by the
  // onboarding checklist in Settings.
  registerTypebuildDetectIpc();
  // fm-b5at.4 — register the TypeBuildTaskSource in the task-source registry
  // exactly while signed in, so TypeBuild tasks appear in the existing
  // TasksPage. Sign-in registers + starts polling; sign-out unregisters +
  // stops polling (which clears the in-memory PHI-light cache). Each
  // transition fires a `sources:changed` broadcast so the renderer's
  // useTaskSources() re-pulls the capability map, plus a `tasks:changed`
  // so the list re-pulls immediately.
  wireTypebuildTaskSource();
  // fm-b5at.10 — TypeBuild MCP session-expiry clock. Watches the live-session
  // registry (sessions.ts) and broadcasts a T-15min warning + an at-expiry
  // prompt per session, re-evaluating on wake-from-sleep so a token that
  // lapsed while suspended is caught the instant the machine resumes. The
  // renderer turns 'expired' into a one-click relaunch via the IPC below.
  startExpiryClock();
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
  // Put `breeze` on PATH automatically (symlink ~/.local/bin/breeze →
  // bundled/dev shim). Idempotent; covers both `npm run dev` and the
  // packaged .app so users never need ./cli/install.sh. Best-effort —
  // failures are logged and never block startup.
  try {
    const result = ensureBreezeCli();
    if (result === 'written') {
      console.log('[breeze-cli] linked ~/.local/bin/breeze');
    }
  } catch (e) {
    console.warn('[breeze-cli] failed:', (e as Error).message);
  }
  // Tool Repository (docs/Playwright agent.md): install the bundled seed
  // tools into ~/.breezefile/tools/ on every launch. Idempotent — only copies
  // tools that aren't already present, so user/agent edits are never clobbered.
  // Dynamic import keeps the .mjs out of the tsc graph (it pulls no TS deps).
  import('./browser/tools/install.mjs')
    .then(({ installSeedTools }) => {
      const { installed, errors } = installSeedTools();
      if (installed.length) console.log('[tool-seeds] installed:', installed.join(', '));
      if (errors.length) console.warn('[tool-seeds] errors:', errors.join('; '));
    })
    .catch((e) => console.warn('[tool-seeds] failed:', (e as Error).message));

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
  // fm-h8g7 — task-notification verbosity mirror. Settings are renderer-owned
  // (localStorage), but the OS-notification gate runs in MAIN (electron-host
  // builds the Notification). The renderer pushes its current value on boot
  // and on every change; we cache it in the main-process notify-settings
  // module. Default stays 'all' until the renderer reports in.
  ipcMain.on('settings:taskNotifications', (_e, value: string) => {
    setTaskNotifyVerbosity(value as 'all' | 'failures' | 'off');
  });
  // Window state verbs. Linux WMs commonly bind Alt+Space to a menu that
  // owns maximize / fullscreen, but Breezefile's chip prompt also uses
  // Alt+Space, so we expose explicit verbs (and accelerators) instead of
  // depending on the WM.
  function focusedWindow(): BrowserWindow | null {
    return (
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ??
      null
    );
  }
  ipcMain.handle('window:toggleMaximize', () => {
    const w = focusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle('window:toggleFullscreen', () => {
    const w = focusedWindow();
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
  });
  // fm-dly3 — grow the window by the chat panel's width when chat opens so the
  // editor / file list keeps the width it had before, then restore on close.
  // Clamped to the current display's work area (and skipped while maximized /
  // fullscreen, where we can't grow and the CSS handles the squeeze). Keyed
  // per-window so multi-window stays sane.
  const chatGrow = new Map<number, number>(); // win.id → width before growing
  ipcMain.handle(
    'window:chatResize',
    (e, open: boolean, panelWidth: number) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w || w.isDestroyed()) return;
      if (w.isMaximized() || w.isFullScreen()) return;
      const id = w.id;
      const pad = Math.max(0, Math.round(panelWidth));
      const [x, y] = w.getPosition();
      const [width, height] = w.getSize();
      const wa = screen.getDisplayMatching(w.getBounds()).workArea;
      if (open) {
        if (chatGrow.has(id)) return; // already grown
        const target = Math.min(width + pad, wa.width);
        if (target <= width) return; // no room to grow — CSS copes
        chatGrow.set(id, width);
        // Keep the (now wider) window inside the work area.
        const nx = Math.max(wa.x, Math.min(x, wa.x + wa.width - target));
        w.setBounds({ x: nx, y, width: target, height });
      } else {
        const prev = chatGrow.get(id);
        if (prev == null) return; // we didn't grow it
        chatGrow.delete(id);
        const minW = w.getMinimumSize()[0] || 0;
        w.setBounds({ x, y, width: Math.max(prev, minW), height });
      }
    },
  );
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

// fm-b5at.4 — keep the TypeBuildTaskSource registered exactly while signed
// in. Broadcasts sources:changed (so the renderer re-pulls the capability
// map via useTaskSources) and tasks:changed (so the list re-pulls) on every
// transition. Handles the initial state too: restoreSession() may have
// already signed us in by the time this runs, and may also flip to signed-in
// shortly after via the auth listener.
function wireTypebuildTaskSource() {
  let source: TypeBuildTaskSource | null = null;

  function broadcast(channel: string) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel);
    }
  }

  // fm-b5at.10 — one-click expiry relaunch. The renderer's "restart task"
  // button (shown when the expiry clock broadcasts 'expired') invokes this.
  // We kill the old PTY, mint a fresh token, and respawn the SAME conversation
  // with --continue. A typed mint failure propagates so the renderer maps it
  // to the same three in-app messages as the initial launch (no dead
  // terminal). After a successful relaunch we poke the clock to re-arm against
  // the new token's horizon immediately. Registered once at module init; it
  // no-ops gracefully when signed out (no source).
  ipcMain.handle(
    'typebuild:relaunchSession',
    async (_e, payload: { ptyId: number; taskId: string }) => {
      if (!source) throw new Error('typebuild: not signed in');
      const result = await source.relaunchSession(payload.ptyId, payload.taskId);
      reconcileExpiry();
      return result;
    },
  );

  function register() {
    if (source) return;
    source = new TypeBuildTaskSource();
    registerTaskSource(source);
    source.startPolling();
    broadcast('sources:changed');
    broadcast('tasks:changed');
  }

  function unregister() {
    if (!source) return;
    source.stopPolling();
    unregisterTaskSource(source.id);
    source = null;
    broadcast('sources:changed');
    broadcast('tasks:changed');
  }

  function sync(signedIn: boolean) {
    if (signedIn) register();
    else unregister();
  }

  // Initial state (restoreSession in registerTypebuildAuthIpc is async, so we
  // may be signed out now and flip later — the listener below catches that).
  sync(getAuthState().signedIn);
  onAuthStateChanged((state) => sync(state.signedIn));
}

function sendVerbToFocused(verbId: string) {
  const w =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ??
    null;
  if (!w || w.isDestroyed()) return;
  w.webContents.send('app:menu-verb', { verbId });
}

// Forward a renderer verb from a native menu item. The renderer opens
// ChipPrompt with this verb pre-selected; zero-slot verbs execute
// immediately. Accelerators here are advisory display only — the actual
// key binding lives in useKeyboard.ts. We omit accelerator on items
// whose chord is multi-key (e.g. "gh", "wt"), since Electron menus only
// support single chords.
function verbItem(
  label: string,
  verbId: string,
  accelerator?: string,
): Electron.MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => sendVerbToFocused(verbId),
  };
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        verbItem('New Tab', 'newTab', 'CmdOrCtrl+T'),
        verbItem('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        verbItem('Reopen Closed Tab', 'restoreTab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        verbItem('New Folder…', 'folder'),
        verbItem('New File…', 'file'),
        verbItem('New Note', 'note'),
        { type: 'separator' },
        verbItem('Rename…', 'rename', 'F2'),
        verbItem('Edit File', 'edit'),
        verbItem('Open', 'open'),
        verbItem('Open With…', 'open-with'),
        verbItem('Reveal in File Manager', 'reveal'),
        { type: 'separator' },
        verbItem('Move to Trash', 'delete'),
        verbItem('Compress…', 'compress'),
        verbItem('Extract', 'extract'),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Navigate',
      submenu: [
        verbItem('Back', 'back'),
        verbItem('Forward', 'forward'),
        verbItem('Up', 'up'),
        { type: 'separator' },
        verbItem('Go to…', 'goto', 'CmdOrCtrl+F'),
        verbItem('Notes Folder', 'notes'),
        verbItem('Switch Tab…', 'switchTab'),
        { type: 'separator' },
        verbItem('Pin Folder', 'pin'),
        verbItem('Unpin Folder', 'unpin'),
      ],
    },
    {
      label: 'Selection',
      submenu: [
        verbItem('Select…', 'select'),
        verbItem('Copy', 'copy', 'CmdOrCtrl+C'),
        verbItem('Move (cut)', 'move', 'CmdOrCtrl+X'),
        verbItem('Paste', 'paste', 'CmdOrCtrl+V'),
        { type: 'separator' },
        verbItem('Copy Path', 'copy-path'),
        verbItem('Share…', 'share'),
      ],
    },
    {
      label: 'View',
      submenu: [
        // Cmd/Ctrl+R is deliberately NOT a full BrowserWindow reload —
        // that nukes every tab + the terminal ptys. The renderer binds
        // C-r to a tab-scoped refresh (store.refreshActive). A full
        // reload is still reachable under Cmd/Ctrl+Shift+R, but since it
        // discards every tab + pty we confirm first (and spell out the
        // cost when more than one tab is open).
        {
          label: 'Force Reload (discards tabs)',
          accelerator: 'CmdOrCtrl+Shift+R',
          async click() {
            const target =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ??
              null;
            if (!target || target.isDestroyed()) return;
            let tabCount = 0;
            try {
              tabCount = Number(
                await target.webContents.executeJavaScript(
                  'window.__fmTabCount ?? 0',
                ),
              );
            } catch {
              tabCount = 0;
            }
            const many = tabCount > 1;
            const { response } = await dialog.showMessageBox(target, {
              type: 'warning',
              buttons: ['Cancel', 'Reload'],
              defaultId: 0,
              cancelId: 0,
              title: 'Force Reload',
              message: 'Reload the whole window?',
              detail: many
                ? `This will close all ${tabCount} open tabs and their terminals. Unsaved work and running terminal sessions will be lost.`
                : 'This closes the current tab and its terminal. Unsaved work and any running terminal session will be lost.',
            });
            if (response === 1) target.webContents.reloadIgnoringCache();
          },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Toggle Maximize',
          accelerator: 'CmdOrCtrl+Shift+M',
          click() {
            const w =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ??
              null;
            if (!w) return;
            if (w.isMaximized()) w.unmaximize();
            else w.maximize();
          },
        },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        verbItem('Change View…', 'view'),
        verbItem('Sort…', 'sort'),
        verbItem('Toggle Hidden Files', 'showHidden', 'CmdOrCtrl+Shift+.'),
        verbItem('Theme…', 'theme'),
        { type: 'separator' },
        verbItem('Tag…', 'tag'),
        verbItem('Untag…', 'untag'),
        verbItem('New Tag…', 'newtag'),
        verbItem('Filter by Tag…', 'filter'),
      ],
    },
    {
      label: 'Tools',
      submenu: [
        verbItem('Terminal in this Folder', 'term'),
        verbItem('Open External Terminal', 'openTerminal'),
        verbItem('Close Terminal', 'term-close'),
        { type: 'separator' },
        verbItem('Attach Remote (SSH)…', 'remote-attach'),
        verbItem('Disconnect Remote', 'disconnect'),
        { type: 'separator' },
        verbItem('Run…', 'run'),
        verbItem('New Task', 'task'),
        verbItem('Tasks View', 'tasks'),
        { type: 'separator' },
        verbItem('Settings', 'settings'),
        verbItem('Permissions', 'permissions'),
        verbItem('Check for Update', 'upgrade'),
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
    {
      role: 'help',
      submenu: [
        verbItem('Help', 'help', 'F1'),
        verbItem('Tutorial', 'tutorial'),
        verbItem('Tips', 'tips'),
        verbItem('Welcome', 'welcome'),
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
