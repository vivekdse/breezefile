// ─── SPIKE (spike/playwright-cdp): the agent's browser as its OWN window ─────
//
// The agent's browser is a dedicated BrowserWindow that loads the page directly
// and is exposed over CDP (port 9222, app-wide) like any other webContents, so
// electron/browser/cli.mjs drives it unchanged.
//
// Layout: the browser fills the screen (the dominant view). The Claude chat is
// a SEPARATE always-on-top overlay window (electron/browser/overlay.ts) docked
// on top — see runTaskInteractive. The main Breeze window is left as-is behind
// the full-screen browser.
//
// Singleton: reused + focused on repeat opens (the agent may call `open` more
// than once).

import { BrowserWindow, screen } from 'electron';

let browserWin: BrowserWindow | null = null;

/** The live browser window, or null if none is open. */
export function getBrowserWindow(): BrowserWindow | null {
  return browserWin && !browserWin.isDestroyed() ? browserWin : null;
}

/** Open (or focus) the browser window, sized to fill the screen. Reuse does NOT
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
  });
  void win.webContents.loadURL(url || 'https://example.com');
  fillScreen(win);
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
