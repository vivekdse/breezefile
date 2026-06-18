// ─── SPIKE (spike/playwright-cdp): the agent's browser as its OWN window ─────
//
// The faithful replacement for `--chrome`'s side-by-side: a dedicated
// BrowserWindow that loads the page directly, snapped beside the Breeze window
// so the user WATCHES the agent drive it while approving in the chat. Its
// webContents is exposed over CDP (port 9222, app-wide) like any other, so
// electron/browser/cli.mjs drives it unchanged.
//
// Singleton: reused + focused on repeat opens (the agent may call `open` more
// than once). Replaces the in-tab WebContentsView for the agent-driven flow.

import { BrowserWindow, screen } from 'electron';

let browserWin: BrowserWindow | null = null;

/** The live browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/** Open (or focus) the browser window. On first open, snap it beside the Breeze
 *  window for side-by-side watching. Reuse does NOT renavigate — the agent
 *  drives navigation via the helper's `goto`. */
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
  });
  void win.webContents.loadURL(url || 'https://example.com');
  snapSideBySide(win);
}

// Snap Breeze to the left half / the browser window to the right half of the
// display under the Breeze window. Best-effort: some window managers (Wayland)
// ignore programmatic setBounds — we degrade to a free-floating window.
function snapSideBySide(bwin: BrowserWindow): void {
  const breeze = BrowserWindow.getAllWindows().find(
    (w) => w !== bwin && !w.isDestroyed(),
  );
  const anchor = breeze ? breeze.getBounds() : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const wa = display.workArea;
  const half = Math.floor(wa.width / 2);
  try {
    if (breeze) {
      breeze.setBounds({ x: wa.x, y: wa.y, width: half, height: wa.height });
    }
    bwin.setBounds({
      x: wa.x + half,
      y: wa.y,
      width: wa.width - half,
      height: wa.height,
    });
  } catch {
    /* best-effort; leave the window free-floating on a degraded WM */
  }
}
