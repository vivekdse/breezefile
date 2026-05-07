import { useCallback, useRef } from 'react';
import { useStore } from '../store';
import { useOverlays } from '../overlays';
import { visibleEntries, basename, lastCol } from '../actions';
import { FileRow, showContextMenu, type MenuItem } from './FileRow';
import { FileGrid } from './FileGrid';
import { fm } from '../bridge';
import type { Entry } from '../types';
import { entryMatchesFilter, findTag, tagMatchesEntry } from '../tags';
import {
  currentDragSourceCwd,
  dragHasAnyPaths,
  dropIntoFolder,
  endAppDrag,
  isExternalDrop,
  resolveDropPaths,
} from '../dragState';
import type { HelpSlideId } from './HelpTour';
import { formatOpError } from '../errorMessages';
import './FolderList.css';

type EmptyKind = 'truly-empty' | 'all-hidden' | 'filtered-out';

function FolderEmptyState({ kind }: { kind: EmptyKind }) {
  let title: string;
  let hint: React.ReactNode;
  let helpSlide: HelpSlideId;
  if (kind === 'filtered-out') {
    title = 'No files match this filter.';
    hint = (
      <>
        Type <kbd>filter</kbd> to clear the tag filter, or pick a different tag.
      </>
    );
    helpSlide = 'tags';
  } else if (kind === 'all-hidden') {
    title = 'Only hidden files here.';
    hint = (
      <>
        Type <kbd>zh</kbd> to show hidden files (dotfiles, system files).
      </>
    );
    helpSlide = 'view-sort';
  } else {
    title = 'Empty folder.';
    hint = (
      <>
        Type <kbd>create</kbd> to add a file or folder. <kbd>←</kbd> goes back up.
      </>
    );
    helpSlide = 'select';
  }
  function openHelp() {
    window.dispatchEvent(
      new CustomEvent('fm:openHelp', { detail: { slide: helpSlide } }),
    );
  }
  return (
    <div className="folder-list__empty" role="status" aria-live="polite">
      <div className="folder-list__empty-glyph" aria-hidden>·</div>
      <div className="folder-list__empty-title">{title}</div>
      <div className="folder-list__empty-hint">{hint}</div>
      <button
        type="button"
        className="folder-list__empty-help"
        onClick={openHelp}
      >
        Learn more
      </button>
    </div>
  );
}

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
        const { renamed } = await fm.paste(
          state.yank.map((y) => ({ src: y.path, dst, mode: y.mode })),
        );
        if (state.yank[0].mode === 'move') dispatch({ type: 'setYank', yank: [] });
        await refreshActive();
        const suffix = renamed > 0 ? ` (${renamed} renamed)` : '';
        dispatch({ type: 'setStatus', msg: `pasted ${state.yank.length} into ${dst.split('/').pop() || '/'}${suffix}` });
      } catch (err) {
        dispatch({ type: 'setStatus', msg: formatOpError('paste', err) });
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
        dispatch({ type: 'setStatus', msg: formatOpError('duplicate', err) });
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
                    kind: 'folder',
                    taskId: null,
                    trail: [entry.path],
                    selected: { 0: 0 },
                    marks: {},
                    sortKey: 'name',
                    sortReverse: false,
                    showHidden: false,
                    viewMode: 'list',
                    foldersFirst: true,
                    filter: '',
                    tagViz: [],
                    tagFilter: { mode: 'off', ids: [] },
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
            action: async () => {
              try {
                if (appName === 'QuickLook') {
                  await fm.runCommand(
                    cwd,
                    `qlmanage -p "${entry.path.replace(/"/g, '\\"')}" >/dev/null 2>&1 &`,
                  );
                } else if (appName === 'Finder') {
                  await fm.openWith(entry.path, 'Finder');
                } else {
                  await fm.openWith(entry.path, appName);
                }
                dispatch({ type: 'setStatus', msg: `opened in ${appName}` });
              } catch (err) {
                dispatch({
                  type: 'setStatus',
                  msg: formatOpError(appName, err),
                });
              }
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
      {
        label: 'Copy Path',
        action: () => {
          void fm.clipboardWrite(entry.path);
          dispatch({ type: 'setStatus', msg: `copied path: ${entry.name}` });
        },
      },
      {
        label: 'Copy Name',
        action: () => {
          void fm.clipboardWrite(entry.name);
          dispatch({ type: 'setStatus', msg: `copied name: ${entry.name}` });
        },
      },
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
          try {
            await fm.trash([entry.path]);
            await refreshActive();
            dispatch({ type: 'setStatus', msg: `trashed ${entry.name}` });
          } catch (err) {
            dispatch({ type: 'setStatus', msg: formatOpError('trash', err) });
          }
        },
      },
    ];

    showContextMenu(e.clientX, e.clientY, items);
  }, []);

  if (!activeTab) return null;
  const tab = activeTab;
  const col = lastCol(tab);
  const cwd = tab.trail[col];
  const rawCount = state.entriesByPath[cwd]?.length ?? 0;
  const allEntries = visibleEntries(state.entriesByPath[cwd], tab);
  // fm-uns — tag-combination filter narrows the visible list. When the
  // filter is off, this is a no-op and entries === allEntries.
  const tagFilterActive =
    tab.tagFilter.mode !== 'off' && tab.tagFilter.ids.length > 0;
  const entries = tagFilterActive
    ? allEntries.filter((e) =>
        entryMatchesFilter(e, tab.tagFilter, state.customTags, state.tagPaths),
      )
    : allEntries;
  const emptyKind: EmptyKind | null =
    entries.length > 0
      ? null
      : tagFilterActive && allEntries.length > 0
        ? 'filtered-out'
        : rawCount > 0 && allEntries.length === 0
          ? 'all-hidden'
          : 'truly-empty';
  const selIdx = tab.selected[col] ?? 0;
  // Resolve active tag defs once per render so each row lookup is cheap.
  const vizTags = tab.tagViz
    .map((id) => findTag(id, state.customTags))
    .filter((t): t is NonNullable<typeof t> => !!t);

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

  // Drop into current cwd. Accepts both in-app drags (FileRow → other
  // tab → back into the same view) and external drops from Finder /
  // browser. External drops are forced to copy because we can't move
  // files out of the source app. In-app default is move, ⌥ toggles copy
  // — same convention as the sidebar/tab drop targets.
  const onCwdDragOver = (e: React.DragEvent) => {
    if (!dragHasAnyPaths(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isExternalDrop() ? 'copy' : e.altKey ? 'copy' : 'move';
  };
  const onCwdDrop = async (e: React.DragEvent) => {
    if (!dragHasAnyPaths(e)) return;
    e.preventDefault();
    let paths: string[];
    try {
      paths = resolveDropPaths(e);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[drop] resolve failed', err);
      store.dispatch({
        type: 'setStatus',
        msg: formatOpError('drop', err),
      });
      return;
    }
    const external = isExternalDrop();
    const srcCwd = currentDragSourceCwd();
    endAppDrag();
    if (paths.length === 0) return;
    const copy = external || e.altKey;
    const msg = await dropIntoFolder(paths, cwd, srcCwd, copy, fm).catch(
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[drop] fs:paste failed', { err, paths, dst: cwd, copy });
        return formatOpError('drop', err);
      },
    );
    if (msg) store.dispatch({ type: 'setStatus', msg });
    await store.refreshActive();
  };

  return (
    <div className="folder-list" onDragOver={onCwdDragOver} onDrop={onCwdDrop}>
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
        <div key={tab.viewMode} className="folder-list__body">
          {emptyKind ? (
            <FolderEmptyState kind={emptyKind} />
          ) : (
            <FileGrid
              entries={entries}
              selIdx={selIdx}
              activeColumn={true}
              marks={tab.marks}
              onSelect={selectAt}
              onOpen={doubleOpen}
              getDragPaths={getDragPaths}
              variant="grid"
            />
          )}
        </div>
      ) : (
        <ul key={tab.viewMode} className="folder-list__list folder-list__body" data-compact={tab.viewMode === 'preview' ? 'true' : undefined}>
          {emptyKind && (
            <li>
              <FolderEmptyState kind={emptyKind} />
            </li>
          )}
          {entries.map((e, j) => {
            const tagColors = vizTags
              .filter((t) => tagMatchesEntry(t, e, state.tagPaths[t.id]))
              .map((t) => t.color);
            return (
              <FileRow
                key={e.path}
                entry={e}
                index={j}
                selected={selIdx === j}
                activeColumn={true}
                marked={!!tab.marks[e.path]}
                tag={state.tags[e.path]}
                tagColors={tagColors.length > 0 ? tagColors : undefined}
                yanked={state.yank.some((y) => y.path === e.path)}
                onClick={selectAt}
                onDoubleClick={doubleOpen}
                onToggleMark={toggleMark}
                onContextMenu={onContextMenu}
                getDragPaths={getDragPaths}
                filter={tab.filter}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

// fm-n8s — ensure the scalable wrapper has the fade class. If the
// enclosing CSS ever grows complex, consider promoting this to its own
// <FolderListBody> component.
