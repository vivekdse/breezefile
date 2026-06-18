// ─── SPIKE (spike/playwright-cdp): dedicated agent-chat overlay window ───────
//
// A small always-on-top window that renders ONLY the agent's terminal (the
// "chat"), floating over the full-screen browser window so the user can see
// when Claude has a question and answer it without the whole Breeze app shrunk.
//
// It loads the same renderer with `#overlay=<ptyId>`; the renderer mounts
// AgentOverlay instead of the full App and mirrors that pty's term:* stream
// (term:mirror in electron/ipc.ts). Singleton: replaced if a new session opens.

import path from 'node:path';
import { BrowserWindow, screen } from 'electron';

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let overlayWin: BrowserWindow | null = null;

/** Open (or replace) the agent-chat overlay for a pty, docked top-right over
 *  the browser window, floating above it. */
export function createAgentOverlay(ptyId: number): void {
  // A fresh session gets a fresh overlay — close any stale one first.
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close();
    overlayWin = null;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 760,
    title: 'Claude',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f1114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  overlayWin = win;
  win.setAlwaysOnTop(true, 'floating');
  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  const hash = `overlay=${ptyId}`;
  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(`${VITE_DEV_SERVER_URL}#${hash}`);
  } else {
    void win.loadFile(path.join(process.env.APP_ROOT || '', 'dist', 'index.html'), {
      hash,
    });
  }

  position(win);
}

/** Dock the overlay in the top-right corner of the display under the cursor /
 *  the focused window — i.e. over the (full-screen) browser. */
function position(win: BrowserWindow): void {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const [w, h] = win.getSize();
    win.setBounds({
      x: wa.x + wa.width - w - 24,
      y: wa.y + 24,
      width: w,
      height: Math.min(h, wa.height - 48),
    });
  } catch {
    /* best-effort placement */
  }
}
