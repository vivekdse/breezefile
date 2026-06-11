// fm-b5at.6 — TypeBuild side-by-side layout orchestrator.
//
// Goal: while a TypeBuild interactive task session runs, put Google Chrome on
// the left `splitFraction` of the work area and the Breezefile window on the
// right remainder — the user watches Claude drive the browser on the left and
// converses/approves in the embedded terminal on the right.
//
// Two halves, deliberately decoupled so we still get *degraded parity* when
// Chrome can't be moved (Wayland, missing Accessibility grant):
//   1. OUR window: pure Electron `setBounds` against the display work area.
//      Always works. We snapshot the previous bounds and restore on exit.
//   2. CHROME's window: delegated to the PlatformAdapter (`arrangeChromeLeft`),
//      which is OS-coupled (System Events / wmctrl). May fail gracefully.
//
// `screen` lives here (main process) — the adapters stay screen-agnostic and
// just take a target rectangle. No `process.platform` in this file; the OS
// branch is entirely inside the adapter.

import { BrowserWindow, screen } from 'electron';
import { platform } from './platform';
import type { ArrangeRect, ArrangeResult } from './platform';

type Rectangle = { x: number; y: number; width: number; height: number };

// Snapshot of the window's bounds before we entered side-by-side, so toggling
// off restores exactly where the user had it. Null when not arranged.
let savedBounds: Rectangle | null = null;
let active = false;

const DEFAULT_SPLIT = 0.67;

function targetWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null
  );
}

function clampSplit(split: number | undefined): number {
  if (typeof split !== 'number' || !Number.isFinite(split)) return DEFAULT_SPLIT;
  // Keep both panes usable: Chrome 30–85% of the width.
  return Math.min(0.85, Math.max(0.3, split));
}

export function isSideBySide(): boolean {
  return active;
}

// Enter side-by-side. `split` is the Chrome (left) fraction of the work area.
// Returns what happened to Chrome so the renderer can surface the right hint
// (e.g. "grant Accessibility" on mac, "snap Chrome manually" on Wayland).
export async function enterSideBySide(
  split = DEFAULT_SPLIT,
): Promise<{ ownWindow: boolean; chrome: ArrangeResult }> {
  const win = targetWindow();
  if (!win) {
    return { ownWindow: false, chrome: { ok: false, reason: 'unsupported' } };
  }
  const frac = clampSplit(split);

  // Resolve the display the window currently sits on; work area excludes the
  // menu bar / taskbar / panels so nothing lands under system chrome.
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;

  // Snapshot once, so repeated enters (e.g. split-% change) don't clobber the
  // original bounds with an already-arranged rectangle.
  if (!active) savedBounds = win.getBounds();

  const chromeWidth = Math.round(wa.width * frac);
  const ownWidth = wa.width - chromeWidth;

  const chromeRect: ArrangeRect = {
    x: wa.x,
    y: wa.y,
    width: chromeWidth,
    height: wa.height,
  };
  const ownRect: Rectangle = {
    x: wa.x + chromeWidth,
    y: wa.y,
    width: ownWidth,
    height: wa.height,
  };

  win.setBounds(ownRect);
  active = true;

  // Best-effort Chrome move. Degraded parity: if this fails the user still has
  // our window snapped to the right and can snap Chrome by hand.
  let chrome: ArrangeResult;
  try {
    chrome = await platform().arrangeChromeLeft(chromeRect);
  } catch {
    chrome = { ok: false, reason: 'unsupported' };
  }

  return { ownWindow: true, chrome };
}

// Exit side-by-side and restore the window's pre-arrangement bounds. Chrome is
// left where it is — we don't track its previous bounds (it's a foreign app)
// and yanking it back would be more surprising than leaving it.
export function exitSideBySide(): { restored: boolean } {
  const win = targetWindow();
  active = false;
  if (win && savedBounds) {
    win.setBounds(savedBounds);
    savedBounds = null;
    return { restored: true };
  }
  savedBounds = null;
  return { restored: false };
}

// Toggle convenience for the `:sidebyside` verb.
export async function toggleSideBySide(
  split = DEFAULT_SPLIT,
): Promise<{ active: boolean; chrome?: ArrangeResult }> {
  if (active) {
    exitSideBySide();
    return { active: false };
  }
  const res = await enterSideBySide(split);
  return { active: true, chrome: res.chrome };
}

export function probeWindowArrange() {
  return platform().canArrangeWindows();
}
