import { useEffect, useState } from 'react';
import { OverlayCtx, type OverlayApi, type RenameMode } from './overlays';
import { Titlebar } from './components/Titlebar';
import { Pathbar } from './components/Pathbar';
import { FolderList } from './components/FolderList';
import { FolderHeader } from './components/FolderHeader';
import { Preview } from './components/Preview';
import { Sidebar } from './components/Sidebar';
import { Statusbar } from './components/Statusbar';
import { Tabbar } from './components/Tabbar';
import { ModeLine } from './components/ModeLine';
import { Settings } from './components/Settings';
import { ChipPrompt } from './components/ChipPrompt';
import { PasteChip } from './components/PasteChip';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import { ThemePicker } from './components/ThemePicker';
import { Welcome, shouldShowWelcome } from './components/Welcome';
import { UpdateChip } from './components/UpdateChip';
import { PrivacyHelpDialog } from './components/PrivacyHelpDialog';
import { OpenWithDialog } from './components/OpenWithDialog';
import { Tutorial } from './components/Tutorial';
import { TipsChip, isTipsEnabled, setTipsEnabled } from './components/TipsChip';
import { IconSprite } from './components/icons';
import { StoreProvider, useStore } from './store';
import { useKeyboard } from './useKeyboard';
import { fm } from './bridge';
import { basename, currentEntry, dirname, lastCol, pathJoin, visibleEntries } from './actions';
import { celebratePaths } from './motion-utils';
import { useOverlayExit } from './useOverlayExit';
import type { Entry } from './types';
import './App.css';


function Shell() {
  const { state, activeTab, refreshActive, dispatch, setTab, focusEntryByName } = useStore();
  const [renaming, setRenaming] = useState<{ entry: Entry; mode: RenameMode } | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [touchOpen, setTouchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(() => shouldShowWelcome());
  const [privacyHelpOpen, setPrivacyHelpOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialNonce, setTutorialNonce] = useState(0);
  // fm-294 — global confirm dialog. Surfaces request a confirm by
  // dispatching `fm:confirm` with a ConfirmRequest payload.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // fm-pg0 — Open With surface. The chip verb dispatches `fm:openWith`
  // with the target path; we run the native app picker here, then mount
  // OpenWithDialog so the user can confirm + optionally bind the app as
  // the default for this extension. Null when no flow is active.
  const [openWith, setOpenWith] = useState<{ path: string; ext?: string; appPath: string } | null>(
    null,
  );

  useKeyboard(
    (entry, mode) => setRenaming({ entry, mode }),
    () => setMkdirOpen(true),
    () => setQuickFindOpen(true),
    () => setShellOpen(true),
  );

  useEffect(() => {
    function h(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Bridge events from ChipPrompt → the overlays owned by App
  useEffect(() => {
    function onRename(e: Event) {
      const path = (e as CustomEvent).detail?.path as string | undefined;
      if (!path || !activeTab) return;
      const cwd = activeTab.trail[activeTab.trail.length - 1];
      const entries = visibleEntries(state.entriesByPath[cwd], activeTab);
      const entry = entries.find((ent) => ent.path === path);
      if (entry) setRenaming({ entry, mode: 'full' });
    }
    function onMkdir() {
      setMkdirOpen(true);
    }
    function onTouch() {
      setTouchOpen(true);
    }
    function onTheme() {
      setThemeOpen(true);
    }
    function onPrivacyHelp() {
      setPrivacyHelpOpen(true);
    }
    function onTutorial() {
      // Always start from step 1 when explicitly opened — picking it up
      // mid-flow on a new launch is fine, but a re-launch via the verb
      // means the user wants to take it again.
      try {
        localStorage.removeItem('fm.tutorial.step');
        localStorage.removeItem('fm.tutorial.done');
      } catch {
        /* noop */
      }
      setTutorialOpen(true);
      setTutorialNonce((n) => n + 1);
    }
    function onToggleTips() {
      const next = !isTipsEnabled();
      setTipsEnabled(next);
      dispatch({
        type: 'setStatus',
        msg: next ? 'tips on' : 'tips off — type tips to bring them back',
      });
    }
    function onConfirm(e: Event) {
      const detail = (e as CustomEvent).detail as ConfirmRequest | undefined;
      if (detail) setConfirm(detail);
    }
    async function onOpenWith(e: Event) {
      const detail = (e as CustomEvent).detail as { path: string; ext?: string } | undefined;
      if (!detail?.path) return;
      try {
        const picked = await fm.pickApplication();
        if (picked) setOpenWith({ path: detail.path, ext: detail.ext, appPath: picked });
      } catch (err) {
        dispatch({
          type: 'setStatus',
          msg: `open with failed: ${(err as Error).message}`,
        });
      }
    }
    window.addEventListener('fm:openRename', onRename);
    window.addEventListener('fm:openMkdir', onMkdir);
    window.addEventListener('fm:openTouch', onTouch);
    window.addEventListener('fm:openTheme', onTheme);
    window.addEventListener('fm:openPrivacyHelp', onPrivacyHelp);
    window.addEventListener('fm:openTutorial', onTutorial);
    window.addEventListener('fm:toggleTips', onToggleTips);
    window.addEventListener('fm:confirm', onConfirm);
    window.addEventListener('fm:openWith', onOpenWith);
    return () => {
      window.removeEventListener('fm:openRename', onRename);
      window.removeEventListener('fm:openMkdir', onMkdir);
      window.removeEventListener('fm:openTouch', onTouch);
      window.removeEventListener('fm:openTheme', onTheme);
      window.removeEventListener('fm:openPrivacyHelp', onPrivacyHelp);
      window.removeEventListener('fm:openTutorial', onTutorial);
      window.removeEventListener('fm:toggleTips', onToggleTips);
      window.removeEventListener('fm:confirm', onConfirm);
      window.removeEventListener('fm:openWith', onOpenWith);
    };
  }, [activeTab, state.entriesByPath]);

  if (!activeTab) {
    return <div className="app">loading…</div>;
  }
  const tab = activeTab;

  const overlayApi: OverlayApi = {
    requestRename: (entry, mode = 'full') => setRenaming({ entry, mode }),
    requestMkdir: () => setMkdirOpen(true),
  };

  return (
    <OverlayCtx.Provider value={overlayApi}><div className="shell" data-view={tab.viewMode}>
      <IconSprite />
      {/* title slot — owned by fm-9w0 */}
      <div className="shell__title">
        <Titlebar />
      </div>
      {/* chrome slot — Tabbar + Pathbar stack */}
      <div className="shell__chrome">
        <Tabbar />
        <Pathbar
          path={tab.trail[tab.trail.length - 1]}
          onNavigate={(p) => setTab({ trail: [p], selected: { 0: 0 } })}
        />
      </div>
      {/* side slot — Sidebar (fm-4zi) fills the reserved 240px slot.
          Hidden in preview mode (fm-wq6) so the preview pane can claim
          the real estate. */}
      {tab.viewMode !== 'preview' && <Sidebar />}
      {/* main slot — the recessed plate. FolderList (single-list Finder-style
          view per fm-ehb) fills it. MillerColumns remains in the tree for a
          future optional view mode. */}
      <main className="shell__main">
        <FolderHeader />
        <FolderList />
      </main>
      {/* preview slot — Preview (fm-fda) fills the reserved 340px slot. */}
      <Preview />
      {/* status slot — ModeLine stacked above Statusbar */}
      <div className="shell__status">
        <ModeLine />
        <Statusbar />
      </div>

      {/* Floating paste affordance (fm-3km) — visible whenever the user has
          staged files via Copy / Move verbs or yy / dd chords. Renders above
          the main content but below modals. */}
      <PasteChip />

      {/* Update available — fetches GitHub Releases on a 24h cadence and
          shows a quiet bottom-left pill when a newer version is out.
          User upgrades via `brew upgrade --cask breezefile` (copy button). */}
      <UpdateChip />

      {/* Rotating "did you know" tips in the bottom-right. Helps first-
          time users discover the verb prompt without an in-your-face
          tutorial. Dismissible forever. */}
      <TipsChip />

      {renaming && (
        <RenameOverlay
          entry={renaming.entry}
          mode={renaming.mode}
          onClose={() => setRenaming(null)}
          onCommit={async (newName) => {
            if (!newName || newName === renaming.entry.name) {
              setRenaming(null);
              return;
            }
            const to = pathJoin(dirname(renaming.entry.path), newName);
            // Let the overlay surface errors inline — rethrow so it stays
            // open and the user can fix the name without retyping.
            await fm.rename(renaming.entry.path, to);
            await refreshActive();
            requestAnimationFrame(() => celebratePaths([to]));
            dispatch({ type: 'setStatus', msg: `renamed → ${newName}` });
            setRenaming(null);
          }}
        />
      )}

      {mkdirOpen && (
        <MkdirOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setMkdirOpen(false)}
          onCommit={async (name) => {
            if (!name) { setMkdirOpen(false); return; }
            await fm.mkdir(pathJoin(tab.trail[tab.trail.length - 1], name));
            await refreshActive();
            focusEntryByName(name);
            dispatch({ type: 'setStatus', msg: `created ${name}/` });
            setMkdirOpen(false);
          }}
        />
      )}

      {touchOpen && (
        <TouchOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setTouchOpen(false)}
          onCommit={async (name) => {
            if (!name) { setTouchOpen(false); return; }
            const to = pathJoin(tab.trail[tab.trail.length - 1], name);
            await fm.touch(to);
            await refreshActive();
            focusEntryByName(name);
            requestAnimationFrame(() => celebratePaths([to]));
            dispatch({ type: 'setStatus', msg: `created ${name}` });
            setTouchOpen(false);
          }}
        />
      )}

      {quickFindOpen && (
        <QuickFindOverlay
          onClose={() => setQuickFindOpen(false)}
        />
      )}

      {shellOpen && (
        <ShellOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setShellOpen(false)}
        />
      )}

      {state.mode === 'command' && (
        <ChipPrompt
          initialFilter={state.modeBuffer}
          initialVerbId={state.modeVerb}
          onClose={() => dispatch({ type: 'setMode', mode: 'normal' })}
        />
      )}
      {themeOpen && <ThemePicker onClose={() => setThemeOpen(false)} />}
      {welcomeOpen && <Welcome onClose={() => setWelcomeOpen(false)} />}
      {privacyHelpOpen && <PrivacyHelpDialog onClose={() => setPrivacyHelpOpen(false)} />}
      {tutorialOpen && (
        <Tutorial key={tutorialNonce} onClose={() => setTutorialOpen(false)} />
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      {openWith && (
        <OpenWithDialog
          filePath={openWith.path}
          ext={openWith.ext}
          appPath={openWith.appPath}
          onClose={() => setOpenWith(null)}
        />
      )}
    </div>
    </OverlayCtx.Provider>
  );
}

function RenameOverlay({
  entry,
  mode,
  onClose,
  onCommit,
}: {
  entry: Entry;
  mode: RenameMode;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const label =
    mode === 'append'
      ? 'Append to name'
      : mode === 'prepend'
        ? 'Prepend to name'
        : mode === 'beforeExt'
          ? 'Rename (keep extension)'
          : 'Rename';
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">{label}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
          onFocus={(e) => {
            const el = e.currentTarget;
            const n = value;
            const dot = n.lastIndexOf('.');
            const hasExt = dot > 0 && entry.kind !== 'dir';
            if (mode === 'append') {
              el.setSelectionRange(n.length, n.length);
            } else if (mode === 'prepend') {
              el.setSelectionRange(0, 0);
            } else if (mode === 'beforeExt' && hasExt) {
              el.setSelectionRange(dot, dot);
            } else if (hasExt) {
              el.setSelectionRange(0, dot);
            } else {
              el.select();
            }
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function MkdirOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New folder in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function TouchOverlay({
  cwd,
  onClose,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onCommit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { exit, state } = useOverlayExit(onClose);
  const submit = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCommit(value);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New file in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className={error ? 'overlay__input overlay__input--error' : 'overlay__input'}
          value={value}
          disabled={busy}
          placeholder="untitled.txt"
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {error && <div className="overlay__error">{error}</div>}
      </div>
    </div>
  );
}

function QuickFindOverlay({ onClose }: { onClose: () => void }) {
  const { state, activeTab, setTab, dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state: overlayState } = useOverlayExit(onClose);
  if (!activeTab) return null;
  const tab = activeTab;

  function doFind(q: string) {
    const path = tab.trail[lastCol(tab)];
    const entries = visibleEntries(state.entriesByPath[path], tab);
    const needle = q.toLowerCase();
    const idx = entries.findIndex((e) => e.name.toLowerCase().includes(needle));
    if (idx >= 0) {
      setTab({ selected: { ...tab.selected, [lastCol(tab)]: idx } });
    }
    dispatch({ type: 'setLastFind', query: q });
  }

  return (
    <div className="overlay" data-state={overlayState} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">Quick find</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            doFind(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // open the currently-selected entry
              const entries = visibleEntries(state.entriesByPath[tab.trail[lastCol(tab)]], tab);
              const entry = currentEntry(tab, entries);
              if (entry) {
                if (entry.kind === 'dir') {
                  setTab({
                    trail: [...tab.trail, entry.path],
                    selected: { ...tab.selected, [tab.trail.length]: 0 },
                  });
                } else {
                  fm.open(entry.path);
                }
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

function ShellOverlay({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { dispatch } = useStore();
  const [value, setValue] = useState('');
  const { exit, state } = useOverlayExit(onClose);
  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">shell in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="echo hi"
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              try {
                await fm.runCommand(cwd, value);
                dispatch({ type: 'setStatus', msg: `$ ${value}` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: `shell failed: ${(err as Error).message}`,
                });
              }
              exit();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
      </div>
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
