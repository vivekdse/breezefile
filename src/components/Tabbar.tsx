import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { basename } from '../actions';
import { fm } from '../bridge';
import {
  currentDragSourceCwd,
  dragHasAnyPaths,
  dropIntoFolder,
  endAppDrag,
  isExternalDrop,
  resolveDropPaths,
} from '../dragState';
import { useTasks } from '../tasks';
import { useIsMac } from '../platform';
import { formatOpError } from '../errorMessages';
import type { Tab } from '../types';
import './Tabbar.css';

export function Tabbar() {
  const { state, dispatch, activeTab, refreshActive } = useStore();
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // fm-b6ki — drag-hover tab activation. While a drag is over an inactive
  // tab, arm a timer; when it fires, switch to that tab without ending the
  // drag so the user can drop into the destination's folder pane or terminal.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverIdx = useRef<number | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    hoverIdx.current = null;
  };
  useEffect(() => () => clearHoverTimer(), []);

  // fm-8by — task tab labels resolve via the task store. Pulling all tasks
  // (incl. done) keeps a tab whose task was completed from suddenly losing
  // its label. Cheap: the task list is small and already cached by useTasks.
  const { tasks } = useTasks({ includeDone: true });
  const taskById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, t.title);
    return m;
  }, [tasks]);

  const onNewTab = () => {
    const cwd = activeTab?.trail[activeTab.trail.length - 1];
    if (!cwd) return;
    dispatch({
      type: 'newTab',
      tab: {
        id: crypto.randomUUID(),
        kind: 'folder',
        taskId: null,
        trail: [cwd],
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
  };

  const onTabDragOver = (idx: number) => (e: React.DragEvent) => {
    if (!dragHasAnyPaths(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isExternalDrop() ? 'copy' : e.altKey ? 'copy' : 'move';
    setDropIdx(idx);
    // Arm hover-activation only for inactive tabs; re-arm if the user moves
    // to a different tab without leaving the tabbar.
    if (idx !== state.activeTab && hoverIdx.current !== idx) {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverIdx.current = idx;
      hoverTimer.current = setTimeout(() => {
        dispatch({ type: 'selectTab', index: idx });
        hoverTimer.current = null;
        hoverIdx.current = null;
      }, 600);
    }
  };
  const onTabDragLeave = () => {
    setDropIdx(null);
    clearHoverTimer();
  };
  const onTabDrop = (idx: number) => async (e: React.DragEvent) => {
    e.preventDefault();
    setDropIdx(null);
    clearHoverTimer();
    let paths: string[];
    try {
      paths = resolveDropPaths(e);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[drop] resolve failed', err);
      dispatch({
        type: 'setStatus',
        msg: formatOpError('drop', err),
      });
      return;
    }
    const external = isExternalDrop();
    const srcCwd = currentDragSourceCwd();
    endAppDrag();
    const tab = state.tabs[idx];
    if (!tab || paths.length === 0) return;
    const target = tab.trail[tab.trail.length - 1];
    const copy = external || e.altKey;
    const msg = await dropIntoFolder(paths, target, srcCwd, copy, fm).catch(
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[drop] fs:paste failed', { err, paths, dst: target, copy });
        return formatOpError('drop', err);
      },
    );
    if (msg) dispatch({ type: 'setStatus', msg });
    await refreshActive();
  };

  // fm-8by — partition tabs into two zones while preserving the original
  // index, because every dispatch (selectTab, closeTab) targets state.tabs
  // by absolute index. Known limit: drag-reorder works only within a zone;
  // cross-zone DnD is intentionally deferred.
  const folderTabs: Array<{ tab: Tab; index: number }> = [];
  const taskTabs: Array<{ tab: Tab; index: number }> = [];
  state.tabs.forEach((tab, index) => {
    // fm-yi85 — tasks-overview tab lives in the task zone too. The visual
    // grouping reads as "files on the left, task surfaces on the right",
    // and the All-tasks tab is the natural pivot point between those.
    if (tab.kind === 'task' || tab.kind === 'tasks' || tab.kind === 'projects')
      taskTabs.push({ tab, index });
    else folderTabs.push({ tab, index });
  });

  const isMac = useIsMac();
  const modKey = isMac ? '⌘' : 'Ctrl+';

  const renderTab = ({
    tab: t,
    index: i,
    pos,
  }: {
    tab: Tab;
    index: number;
    pos: number;
  }) => {
    const cwd = t.trail[t.trail.length - 1];
    const folderName = basename(cwd) || '/';
    const isTask = t.kind === 'task';
    const isTasksOverview = t.kind === 'tasks';
    const isProjects = t.kind === 'projects';
    const isEdit = t.kind === 'edit';
    const isBrowser = t.kind === 'browser'; // SPIKE (spike/playwright-cdp)
    // Defensive: a task tab without a resolvable id/title falls back to
    // the folder basename, then to the literal "Task" — never crash.
    // fm-yi85 — tasks-overview tab gets a fixed "All tasks" label.
    // fm-vu55 — edit tabs label by the file's basename.
    const editName = isEdit && t.editPath ? basename(t.editPath) : '';
    const label = isProjects
      ? 'Home'
      : isTasksOverview
      ? 'All tasks'
      : isBrowser
        ? 'Browser'
        : isEdit
          ? editName || 'Untitled'
          : isTask
            ? (t.taskId && taskById.get(t.taskId)) || folderName || 'Task'
            : folderName;
    const active = i === state.activeTab;
    const canClose = state.tabs.length > 1;
    const isDropTarget = dropIdx === i;
    // fm-4bs — attention class drives the full-tab green/red tint.
    const attn = t.terminal?.attention;
    const cls = [
      'tabbar__tab',
      isTasksOverview
        ? 'tabbar__tab--tasks-overview'
        : isTask
          ? 'tabbar__tab--task'
          : 'tabbar__tab--folder',
      active ? 'tabbar__tab--active' : '',
      isDropTarget ? 'tabbar__tab--drop' : '',
      attn ? `tabbar__tab--attn-${attn}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const titleSuffix =
      attn === 'busy'
        ? ' · terminal working…'
        : attn === 'idle'
          ? ' · terminal waiting for input'
          : attn === 'bell'
            ? ' · terminal alert'
            : '';
    const shortcutHint = pos <= 9 ? ` (${modKey}${pos})` : '';
    const baseTitle = isProjects
      ? 'Home' + shortcutHint
      : isTasksOverview
      ? 'All tasks' + shortcutHint
      : (isTask ? `${label} — ${cwd}` : cwd) + shortcutHint;
    return (
      <button
        key={t.id}
        className={cls}
        onClick={() => dispatch({ type: 'selectTab', index: i })}
        onDragOver={onTabDragOver(i)}
        onDragLeave={onTabDragLeave}
        onDrop={onTabDrop(i)}
        title={`${baseTitle}${titleSuffix}`}
      >
        {pos <= 9 && (
          <span className="tabbar__num" aria-hidden="true">
            {pos}
          </span>
        )}
        <span className="tabbar__label">
          {label}
          {isEdit && t.dirty ? ' •' : ''}
        </span>
        {/* fm-fux — attention badge layers on top of either kind. */}
        {t.terminal?.attention && (
          <span
            className={`tabbar__attn tabbar__attn--${t.terminal.attention}`}
            aria-label="terminal needs attention"
          />
        )}
        {canClose && (
          <span
            className="tabbar__close"
            onClick={(e) => {
              e.stopPropagation();
              // fm-jtu — kill the embedded terminal's pty before the
              // tab disappears, otherwise the shell stays alive in
              // the main process until window close.
              if (t.terminal) {
                void fm.termKill(t.terminal.ptyId).catch(() => {});
              }
              // fm-vu55 — warn before discarding unsaved editor changes.
              if (t.kind === 'edit' && t.dirty) {
                window.dispatchEvent(
                  new CustomEvent('fm:confirm', {
                    detail: {
                      title: 'Discard unsaved changes?',
                      body: `${basename(t.editPath ?? '')} has unsaved changes that will be lost.`,
                      confirmLabel: 'Discard',
                      destructive: true,
                      onConfirm: () => dispatch({ type: 'closeTab', index: i }),
                    },
                  }),
                );
                return;
              }
              dispatch({ type: 'closeTab', index: i });
            }}
          >
            ×
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="tabbar">
      <div className="tabbar__zone tabbar__zone--folder">
        {folderTabs.map((entry, n) => renderTab({ ...entry, pos: n + 1 }))}
        <button
          className="tabbar__new"
          onClick={onNewTab}
          title="New tab at current folder"
          aria-label="New tab"
        >
          +
        </button>
      </div>
      {taskTabs.length > 0 && (
        <>
          <div
            className="tabbar__divider"
            aria-hidden="true"
            role="presentation"
          />
          <div className="tabbar__zone tabbar__zone--task">
            {taskTabs.map((entry, n) =>
              renderTab({ ...entry, pos: folderTabs.length + n + 1 }),
            )}
          </div>
        </>
      )}
    </div>
  );
}
