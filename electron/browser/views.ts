// Shared embedded-browser view backend (task — browser/operator unification).
//
// Both the in-app browser tab (electron/ipc.ts `browser:*`) and the operator
// session's left pane (electron/browser/window.ts) used to manage their OWN
// WebContentsView — two parallel implementations that drifted (the operator one
// lacked Record + autofill). This module is the SINGLE owner of the view
// registry + lifecycle so one set of handlers (and one React surface,
// src/components/BrowserSurface.tsx) drives both.
//
// A view is a WebContentsView parented to whichever BrowserWindow asked for it
// (the main window for an in-app tab; the operator window for the operator
// pane). It carries the teach-by-recording preload, a credential-capture hook,
// and a `fill` mode that decides how its bounds are computed (see below).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, WebContentsView } from 'electron';
import { currentRecording as currentBrowserRecording } from './record.ts';
import { wireCredentialCapture } from './credential-capture';
import { resolveStartUrl } from './start-splash';
import { recordVisit } from './history-store';

// This chunk is bundled into dist-electron/ (same dir as the built preloads),
// so record-preload.mjs resolves here exactly as it does from ipc.ts/window.ts.
const __viewsDir = path.dirname(fileURLToPath(import.meta.url));

// How a view's on-screen rect is computed from the renderer's reported rect:
//  - 'edge': take the corner from the renderer but run to the window's
//    right/bottom edges (an in-app browser tab collapses every other panel).
//  - 'rect': honor the measured width/height so the view STOPS AT THE DIVIDER
//    (the operator pane leaves room for the terminal on the right).
export type FillMode = 'edge' | 'rect';

export type BrowserRec = {
  view: WebContentsView;
  win: BrowserWindow;
  emit: () => void;
  fill: FillMode;
};

// The single registry. Keyed by the numeric id handed to the renderer; that id
// rides every `browser:*` channel and the operator chrome's `view=` hash.
export const browserViews = new Map<number, BrowserRec>();
let nextBrowserId = 1;

export function getBrowserView(id: number): WebContentsView | null {
  const rec = browserViews.get(id);
  return rec && !rec.view.webContents.isDestroyed() ? rec.view : null;
}

export function getBrowserRec(id: number): BrowserRec | undefined {
  return browserViews.get(id);
}

/** Re-broadcast a view's current url/title/nav (the `browser:sync` body). */
export function reBroadcastState(id: number): void {
  browserViews.get(id)?.emit();
}

/**
 * Create an embedded browser view parented to `win`, returning its id. Shared
 * by `browser:attach` (in-app, fill:'edge') and the operator window (fill:'rect',
 * created eagerly in main BEFORE its React chrome mounts so the agent's CDP
 * target exists immediately). Mirrors the old `browser:attach` body verbatim
 * apart from the `fill` parameter and taking `win` as an argument.
 */
export function createBrowserView(
  win: BrowserWindow,
  opts: { url?: string; fill: FillMode },
): number {
  const id = nextBrowserId++;
  const view = new WebContentsView({
    webPreferences: {
      // Teach-by-recording capture preload (idle until 'tb-record:set' true).
      // It only reads selector STRUCTURE and exfiltrates over sendToHost; it
      // never reads field values. Keep contextIsolation on (the preload uses
      // contextBridge defensively) and the default sandbox.
      preload: path.join(__viewsDir, 'record-preload.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  // Give the page a REAL viewport immediately, sized to the window, so it lays
  // out and can be screenshotted/driven even before the renderer reports bounds.
  // Parked off-screen + hidden until the first bounds report.
  const cb0init = win.getContentBounds();
  view.setBounds({
    x: -(cb0init.width + 100),
    y: 0,
    width: cb0init.width,
    height: cb0init.height,
  });
  view.setVisible(false);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const emit = () => {
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('browser:state', {
      id,
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  };
  wc.on('did-navigate', emit);
  wc.on('did-navigate-in-page', emit);
  wc.on('page-title-updated', emit);
  // Address-bar autocomplete (task-ff707aea93d8): record top-level navigations
  // as visited-URL history. did-navigate fires on real page loads (not every
  // in-page hash change), so it's the right granularity. NON-PHI — plain URL +
  // page title only; the store normalizes + drops non-http(s) urls.
  wc.on('did-navigate', () => {
    void recordVisit(wc.getURL(), wc.getTitle());
  });
  // Each full load re-runs the record preload, which starts idle — re-arm it if
  // a recording is live so a navigation mid-session keeps capturing.
  wc.on('did-finish-load', () => {
    if (currentBrowserRecording().webContentsId === wc.id) {
      try { wc.send('tb-record:set', true); } catch { /* page gone */ }
    }
  });
  // Login-submit detection + credential capture (task-1188c6535e91). Injects a
  // value-free capturing submit listener; on a human login it pulls
  // { origin, username, password } into main and forwards it to the renderer's
  // "Save password?" prompt. SECURITY: the password is memory-only — we send it
  // straight over IPC and NEVER log it, screenshot it, or put it in
  // browser:state. See electron/browser/credential-capture.ts.
  wireCredentialCapture(wc, win, id, (cred) => {
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('browser:credential-captured', {
      id,
      origin: cred.origin,
      username: cred.username,
      password: cred.password,
    });
  });
  // Open target=_blank / window.open in the same view rather than spawning a
  // native child window (keeps everything inside the tab).
  wc.setWindowOpenHandler(({ url }) => {
    void wc.loadURL(url);
    return { action: 'deny' };
  });
  // THE chokepoint: empty/missing OR a stale example.com placeholder both
  // resolve to the themed splash — example.com must never load on task start
  // (task-d85d23f3aea4). A real url passes through.
  void wc.loadURL(resolveStartUrl(opts.url));
  browserViews.set(id, { view, win, emit, fill: opts.fill });
  return id;
}

/**
 * Position a view from the renderer's reported CSS-px rect. setBounds works in
 * device-independent pixels (DIP); on HiDPI / fractionally-scaled displays CSS
 * px ≠ DIP, so scale the corner using the ratio between the window's DIP size
 * and the renderer's reported CSS size. The extent is computed per `rec.fill`.
 */
export function setBrowserViewBounds(
  id: number,
  rect: { x: number; y: number; width: number; height: number; winW: number; winH: number },
): void {
  const rec = browserViews.get(id);
  if (!rec) return;
  const cb = rec.win.getContentBounds();
  const sx = rect.winW > 0 ? cb.width / rect.winW : 1;
  const sy = rect.winH > 0 ? cb.height / rect.winH : 1;
  const x = Math.round(rect.x * sx);
  const y = Math.round(rect.y * sy);
  if (rec.fill === 'edge') {
    // Corner from the renderer, extent to the window edges.
    rec.view.setBounds({
      x,
      y,
      width: Math.max(0, cb.width - x),
      height: Math.max(0, cb.height - y),
    });
    rec.view.setVisible(true);
  } else {
    // Honor the measured width/height so the view stops at the divider.
    const b = {
      x,
      y,
      width: Math.max(0, Math.round(rect.width * sx)),
      height: Math.max(0, Math.round(rect.height * sy)),
    };
    rec.view.setBounds(b);
    rec.view.setVisible(b.width > 1 && b.height > 1);
  }
}

/** Park a view off-screen at full size (keeps it rendering for the agent) while
 *  its tab is in the background. In-app tabs only. */
export function hideBrowserView(id: number): void {
  const rec = browserViews.get(id);
  if (!rec) return;
  const cb = rec.win.getContentBounds();
  rec.view.setBounds({ x: -(cb.width + 100), y: 0, width: cb.width, height: cb.height });
  rec.view.setVisible(false);
}

/** Tear down a view and drop it from the registry. */
export function destroyBrowserView(id: number): void {
  const rec = browserViews.get(id);
  if (!rec) return;
  try { rec.win.contentView.removeChildView(rec.view); } catch { /* gone */ }
  try { rec.view.webContents.close(); } catch { /* gone */ }
  browserViews.delete(id);
}
