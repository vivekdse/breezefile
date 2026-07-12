// Instance identity — which window am I in? Fetched once per app run.
// Stamps <html data-profile="…"> as a side effect so CSS can mark a
// non-default-profile window (the amber top stripe in styles/base.css).
// Stamped from src/main.tsx at BOOT, not from a component: the login gate
// replaces the whole UI while signed out, and that unbranded screen is
// exactly where "is this dev or stable?" needs answering (2026-07-12).
import { fm } from './bridge';

export type AppInfo = { profile: string; version: string; sha: string };

let appInfoPromise: Promise<AppInfo | null> | null = null;

export function loadAppInfo(): Promise<AppInfo | null> {
  if (!appInfoPromise) {
    appInfoPromise = fm
      .appInfo()
      .then((info) => {
        document.documentElement.dataset.profile = info.profile;
        return info;
      })
      .catch(() => null);
  }
  return appInfoPromise;
}
