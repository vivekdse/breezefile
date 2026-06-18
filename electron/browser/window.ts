// ─── SPIKE (spike/playwright-cdp): the agent's browser as its OWN window ─────
//
// The agent's browser is a dedicated BrowserWindow that loads the page directly
// and is exposed over CDP (port 9222, app-wide) like any other webContents, so
// electron/browser/cli.mjs drives it unchanged.
//
// Layout: the BROWSER fills the screen (the dominant view); the Breeze window
// (the Claude chat/terminal) shrinks to a small always-on-top OVERLAY in the
// top-right, floating over the browser — a copilot-style chat over the page.
// The Breeze window's prior bounds + always-on-top state are restored when the
// browser window closes.
//
// Singleton: reused + focused on repeat opens (the agent may call `open` more
// than once).

import { BrowserWindow, screen } from 'electron';
import type { Rectangle } from 'electron';

let browserWin: BrowserWindow | null = null;

// How to put the Breeze window back when the browser window closes.
let breezeRestore: { win: BrowserWindow; bounds: Rectangle; onTop: boolean } | null = null;

/** The live browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/** Open (or focus) the browser window. On first open, make the browser fill the
 *  screen and dock the Breeze window as a small overlay on top. Reuse does NOT
 *  renavigate — the agent drives navigation via the helper's `goto`. */
export function openBrowserWindow(url?: string): void {
  const existing = getBrowserWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
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
    if (browserWin === win) browserWin = null;
    restoreBreeze();
  });
  void win.webContents.loadURL(url || 'https://example.com');
  arrangeOverlay(win);
}

// Browser fills the work area; Breeze becomes a small always-on-top overlay in
// the top-right so the user reads/approves in the chat while watching the page.
// Best-effort: some window managers (Wayland) ignore programmatic setBounds.
function arrangeOverlay(bwin: BrowserWindow): void {
  const breeze = BrowserWindow.getAllWindows().find(
    (w) => w !== bwin && !w.isDestroyed(),
  );
  const anchor = breeze ? breeze.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const wa = display.workArea;
  try {
    // Browser = full screen (the dominant view).
    bwin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    if (breeze) {
      // Remember how to restore Breeze when the browser window closes.
      breezeRestore = {
        win: breeze,
        bounds: breeze.getBounds(),
        onTop: breeze.isAlwaysOnTop(),
      };
      // Claude chat overlay: narrow column, top-right, floating above browser.
      const ow = 480;
      const oh = Math.min(760, wa.height - 48);
      breeze.setBounds({
        x: wa.x + wa.width - ow - 24,
        y: wa.y + 24,
        width: ow,
        height: oh,
      });
      breeze.setAlwaysOnTop(true, 'floating');
      breeze.focus();
    }
  } catch {
    /* best-effort; leave the windows free-floating on a degraded WM */
  }
}

// Put the Breeze window back to its pre-overlay size + z-order.
function restoreBreeze(): void {
  const r = breezeRestore;
  breezeRestore = null;
  if (!r || r.win.isDestroyed()) return;
  try {
    r.win.setAlwaysOnTop(r.onTop);
    r.win.setBounds(r.bounds);
  } catch {
    /* best-effort */
  }
}
