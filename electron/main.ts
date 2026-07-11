import { app, BrowserWindow, ipcMain, shell, Menu, dialog, protocol, screen, Notification as ElectronNotification } from 'electron';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registerIpc } from './ipc';
import { startCopilotRuntime } from './copilot/runtime';
import { registerCopilotIpc } from './copilot/ipc';
import { startApiServer } from './api-server';
import { startScheduler } from './scheduler';
import { startTaskReminders, setTaskReminderMode } from './task-reminders';
import { setBreezeHost } from './core/host';
import { ElectronBreezeHost } from './core/electron-host';
import { setTaskNotifyVerbosity } from './core/notify-settings.mjs';
// fm-m7q / task-1bf3ce50575a — native menu derives its verb rows from the SAME
// build-safe metadata module the renderer registry uses. Pure data (no React),
// so the electron-main Rollup build can bundle it.
import {
  menuVerbsByCategory,
  menuAcceleratorFor,
} from '../src/verbCatalog.mjs';
import { restoreSources } from './sources';
import { registerBreezeHooks } from './hooks-register';
import { registerTypebuildAuthIpc } from './typebuild/ipc-auth';
import { registerTypebuildVaultIpc } from './typebuild/ipc-vault';
import { registerTypebuildTaskDataIpc } from './typebuild/ipc-task-data';
import { registerTypebuildCredentialsIpc } from './typebuild/ipc-credentials';
import { registerTypebuildProjectsIpc } from './typebuild/ipc-projects';
import { registerTypebuildConnectionsIpc } from './typebuild/ipc-connections';
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
// fm-ued6 — cold-start timing instrumentation. Flag-gated ([startup] log
// namespace); off in production unless BREEZE_STARTUP_PROFILE=1. Kept lightweight
// so it can stay in the tree or be removed by grepping "[startup]".
import { mark, timeSync, dumpTimeline } from './core/startup-timing';
// Side-effect import: registers built-in agent runners (Claude) so the
// scheduler / run-now endpoints can dispatch by id (epic fm-zf3m).
import './agents';

mark('main:module-loaded');

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
// labels. Force the display name so the menu says "TypeBuild"
// everywhere, dev and packaged alike.
app.setName('TypeBuild');

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

// Linux: Electron only auto-detects the OS keyring on GNOME/KDE. On other
// desktops (LXQt, etc.) safeStorage.isEncryptionAvailable() returns false even
// when gnome-keyring is running, so the TypeBuild refresh token can't persist
// and the user is signed out on every launch (electron/typebuild/auth.ts). Force
// the libsecret backend so the running keyring is used. Harmless where libsecret
// isn't the backend (Electron falls back). Must be set before app is ready.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

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

  mark('createWindow:BrowserWindow-constructed');

  win.once('ready-to-show', () => {
    mark('createWindow:ready-to-show');
    if (!win || win.isDestroyed()) return;
    // showInactive() avoids raising the window above other apps / stealing
    // keyboard focus on every dev reload. A real production launch should
    // come to the front like a normal app.
    if (VITE_DEV_SERVER_URL) win.showInactive();
    else win.show();
  });

  mark('createWindow:load-start');
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
  mark('whenReady:enter');
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

  timeSync('boot:registerIpc', () => registerIpc());
  // task-8676ddafadf0 — CopilotKit sidebar foundation. registerCopilotIpc is
  // cheap (just wires ipcMain.handle); startCopilotRuntime is async and
  // fire-and-forget — it no-ops when no Anthropic key is configured, so it
  // never blocks boot or throws into the whenReady chain.
  timeSync('boot:registerCopilotIpc', () => registerCopilotIpc());
  void startCopilotRuntime().catch((err) => {
    console.error('[copilot] failed to start runtime:', (err as Error).message);
  });
  // Inject the Electron host before any task subsystem runs so
  // tasks.ts/scheduler.ts broadcast to windows + raise notifications
  // exactly as before the P1 core extraction (breezed injects a
  // headless host instead).
  setBreezeHost(ElectronBreezeHost);
  timeSync('boot:startApiServer', () => startApiServer());

  // fm-ued6 — IPC HANDLER registration only. These calls just wire up
  // ipcMain.handle/on for auth/vault/projects/detection; they're cheap and
  // MUST run before the renderer can invoke them, so they stay on the
  // pre-paint path. The genuinely heavy work each used to drag in (a session
  // restore, the immediate TypeBuild poll) is deferred below — restoreSession()
  // inside registerTypebuildAuthIpc is already fire-and-forget (`void`), so
  // registering the handler costs nothing at boot.
  // fm-b5at.2 — TypeBuild Firebase auth IPC (signIn/signOut/state handlers +
  // auth-state broadcaster). restoreSession() is kicked async inside.
  timeSync('boot:registerTypebuildAuthIpc', () => registerTypebuildAuthIpc());
  // User credential vault IPC (:secrets panel) — class-2 data. Server-backed.
  timeSync('boot:registerTypebuildVaultIpc', () => registerTypebuildVaultIpc());
  // task-1af4f59428eb — task `data` (class-1 PHI) resolve IPC for New Home's
  // own display reads (TaskDetailDialog customValues), separate from the
  // browser-agent fill path. Server-backed; never cached in main.
  timeSync('boot:registerTypebuildTaskDataIpc', () => registerTypebuildTaskDataIpc());
  // task-d60860fb4d7f — site-keyed credential vault IPC (Save-password prompt +
  // autofill). Server-backed; password encrypted at rest, never cached in main.
  timeSync('boot:registerTypebuildCredentialsIpc', () =>
    registerTypebuildCredentialsIpc(),
  );
  // task-ab1d7955e23f — TypeBuild Projects IPC (list/get/resolve/create).
  timeSync('boot:registerTypebuildProjectsIpc', () =>
    registerTypebuildProjectsIpc(),
  );
  // task-62a5b4324954 — Connections IPC (register/list/edit an external REST
  // API or MCP server + its server-vaulted credential).
  timeSync('boot:registerTypebuildConnectionsIpc', () =>
    registerTypebuildConnectionsIpc(),
  );
  // fm-b5at.3 — TypeBuild onboarding prerequisite detection IPC.
  timeSync('boot:registerTypebuildDetectIpc', () => registerTypebuildDetectIpc());

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
  // fm-5xy — start-at / near-due reminder mode mirror. Like the verbosity
  // mirror above, the setting is renderer-owned (localStorage) but the daily
  // 8am tick + startup catch-up that consume it run in MAIN (task-reminders.ts),
  // which can't read localStorage. Renderer pushes its value on boot + change.
  ipcMain.on('settings:taskReminders', (_e, value: string) => {
    setTaskReminderMode(value);
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
  // per-window so multi-window stays sane. The stored value is the *ungrown*
  // base width; repeated open calls (the user drag-resizing the panel) re-grow
  // to base + panelWidth, so the file list keeps its width as the panel widens.
  const chatGrow = new Map<number, number>(); // win.id → ungrown base width
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
        // Anchor off the ungrown base: capture it on first open, reuse it on
        // every later resize so the window tracks the panel without drifting.
        const base = chatGrow.has(id) ? chatGrow.get(id)! : width;
        chatGrow.set(id, base);
        const target = Math.min(base + pad, wa.width);
        if (target === width) return; // already at the right size
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
  timeSync('boot:buildAppMenu', () => buildAppMenu());
  mark('boot:sync-work-complete');
  // fm-ued6 — paint FIRST. createWindow() only constructs the BrowserWindow and
  // starts loading the renderer; the expensive boot steps (local sqlite open +
  // migration, the ~/.claude hooks read/write, the immediate TypeBuild poll,
  // breezed reconnect, automation/tool seeding) now run on the next tick via
  // deferredBoot(), AFTER the window is on screen. None of them is needed before
  // the renderer's first frame: the renderer reaches all of this lazily over IPC
  // (and tolerates a not-yet-ready source), so deferring by a tick removes the
  // blocking work from the critical path without changing behavior.
  timeSync('boot:createWindow', () => createWindow());
  mark('whenReady:exit');

  // fm-ued6 — the renderer posts 'app:firstPaint' from its first useEffect
  // (App mounted + first frame committed); that's our "first interactive frame"
  // marker. dumpTimeline() is idempotent, so the fallback timer below only
  // fires if the renderer never reports (e.g. a crash) — it still prints the
  // main-process timeline we captured.
  ipcMain.on('app:firstPaint', () => {
    mark('renderer:firstPaint');
    dumpTimeline('renderer-first-paint');
  });
  setTimeout(() => dumpTimeline('fallback-timer-8s'), 8000).unref?.();

  // fm-ued6 — run the heavy, paint-irrelevant boot steps on the next tick so
  // the window paints first. setImmediate yields back to the event loop (and
  // thus to window construction / the renderer's first load) before this runs.
  setImmediate(() => {
    void deferredBoot();
  });
});

// fm-ued6 — everything here used to run synchronously inside whenReady BEFORE
// createWindow, stalling first paint. It's all post-paint work: nothing the
// renderer needs for its first frame. Order preserved within; each step stays
// functionally identical, only the timing moved (now after the window exists).
async function deferredBoot(): Promise<void> {
  mark('deferredBoot:enter');
  // fm-zf3m — auto-executor for tasks with auto_mode=1 / cron set. Opens the
  // local sqlite tasks.db (WAL + full migration chain) via reapStaleRuns() /
  // rearm() — the single biggest blocking cold-start cost, now off the paint
  // path. The scheduler's startup catch-up still runs; it just runs a tick late.
  try {
    timeSync('defer:startScheduler(opens sqlite)', () => startScheduler());
  } catch (e) {
    console.warn('[scheduler] start failed:', (e as Error).message);
  }
  // fm-5xy — daily 8am + startup catch-up reminders for tasks whose start_at /
  // due_at lands today. Runs after the scheduler so the DB handle + migrations
  // (incl. the v6 last_notified_for_date column) are in place.
  try {
    timeSync('defer:startTaskReminders', () => startTaskReminders());
  } catch (e) {
    console.warn('[reminders] start failed:', (e as Error).message);
  }
  // Reconnect previously-connected remote breezed daemons (best-effort).
  try {
    timeSync('defer:restoreSources', () => restoreSources());
  } catch (e) {
    console.warn('[sources] restore failed:', (e as Error).message);
  }
  // fm-b5at.4 — register the TypeBuildTaskSource while signed in so TypeBuild
  // tasks appear in TasksPage. When already signed in this constructs the
  // source + kicks an immediate poll (GET /chromeext/tasks); deferring it keeps
  // that network round-trip off the sluggish first window. The renderer already
  // tolerates the source not being registered yet (it re-pulls on the
  // sources:changed / tasks:changed broadcasts this fires).
  try {
    timeSync('defer:wireTypebuildTaskSource(immediate poll)', () =>
      wireTypebuildTaskSource(),
    );
  } catch (e) {
    console.warn('[typebuild] wire failed:', (e as Error).message);
  }
  // fm-b5at.10 — TypeBuild MCP session-expiry clock. No live session can exist
  // at boot, so this is safe to arm a tick late.
  try {
    timeSync('defer:startExpiryClock', () => startExpiryClock());
  } catch (e) {
    console.warn('[expiry] start failed:', (e as Error).message);
  }
  // fm-z7v — register UserPromptSubmit/Stop hooks so Claude Code reports
  // working/idle per pty. Reads + writes ~/.claude/settings.json synchronously
  // (file IO) — moved off the paint path. Idempotent; failures logged + ignored.
  try {
    const result = timeSync('defer:registerBreezeHooks(reads ~/.claude)', () =>
      registerBreezeHooks(),
    );
    if (result === 'written') {
      console.log('[hooks-register] updated ~/.claude/settings.json');
    }
  } catch (e) {
    console.warn('[hooks-register] failed:', (e as Error).message);
  }
  // Browser-automation RUNTIME: install the helper CLIs (+ a bundled
  // playwright-core) into ~/.breezefile/automation/ on launch so the agent's
  // `node <cli>` commands resolve from a stable user-owned path. Best-effort;
  // runs well before any agent session can start.
  try {
    const { installAutomation } = await import('./browser/install-runtime.mjs');
    const { dir, installed, errors } = installAutomation();
    if (installed.length) console.log(`[automation] installed into ${dir}:`, installed.join(', '));
    if (errors.length) console.warn('[automation] errors:', errors.join('; '));
  } catch (e) {
    console.warn('[automation] failed:', (e as Error).message);
  }
  // Tool Repository: install the bundled seed tools into ~/.breezefile/tools/.
  // Idempotent — only copies tools that aren't already present.
  try {
    const { installSeedTools } = await import('./browser/tools/install.mjs');
    const { installed, errors } = installSeedTools();
    if (installed.length) console.log('[tool-seeds] installed:', installed.join(', '));
    if (errors.length) console.warn('[tool-seeds] errors:', errors.join('; '));
  } catch (e) {
    console.warn('[tool-seeds] failed:', (e as Error).message);
  }
  mark('deferredBoot:exit');
}

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

// fm-m7q / task-1bf3ce50575a — build the verb menu rows for one category
// (Files / Selection / Navigate / View / Tools / Help) straight from
// verbCatalog.mjs. Adding a verb with a category + keybinding to that module
// surfaces it here WITHOUT editing main.ts. The accelerator follows the
// catalog's single-chord rule (multi-chord bindings are display-only and never
// shown as menu accelerators — menuAcceleratorFor returns undefined for them).
const VERB_GROUPS = menuVerbsByCategory();
function categoryVerbItems(category: string): Electron.MenuItemConstructorOptions[] {
  const group = VERB_GROUPS.find((g) => g.category === category);
  if (!group) return [];
  return group.items.map((meta) =>
    verbItem(meta.menuLabel ?? meta.label, meta.id, menuAcceleratorFor(meta)),
  );
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      // fm-m7q / task-1bf3ce50575a — verb rows derived from verbCatalog.mjs
      // (the 'Files' category). The two non-verb "New Folder…/New File…" items
      // dispatch the create pseudo-verbs and stay hand-coded.
      label: 'File',
      submenu: [
        verbItem('New Folder…', 'folder'),
        verbItem('New File…', 'file'),
        { type: 'separator' },
        ...categoryVerbItems('Files'),
      ],
    },
    { role: 'editMenu' },
    {
      // Navigate-category verbs from the catalog (Back/Forward/Up, Go to…, tab
      // switching + new/close/reopen tab, pin/unpin).
      label: 'Navigate',
      submenu: [...categoryVerbItems('Navigate')],
    },
    {
      // Selection-category verbs from the catalog.
      label: 'Selection',
      submenu: [...categoryVerbItems('Selection')],
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
        // View-category verbs from verbCatalog.mjs (Change View…, Sort…, Toggle
        // Hidden Files, Theme…, Tag…/Untag…/New Tag…, Filter by Tag…).
        ...categoryVerbItems('View'),
      ],
    },
    {
      // Tools-category verbs from the catalog.
      label: 'Tools',
      submenu: [
        {
          // DevTools is hidden on a fresh session (opt-in via BREEZE_DEVTOOLS);
          // this gives an explicit, discoverable way to open it on demand.
          label: 'Developer Console',
          accelerator: 'CmdOrCtrl+Alt+I',
          click() {
            const w =
              BrowserWindow.getFocusedWindow() ??
              BrowserWindow.getAllWindows().find((b) => !b.isDestroyed()) ??
              null;
            if (!w) return;
            if (w.webContents.isDevToolsOpened())
              w.webContents.closeDevTools();
            else w.webContents.openDevTools({ mode: 'detach' });
          },
        },
        { type: 'separator' },
        ...categoryVerbItems('Tools'),
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
      // Help-category verbs from the catalog (Help, Tutorial, Tips, Welcome).
      role: 'help',
      submenu: [...categoryVerbItems('Help')],
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
