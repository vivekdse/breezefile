import { useCallback, useRef } from 'react';
import { useStore } from '../store';
import { useOverlays } from '../overlays';
import { visibleEntries, basename, lastCol } from '../actions';
import { FileRow, showContextMenu, type MenuItem } from './FileRow';
import { FileGrid } from './FileGrid';
import { fm } from '../bridge';
import type { Entry } from '../types';
import './FolderList.css';

/**
 * Finder/Explorer-style single-list view of the current folder.
 *
 * Replaces MillerColumns as the v1 default (fm-ehb): the user reviewed the
 * stacked-miller UI and preferred a single big list for the cwd, with a
 * dedicated preview pane on the right (owned by fm-fda). We keep the
 * `trail` array in tab state so back/forward history, `h` → parent, etc.
 * still work — but render only the *last* entry in the trail as one list.
 */
export function FolderList() {
  const store = useStore();
  const overlays = useOverlays();
  const { state, activeTab, setTab, openPath } = store;

  // fm-l6a — Per-render context snapshot that stable handlers below read
  // from via a ref. This lets us wrap row callbacks in useCallback with
  // [] deps (so React.memo on FileRow actually holds) while still letting
  // the handlers see fresh state at click time.
  const ctxRef = useRef<{
    store: typeof store;
    overlays: typeof overlays;
    tab: typeof activeTab;
    col: number;
    entries: Entry[];
  }>({ store, overlays, tab: activeTab, col: 0, entries: [] });

  const selectAt = useCallback((entry: Entry) => {
    const { store, tab, col, entries } = ctxRef.current;
    if (!tab) return;
    const rowIdx = entries.findIndex((e) => e.path === entry.path);
    if (rowIdx < 0) return;
    store.setTab({ selected: { ...tab.selected, [col]: rowIdx } });
  }, []);

  const toggleMark = useCallback((entry: Entry) => {
    const { store, tab } = ctxRef.current;
    if (!tab) return;
    const marks = { ...tab.marks };
    if (marks[entry.path]) delete marks[entry.path];
    else marks[entry.path] = true;
    store.setTab({ marks });
  }, []);

  const doubleOpen = useCallback((entry: Entry) => {
    ctxRef.current.store.openPath(entry.path);
  }, []);

  // fm-w8x — Drag a marked row → drag every marked path. Drag an unmarked
  // row → drag just that one. Stable callback (reads via ctxRef) so memo on
  // FileRow keeps holding.
  const getDragPaths = useCallback((entry: Entry): string[] => {
    const t = ctxRef.current.tab;
    if (!t) return [entry.path];
    const marked = Object.keys(t.marks);
    if (marked.length > 1 && t.marks[entry.path]) return marked;
    return [entry.path];
  }, []);

  // fm-l6a — Context-menu handler was previously built inside FileRow using
  // `useStore()` directly. That subscription was the main perf offender:
  // every reducer dispatch re-rendered every row just so each row's closure
  // could see fresh state. Now it's built here, once, reading fresh state
  // from ctxRef at click time.
  const onContextMenu = useCallback((entry: Entry, e: React.MouseEvent) => {
    const { store, overlays, tab } = ctxRef.current;
    const { state, dispatch, refreshActive } = store;

    const parentDir = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
    const baseName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const hasClipboard = state.yank.length > 0;
    const cwd = tab?.trail[tab.trail.length - 1] ?? parentDir;

    async function doPasteInto(dst: string) {
      if (state.yank.length === 0) return;
      try {
        await fm.paste(
          state.yank.map((y) => ({ src: y.path, dst, mode: y.mode })),
        );
        if (state.yank[0].mode === 'move') dispatch({ type: 'setYank', yank: [] });
        await refreshActive();
        dispatch({ type: 'setStatus', msg: `pasted ${state.yank.length} into ${dst.split('/').pop() || '/'}` });
      } catch (err) {
        dispatch({ type: 'setStatus', msg: `paste failed: ${(err as Error).message}` });
      }
    }

    async function duplicate() {
      const parsed = baseName.includes('.') ? [baseName.slice(0, baseName.lastIndexOf('.')), baseName.slice(baseName.lastIndexOf('.'))] : [baseName, ''];
      const [stem, ext] = parsed;
      let i = 1;
      // fm.paste handles uniqueness automatically when we do a copy into the same dir.
      try {
        await fm.paste([{ src: entry.path, dst: parentDir, mode: 'copy' }]);
        await refreshActive();
        dispatch({ type: 'setStatus', msg: `duplicated ${entry.name}` });
      } catch (err) {
        dispatch({ type: 'setStatus', msg: `duplicate failed: ${(err as Error).message}` });
      }
      void stem; void ext; void i;
    }

    const items: MenuItem[] = [
      { label: 'Open', action: () => { fm.open(entry.path); } },
      ...(entry.kind === 'dir'
        ? [
            {
              label: 'Open in New Tab',
              action: () => {
                dispatch({
                  type: 'newTab',
                  tab: {
                    id: crypto.randomUUID(),
                    trail: [entry.path],
                    selected: { 0: 0 },
                    marks: {},
                    sortKey: 'name',
                    sortReverse: false,
                    showHidden: false,
                    viewMode: 'list',
                    filter: '',
                    history: [],
                    forward: [],
                  },
                });
              },
            } as MenuItem,
          ]
        : []),
      {
        label: 'Open With…',
        submenu: ['Visual Studio Code', 'TextEdit', 'Preview', 'QuickLook', 'Finder'].map(
          (appName) => ({
            label: appName,
            action: () => {
              if (appName === 'QuickLook') fm.runCommand(cwd, `qlmanage -p "${entry.path.replace(/"/g, '\\"')}" >/dev/null 2>&1 &`);
              else if (appName === 'Finder') fm.openWith(entry.path, 'Finder');
              else fm.openWith(entry.path, appName);
            },
          }),
        ),
      },
      { label: 'Reveal in Finder', action: () => fm.reveal(entry.path) },
      { separator: true },
      {
        label: 'Cut',
        action: () => {
          dispatch({ type: 'setYank', yank: [{ path: entry.path, mode: 'move' }] });
          dispatch({ type: 'setStatus', msg: `cut ${entry.name}` });
        },
      },
      {
        label: 'Copy',
        action: () => {
          dispatch({ type: 'setYank', yank: [{ path: entry.path, mode: 'copy' }] });
          dispatch({ type: 'setStatus', msg: `copied ${entry.name}` });
        },
      },
      ...(hasClipboard && entry.kind === 'dir'
        ? [{ label: `Paste into ${entry.name}`, action: () => doPasteInto(entry.path) } as MenuItem]
        : []),
      ...(hasClipboard
        ? [{ label: 'Paste here', action: () => doPasteInto(parentDir) } as MenuItem]
        : []),
      { label: 'Duplicate', action: duplicate },
      { label: 'Rename…', action: () => overlays.requestRename(entry, 'full') },
      { separator: true },
      { label: 'Copy Path', action: () => fm.clipboardWrite(entry.path) },
      { label: 'Copy Name', action: () => fm.clipboardWrite(entry.name) },
      { label: 'New Folder Here…', action: () => overlays.requestMkdir() },
      { separator: true },
      ...(entry.kind === 'dir'
        ? [
            {
              label: 'Bookmark this Folder…',
              action: () => {
                const key = prompt('Bind to key (single char):');
                if (key && key.length === 1) {
                  dispatch({ type: 'setBookmark', key, path: entry.path });
                }
              },
            } as MenuItem,
          ]
        : []),
      {
        label: 'Move to Trash',
        action: async () => {
          await fm.trash([entry.path]);
          await refreshActive();
        },
      },
    ];

    showContextMenu(e.clientX, e.clientY, items);
  }, []);

  if (!activeTab) return null;
  const tab = activeTab;
  const col = lastCol(tab);
  const cwd = tab.trail[col];
  const entries = visibleEntries(state.entriesByPath[cwd], tab);
  const selIdx = tab.selected[col] ?? 0;

  // Keep the ref fresh so the stable callbacks above see current data.
  ctxRef.current = { store, overlays, tab, col, entries };

  const toggleSelectAll = () => {
    const allMarked = entries.length > 0 && entries.every((e) => tab.marks[e.path]);
    const marks = { ...tab.marks };
    if (allMarked) {
      for (const e of entries) delete marks[e.path];
    } else {
      for (const e of entries) marks[e.path] = true;
    }
    setTab({ marks });
  };

  void openPath; // retained via store.openPath through ctxRef

  const allMarked = entries.length > 0 && entries.every((e) => tab.marks[e.path]);
  const someMarked = !allMarked && entries.some((e) => tab.marks[e.path]);
  const checkGlyph = allMarked ? '☑' : someMarked ? '◪' : '☐';

  return (
    <div className="folder-list">
      <div className="folder-list__head">
        {entries.length > 0 && (
          <span
            className={[
              'col-head__checkbox',
              allMarked && 'col-head__checkbox--checked',
              someMarked && 'col-head__checkbox--indeterminate',
            ].filter(Boolean).join(' ')}
            role="checkbox"
            aria-checked={allMarked ? true : someMarked ? 'mixed' : false}
            tabIndex={-1}
            title="Press shift+space to select all"
            onClick={toggleSelectAll}
          >
            {checkGlyph}
          </span>
        )}
        <span className="folder-list__name">{basename(cwd) || '/'}</span>
        <span className="folder-list__meta">{entries.length}</span>
      </div>
      {/* fm-n8s — view-mode cross-fade. Keying the wrapper on viewMode
          forces a remount when the user toggles grid↔list, which makes
          the receiving side animate in (via gpPopIn on .folder-list__body). */}
      {tab.viewMode === 'grid' ? (
        <div key="grid" className="folder-list__body">
          <FileGrid
            entries={entries}
            selIdx={selIdx}
            activeColumn={true}
            marks={tab.marks}
            onSelect={selectAt}
            onOpen={doubleOpen}
            getDragPaths={getDragPaths}
          />
        </div>
      ) : (
        <ul key="list" className="folder-list__list folder-list__body">
          {entries.length === 0 && <li className="folder-list__empty">empty</li>}
          {entries.map((e, j) => (
            <FileRow
              key={e.path}
              entry={e}
              index={j}
              selected={selIdx === j}
              activeColumn={true}
              marked={!!tab.marks[e.path]}
              tag={state.tags[e.path]}
              yanked={state.yank.some((y) => y.path === e.path)}
              onClick={selectAt}
              onDoubleClick={doubleOpen}
              onToggleMark={toggleMark}
              onContextMenu={onContextMenu}
              getDragPaths={getDragPaths}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// fm-n8s — ensure the scalable wrapper has the fade class. If the
// enclosing CSS ever grows complex, consider promoting this to its own
// <FolderListBody> component.
