import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Capabilities } from './bridge';

// Loaded once at app boot and stable thereafter. Components that gate verbs
// or UI on platform features read this via usePlatform(). Never reach for
// `window.fm.platform` directly — the rule is capabilities, not OS string.
//
// Until the IPC resolves, we expose a permissive default so first-paint UI
// doesn't flicker. Anything platform-coupled should render *nothing* while
// `loaded` is false, or treat `loaded === false` as a defer.

const DEFAULTS: Capabilities = {
  id: 'mac',
  spotlightSearch: false,
  externalVolumes: false,
  cloudMounts: false,
  attentionSound: false,
  dockBadge: false,
  share: false,
  colorTags: false,
  quickLook: false,
  openWithLauncher: false,
  vibrancy: false,
  windowArrange: false,
};

type Ctx = { caps: Capabilities; loaded: boolean };
const PlatformCtx = createContext<Ctx>({ caps: DEFAULTS, loaded: false });

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Ctx>({ caps: DEFAULTS, loaded: false });
  useEffect(() => {
    let cancelled = false;
    window.fm.capabilities().then((caps) => {
      if (!cancelled) setState({ caps, loaded: true });
    }).catch(() => {
      if (!cancelled) setState({ caps: DEFAULTS, loaded: true });
    });
    return () => { cancelled = true; };
  }, []);
  return <PlatformCtx.Provider value={state}>{children}</PlatformCtx.Provider>;
}

export function usePlatform(): Ctx {
  return useContext(PlatformCtx);
}

// True on macOS. Reads the loaded capability id; falls back to the
// synchronous navigator string so labels don't flash the wrong modifier
// during the brief window before capabilities resolve.
export function useIsMac(): boolean {
  const { caps, loaded } = usePlatform();
  if (loaded) return caps.id === 'mac';
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
}

// Rewrite macOS chord glyphs to their cross-platform names when not on a
// Mac, so Linux/Windows users see "Ctrl+F" where Mac users see "⌘F".
// The keyboard handlers already accept metaKey || ctrlKey — this only
// fixes the user-facing label. Safe to call on whole sentences (the
// catalog mixes chords into prose like "⌘S saves atomically").
export function fmtKeys(s: string, isMac: boolean): string {
  if (isMac) return s;
  return s
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+');
}
