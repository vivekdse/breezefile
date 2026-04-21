import { useEffect, useState } from 'react';
import { OverlayCtx, type OverlayApi, type RenameMode } from './overlays';
import { Titlebar } from './components/Titlebar';
import { Pathbar } from './components/Pathbar';
import { FolderList } from './components/FolderList';
import { Preview } from './components/Preview';
import { Sidebar } from './components/Sidebar';
import { Statusbar } from './components/Statusbar';
import { Tabbar } from './components/Tabbar';
import { ModeLine } from './components/ModeLine';
import { Settings } from './components/Settings';
import { ChipPrompt } from './components/ChipPrompt';
import { IconSprite } from './components/icons';
import { StoreProvider, useStore } from './store';
import { useKeyboard } from './useKeyboard';
import { fm } from './bridge';
import { basename, currentEntry, dirname, lastCol, pathJoin, visibleEntries } from './actions';
import type { Entry } from './types';
import './App.css';


function Shell() {
  const { state, activeTab, refreshActive, dispatch, setTab } = useStore();
  const [renaming, setRenaming] = useState<{ entry: Entry; mode: RenameMode } | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickFindOpen, setQuickFindOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);

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
    window.addEventListener('fm:openRename', onRename);
    window.addEventListener('fm:openMkdir', onMkdir);
    return () => {
      window.removeEventListener('fm:openRename', onRename);
      window.removeEventListener('fm:openMkdir', onMkdir);
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
    <OverlayCtx.Provider value={overlayApi}><div className="shell">
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
      {/* side slot — Sidebar (fm-4zi) fills the reserved 240px slot. */}
      <Sidebar />
      {/* main slot — the recessed plate. FolderList (single-list Finder-style
          view per fm-ehb) fills it. MillerColumns remains in the tree for a
          future optional view mode. */}
      <main className="shell__main">
        <FolderList />
      </main>
      {/* preview slot — Preview (fm-fda) fills the reserved 340px slot. */}
      <Preview />
      {/* status slot — ModeLine stacked above Statusbar */}
      <div className="shell__status">
        <ModeLine />
        <Statusbar />
      </div>

      {renaming && (
        <RenameOverlay
          entry={renaming.entry}
          mode={renaming.mode}
          onClose={() => setRenaming(null)}
          onCommit={async (newName) => {
            if (newName && newName !== renaming.entry.name) {
              const to = pathJoin(dirname(renaming.entry.path), newName);
              try {
                await fm.rename(renaming.entry.path, to);
                await refreshActive();
                dispatch({ type: 'setStatus', msg: `renamed → ${newName}` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: `rename failed: ${(err as Error).message}`,
                });
              }
            }
            setRenaming(null);
          }}
        />
      )}

      {mkdirOpen && (
        <MkdirOverlay
          cwd={tab.trail[tab.trail.length - 1]}
          onClose={() => setMkdirOpen(false)}
          onCommit={async (name) => {
            if (name) {
              try {
                await fm.mkdir(pathJoin(tab.trail[tab.trail.length - 1], name));
                await refreshActive();
                dispatch({ type: 'setStatus', msg: `created ${name}/` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: `mkdir failed: ${(err as Error).message}`,
                });
              }
            }
            setMkdirOpen(false);
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

      {state.mode === 'find' && <FindPrompt />}
      {state.mode === 'command' && (
        <ChipPrompt
          initialFilter={state.modeBuffer}
          onClose={() => dispatch({ type: 'setMode', mode: 'normal' })}
        />
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
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
  onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState(entry.name);
  const label =
    mode === 'append'
      ? 'Append to name'
      : mode === 'prepend'
        ? 'Prepend to name'
        : mode === 'beforeExt'
          ? 'Rename (keep extension)'
          : 'Rename';
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">{label}</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(value);
            else if (e.key === 'Escape') onClose();
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
  onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="overlay__label">New folder in {basename(cwd) || '/'}</div>
        <input
          autoFocus
          className="overlay__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit(value);
            else if (e.key === 'Escape') onClose();
          }}
        />
      </div>
    </div>
  );
}

function QuickFindOverlay({ onClose }: { onClose: () => void }) {
  const { state, activeTab, setTab, dispatch } = useStore();
  const [value, setValue] = useState('');
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
    <div className="overlay" onClick={onClose}>
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
              onClose();
            } else if (e.key === 'Escape') {
              onClose();
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
  return (
    <div className="overlay" onClick={onClose}>
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
              onClose();
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
      </div>
    </div>
  );
}

function FindPrompt() {
  const { state, dispatch, setTab, activeTab, openPath } = useStore();
  if (!activeTab) return null;
  const tab = activeTab;

  function moveSel(delta: number) {
    const col = lastCol(tab);
    const entries = visibleEntries(state.entriesByPath[tab.trail[col]], tab);
    if (entries.length === 0) return;
    const cur = tab.selected[col] ?? 0;
    const next = Math.max(0, Math.min(entries.length - 1, cur + delta));
    setTab({ selected: { ...tab.selected, [col]: next } });
  }

  function openSelected() {
    const col = lastCol(tab);
    const entries = visibleEntries(state.entriesByPath[tab.trail[col]], tab);
    const entry = entries[tab.selected[col] ?? 0];
    if (!entry) return;
    if (entry.kind === 'dir') {
      openPath(entry.path);
      // fresh directory — clear filter so you see everything
      setTab({ filter: '' });
      dispatch({ type: 'setModeBuffer', buffer: '' });
    } else {
      fm.open(entry.path);
      dispatch({ type: 'setMode', mode: 'normal' });
    }
  }

  function goParent() {
    if (tab.trail.length > 1) {
      const newTrail = tab.trail.slice(0, -1);
      const newSel = { ...tab.selected };
      delete newSel[tab.trail.length - 1];
      setTab({ trail: newTrail, selected: newSel, filter: '' });
      dispatch({ type: 'setModeBuffer', buffer: '' });
    }
  }

  return (
    <div className="prompt">
      <span className="prompt__sigil">/</span>
      <input
        autoFocus
        className="prompt__input"
        value={state.modeBuffer}
        onChange={(e) => {
          dispatch({ type: 'setModeBuffer', buffer: e.target.value });
          setTab({ filter: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSel(+1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSel(-1);
          } else if (e.key === 'ArrowRight') {
            // Only intercept when cursor is at end of input — otherwise let
            // the input's caret move as normal.
            const el = e.currentTarget;
            if (el.selectionStart === el.value.length) {
              e.preventDefault();
              openSelected();
            }
          } else if (e.key === 'ArrowLeft') {
            const el = e.currentTarget;
            if (el.selectionStart === 0) {
              e.preventDefault();
              goParent();
            }
          } else if (e.key === 'Enter') {
            e.preventDefault();
            dispatch({ type: 'setLastFind', query: state.modeBuffer });
            openSelected();
          } else if (e.key === 'Escape') {
            setTab({ filter: '' });
            dispatch({ type: 'setMode', mode: 'normal' });
          }
        }}
        spellCheck={false}
      />
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
