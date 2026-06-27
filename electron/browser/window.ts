// ─── SPIKE (spike/playwright-cdp): the operator session window ───────────────
//
// A single window split into TWO panes: the browser page on the LEFT and the
// agent's Claude-Code terminal on the RIGHT, divided by ONE resizer. The whole
// window is the Breeze React bundle (loaded with `#operator=<ptyId>`, rendered
// by src/components/OperatorSession.tsx); the page itself is a child
// WebContentsView the React chrome positions into the left pane (mirror-onto-
// rect, the same trick BrowserPane uses) and Playwright drives over CDP.
//
// This REPLACES the old floating, draggable chat overlay (a WebContentsView
// docked bottom-right over a full-window page) — there is no more
// overlay:move / overlay:resize machinery. The single resizer + a minimize
// button (1/3 ↔ 0) live in the React chrome; their geometry is persisted there.
//
// Singleton window + singleton page view. When opened WITHOUT a ptyId (the
// HTTP `open-browser` control verb) we still render the operator chrome but with
// no terminal pane, so the CDP target is a clean page view either way.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, WebContentsView, ipcMain, screen } from 'electron';
import { killManagedPty } from '../ipc';

// The bundle is ESM — `__dirname` doesn't exist. Derive it from this chunk's
// URL (resolves to dist-electron/, where preload.mjs lives) so the operator
// chrome + page view get the same preload as the main window.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let browserWin: BrowserWindow | null = null;
// The page WebContentsView living in the LEFT pane of the operator window.
let pageView: WebContentsView | null = null;
// Last URL requested for the page (used when the view is (re)created).
let pendingUrl = 'https://example.com';
// The agent PTY this operator session mirrors. Tracked so that closing the
// window — via the single CLOSE button OR the OS window chrome — tears the PTY
// down TOO (task-c4064f8a4994), routing through the existing onSessionExit /
// release / keep-alive flow. null for the no-agent open-browser verb.
let operatorPtyId: number | null = null;

/** The live operator/browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/** The page WebContentsView the agent drives (left pane), or null. */
export function getOperatorPageView(): WebContentsView | null {
  return pageView && !pageView.webContents.isDestroyed() ? pageView : null;
}

/** Open (or focus) the operator session window: browser LEFT, Claude Code
 *  terminal RIGHT, one resizer. When `ptyId` is given the right pane mirrors
 *  that PTY's terminal; without it the window is just the browser pane (the
 *  HTTP `open-browser` verb). Reuse does NOT renavigate — the agent drives
 *  navigation via the helper's `goto`. */
export function openBrowserWindow(url?: string, ptyId?: number): void {
  if (url) pendingUrl = url;
  if (ptyId != null) operatorPtyId = ptyId;
  const existing = getBrowserWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'TypeBuild Operator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // Must match the main window (main.ts): the bundled preload.mjs is loaded
      // as an ES module and contains a `require`, which only resolves under the
      // sandboxed preload loader's require-shim. With sandbox:false Electron
      // loads it as a native ESM where `require` is undefined → the preload
      // throws ("require is not defined in ES module scope"), window.fm is never
      // exposed, and OperatorSession/Terminal crash to a blank window.
      sandbox: true,
      contextIsolation: true,
    },
  });
  browserWin = win;
  // ONE elegant close (task-c4064f8a4994): whichever way the window goes away —
  // the in-chrome CLOSE button (operator:close → win.close()) or the OS window
  // chrome — tear the agent PTY down TOO so both halves end as one action.
  // Killing the PTY fires its onExit, which for a TypeBuild session routes into
  // onSessionExit (stopKeepAlive + the "release this task?" prompt). Idempotent:
  // if the renderer already killed the PTY first, killManagedPty is a no-op.
  win.on('close', () => {
    if (operatorPtyId != null) {
      try {
        killManagedPty(operatorPtyId);
      } catch {
        /* already gone */
      }
    }
  });
  win.on('closed', () => {
    if (browserWin === win) {
      browserWin = null;
      pageView = null;
      operatorPtyId = null;
    }
  });

  // The whole window is the operator React chrome. It renders a left
  // placeholder for the page and a right terminal pane, measures the
  // placeholder, and streams its rect via `operator:browser-bounds`.
  const hash = ptyId != null ? `operator=${ptyId}` : 'operator';
  if (VITE_DEV_SERVER_URL) {
    void win.webContents.loadURL(`${VITE_DEV_SERVER_URL}#${hash}`);
  } else {
    void win.webContents.loadFile(
      path.join(process.env.APP_ROOT || '', 'dist', 'index.html'),
      { hash },
    );
  }

  fillScreen(win);
  ensurePageView(win);
}

// Create the page WebContentsView (the agent's CDP target) parented to the
// operator window. Parked off-screen + hidden until the React chrome reports
// the left pane's on-screen rect via `operator:browser-bounds`.
function ensurePageView(win: BrowserWindow): void {
  if (getOperatorPageView()) return;
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true },
  });
  pageView = view;
  const wc = view.webContents;
  // Keep target=_blank / window.open inside this same view.
  wc.setWindowOpenHandler(({ url }) => {
    void wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.error(`[operator:page] did-fail-load ${code} ${desc} ${validatedURL}`);
  });
  const emit = () => {
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('operator:browser-state', {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  };
  wc.on('did-navigate', emit);
  wc.on('did-navigate-in-page', emit);
  wc.on('page-title-updated', emit);

  // Give it a real viewport immediately, parked off-screen, so it lays out and
  // can be screenshotted/driven before the chrome reports bounds.
  const cb = win.getContentBounds();
  view.setBounds({ x: -(cb.width + 100), y: 0, width: cb.width, height: cb.height });
  view.setVisible(false);
  win.contentView.addChildView(view);
  void wc.loadURL(pendingUrl);
}

// Size the operator window to the full work area of the display under the
// Breeze window. Best-effort: some window managers (Wayland) ignore setBounds.
function fillScreen(bwin: BrowserWindow): void {
  const breeze = BrowserWindow.getAllWindows().find(
    (w) => w !== bwin && !w.isDestroyed(),
  );
  const anchor = breeze ? breeze.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const wa = display.workArea;
  try {
    bwin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } catch {
    /* best-effort; leave the window free-floating on a degraded WM */
  }
}

// ─── operator page-view control (from src/components/OperatorSession.tsx) ────
// The React chrome measures the LEFT pane and streams its CSS-px rect; we scale
// into device-independent pixels (what setBounds expects) and position the page
// view there EXACTLY (honoring the measured width/height — unlike the in-app
// BrowserPane handler, the page does NOT run to the window edge here, it stops
// at the divider). winW/winH are the renderer's CSS window size for the scale.
ipcMain.on(
  'operator:browser-bounds',
  (
    _e,
    rect: { x: number; y: number; width: number; height: number; winW: number; winH: number },
  ) => {
    const view = getOperatorPageView();
    if (!view || !browserWin) return;
    const cb = browserWin.getContentBounds();
    const sx = rect.winW > 0 ? cb.width / rect.winW : 1;
    const sy = rect.winH > 0 ? cb.height / rect.winH : 1;
    const b = {
      x: Math.round(rect.x * sx),
      y: Math.round(rect.y * sy),
      width: Math.max(0, Math.round(rect.width * sx)),
      height: Math.max(0, Math.round(rect.height * sy)),
    };
    view.setBounds(b);
    view.setVisible(b.width > 1 && b.height > 1);
  },
);

// Navigation verbs from the operator chrome's address bar / nav buttons.
ipcMain.on('operator:navigate', (_e, url: string) => {
  const view = getOperatorPageView();
  if (view) void view.webContents.loadURL(url);
});
ipcMain.on('operator:back', () => {
  const wc = getOperatorPageView()?.webContents;
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
});
ipcMain.on('operator:forward', () => {
  const wc = getOperatorPageView()?.webContents;
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
});
ipcMain.on('operator:reload', () => {
  getOperatorPageView()?.webContents.reload();
});
// The chrome (re)mounted — push current url/nav so its address bar is accurate.
ipcMain.on('operator:sync', () => {
  const view = getOperatorPageView();
  const wc = view?.webContents;
  if (!wc || !browserWin || browserWin.webContents.isDestroyed()) return;
  browserWin.webContents.send('operator:browser-state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  });
});

// Single CLOSE action (task-c4064f8a4994): tear down the page view + the window
// together. The renderer kills the PTY first (so its onExit → onSessionExit →
// release/keep-alive routing fires deterministically), then asks us to close the
// window here. The window's `close` handler ALSO kills the PTY as a backstop
// (idempotent), so the OS window chrome's X is just as elegant.
ipcMain.on('operator:close', () => {
  const win = getBrowserWindow();
  if (win) win.close();
});
