// ─── SPIKE (spike/playwright-cdp): the agent's browser window + chat widget ──
//
// A dedicated BrowserWindow whose own webContents IS the page (full-window,
// exposed over CDP so electron/browser/cli.mjs drives it). Floating ABOVE the
// page, in the same window, is a small WebContentsView "chat bot" rendering the
// agent's terminal (#overlay=<ptyId>) — draggable and collapsible to a bubble,
// so the user sees the browser and what Claude is doing at the same time.
//
// Singleton window + singleton chat view. The chat is driven from its renderer
// (src/components/AgentOverlay.tsx) via overlay:move / overlay:resize.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, WebContentsView, ipcMain, screen } from 'electron';

// The bundle is ESM — `__dirname` doesn't exist. Derive it from this chunk's
// URL (resolves to dist-electron/, where preload.mjs lives) so the chat view
// gets the same preload as the main window.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const MARGIN = 24;
const PANEL = { width: 380, height: 560 };

let browserWin: BrowserWindow | null = null;
let chatView: WebContentsView | null = null;
// Chat widget rect in window-content (DIP) coords; mutated by drag/resize.
let chatBounds = { x: 0, y: 0, width: PANEL.width, height: PANEL.height };

/** The live browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/** Open (or focus) the full-screen browser window. When `ptyId` is given, dock
 *  the agent chat widget over the page. Reuse does NOT renavigate — the agent
 *  drives navigation via the helper's `goto`. */
export function openBrowserWindow(url?: string, ptyId?: number): void {
  const existing = getBrowserWindow();
  console.log(`[browser:win] open url=${url} ptyId=${ptyId} existing=${!!existing} chatView=${!!chatView}`);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    if (ptyId != null && !chatView) createChat(existing, ptyId);
    return;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'Breeze Browser',
    autoHideMenuBar: true,
  });
  browserWin = win;
  win.on('closed', () => {
    if (browserWin === win) {
      browserWin = null;
      chatView = null;
    }
  });
  void win.webContents.loadURL(url || 'https://example.com');
  fillScreen(win);
  if (ptyId != null) createChat(win, ptyId);
  // Keep the chat docked when the window resizes.
  win.on('resize', () => clampChat());
}

// Dock the agent chat widget (a WebContentsView) above the page, bottom-right.
function createChat(win: BrowserWindow, ptyId: number): void {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  chatView = view;
  win.contentView.addChildView(view); // added last → floats above the page
  view.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    console.error(`[browser:chat] did-fail-load ${code} ${desc} ${validatedURL}`);
  });

  const hash = `overlay=${ptyId}`;
  const target = VITE_DEV_SERVER_URL ? `${VITE_DEV_SERVER_URL}#${hash}` : '(file)';
  console.log(`[browser:chat] createChat ptyId=${ptyId} -> ${target}`);
  if (VITE_DEV_SERVER_URL) {
    void view.webContents.loadURL(`${VITE_DEV_SERVER_URL}#${hash}`);
  } else {
    void view.webContents.loadFile(
      path.join(process.env.APP_ROOT || '', 'dist', 'index.html'),
      { hash },
    );
  }

  const cb = win.getContentBounds();
  chatBounds = {
    width: PANEL.width,
    height: PANEL.height,
    x: cb.width - PANEL.width - MARGIN,
    y: cb.height - PANEL.height - MARGIN,
  };
  view.setBounds(chatBounds);
  view.setVisible(true);
  console.log(`[browser:chat] bounds=${JSON.stringify(chatBounds)} content={w:${cb.width},h:${cb.height}}`);
}

// Re-apply chatBounds clamped to the current window size.
function clampChat(): void {
  if (!chatView || !browserWin) return;
  const cb = browserWin.getContentBounds();
  chatBounds.x = Math.max(0, Math.min(chatBounds.x, cb.width - chatBounds.width));
  chatBounds.y = Math.max(0, Math.min(chatBounds.y, cb.height - chatBounds.height));
  chatView.setBounds(chatBounds);
}

// Size the browser to the full work area of the display under the Breeze
// window. Best-effort: some window managers (Wayland) ignore setBounds.
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

// ─── chat widget control (from src/components/AgentOverlay.tsx) ──────────────
// Drag: move the widget by a CSS-px delta (== DIP at zoom 1), clamped in-window.
ipcMain.on('overlay:move', (_e, dx: number, dy: number) => {
  if (!chatView || !browserWin) return;
  chatBounds.x += dx;
  chatBounds.y += dy;
  clampChat();
});
// Resize: the renderer asks for a size (panel vs collapsed bubble); keep the
// widget anchored to its current corner, clamped in-window.
ipcMain.on('overlay:resize', (_e, width: number, height: number) => {
  if (!chatView || !browserWin) return;
  chatBounds.width = Math.max(48, width);
  chatBounds.height = Math.max(48, height);
  clampChat();
});
