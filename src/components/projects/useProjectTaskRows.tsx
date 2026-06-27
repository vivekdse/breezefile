// task-1bf3a297c9f9 — the per-row plumbing that lets a project render its tasks
// as FILES (real TaskRows) inside a ProjectFolderBlock, reusing the SAME engine
// as the flat TasksPage so the surfaces read as one app and never drift:
//   useTaskActions  — capability-aware mutations (status, due, pin, delete, …)
//   primaryActionFor — the one primary action per row (Start / Run / View …)
//   useRunCounts / useOverlaySchedules / useRunningSessions — row meta
//   RowKebabMenu / ScheduleModal — the per-row "more actions" + scheduler
//
// The hook returns `renderTaskRow(row)` (a thin TaskRow wrapper) plus the
// modal/menu overlays the host renders once. Selection/cursor live in the host
// (HomeSurface) so the keyboard model can span project headers + task rows.
//
// PHI: task titles render in-app for the operator (same contract as TasksPage);
// nothing here writes task text to disk/logs.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';
import { spawnTerminal } from '../../terminalSpawn';
import {
  clearOverlaySchedule,
  setOverlaySchedule,
  todayISO,
  useOverlaySchedules,
  useRunCounts,
  useTaskSources,
  useTypebuildReadiness,
} from '../../tasks';
import { formatOpError } from '../../errorMessages';
import type { ConfirmRequest } from '../ConfirmDialog';
import type { RemoteSchedule, Task } from '../../types';
import { primaryActionFor } from '../tasks/primaryAction.mjs';
import type { PrimaryAction } from '../tasks/primaryAction.mjs';
import { useTaskActions } from '../tasks/useTaskActions';
import { useRunningSessions } from '../tasks/useRunningSessions';
import { TaskRow } from '../tasks/TaskRow';
import { RowKebabMenu, type KebabAction } from '../tasks/RowKebabMenu';
import { ScheduleModal } from '../tasks/ScheduleModal';
import { addDays } from '../tasks/helpers';
import type { ProjectFolderRow } from './ProjectFolderBlock';
import '../TasksPage.css';

function nextWeekday(targetDow: number): string {
  const d = new Date();
  const offset = (targetDow - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export interface ProjectTaskRowState {
  /** Selected task ids (Space toggles via the host keyboard model). */
  selected: Set<string>;
  /** Cursor key (task id OR project id) — TaskRow lights when it matches. */
  cursorKey: string | null;
  /** Expanded parent task ids (parent rows collapse their children). */
  expanded: Set<string>;
}

export interface ProjectTaskRowHandlers {
  onRowClick: (e: React.MouseEvent, task: Task) => void;
  onToggleSelect: (taskId: string) => void;
  onSetCursor: (taskId: string) => void;
  onToggleExpand: (taskId: string) => void;
  /** Resolve titles of a task's blockers (renderer-memory only, PHI-safe). */
  blockedByTitles?: (task: Task) => string[];
}

/** A bulk verb the Home `:` palette can apply to the current task selection. */
export type ProjectBulkVerb =
  | 'done'
  | 'reopen'
  | 'cancel'
  | 'in-progress'
  | 'pin'
  | 'unpin'
  | 'delete';

/**
 * Bundles the task-row engine for project folder blocks. Returns:
 *  - `renderTaskRow(row)` — a fully-wired TaskRow for one ProjectFolderRow.
 *  - `overlays` — the kebab menu + schedule modal JSX (render once in host).
 *  - `bulkApply(verb, tasks)` — apply a `:` verb to a task selection (reuses
 *    the SAME capability-aware engine as TasksPage).
 */
export function useProjectTaskRows(
  state: ProjectTaskRowState,
  handlers: ProjectTaskRowHandlers,
): {
  renderTaskRow: (row: ProjectFolderRow) => ReactNode;
  overlays: ReactNode;
  bulkApply: (verb: ProjectBulkVerb, tasks: Task[]) => Promise<void>;
} {
  const { state: appState, dispatch } = useStore();
  const actions = useTaskActions();
  const { byId: sourcesById } = useTaskSources();
  const tbReady = useTypebuildReadiness();
  const myEmail = (tbReady as { email?: string | null }).email ?? null;
  const runCounts = useRunCounts();
  const overlayByKey = useOverlaySchedules();
  const sessions = useRunningSessions();

  const [kebabFor, setKebabFor] = useState<{ task: Task; x: number; y: number } | null>(null);
  const [scheduleFor, setScheduleFor] = useState<Task | null>(null);

  const overlayFor = (t: Task): RemoteSchedule | undefined =>
    t.source ? overlayByKey[`${t.source}:${t.id}`] : undefined;
  const capsFor = (t: Task) =>
    t.source ? sourcesById[t.source]?.capabilities : undefined;

  const stateRef = useRef(appState);
  stateRef.current = appState;

  function invokePrimary(task: Task, action: PrimaryAction) {
    switch (action.kind) {
      case 'done-toggle':
        void actions.setStatus(task, 'done');
        break;
      case 'reopen':
        if (task.source === 'typebuild') void actions.sourceAction(task, 'reopen');
        else void actions.setStatus(task, 'pending');
        break;
      case 'start':
      case 'run-now':
        void actions.start(task);
        break;
      case 'open-session':
        dispatch({ type: 'selectTab', index: action.tabIndex });
        break;
      case 'view-run':
        window.dispatchEvent(
          new CustomEvent('fm:openRunHistory', { detail: { taskId: task.id } }),
        );
        break;
      case 'none':
        break;
    }
  }

  function openEdit(task: Task) {
    window.dispatchEvent(new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }));
  }
  function openDetail(task: Task) {
    window.dispatchEvent(new CustomEvent('fm:openTaskDetail', { detail: { task } }));
  }
  function openRuns(task: Task) {
    window.dispatchEvent(new CustomEvent('fm:openRunHistory', { detail: { taskId: task.id } }));
  }
  function rowOpenInTab(task: Task) {
    dispatch({ type: 'openTaskTab', taskId: task.id, folder: task.folder });
  }
  function rowGotoFolder(task: Task) {
    if (!task.folder) return;
    dispatch({
      type: 'newTab',
      tab: {
        id: crypto.randomUUID(),
        kind: 'folder',
        taskId: null,
        trail: [task.folder],
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
  }
  async function rowOpenTerminal(task: Task) {
    const tabsSnapshot = stateRef.current.tabs.slice();
    const existing = tabsSnapshot.findIndex(
      (tt) => tt.kind === 'task' && tt.taskId === task.id,
    );
    const tabIndex = existing >= 0 ? existing : tabsSnapshot.length;
    dispatch({ type: 'openTaskTab', taskId: task.id, folder: task.folder });
    if (existing >= 0 && tabsSnapshot[existing].terminal) {
      dispatch({ type: 'setStatus', msg: 'terminal already open' });
      return;
    }
    try {
      const ptyId = await spawnTerminal({ cwd: task.folder, sessionLabel: task.title });
      dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: task.folder, taskId: task.id });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: formatOpError('terminal', e) });
    }
  }

  function rowActivate(task: Task) {
    const caps = capsFor(task);
    if (caps ? caps.canEdit : true) openEdit(task);
    else openDetail(task);
  }

  function confirmDelete(task: Task) {
    const req: ConfirmRequest = {
      title: `Delete "${task.title}"?`,
      body: 'This cannot be undone. The folders themselves are not touched.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await actions.bulkDelete([task]);
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }

  function handleKebab(task: Task, action: KebabAction) {
    switch (action) {
      case 'edit': openEdit(task); break;
      case 'open-tab': rowOpenInTab(task); break;
      case 'open-terminal': void rowOpenTerminal(task); break;
      case 'mark-pending': void actions.setStatus(task, 'pending'); break;
      case 'mark-in-progress': void actions.setStatus(task, 'in_progress'); break;
      case 'mark-done': void actions.setStatus(task, 'done'); break;
      case 'mark-cancelled': void actions.setStatus(task, 'cancelled'); break;
      case 'pin': void actions.togglePin(task); break;
      case 'goto-folder': rowGotoFolder(task); break;
      case 'due-today': void actions.setDue(task, todayISO()); break;
      case 'due-tomorrow': void actions.setDue(task, addDays(todayISO(), 1)); break;
      case 'due-friday': void actions.setDue(task, nextWeekday(5)); break;
      case 'due-next-week': void actions.setDue(task, addDays(todayISO(), 7)); break;
      case 'due-clear': void actions.setDue(task, null); break;
      case 'schedule': setScheduleFor(task); break;
      case 'release': void actions.sourceAction(task, 'release'); break;
      case 'complete': void actions.sourceAction(task, 'complete'); break;
      case 'tb-cancel': void actions.sourceAction(task, 'cancel'); break;
      case 'tb-reopen': void actions.sourceAction(task, 'reopen'); break;
      case 'delete': confirmDelete(task); break;
    }
  }

  async function saveSchedule(task: Task, cron: string) {
    if (!task.source) return;
    await setOverlaySchedule(task.source, task.id, cron);
    dispatch({ type: 'setStatus', msg: `scheduled · ${cron}` });
  }
  async function clearSchedule(task: Task) {
    if (!task.source) return;
    try {
      await clearOverlaySchedule(task.source, task.id);
      dispatch({ type: 'setStatus', msg: 'schedule cleared' });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: formatOpError('clear schedule', e) });
    }
  }

  const renderTaskRow = useMemo(
    () => (row: ProjectFolderRow): ReactNode => {
      const t = row.task;
      const isParent = row.childCount > 0;
      const hasOpenChildren = isParent && row.doneChildCount < row.childCount;
      // primaryActionFor wants the open-children flag; recompute with it.
      const base = primaryActionFor(t, {
        caps: capsFor(t),
        tbReady,
        myEmail,
        session: sessions.get(t.id),
        lastRunRunning: false,
        hasOpenChildren,
      });
      return (
        <TaskRow
          key={t.id}
          task={t}
          today={todayISO()}
          primary={base}
          schedule={overlayFor(t)}
          runCount={runCounts[t.id] ?? 0}
          selected={state.selected.has(t.id)}
          cursor={state.cursorKey === t.id}
          myEmail={myEmail}
          depth={row.depth}
          childCount={isParent ? row.childCount : undefined}
          doneChildCount={isParent ? row.doneChildCount : undefined}
          visibleChildCount={isParent ? row.childCount : undefined}
          expanded={state.expanded.has(t.id)}
          onToggleExpand={isParent ? () => handlers.onToggleExpand(t.id) : undefined}
          blockedByTitles={handlers.blockedByTitles?.(t)}
          onCheckbox={() => handlers.onToggleSelect(t.id)}
          onClick={(e) => handlers.onRowClick(e, t)}
          onDoubleClick={() => rowActivate(t)}
          onPrimary={(a) => invokePrimary(t, a)}
          onKebab={(x, y) => setKebabFor({ task: t, x, y })}
          onOpenRuns={() => openRuns(t)}
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.selected, state.cursorKey, state.expanded, runCounts, overlayByKey, sessions, sourcesById, tbReady, myEmail, handlers],
  );

  // `:` palette → selection. Reuses the same capability-aware bulk engine as
  // TasksPage (actions.bulkPatch partitions by capability + reports skips).
  async function bulkApply(verb: ProjectBulkVerb, tasks: Task[]): Promise<void> {
    if (tasks.length === 0) {
      dispatch({ type: 'setStatus', msg: 'no task selected' });
      return;
    }
    switch (verb) {
      case 'done':
        await actions.bulkPatch(tasks, { status: 'done' }, 'marked done');
        break;
      case 'reopen':
        await actions.bulkPatch(tasks, { status: 'pending' }, 'reopened');
        break;
      case 'cancel':
        await actions.bulkPatch(tasks, { status: 'cancelled' }, 'cancelled');
        break;
      case 'in-progress':
        await actions.bulkPatch(tasks, { status: 'in_progress' }, 'set in-progress');
        break;
      case 'pin':
        await actions.bulkPatch(tasks, { pinned: true }, 'pinned');
        break;
      case 'unpin':
        await actions.bulkPatch(tasks, { pinned: false }, 'unpinned');
        break;
      case 'delete': {
        const req: ConfirmRequest = {
          title: tasks.length === 1 ? `Delete "${tasks[0].title}"?` : `Delete ${tasks.length} tasks?`,
          body: 'This cannot be undone. The folders themselves are not touched.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: async () => {
            await actions.bulkDelete(tasks);
          },
        };
        window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
        break;
      }
    }
  }

  const overlays = (
    <>
      {kebabFor && (
        <RowKebabMenu
          task={kebabFor.task}
          caps={capsFor(kebabFor.task)}
          schedule={overlayFor(kebabFor.task)}
          myEmail={myEmail}
          x={kebabFor.x}
          y={kebabFor.y}
          onClose={() => setKebabFor(null)}
          onAction={(action) => {
            const t = kebabFor.task;
            setKebabFor(null);
            handleKebab(t, action);
          }}
        />
      )}
      {scheduleFor && (
        <ScheduleModal
          task={scheduleFor}
          current={overlayFor(scheduleFor)}
          onClose={() => setScheduleFor(null)}
          onSave={async (cron) => {
            await saveSchedule(scheduleFor, cron);
            setScheduleFor(null);
          }}
          onClear={async () => {
            await clearSchedule(scheduleFor);
            setScheduleFor(null);
          }}
        />
      )}
    </>
  );

  return { renderTaskRow, overlays, bulkApply };
}
