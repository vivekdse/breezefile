// fm-7909 — Tasks overview, rebuilt around OWNER sections + one primary
// action per row. Container responsibilities: filter state, selection/cursor,
// keyboard, the fm:tasks:* verb listeners, the layout, and routing every
// mutation through the capability-aware useTaskActions hook (the old page
// called updateTask/deleteTask without task.source — the bug this fixes).
//
// fm-jw9m — decluttered top bar: filters collapse behind a Filter button
// (header action row, next to + New task) instead of an always-on row, and the
// Tasks/Runs toggle is gone — runs are reached per-task from the detail panel.
//
// Sections (pure, see sections.mjs):
//   FOR YOU    — manual local tasks you act on by hand
//   FOR AGENTS — TypeBuild + local auto-mode tasks
//   DONE       — terminal states, collapsed, capped at 50
//
// Keyboard model — motion + selection + snooze, no letter-as-verb:
//   ↑/↓ or j/k   move cursor
//   Space        toggle selection on cursor row
//   Shift+↑/↓    extend selection
//   Enter        open edit (manual) / open detail drawer (agent)
//   /            focus search
//   [ / ]        shift due ∓1 day (caps.canEdit rows only)
//   w            shift due +7 days (caps.canEdit rows only)
// Everything else is a verb in the chip prompt.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fm } from '../../bridge';
import { useStore } from '../../store';
import { spawnTerminal } from '../../terminalSpawn';
import {
  clearOverlaySchedule,
  setOverlaySchedule,
  todayISO,
  useOverlaySchedules,
  useRunCounts,
  useTaskSources,
  useTasks,
  useTypebuildReadiness,
  useLastRun,
} from '../../tasks';
import type { ConfirmRequest } from '../ConfirmDialog';
import { formatOpError } from '../../errorMessages';
import type { RemoteSchedule, Task, TaskStatus } from '../../types';
import { partitionTasks, resolveBlockedBy } from './sections.mjs';
import type { AgentRow } from './sections.mjs';
import { primaryActionFor } from './primaryAction.mjs';
import type { PrimaryAction } from './primaryAction.mjs';
import { useTaskActions } from './useTaskActions';
import { useRunningSessions } from './useRunningSessions';
import { TaskRow } from './TaskRow';
import { TaskDetailPanel } from './TaskDetailPanel';
import { RowKebabMenu, type KebabAction } from './RowKebabMenu';
import { ScheduleModal } from './ScheduleModal';
import { addDays, isoFromDate } from './helpers';
import '../TasksPage.css';

type SourceFilter = 'all' | 'typebuild';

function nextWeekday(targetDow: number): string {
  const d = new Date();
  const offset = (targetDow - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + offset);
  return isoFromDate(d);
}

function TasksPageInner() {
  const { state, dispatch } = useStore();
  const actions = useTaskActions();
  const { byId: sourcesById } = useTaskSources();
  const tbReady = useTypebuildReadiness();
  const myEmail = (tbReady as { email?: string | null }).email ?? null;
  const runCounts = useRunCounts();
  const overlayByKey = useOverlaySchedules();
  const sessions = useRunningSessions();

  const overlayFor = (t: Task): RemoteSchedule | undefined =>
    t.source ? overlayByKey[`${t.source}:${t.id}`] : undefined;
  const capsFor = (t: Task) =>
    t.source ? sourcesById[t.source]?.capabilities : undefined;

  // ── filter state ──────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  // fm-lji6 (S2) — "Mine" toggle. Server-backed for TypeBuild (threads
  // claimed_by=me into the list request); local tasks are unaffected.
  const [mineOnly, setMineOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  // fm-jw9m — filters are hidden behind a toggle now (the row was always-on
  // chrome). Open via the Filter button on the header action row. A non-default
  // filter (search / mine / done / source) is reflected on the button so the
  // user can tell filters are active even while the bar is collapsed.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [doneExpanded, setDoneExpanded] = useState(false);
  // fm-8yky — parent tasks whose child subtree is expanded. Collapsed by
  // default so a group reads as one row (with N/M done) until you drill in.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  // selection / cursor
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // inline due/start picker (opened via :due / :start verbs)
  const [datePicker, setDatePicker] = useState<{
    field: 'due_at' | 'start_at';
    value: string;
  } | null>(null);

  // per-row kebab anchor
  const [kebabFor, setKebabFor] = useState<{ task: Task; x: number; y: number } | null>(null);
  // schedule modal target
  const [scheduleFor, setScheduleFor] = useState<Task | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 150);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // Pull everything (incl. done) once; partition + filter client-side.
  // fm-lji6 (S2) — claimedByMe rides through to the TypeBuild source only
  // (server-backed ?claimed_by=me); the local source ignores the member, so
  // local rows stay unaffected by the toggle.
  const sqlFilter = useMemo(
    () => ({
      includeDone: true,
      search: search || undefined,
      claimedByMe: mineOnly || undefined,
    }),
    [search, mineOnly],
  );
  const { tasks: rawTasks, loading } = useTasks(sqlFilter);

  // Apply the source dropdown before partitioning.
  const sourceFiltered = useMemo(() => {
    if (sourceFilter === 'all') return rawTasks;
    // typebuild
    return rawTasks.filter((t) => t.source === 'typebuild');
  }, [rawTasks, sourceFilter]);

  const runningTaskIds = useMemo(() => new Set(sessions.keys()), [sessions]);
  const { forYou, forAgents, forAgentsRows, done, doneTotal } = useMemo(
    () => partitionTasks(sourceFiltered, { myEmail, runningTaskIds }),
    [sourceFiltered, myEmail, runningTaskIds],
  );

  // fm-bq86 (S3) — map a task id → its FOR AGENTS grouping annotation, so the
  // row render and primaryFor can pull depth / child-progress / the
  // parent-loses-Start readiness flag without re-deriving the grouping.
  const agentRowById = useMemo(() => {
    const m = new Map<string, AgentRow>();
    for (const r of forAgentsRows) m.set(r.task.id, r);
    return m;
  }, [forAgentsRows]);

  // fm-8yky — collapse child rows under parents that aren't expanded. A child
  // (depth 1) is hidden unless its parent id is in expandedParents. This
  // filtered list drives BOTH the render and flatOrder, so collapsed children
  // are also out of keyboard nav / selection scope (they can't be acted on
  // while hidden — expand to reach them).
  const visibleAgentRows = useMemo(
    () =>
      forAgentsRows.filter(
        (r) =>
          r.depth !== 1 ||
          (r.task.parentTaskId
            ? expandedParents.has(r.task.parentTaskId)
            : true),
      ),
    [forAgentsRows, expandedParents],
  );
  const visibleForAgents = useMemo(
    () => visibleAgentRows.map((r) => r.task),
    [visibleAgentRows],
  );
  function toggleExpand(parentId: string) {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  }

  const showDoneSection = showDone || doneExpanded;

  // Flat order across the visible sections — drives arrow nav + selection scope.
  const flatOrder = useMemo(() => {
    const out = [...forYou, ...visibleForAgents];
    if (showDoneSection) out.push(...done);
    return out;
  }, [forYou, visibleForAgents, done, showDoneSection]);

  // Drop selection ids no longer visible; re-anchor cursor.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(flatOrder.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (cursorId && !flatOrder.some((t) => t.id === cursorId)) {
      setCursorId(flatOrder[0]?.id ?? null);
    } else if (!cursorId && flatOrder.length > 0) {
      setCursorId(flatOrder[0].id);
    }
  }, [flatOrder, cursorId]);

  // ── target helpers (selection ∪ cursor) ──────────────────────────────────
  const targetIds = (): string[] => {
    if (selected.size > 0) return Array.from(selected);
    if (cursorId) return [cursorId];
    return [];
  };
  const targetTasks = (): Task[] => {
    const ids = new Set(targetIds());
    return flatOrder.filter((t) => ids.has(t.id));
  };

  function openEdit(task: Task) {
    window.dispatchEvent(new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }));
  }
  function openRuns(task: Task) {
    window.dispatchEvent(
      new CustomEvent('fm:openRunHistory', { detail: { taskId: task.id } }),
    );
  }
  // task-5e9d866a377f — open the full task detail DRAWER (Trace · Config ·
  // Session, Stop, Enter thread). Pass the task object so the drawer renders
  // without a refetch (the decrypted body is still lazy-loaded inside).
  // task-f60a8003efa9 — 'trace'/'session' are accepted for back-compat and map
  // onto the clubbed 'activity' tab inside the drawer; 'activity' is the new id.
  function openDetail(
    task: Task,
    initialTab?: 'trace' | 'config' | 'session' | 'activity',
  ) {
    window.dispatchEvent(
      new CustomEvent('fm:openTaskDetail', { detail: { task, initialTab } }),
    );
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

  // ── session-aware terminal open (manual / local-auto rows) ────────────────
  const stateRef = useRef(state);
  stateRef.current = state;
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

  // ── primary-action routing ────────────────────────────────────────────────
  function primaryFor(task: Task): PrimaryAction {
    const session = sessions.get(task.id);
    const lastRunRunning = false; // refined per-row via the hook below for auto
    // fm-bq86 (S3) — a parent with non-terminal children loses Start (server
    // won't hand out the container). The grouping computed it; pass it through.
    const hasOpenChildren = agentRowById.get(task.id)?.hasOpenChildren ?? false;
    return primaryActionFor(task, {
      caps: capsFor(task),
      tbReady,
      myEmail,
      session,
      lastRunRunning,
      hasOpenChildren,
    });
  }

  function invokePrimary(task: Task, action: PrimaryAction) {
    switch (action.kind) {
      case 'done-toggle':
        void actions.setStatus(task, 'done');
        break;
      case 'reopen':
        // local → pending; typebuild blocked → source reopen verb.
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
        openRuns(task);
        break;
      case 'none':
        break;
    }
  }

  // ── kebab routing ─────────────────────────────────────────────────────────
  function handleKebab(task: Task, action: KebabAction) {
    switch (action) {
      case 'edit':
        openEdit(task);
        break;
      case 'open-tab':
        rowOpenInTab(task);
        break;
      case 'open-terminal':
        void rowOpenTerminal(task);
        break;
      case 'mark-pending':
        void actions.setStatus(task, 'pending');
        break;
      case 'mark-in-progress':
        void actions.setStatus(task, 'in_progress');
        break;
      case 'mark-done':
        void actions.setStatus(task, 'done');
        break;
      case 'mark-cancelled':
        void actions.setStatus(task, 'cancelled');
        break;
      case 'pin':
        void actions.togglePin(task);
        break;
      case 'goto-folder':
        rowGotoFolder(task);
        break;
      case 'due-today':
        void actions.setDue(task, todayISO());
        break;
      case 'due-tomorrow':
        void actions.setDue(task, addDays(todayISO(), 1));
        break;
      case 'due-friday':
        void actions.setDue(task, nextWeekday(5));
        break;
      case 'due-next-week':
        void actions.setDue(task, addDays(todayISO(), 7));
        break;
      case 'due-clear':
        void actions.setDue(task, null);
        break;
      case 'schedule':
        setScheduleFor(task);
        break;
      case 'release':
        void actions.sourceAction(task, 'release');
        break;
      case 'complete':
        void actions.sourceAction(task, 'complete');
        break;
      // fm-alfz (S1) — TypeBuild cancel / reopen via the v2 PATCH verb.
      case 'tb-cancel':
        void actions.sourceAction(task, 'cancel');
        break;
      case 'tb-reopen':
        void actions.sourceAction(task, 'reopen');
        break;
      case 'delete':
        confirmDelete([task]);
        break;
    }
  }

  function confirmDelete(tasks: Task[]) {
    if (tasks.length === 0) return;
    const req: ConfirmRequest = {
      title:
        tasks.length === 1
          ? `Delete "${tasks[0].title}"?`
          : `Delete ${tasks.length} tasks?`,
      body: 'This cannot be undone. The folders themselves are not touched.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await actions.bulkDelete(tasks);
        setSelected(new Set());
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }

  // ── schedule overlay save/clear ───────────────────────────────────────────
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

  // ── snooze (keyboard [ / ] / w) ───────────────────────────────────────────
  async function shiftDue(days: number) {
    const tasks = targetTasks().filter((t) => {
      const caps = capsFor(t);
      return caps ? caps.canEdit : true;
    });
    if (tasks.length === 0) {
      dispatch({ type: 'setStatus', msg: 'no editable task targeted' });
      return;
    }
    const today = todayISO();
    await Promise.all(
      tasks.map((t) => {
        const base = t.due_at ?? today;
        return actions.patch(t, { due_at: addDays(base, days) });
      }),
    );
    const sign = days > 0 ? '+' : '';
    dispatch({
      type: 'setStatus',
      msg:
        tasks.length === 1
          ? `due ${sign}${days}d · ${tasks[0].title}`
          : `due ${sign}${days}d · ${tasks.length} tasks`,
    });
  }

  // ── selection mechanics ───────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function rowClick(e: React.MouseEvent, task: Task) {
    if (e.shiftKey && lastSelectedRef.current) {
      e.preventDefault();
      const ids = flatOrder.map((t) => t.id);
      const a = ids.indexOf(lastSelectedRef.current);
      const b = ids.indexOf(task.id);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(ids[i]);
        return next;
      });
      setCursorId(task.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSelect(task.id);
      lastSelectedRef.current = task.id;
      setCursorId(task.id);
      return;
    }
    // Plain click selects the cursor (does NOT open edit — that's Enter /
    // double-click, so a click-to-inspect doesn't yank focus into a dialog).
    lastSelectedRef.current = task.id;
    setCursorId(task.id);
  }
  function rowActivate(task: Task) {
    // Enter / double-click. Manual → edit dialog; agent (read-only) → open the
    // full detail DRAWER (Trace · Config · Session, Stop, Enter thread).
    const caps = capsFor(task);
    if (caps ? caps.canEdit : true) openEdit(task);
    else openDetail(task);
  }
  function moveCursor(delta: number, extend: boolean) {
    if (flatOrder.length === 0) return;
    const idx = cursorId ? flatOrder.findIndex((t) => t.id === cursorId) : -1;
    const nextIdx = Math.max(0, Math.min(flatOrder.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextTask = flatOrder[nextIdx];
    if (extend && cursorId) {
      const a = idx < 0 ? 0 : idx;
      const [lo, hi] = a < nextIdx ? [a, nextIdx] : [nextIdx, a];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(flatOrder[i].id);
        return next;
      });
    }
    setCursorId(nextTask.id);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-task-id="${nextTask.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  // fm-7909 — focus a specific task (sidebar click on a TypeBuild row, or the
  // sidebar context menu "Open session"). Move the cursor there + clear any
  // multi-selection so the detail panel shows it. Listens regardless of the
  // active-tab gate so it works the same tick the Tasks tab opens.
  useEffect(() => {
    function onFocus(e: Event) {
      const id = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!id) return;
      setSelected(new Set());
      setCursorId(id);
      requestAnimationFrame(() => {
        listRef.current
          ?.querySelector(`[data-task-id="${id}"]`)
          ?.scrollIntoView({ block: 'center' });
      });
    }
    window.addEventListener('fm:tasks:focus', onFocus);
    return () => window.removeEventListener('fm:tasks:focus', onFocus);
  }, []);

  // fm-lji6 (S2) — surface per-source list failures in the status line. A
  // dead/transient source (notably TypeBuild's 30s poll) used to vanish into
  // the main-process log; show it once per failure burst and dedupe by
  // source+message until the source recovers (a successful tasks:changed
  // clears the seen set so a later failure surfaces again). PHI-free.
  const sourceErrSeenRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const offErr = fm.onTaskSourceError(({ source, message }) => {
      const prev = sourceErrSeenRef.current.get(source);
      if (prev === message) return; // already announced this burst
      sourceErrSeenRef.current.set(source, message);
      const label = source === 'typebuild' ? 'TypeBuild' : source;
      dispatch({
        type: 'setStatus',
        msg: `tasks from ${label} unavailable: ${message}`,
      });
    });
    // A successful list refresh means the source recovered — forget the seen
    // messages so a NEW failure later still announces itself.
    const offOk = fm.onTasksChanged(() => sourceErrSeenRef.current.clear());
    return () => {
      offErr();
      offOk();
    };
  }, [dispatch]);

  // ── verb event listeners (fm:tasks:*) — routed via bulkPatch ──────────────
  const isActive = state.tabs[state.activeTab]?.kind === 'tasks';

  useEffect(() => {
    if (!isActive) return;

    async function applyToTargets(patch: Record<string, unknown>, verb: string) {
      const tasks = targetTasks();
      if (tasks.length === 0) {
        dispatch({ type: 'setStatus', msg: 'no task targeted' });
        return;
      }
      await actions.bulkPatch(tasks, patch as never, verb);
      setSelected(new Set());
    }

    const handlers: Record<string, (detail?: unknown) => void | Promise<void>> = {
      'fm:tasks:done': () => applyToTargets({ status: 'done' as TaskStatus }, 'marked done'),
      'fm:tasks:reopen': () => applyToTargets({ status: 'pending' as TaskStatus }, 'reopened'),
      'fm:tasks:in-progress': () =>
        applyToTargets({ status: 'in_progress' as TaskStatus }, 'set in-progress'),
      'fm:tasks:cancel': () => applyToTargets({ status: 'cancelled' as TaskStatus }, 'cancelled'),
      'fm:tasks:pin': () => applyToTargets({ pinned: true }, 'pinned'),
      'fm:tasks:unpin': () => applyToTargets({ pinned: false }, 'unpinned'),
      'fm:tasks:due': (detail) => {
        const v = (detail as { value?: string } | undefined)?.value;
        if (v === undefined) {
          setDatePicker({ field: 'due_at', value: todayISO() });
          return;
        }
        return applyToTargets(
          { due_at: v === '' ? null : v },
          v === '' ? 'cleared due' : `set due ${v}`,
        );
      },
      'fm:tasks:start': (detail) => {
        const v = (detail as { value?: string } | undefined)?.value;
        if (v === undefined) {
          setDatePicker({ field: 'start_at', value: todayISO() });
          return;
        }
        return applyToTargets(
          { start_at: v === '' ? null : v },
          v === '' ? 'cleared start' : `set start ${v}`,
        );
      },
      'fm:tasks:delete': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) {
          dispatch({ type: 'setStatus', msg: 'no task targeted' });
          return;
        }
        confirmDelete(tasks);
      },
      'fm:tasks:edit': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) {
          dispatch({ type: 'setStatus', msg: 'no task targeted' });
          return;
        }
        if (tasks.length > 1) {
          dispatch({
            type: 'setStatus',
            msg: `editing first of ${tasks.length} — edit dialog is single-task`,
          });
        }
        openEdit(tasks[0]);
      },
      'fm:tasks:goto-folder': () => {
        for (const t of targetTasks()) rowGotoFolder(t);
      },
      // task-5e9d866a377f — open the detail DRAWER for the targeted task
      // (single target; the drawer is a per-task view, not a bulk op). Resolve
      // the cursor row directly so this doesn't depend on the later-declared
      // detailTask memo.
      'fm:tasks:open-detail': (detail?: unknown) => {
        const ids = new Set(targetIds());
        const t =
          (ids.size === 1
            ? flatOrder.find((x) => ids.has(x.id))
            : cursorId
              ? flatOrder.find((x) => x.id === cursorId)
              : null) ?? null;
        if (!t) {
          dispatch({ type: 'setStatus', msg: 'no task targeted' });
          return;
        }
        const initialTab = (
          detail as { initialTab?: 'trace' | 'config' | 'session' | 'activity' } | undefined
        )?.initialTab;
        openDetail(t, initialTab);
      },
      'fm:tasks:open': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) return;
        for (const t of tasks) {
          dispatch({ type: 'openTaskTab', taskId: t.id, folder: t.folder, focus: false });
        }
        const last = tasks[tasks.length - 1];
        dispatch({ type: 'openTaskTab', taskId: last.id, folder: last.folder });
      },
      'fm:tasks:terminal': async () => {
        const tasks = targetTasks();
        for (const t of tasks) await rowOpenTerminal(t);
      },
      'fm:tasks:group': () => {
        // fm-7909 — grouping is now by owner; the verb is retired.
        dispatch({ type: 'setStatus', msg: 'tasks are grouped by owner now' });
      },
      'fm:tasks:sort': () => {
        // FOR YOU sort is fixed (pinned · due · created). Keep the verb a no-op
        // with a hint rather than surfacing a stale control.
        dispatch({ type: 'setStatus', msg: 'FOR YOU sorts by pinned · due · created' });
      },
      'fm:tasks:filter': (detail) => {
        // Map the legacy derived-view verb onto the source dropdown / show-done
        // where it still makes sense; otherwise hint.
        const v = (detail as { value?: string } | undefined)?.value;
        if (v === 'overdue' || v === 'this_week' || v === 'all') {
          dispatch({ type: 'setStatus', msg: 'use the digest chips to scope by due date' });
        }
      },
      'fm:tasks:show-completed': () => setShowDone(true),
      'fm:tasks:hide-completed': () => setShowDone(false),
      'fm:tasks:select': (detail) => {
        const what = (detail as { what?: string } | undefined)?.what;
        if (!what) return;
        if (what === 'all') setSelected(new Set(flatOrder.map((t) => t.id)));
        else if (what === 'none') setSelected(new Set());
        else if (what === 'overdue') {
          const today = todayISO();
          setSelected(
            new Set(
              flatOrder
                .filter(
                  (t) =>
                    t.due_at &&
                    t.due_at < today &&
                    t.status !== 'done' &&
                    t.status !== 'cancelled',
                )
                .map((t) => t.id),
            ),
          );
        } else if (what === 'pinned') {
          setSelected(new Set(flatOrder.filter((t) => t.pinned).map((t) => t.id)));
        } else if (what === 'invert') {
          const next = new Set<string>();
          for (const t of flatOrder) if (!selected.has(t.id)) next.add(t.id);
          setSelected(next);
        }
      },
    };

    const wrapped: Array<[string, EventListener]> = Object.entries(handlers).map(
      ([name, fn]) => [name, (e) => void fn((e as CustomEvent).detail)],
    );
    for (const [name, fn] of wrapped) window.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of wrapped) window.removeEventListener(name, fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, flatOrder, selected, cursorId, dispatch, actions]);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (e.key === '/' && !inField) {
        e.preventDefault();
        // fm-jw9m — filters are collapsed by default; "/" opens the bar (if
        // closed) and focuses search on the next tick once it's mounted.
        setFiltersOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // fm-8yky — ":" opens command mode so the chip-prompt verbs (:done, :due,
      // :delete, …) act on the current selection. The global useKeyboard
      // handler bails out for non-folder tabs (tab.kind !== 'folder'), so the
      // Tasks page has to wire its own ":" — without this, the "press : to act"
      // hint on a multi-selection did nothing.
      if (e.key === ':') {
        e.preventDefault();
        dispatch({ type: 'setMode', mode: 'command', buffer: '' });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveCursor(1, e.shiftKey);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveCursor(-1, e.shiftKey);
      } else if (e.key === ' ' && cursorId) {
        e.preventDefault();
        toggleSelect(cursorId);
        lastSelectedRef.current = cursorId;
      } else if (e.key === 'Enter' && cursorId) {
        e.preventDefault();
        const t = flatOrder.find((x) => x.id === cursorId);
        if (t) rowActivate(t);
      } else if (e.key === '[') {
        e.preventDefault();
        void shiftDue(-1);
      } else if (e.key === ']') {
        e.preventDefault();
        void shiftDue(1);
      } else if (e.key === 'w') {
        e.preventDefault();
        void shiftDue(7);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, flatOrder, cursorId]);

  // ── header digest (scoped to FOR YOU) ─────────────────────────────────────
  const digest = useMemo(() => {
    const today = todayISO();
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const week = isoFromDate(d);
    let overdue = 0;
    let dueWeek = 0;
    for (const t of forYou) {
      if (t.due_at && t.due_at < today) overdue++;
      else if (t.due_at && t.due_at <= week) dueWeek++;
    }
    return { overdue, dueWeek };
  }, [forYou]);

  // detail panel target
  const detailTask = useMemo<Task | null>(() => {
    if (selected.size === 1) {
      const [only] = Array.from(selected);
      const t = flatOrder.find((x) => x.id === only);
      if (t) return t;
    }
    if (cursorId) return flatOrder.find((t) => t.id === cursorId) ?? null;
    return null;
  }, [selected, cursorId, flatOrder]);

  const total = forYou.length + forAgents.length;
  const empty = !loading && total === 0 && doneTotal === 0;

  // fm-jw9m — is any filter scoped away from its default? Drives the dot on the
  // collapsed Filter button so active scoping is never invisible.
  const filtersActive =
    search.trim() !== '' || mineOnly || showDone || sourceFilter !== 'all';

  return (
    <div className="tasks tasks--inline">
      <header className="tasks__head">
        <h1 className="tasks__title">
          Tasks
          <span className="tasks__count">{total}</span>
        </h1>
        <div className="tasks__digest" role="group" aria-label="Task digest">
          {digest.overdue > 0 && (
            <button
              type="button"
              className="tasks__digest-chip tasks__digest-chip--overdue"
              onClick={() => {
                const today = todayISO();
                setSelected(
                  new Set(
                    forYou
                      .filter((t) => t.due_at && t.due_at < today)
                      .map((t) => t.id),
                  ),
                );
              }}
              title="Select overdue tasks"
            >
              {digest.overdue} overdue
            </button>
          )}
          {digest.dueWeek > 0 && (
            <span className="tasks__digest-chip" title="Due within 7 days (FOR YOU)">
              {digest.dueWeek} due this week
            </span>
          )}
          {digest.overdue === 0 && digest.dueWeek === 0 && (
            <span className="tasks__digest-clear">Nothing pressing.</span>
          )}
        </div>
        <div className="tasks__head-actions">
          {/* fm-jw9m — Filter toggle. Filters live behind this button now
              rather than as an always-on row. The dot marks a non-default
              filter so the user knows scoping is active while it's collapsed. */}
          <button
            type="button"
            className={['tasks__btn tasks__btn--ghost', filtersOpen && 'tasks__btn--on']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
            title="Show search and filters"
          >
            <span aria-hidden="true">⫶⫶</span> Filter
            {filtersActive && <span className="tasks__filter-dot" aria-label="filters active" />}
          </button>
          <button
            type="button"
            className="tasks__btn"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('fm:openTask', { detail: { mode: 'create', defaultFolder: '' } }),
              )
            }
            title="Create a new task"
          >
            + New task
          </button>
        </div>
      </header>

      {/* fm-jw9m — runs are reached per-task (detail panel → run history), so
          the page no longer carries a Tasks/Runs toggle. The body is always the
          task list. */}
      <>
          {/* fm-jw9m — filters collapsed behind the header Filter button.
              fm-7909 — a single filter row replaced the old three chip rows. */}
          {filtersOpen && (
          <div className="tasks__filterbar">
            <input
              ref={searchInputRef}
              type="text"
              className="tasks__input"
              placeholder="Search title or notes…    ( / to focus )"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              spellCheck={false}
            />
            <label className="tasks__toggle">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />
              <span>Show done</span>
            </label>
            {/* fm-lji6 (S2) — "Mine": server-backed claimed_by=me for TypeBuild
                rows; local tasks are unaffected. */}
            <label
              className="tasks__toggle"
              title="Show only TypeBuild tasks you’ve claimed (local tasks unaffected)"
            >
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
              />
              <span>Mine</span>
            </label>
            <select
              className="tasks__select"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
              aria-label="Filter by source"
            >
              <option value="all">All sources</option>
              <option value="typebuild">TypeBuild</option>
            </select>
            <span className="tasks__filter-spacer" />
            {selected.size > 0 && (
              <span className="tasks__filterbar-sel">
                {selected.size} selected · type <kbd>:</kbd> for actions
              </span>
            )}
          </div>
          )}

          {datePicker && (
            <div className="tasks__datebar" role="dialog" aria-label="Set date">
              <span>
                Set <b>{datePicker.field === 'due_at' ? 'due' : 'start'}</b> on{' '}
                {targetIds().length} task{targetIds().length === 1 ? '' : 's'}:
              </span>
              <input
                type="date"
                autoFocus
                value={datePicker.value}
                onChange={(e) => setDatePicker({ ...datePicker, value: e.target.value })}
              />
              <button
                type="button"
                className="tasks__btn"
                onClick={async () => {
                  const tasks = targetTasks();
                  if (tasks.length === 0 || !datePicker.value) {
                    setDatePicker(null);
                    return;
                  }
                  await actions.bulkPatch(
                    tasks,
                    { [datePicker.field]: datePicker.value } as never,
                    `set ${datePicker.field === 'due_at' ? 'due' : 'start'} ${datePicker.value}`,
                  );
                  setDatePicker(null);
                  setSelected(new Set());
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="tasks__btn tasks__btn--ghost"
                onClick={async () => {
                  const tasks = targetTasks();
                  if (tasks.length === 0) {
                    setDatePicker(null);
                    return;
                  }
                  await actions.bulkPatch(
                    tasks,
                    { [datePicker.field]: null } as never,
                    `cleared ${datePicker.field === 'due_at' ? 'due' : 'start'}`,
                  );
                  setDatePicker(null);
                  setSelected(new Set());
                }}
              >
                Clear
              </button>
              <button
                type="button"
                className="tasks__btn tasks__btn--ghost"
                onClick={() => setDatePicker(null)}
              >
                Cancel
              </button>
            </div>
          )}

          <div className="tasks__split">
            <div className="tasks__list" role="list" ref={listRef}>
              {empty && (
                <div className="tasks__empty">
                  <div className="tasks__empty-glyph">✓</div>
                  <div className="tasks__empty-title">No tasks yet</div>
                  <div className="tasks__empty-body">
                    Type <kbd>:task</kbd> to add one — or use <b>+ New task</b>.
                  </div>
                </div>
              )}

              {!empty && (
                <>
                  <Section
                    title="For you"
                    hint="Manual tasks you act on by hand"
                    tasks={forYou}
                    emptyNote="Nothing on your plate."
                    today={todayISO()}
                    myEmail={myEmail}
                    primaryFor={primaryFor}
                    overlayFor={overlayFor}
                    runCounts={runCounts}
                    selected={selected}
                    cursorId={cursorId}
                    onCheckbox={(t) => {
                      toggleSelect(t.id);
                      lastSelectedRef.current = t.id;
                      setCursorId(t.id);
                    }}
                    onRowClick={rowClick}
                    onActivate={rowActivate}
                    onPrimary={invokePrimary}
                    onKebab={(t, x, y) => setKebabFor({ task: t, x, y })}
                    onOpenRuns={openRuns}
                  />
                  <Section
                    title="For agents"
                    hint="TypeBuild + auto-execute tasks"
                    tasks={visibleForAgents}
                    rows={visibleAgentRows}
                    blockedByFor={(t) => resolveBlockedBy(t.blockedBy, rawTasks)}
                    emptyNote="No agent work queued."
                    today={todayISO()}
                    myEmail={myEmail}
                    primaryFor={primaryFor}
                    overlayFor={overlayFor}
                    runCounts={runCounts}
                    selected={selected}
                    cursorId={cursorId}
                    expandedParents={expandedParents}
                    onToggleExpand={toggleExpand}
                    onCheckbox={(t) => {
                      toggleSelect(t.id);
                      lastSelectedRef.current = t.id;
                      setCursorId(t.id);
                    }}
                    onRowClick={rowClick}
                    onActivate={rowActivate}
                    onPrimary={invokePrimary}
                    onKebab={(t, x, y) => setKebabFor({ task: t, x, y })}
                    onOpenRuns={openRuns}
                  />

                  {doneTotal > 0 && (
                    <div className="tasks__section">
                      <button
                        type="button"
                        className="tasks__section-head tasks__section-head--toggle"
                        onClick={() => setDoneExpanded((v) => !v)}
                        aria-expanded={showDoneSection}
                      >
                        <span className="tasks__section-disclosure">
                          {showDoneSection ? '▾' : '▸'}
                        </span>
                        <span className="tasks__section-title">Done</span>
                        <span className="tasks__section-count">{doneTotal}</span>
                      </button>
                      {showDoneSection &&
                        done.map((t) => (
                          <TaskRow
                            key={t.id}
                            task={t}
                            today={todayISO()}
                            primary={primaryFor(t)}
                            schedule={overlayFor(t)}
                            runCount={runCounts[t.id] ?? 0}
                            selected={selected.has(t.id)}
                            cursor={cursorId === t.id}
                            myEmail={myEmail}
                            onCheckbox={() => {
                              toggleSelect(t.id);
                              lastSelectedRef.current = t.id;
                              setCursorId(t.id);
                            }}
                            onClick={(e) => rowClick(e, t)}
                            onDoubleClick={() => rowActivate(t)}
                            onPrimary={(a) => invokePrimary(t, a)}
                            onKebab={(x, y) => setKebabFor({ task: t, x, y })}
                            onOpenRuns={() => openRuns(t)}
                          />
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <TaskDetailPanel
              task={detailTask}
              caps={detailTask ? capsFor(detailTask) : undefined}
              primary={detailTask ? primaryFor(detailTask) : null}
              myEmail={myEmail}
              selectedCount={selected.size}
              onPrimary={(a) => detailTask && invokePrimary(detailTask, a)}
              onEdit={() => detailTask && openEdit(detailTask)}
              onOpenInTab={() => detailTask && rowOpenInTab(detailTask)}
              onOpenTerminal={() => detailTask && void rowOpenTerminal(detailTask)}
              onGotoFolder={() => detailTask && rowGotoFolder(detailTask)}
              onSetStatus={(s) => detailTask && void actions.setStatus(detailTask, s)}
              onTogglePin={() => detailTask && void actions.togglePin(detailTask)}
              onDelete={() => detailTask && confirmDelete([detailTask])}
              onSourceAction={(act) => detailTask && void actions.sourceAction(detailTask, act)}
              onOpenRuns={() => detailTask && openRuns(detailTask)}
              onOpenDetail={(tab) => detailTask && openDetail(detailTask, tab)}
            />
          </div>
      </>

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
    </div>
  );
}

// ── a single owner section ──────────────────────────────────────────────────
function Section({
  title,
  hint,
  tasks,
  rows,
  blockedByFor,
  emptyNote,
  today,
  myEmail,
  primaryFor,
  overlayFor,
  runCounts,
  selected,
  cursorId,
  expandedParents,
  onToggleExpand,
  onCheckbox,
  onRowClick,
  onActivate,
  onPrimary,
  onKebab,
  onOpenRuns,
}: {
  title: string;
  hint: string;
  tasks: Task[];
  // fm-bq86 (S3) — annotated FOR AGENTS rows (parent/child grouping). When
  // present they drive rendering (indent + child-progress); FOR YOU passes
  // plain `tasks` only and falls back to depth-0 rows.
  rows?: AgentRow[];
  blockedByFor?: (t: Task) => string[];
  emptyNote: string;
  today: string;
  myEmail: string | null;
  primaryFor: (t: Task) => PrimaryAction;
  overlayFor: (t: Task) => RemoteSchedule | undefined;
  runCounts: Record<string, number>;
  selected: Set<string>;
  cursorId: string | null;
  // fm-8yky — parent expansion state + toggle (FOR AGENTS only; undefined for
  // the flat FOR YOU section).
  expandedParents?: Set<string>;
  onToggleExpand?: (parentId: string) => void;
  onCheckbox: (t: Task) => void;
  onRowClick: (e: React.MouseEvent, t: Task) => void;
  onActivate: (t: Task) => void;
  onPrimary: (t: Task, a: PrimaryAction) => void;
  onKebab: (t: Task, x: number, y: number) => void;
  onOpenRuns: (t: Task) => void;
}) {
  // fm-bq86 (S3) — normalize to AgentRow[] so a single render path covers both
  // the flat FOR YOU section and the grouped FOR AGENTS section.
  const renderRows: AgentRow[] = rows ?? tasks.map((t) => ({ task: t, depth: 0 }));
  return (
    <div className="tasks__section">
      <div className="tasks__section-head">
        <span className="tasks__section-title">{title}</span>
        <span className="tasks__section-count">{tasks.length}</span>
        <span className="tasks__section-hint">{hint}</span>
      </div>
      {renderRows.length === 0 ? (
        <div className="tasks__section-empty">{emptyNote}</div>
      ) : (
        renderRows.map((row) => {
          const t = row.task;
          // fm-7909 — refine the auto-mode "run in flight" signal per row via
          // the live last-run hook; pure primaryActionFor handles the rest.
          return (
            <AutoAwareRow
              key={t.id}
              task={t}
              today={today}
              basePrimary={primaryFor(t)}
              schedule={overlayFor(t)}
              runCount={runCounts[t.id] ?? 0}
              selected={selected.has(t.id)}
              cursor={cursorId === t.id}
              myEmail={myEmail}
              depth={row.depth}
              childCount={row.childCount}
              doneChildCount={row.doneChildCount}
              visibleChildCount={row.visibleChildCount}
              expanded={expandedParents?.has(t.id)}
              onToggleExpand={onToggleExpand ? () => onToggleExpand(t.id) : undefined}
              blockedByTitles={blockedByFor ? blockedByFor(t) : undefined}
              onCheckbox={() => onCheckbox(t)}
              onClick={(e) => onRowClick(e, t)}
              onDoubleClick={() => onActivate(t)}
              onPrimary={(a) => onPrimary(t, a)}
              onKebab={(x, y) => onKebab(t, x, y)}
              onOpenRuns={() => onOpenRuns(t)}
            />
          );
        })
      )}
    </div>
  );
}

// Wraps TaskRow so local-auto rows can subscribe to their last run and flip
// run-now → view-run while a run is in flight (the pure machine can't poll).
function AutoAwareRow({
  task,
  today,
  basePrimary,
  ...rest
}: {
  task: Task;
  today: string;
  basePrimary: PrimaryAction;
  schedule?: RemoteSchedule;
  runCount: number;
  selected: boolean;
  cursor: boolean;
  myEmail: string | null;
  depth?: 0 | 1;
  childCount?: number;
  doneChildCount?: number;
  visibleChildCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  blockedByTitles?: string[];
  onCheckbox: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onPrimary: (a: PrimaryAction) => void;
  onKebab: (x: number, y: number) => void;
  onOpenRuns: () => void;
}) {
  const isLocalAuto =
    (!task.source || task.source === 'local') && !!task.auto_mode;
  const lastRun = useLastRun(isLocalAuto ? task.id : null);
  let primary = basePrimary;
  if (isLocalAuto && basePrimary.kind === 'run-now') {
    const running = lastRun?.status === 'running' || lastRun?.status === 'queued';
    if (running) primary = { kind: 'view-run' };
  }
  return <TaskRow task={task} today={today} primary={primary} {...rest} />;
}

export function TasksPage() {
  return <TasksPageInner />;
}

export default TasksPage;
