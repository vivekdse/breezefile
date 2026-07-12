import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { visibleEntries } from '../actions';
import { formatSize } from '../sort';
import { fm } from '../bridge';
import './Statusbar.css';

// Instance identity (which window am I in?) — fetched once per app run and
// shared by every Statusbar mount. Alongside the chip, stamp
// <html data-profile="…"> so CSS can mark the whole dev window (the amber
// top stripe in base.css) — alt-tab alone couldn't tell dev from stable.
type AppInfo = { profile: string; version: string; sha: string };
let appInfoPromise: Promise<AppInfo | null> | null = null;
function loadAppInfo(): Promise<AppInfo | null> {
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

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadAppInfo().then((i) => {
      if (!cancelled) setInfo(i);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}

export function Statusbar() {
  const appInfo = useAppInfo();
  const { state, activeTab } = useStore();
  if (!activeTab) return null;

  const cwd = activeTab.trail[activeTab.trail.length - 1];
  const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
  const markedCount = entries.reduce(
    (n, e) => (activeTab.marks[e.path] ? n + 1 : n),
    0,
  );
  const yanked = state.yank.length;

  // Sum sizes: when something is marked we report the selection size;
  // otherwise the combined size of visible files in this folder.
  const totalSize = entries.reduce(
    (sum, e) => sum + (e.kind === 'file' ? e.size : 0),
    0,
  );
  const selectedSize = entries.reduce(
    (sum, e) =>
      activeTab.marks[e.path] && e.kind === 'file' ? sum + e.size : sum,
    0,
  );

  const mode = state.mode.toUpperCase();
  // task-83048f692491 — the Projects tab has no folder listing; describe its
  // own motion model instead of reporting "0 items" for a placeholder trail.
  // task-97c0800ff55d — Home now rides kind:'home' (was relabeled 'projects').
  // Both render the same surface with no folder listing.
  const isProjects = activeTab.kind === 'projects' || activeTab.kind === 'home';
  // task-b9cdad64ab9c — New Home (kind:'newhome') is likewise a no-folder-
  // listing surface; describe it instead of reporting "0 items".
  const isNewHome = activeTab.kind === 'newhome';
  const summary = isProjects
    ? 'Home · your tasks, projects as folders · drill into any one'
    : isNewHome
      ? 'New Home · agent work monitor'
      : markedCount > 0
        ? `${markedCount} of ${entries.length} selected · ${formatSize(selectedSize)}`
        : `${entries.length} items · ${formatSize(totalSize)}`;

  // Keyboard hints — only the two affordances that are still real after the
  // shift to the verb-first model: Space marks the cursor item, `:` opens
  // the verb palette empty. Everything else is reachable by typing any
  // letter (which opens the palette pre-filtered). The Projects tab is a
  // zoom surface, so its hints are motion: j/k move, l/Enter in, h/Esc back.
  const hints: Array<{ keys: string[]; label: string }> = isProjects
    ? [
        { keys: ['j', 'k'], label: 'move' },
        { keys: ['l'], label: 'open' },
        { keys: ['h'], label: 'back' },
        { keys: [':'], label: 'actions' },
      ]
    : isNewHome
      ? [{ keys: [':'], label: 'actions' }]
      : [
          { keys: ['space'], label: 'mark' },
          { keys: [':'], label: 'actions' },
        ];

  return (
    <div className="statusbar">
      <span className="statusbar__mode">{mode}</span>
      <span className="statusbar__summary tnum-oldstyle">{summary}</span>
      {yanked > 0 && (
        <span className="statusbar__clip tnum-oldstyle">
          {yanked} in clipboard
        </span>
      )}
      <span className="sp" />
      {hints.map((h, i) => (
        <span key={i} className="statusbar__hint">
          {h.keys.map((k, j) => (
            <kbd key={j}>{k}</kbd>
          ))}{' '}
          {h.label}
        </span>
      ))}
      {appInfo && (
        <span
          className="statusbar__instance"
          data-profile={appInfo.profile}
          title={`profile: ${appInfo.profile}${appInfo.sha ? ` · ${appInfo.sha}` : ''}`}
        >
          {appInfo.profile === 'default'
            ? `v${appInfo.version}`
            : appInfo.profile === 'dev'
              ? `DEV v${appInfo.version}`
              : `${appInfo.profile} v${appInfo.version}`}
        </span>
      )}
      <button
        type="button"
        className="statusbar__help"
        onClick={() => window.dispatchEvent(new CustomEvent('fm:openSecrets'))}
        title="Manage your saved credentials (NPI, Tax ID, login IDs)"
      >
        Secrets
      </button>
      <button
        type="button"
        className="statusbar__help"
        onClick={() => window.dispatchEvent(new CustomEvent('fm:openHelp'))}
        title="Open the help tour (slides)"
      >
        Help
      </button>
    </div>
  );
}
