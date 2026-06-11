// Platform adapter layer. See docs/cross-platform-strategy.md.
//
// All OS-coupled work goes through PlatformAdapter. IPC handlers and renderer
// code never branch on `process.platform` — they ask the adapter or read the
// capability manifest.

export type FindHit = {
  path: string;
  name: string;
  isDir: boolean;
  tier: 'local' | 'index';
};

export type Capabilities = {
  spotlightSearch: boolean;
  externalVolumes: boolean;
  cloudMounts: boolean;
  attentionSound: boolean;
  dockBadge: boolean;
  share: boolean;
  colorTags: boolean;
  quickLook: boolean;
  openWithLauncher: boolean;
  vibrancy: boolean;
  // fm-b5at.6 — can we position *another* app's (Chrome's) top-level window?
  // Mac: AppleScript/System Events (needs Accessibility). Linux X11:
  // wmctrl/xdotool. Wayland: false (degraded — we still arrange our own
  // window, see windowArrange.ts). When false the renderer explains the
  // degraded path rather than hiding the side-by-side feature outright.
  windowArrange: boolean;
};

// fm-b5at.6 — outcome of trying to move Chrome's window. `ok` means the
// adapter believes it positioned the most-recently-active Chrome window.
export type ArrangeResult = {
  ok: boolean;
  reason?: 'no-permission' | 'no-chrome-window' | 'unsupported';
};

// fm-b5at.6 — pixel rectangle in the display's work area (menu-bar / panel
// excluded) where Chrome's window should land. Supplied by the orchestrator,
// which owns the Electron `screen` module; the adapter just drives the OS.
export type ArrangeRect = { x: number; y: number; width: number; height: number };

export interface PlatformAdapter {
  readonly id: 'mac' | 'linux';
  capabilities(): Capabilities;

  // Folder-name search across the user's home (sidebar quick-jump). Returns
  // absolute paths of directories whose name matches all tokens. Empty list
  // when the platform has no index — callers fall back to BFS / curated.
  searchFolders(tokens: string[], limit: number): Promise<string[]>;

  // Generic name search across the user's home — used by the Find overlay to
  // broaden beyond the bounded local BFS. May return files OR folders.
  searchByIndex(tokens: string[], limit: number): Promise<string[]>;

  // Best-effort attention sound for background-task completion.
  playAttentionSound(): void;

  // Absolute path to the Google Chrome (or Chromium) executable, or null if
  // not installed. Used by the TypeBuild onboarding prerequisite check.
  // Mac: standard /Applications path + mdfind fallback. Linux: command -v of
  // google-chrome / google-chrome-stable / chromium.
  chromePath(): Promise<string | null>;

  // fm-b5at.6 — TypeBuild side-by-side. Position the MOST RECENTLY ACTIVE
  // Google Chrome window into `rect` (a sub-rectangle of the current
  // display's work area). MUST act on a single window (the frontmost /
  // last-active one), never spray every Chrome window/profile. The
  // orchestrator computes `rect`; the adapter just drives the OS tool.
  arrangeChromeLeft(rect: ArrangeRect): Promise<ArrangeResult>;

  // fm-b5at.6 — capability + permission probe for the above, surfaced to the
  // Settings UI so it can offer the right affordance:
  //   'ok'            — we can arrange Chrome right now
  //   'no-permission' — supported but the OS grant is missing (mac
  //                     Accessibility); UI offers the privacy-pane button
  //   'unsupported'   — no portable mechanism (Wayland); UI explains the
  //                     degraded "we move only our own window" mode
  canArrangeWindows(): Promise<'ok' | 'no-permission' | 'unsupported'>;
}

import { MacAdapter } from './mac';
import { LinuxAdapter } from './linux';

let _current: PlatformAdapter | null = null;
export function platform(): PlatformAdapter {
  if (_current) return _current;
  _current = process.platform === 'darwin' ? new MacAdapter() : new LinuxAdapter();
  return _current;
}
