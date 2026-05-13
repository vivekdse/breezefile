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
