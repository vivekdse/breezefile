// fm-yi85 — Tasks overview, rendered inline as a singleton tab (kind='tasks').
//
// Why inline (was modal kaa): the modal divorced tasks from the chip
// prompt and side panels. Inline puts tasks on the same footing as folder
// tabs: the prompt is right there, side panels stay visible, filters
// persist while the user pivots. The ChipPrompt fires `fm:tasks:*`
// custom events for verb-driven actions; we listen and act on the
// current selection (or the cursor row when nothing is selected).
//
// Keyboard model — motion + selection only, no letter-as-verb:
//   ↑/↓        move cursor
//   Space      toggle selection on cursor row
//   Shift+↑/↓  extend selection
//   Enter      open edit
//   /          focus search
//
// Everything else is a verb in the chip prompt.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import { invokeLauncher } from '../launchers';
import { spawnTerminal } from '../terminalSpawn';
import {
  deleteTask,
  todayISO,
  updateTask,
  useTasks,
} from '../tasks';
import type { ConfirmRequest } from './ConfirmDialog';
import type { Task, TaskStatus } from '../types';
import './TasksPage.css';

type SortKey = 'due' | 'start' | 'created' | 'alpha';
type GroupKey = 'folder' | 'status' | 'due' | 'flat';
type DerivedFilter = 'all' | 'this_week' | 'overdue' | 'scheduled' | 'orphaned';

const ALL_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const SORT_LABEL: Record<SortKey, string> = {
  due: 'Due ↑',
  start: 'Start ↑',
  created: 'Created ↓',
  alpha: 'Title A→Z',
};

const GROUP_LABEL: Record<GroupKey, string> = {
  folder: 'Folder',
  status: 'Status',
  due: 'Due',
  flat: 'Flat',
};

const DERIVED_LABEL: Record<DerivedFilter, string> = {
  all: 'All',
  this_week: 'Due this week',
  overdue: 'Overdue',
  scheduled: 'Scheduled',
  orphaned: 'Orphaned',
};

function homeRel(p: string): string {
  const home =
    typeof window !== 'undefined' && (window as unknown as { fm?: { home?: string } }).fm?.home;
  if (home && p === home) return '~';
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || '/' : trimmed;
}

function isOrphanedLooking(folder: string): boolean {
  if (!folder) return true;
  if (folder.includes('/..')) return true;
  if (!folder.startsWith('/') && !folder.startsWith('~')) return true;
  return false;
}

function cmpISO(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

function compareTasks(a: Task, b: Task, sort: SortKey): number {
  switch (sort) {
    case 'due': {
      const c = cmpISO(a.due_at, b.due_at);
      if (c !== 0) return c;
      return b.created_at - a.created_at;
    }
    case 'start': {
      const c = cmpISO(a.start_at, b.start_at);
      if (c !== 0) return c;
      return b.created_at - a.created_at;
    }
    case 'created':
      return b.created_at - a.created_at;
    case 'alpha':
      return a.title.localeCompare(b.title);
  }
}

function dueGroupKey(t: Task, today: string): string {
  if (!t.due_at) return 'No due date';
  if (t.due_at < today) return 'Overdue';
  if (t.due_at === today) return 'Today';
  // 7-day window
  const d = new Date(today);
  d.setDate(d.getDate() + 7);
  const week = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (t.due_at <= week) return 'This week';
  return 'Later';
}

function groupOrder(group: GroupKey, key: string): number {
  if (group === 'due') {
    const order = ['Overdue', 'Today', 'This week', 'Later', 'No due date'];
    const i = order.indexOf(key);
    return i < 0 ? 99 : i;
  }
  if (group === 'status') {
    const order: TaskStatus[] = ['in_progress', 'pending', 'done', 'cancelled'];
    const i = order.indexOf(key as TaskStatus);
    return i < 0 ? 99 : i;
  }
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────

export function TasksPage() {
  const { state, dispatch } = useStore();

  // Filter / view state — persisted in localStorage so reopening lands on the
  // user's last view rather than a hard reset.
  const [statuses, setStatuses] = useState<Set<TaskStatus>>(
    () => new Set<TaskStatus>(['pending', 'in_progress']),
  );
  const [folder, setFolder] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [derived, setDerived] = useState<DerivedFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('due');
  const [group, setGroup] = useState<GroupKey>('folder');
  const [showCompleted, setShowCompleted] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const lastSelectedRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Inline due/start picker state — opened via :due / :start verbs
  const [datePicker, setDatePicker] = useState<{
    field: 'due_at' | 'start_at';
    value: string;
  } | null>(null);

  // Per-row kebab menu — anchored to a row's kebab button. Outside-click
  // dismisses; the menu owns the rest of the actions that don't earn a
  // dedicated row button.
  const [kebabFor, setKebabFor] = useState<{
    task: Task;
    x: number;
    y: number;
  } | null>(null);


  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 150);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const effectiveStatuses = useMemo<TaskStatus[] | undefined>(() => {
    if (statuses.size === 0) return undefined;
    if (showCompleted) return Array.from(statuses);
    const arr = Array.from(statuses).filter((s) => s !== 'done' && s !== 'cancelled');
    return arr.length > 0 ? arr : undefined;
  }, [statuses, showCompleted]);

  const sqlFilter = useMemo(
    () => ({
      status: effectiveStatuses,
      folder: folder.trim() || undefined,
      pinned: pinnedOnly || undefined,
      search: search || undefined,
      includeDone: showCompleted,
    }),
    [effectiveStatuses, folder, pinnedOnly, search, showCompleted],
  );

  const { tasks: rawTasks, loading } = useTasks(sqlFilter);

  const filtered = useMemo(() => {
    const today = todayISO();
    const week = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    const out = rawTasks.filter((t) => {
      if (!showCompleted && (t.status === 'done' || t.status === 'cancelled')) return false;
      if (statuses.size > 0 && !statuses.has(t.status)) return false;
      switch (derived) {
        case 'this_week':
          if (!t.due_at) return false;
          return t.due_at <= week;
        case 'overdue':
          if (!t.due_at) return false;
          if (t.due_at >= today) return false;
          return t.status !== 'done' && t.status !== 'cancelled';
        case 'scheduled':
          if (!t.start_at) return false;
          return t.start_at > today;
        case 'orphaned':
          return isOrphanedLooking(t.folder);
        case 'all':
        default:
          return true;
      }
    });
    return out.slice().sort((a, b) => compareTasks(a, b, sort));
  }, [rawTasks, statuses, derived, showCompleted, sort]);

  // Group the filtered list. 'flat' returns one group with empty header.
  const groups = useMemo(() => {
    const today = todayISO();
    const map = new Map<string, Task[]>();
    for (const t of filtered) {
      let key = '';
      switch (group) {
        case 'folder':
          key = homeRel(t.folder) || '(no folder)';
          break;
        case 'status':
          key = t.status;
          break;
        case 'due':
          key = dueGroupKey(t, today);
          break;
        case 'flat':
          key = '';
          break;
      }
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    return Array.from(map.entries())
      .sort((a, b) => {
        const oa = groupOrder(group, a[0]);
        const ob = groupOrder(group, b[0]);
        if (oa !== ob) return oa - ob;
        return a[0].localeCompare(b[0]);
      })
      .map(([key, tasks]) => ({ key, tasks }));
  }, [filtered, group]);

  // Flat order across groups — drives arrow nav.
  const flatOrder = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);

  // Drop selection ids that fell out of view; re-anchor cursor.
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

  // ─── helpers ─────────────────────────────────────────────────────────────
  const targetIds = (): string[] => {
    if (selected.size > 0) return Array.from(selected);
    if (cursorId) return [cursorId];
    return [];
  };

  const targetTasks = (): Task[] => {
    const ids = new Set(targetIds());
    return flatOrder.filter((t) => ids.has(t.id));
  };

  function toggleStatus(s: TaskStatus) {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function openEdit(task: Task) {
    window.dispatchEvent(
      new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }),
    );
  }

  // ─── per-row single-task action helpers ──────────────────────────────────
  // Operate on exactly one task — bypass selection. The bulk verb path
  // remains the way to act on many; row buttons are for quick, focused
  // moves on the row in front of the user.
  function setStatus(task: Task, status: TaskStatus) {
    void updateTask(task.id, { status });
    // Filter view often hides the row immediately after this change (e.g.
    // marking done while showCompleted=false). Without a status nudge the
    // click feels like a no-op — the row just disappears. Toast restores
    // the cause→effect link.
    const verbed: Record<TaskStatus, string> = {
      pending: 'reopened',
      in_progress: 'set in-progress',
      done: 'marked done',
      cancelled: 'cancelled',
    };
    dispatch({
      type: 'setStatus',
      msg: `${verbed[status]} · ${task.title}${
        (status === 'done' || status === 'cancelled') && !showCompleted
          ? ' (toggle “Show completed” to see it)'
          : ''
      }`,
    });
  }
  function cycleStatus(task: Task) {
    const order: TaskStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];
    const next = order[(order.indexOf(task.status) + 1) % order.length];
    void updateTask(task.id, { status: next });
    dispatch({
      type: 'setStatus',
      msg: `${task.title} → ${STATUS_LABEL[next].toLowerCase()}`,
    });
  }
  function rowOpenInTab(task: Task) {
    dispatch({ type: 'openTaskTab', taskId: task.id, folder: task.folder });
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
      dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: task.folder });
    } catch (e) {
      dispatch({ type: 'setStatus', msg: `terminal failed: ${(e as Error).message}` });
    }
  }
  function rowGotoFolder(task: Task) {
    // Open the folder in a new folder tab so the task tab (if any) and the
    // tasks-overview tab both stay alive — the user can pivot back without
    // losing state.
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
        filter: '',
        tagViz: [],
        tagFilter: { mode: 'off', ids: [] },
        history: [],
        forward: [],
      },
    });
  }
  function rowDelete(task: Task) {
    const req: ConfirmRequest = {
      title: `Delete "${task.title}"?`,
      body: 'This cannot be undone. The folder itself is not touched.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await deleteTask(task.id);
        dispatch({ type: 'setStatus', msg: 'task deleted' });
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }
  function rowSetDueQuick(task: Task, value: string | null) {
    void updateTask(task.id, { due_at: value });
    dispatch({
      type: 'setStatus',
      msg: value === null ? 'cleared due' : `due ${value} · ${task.title}`,
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
    lastSelectedRef.current = task.id;
    setCursorId(task.id);
    openEdit(task);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveCursor(delta: number, extend: boolean) {
    if (flatOrder.length === 0) return;
    const idx = cursorId ? flatOrder.findIndex((t) => t.id === cursorId) : -1;
    const nextIdx = Math.max(0, Math.min(flatOrder.length - 1, (idx < 0 ? 0 : idx) + delta));
    const nextTask = flatOrder[nextIdx];
    if (extend && cursorId) {
      // Extend selection from anchor through next
      const a = idx < 0 ? 0 : idx;
      const b = nextIdx;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(flatOrder[i].id);
        return next;
      });
    }
    setCursorId(nextTask.id);
    // Scroll into view
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-task-id="${nextTask.id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  // ─── verb event listeners ────────────────────────────────────────────────
  const isActive = state.tabs[state.activeTab]?.kind === 'tasks';
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  // Latest store state — verb handlers run inside a stable useEffect closure;
  // we need fresh tabs/activeTab to predict tab indices for sequential
  // openTaskTab + openTerminal dispatches.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!isActive) return;

    async function applyToTargets(patch: { [k: string]: unknown }, label: string) {
      const ids = targetIds();
      if (ids.length === 0) {
        dispatch({ type: 'setStatus', msg: 'no task targeted' });
        return;
      }
      await Promise.all(ids.map((id) => updateTask(id, patch as never)));
      dispatch({ type: 'setStatus', msg: `${label} · ${ids.length} task${ids.length === 1 ? '' : 's'}` });
      setSelected(new Set());
    }

    const handlers: Record<string, (detail?: unknown) => void | Promise<void>> = {
      'fm:tasks:done': () => applyToTargets({ status: 'done' as TaskStatus }, 'marked done'),
      'fm:tasks:reopen': () => applyToTargets({ status: 'pending' as TaskStatus }, 'reopened'),
      'fm:tasks:in-progress': () =>
        applyToTargets({ status: 'in_progress' as TaskStatus }, 'set in-progress'),
      'fm:tasks:cancel': () =>
        applyToTargets({ status: 'cancelled' as TaskStatus }, 'cancelled'),
      'fm:tasks:pin': () => applyToTargets({ pinned: true }, 'pinned'),
      'fm:tasks:unpin': () => applyToTargets({ pinned: false }, 'unpinned'),
      'fm:tasks:due': (detail) => {
        const v = (detail as { value?: string } | undefined)?.value;
        if (v === undefined) {
          // open inline picker
          const todays = todayISO();
          setDatePicker({ field: 'due_at', value: todays });
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
        const req: ConfirmRequest = {
          title: `Delete ${tasks.length} task${tasks.length === 1 ? '' : 's'}?`,
          body: 'This cannot be undone. The folders themselves are not touched.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: async () => {
            await Promise.all(tasks.map((t) => deleteTask(t.id)));
            dispatch({ type: 'setStatus', msg: `deleted ${tasks.length} tasks` });
            setSelected(new Set());
          },
        };
        window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
      },
      'fm:tasks:edit': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) {
          dispatch({ type: 'setStatus', msg: 'no task targeted' });
          return;
        }
        // Edit dialog handles one task at a time. Multi-select edit would
        // require a bulk-edit dialog — opt for opening the first one and
        // hint at the limitation.
        if (tasks.length > 1) {
          dispatch({
            type: 'setStatus',
            msg: `editing first of ${tasks.length} — edit dialog is single-task`,
          });
        }
        openEdit(tasks[0]);
      },
      'fm:tasks:goto-folder': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) return;
        for (const t of tasks) rowGotoFolder(t);
      },
      'fm:tasks:open': () => {
        const tasks = targetTasks();
        if (tasks.length === 0) return;
        for (const t of tasks) {
          dispatch({ type: 'openTaskTab', taskId: t.id, folder: t.folder, focus: false });
        }
        // Focus the last one we just opened so the user lands on a real surface.
        const last = tasks[tasks.length - 1];
        dispatch({ type: 'openTaskTab', taskId: last.id, folder: last.folder });
      },
      'fm:tasks:terminal': async () => {
        const tasks = targetTasks();
        if (tasks.length === 0) return;
        const tabsSnapshot = stateRef.current.tabs.slice();
        for (const t of tasks) {
          const existing = tabsSnapshot.findIndex(
            (tt) => tt.kind === 'task' && tt.taskId === t.id,
          );
          const tabIndex = existing >= 0 ? existing : tabsSnapshot.length;
          if (existing < 0) tabsSnapshot.push({ ...t, kind: 'task' } as never);
          const isLast = t === tasks[tasks.length - 1];
          dispatch({
            type: 'openTaskTab',
            taskId: t.id,
            folder: t.folder,
            focus: isLast,
          });
          // Skip if the tab already had a terminal — don't trample state.
          if (existing >= 0 && tabsSnapshot[existing]?.terminal) {
            dispatch({ type: 'setStatus', msg: `terminal already open for ${t.title}` });
            continue;
          }
          try {
            const ptyId = await spawnTerminal({ cwd: t.folder, sessionLabel: t.title });
            dispatch({ type: 'openTerminal', tabIndex, ptyId, cwd: t.folder });
          } catch (e) {
            dispatch({ type: 'setStatus', msg: `terminal failed: ${(e as Error).message}` });
          }
        }
      },
      'fm:tasks:launcher': async (detail) => {
        const launcherId = (detail as { launcherId?: string } | undefined)?.launcherId;
        const variantId = (detail as { variantId?: string } | undefined)?.variantId;
        if (!launcherId) return;
        const launcher = (await fm.launchersList()).find((l) => l.id === launcherId);
        if (!launcher) {
          dispatch({ type: 'setStatus', msg: `launcher not found: ${launcherId}` });
          return;
        }
        const tasks = targetTasks();
        if (tasks.length === 0) return;
        // Sequentially open a task tab per target and invoke the launcher
        // bound to that tab. We predict each tab's index from the current
        // tabs snapshot — openTaskTab either focuses an existing tab (known
        // index) or appends (index = current length). Reading the snapshot
        // afresh per task accounts for tabs we just appended in this loop.
        const tabsSnapshot = stateRef.current.tabs.slice();
        for (const t of tasks) {
          const existing = tabsSnapshot.findIndex(
            (tt) => tt.kind === 'task' && tt.taskId === t.id,
          );
          const tabIndex = existing >= 0 ? existing : tabsSnapshot.length;
          if (existing < 0) {
            tabsSnapshot.push({ ...t, kind: 'task' } as never);
          }
          // Focus the last one we open; earlier ones stay in the background
          // so the user can come back to them.
          const isLast = t === tasks[tasks.length - 1];
          dispatch({
            type: 'openTaskTab',
            taskId: t.id,
            folder: t.folder,
            focus: isLast,
          });
          await invokeLauncher({
            launcher,
            variantId,
            task: t,
            cwd: t.folder,
            sessionLabel: t.title,
            onStatus: (msg) => dispatch({ type: 'setStatus', msg }),
            onPtyOpened: ({ ptyId, label, cwd }) =>
              dispatch({
                type: 'openTerminal',
                tabIndex,
                ptyId,
                cwd,
                label,
              }),
          });
        }
      },
      'fm:tasks:group': (detail) => {
        const v = (detail as { value?: GroupKey } | undefined)?.value;
        if (v && (['folder', 'status', 'due', 'flat'] as GroupKey[]).includes(v)) setGroup(v);
      },
      'fm:tasks:sort': (detail) => {
        const v = (detail as { value?: SortKey } | undefined)?.value;
        if (v && (['due', 'start', 'created', 'alpha'] as SortKey[]).includes(v)) setSort(v);
      },
      'fm:tasks:filter': (detail) => {
        const v = (detail as { value?: DerivedFilter } | undefined)?.value;
        if (v && (['all', 'this_week', 'overdue', 'scheduled', 'orphaned'] as DerivedFilter[]).includes(v)) setDerived(v);
      },
      'fm:tasks:show-completed': () => setShowCompleted(true),
      'fm:tasks:hide-completed': () => setShowCompleted(false),
      'fm:tasks:select': (detail) => {
        const what = (detail as { what?: string } | undefined)?.what;
        if (!what) return;
        if (what === 'all') {
          setSelected(new Set(flatOrder.map((t) => t.id)));
        } else if (what === 'none') {
          setSelected(new Set());
        } else if (what === 'overdue') {
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
          const all = new Set(flatOrder.map((t) => t.id));
          const next = new Set<string>();
          for (const id of all) if (!selected.has(id)) next.add(id);
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
  }, [isActive, flatOrder, selected, cursorId, dispatch]);

  // ─── keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    function onKey(e: KeyboardEvent) {
      // Don't intercept while typing in the search box / date picker — let
      // those inputs handle their own keys.
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveCursor(1, e.shiftKey);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveCursor(-1, e.shiftKey);
      } else if (e.key === ' ' && cursorId) {
        e.preventDefault();
        toggleSelect(cursorId);
        lastSelectedRef.current = cursorId;
      } else if (e.key === 'Enter' && cursorId) {
        e.preventDefault();
        const t = flatOrder.find((x) => x.id === cursorId);
        if (t) openEdit(t);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, flatOrder, cursorId]);

  // ─── digest stats for the header ─────────────────────────────────────────
  const digest = useMemo(() => {
    const today = todayISO();
    const week = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    let overdue = 0;
    let dueWeek = 0;
    let orphan = 0;
    for (const t of rawTasks) {
      if (t.status === 'done' || t.status === 'cancelled') continue;
      if (t.due_at && t.due_at < today) overdue++;
      else if (t.due_at && t.due_at <= week) dueWeek++;
      if (isOrphanedLooking(t.folder)) orphan++;
    }
    return { overdue, dueWeek, orphan };
  }, [rawTasks]);

  // ─── render ──────────────────────────────────────────────────────────────
  const allVisibleSelected =
    flatOrder.length > 0 && flatOrder.every((t) => selected.has(t.id));
  const someSelected = selected.size > 0;
  const empty = !loading && flatOrder.length === 0;
  const emptyEver = !loading && rawTasks.length === 0 && empty;

  function toggleAll() {
    if (allVisibleSelected) setSelected(new Set());
    else setSelected(new Set(flatOrder.map((t) => t.id)));
  }

  function toggleGroupSelection(taskIds: string[]) {
    const allOn = taskIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) for (const id of taskIds) next.delete(id);
      else for (const id of taskIds) next.add(id);
      return next;
    });
  }

  return (
    <div className="tasks tasks--inline">
      <header className="tasks__head">
        <h1 className="tasks__title">
          Tasks
          <span className="tasks__count">{flatOrder.length}</span>
        </h1>
        <div className="tasks__digest" role="group" aria-label="Task digest">
          {digest.overdue > 0 && (
            <button
              type="button"
              className="tasks__digest-chip tasks__digest-chip--overdue"
              onClick={() => setDerived('overdue')}
              title="Show only overdue"
            >
              {digest.overdue} overdue
            </button>
          )}
          {digest.dueWeek > 0 && (
            <button
              type="button"
              className="tasks__digest-chip"
              onClick={() => setDerived('this_week')}
              title="Show due this week"
            >
              {digest.dueWeek} due this week
            </button>
          )}
          {digest.orphan > 0 && (
            <button
              type="button"
              className="tasks__digest-chip"
              onClick={() => setDerived('orphaned')}
              title="Show orphaned"
            >
              {digest.orphan} orphaned
            </button>
          )}
          {digest.overdue === 0 && digest.dueWeek === 0 && digest.orphan === 0 && (
            <span className="tasks__digest-clear">Nothing pressing.</span>
          )}
        </div>
        <div className="tasks__head-actions">
          <button
            type="button"
            className="tasks__btn"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('fm:openTask', {
                  detail: { mode: 'create', defaultFolder: '' },
                }),
              )
            }
            title="Create a new task"
          >
            + New task
          </button>
        </div>
      </header>

      <div className="tasks__filters">
        <div className="tasks__filter-row">
          <span className="tasks__filter-label">Status</span>
          <div className="tasks__chips">
            {ALL_STATUSES.map((s) => {
              const dimmed = !showCompleted && (s === 'done' || s === 'cancelled');
              return (
                <button
                  key={s}
                  type="button"
                  className={[
                    'tasks__chip',
                    statuses.has(s) && 'tasks__chip--on',
                    dimmed && 'tasks__chip--dim',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => toggleStatus(s)}
                  title={dimmed ? 'Enable “Show completed” to include' : undefined}
                >
                  {STATUS_LABEL[s]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="tasks__filter-row">
          <span className="tasks__filter-label">View</span>
          <div className="tasks__chips">
            {(Object.keys(DERIVED_LABEL) as DerivedFilter[]).map((d) => (
              <button
                key={d}
                type="button"
                className={[
                  'tasks__chip',
                  derived === d && 'tasks__chip--on',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => setDerived(d)}
              >
                {DERIVED_LABEL[d]}
              </button>
            ))}
          </div>
        </div>

        <div className="tasks__filter-row">
          <span className="tasks__filter-label">Search</span>
          <input
            ref={searchInputRef}
            type="text"
            className="tasks__input"
            placeholder="Title or notes…    ( / to focus )"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            spellCheck={false}
          />
          <input
            type="text"
            className="tasks__input tasks__input--mono"
            placeholder="Folder substring…"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="tasks__filter-row">
          <label className="tasks__toggle">
            <input
              type="checkbox"
              checked={pinnedOnly}
              onChange={(e) => setPinnedOnly(e.target.checked)}
            />
            <span>Pinned only</span>
          </label>
          <label className="tasks__toggle">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
            />
            <span>Show completed</span>
          </label>
          <span className="tasks__filter-spacer" />
          <span className="tasks__filter-label">Group</span>
          <select
            className="tasks__select"
            value={group}
            onChange={(e) => setGroup(e.target.value as GroupKey)}
          >
            {(Object.keys(GROUP_LABEL) as GroupKey[]).map((k) => (
              <option key={k} value={k}>
                {GROUP_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="tasks__filter-label">Sort</span>
          <select
            className="tasks__select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="tasks__selectstrip">
        <label className="tasks__selectstrip-master" title="Select all visible">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allVisibleSelected;
            }}
            onChange={toggleAll}
          />
          <span>
            {someSelected
              ? `${selected.size} selected`
              : flatOrder.length > 0
                ? 'Select all'
                : 'No tasks'}
          </span>
        </label>
        {someSelected && (
          <span className="tasks__selectstrip-hint">
            Type <kbd>:</kbd> for actions —
            {' '}
            <code>:done</code> · <code>:due</code> · <code>:claude</code> ·
            {' '}
            <code>:open</code> · <code>:delete</code>
          </span>
        )}
        {!someSelected && flatOrder.length > 0 && (
          <span className="tasks__selectstrip-hint">
            ↑↓ move · <kbd>Space</kbd> select · <kbd>Enter</kbd> edit ·
            {' '}
            <kbd>:</kbd> verbs
          </span>
        )}
      </div>

      {datePicker && (
        <div className="tasks__datebar" role="dialog" aria-label="Set date">
          <span>
            Set <b>{datePicker.field === 'due_at' ? 'due' : 'start'}</b> on
            {' '}
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
              const ids = targetIds();
              if (ids.length === 0 || !datePicker.value) {
                setDatePicker(null);
                return;
              }
              await Promise.all(
                ids.map((id) =>
                  updateTask(id, { [datePicker.field]: datePicker.value } as never),
                ),
              );
              dispatch({
                type: 'setStatus',
                msg: `set ${datePicker.field === 'due_at' ? 'due' : 'start'} ${datePicker.value} · ${ids.length}`,
              });
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
              const ids = targetIds();
              if (ids.length === 0) {
                setDatePicker(null);
                return;
              }
              await Promise.all(
                ids.map((id) =>
                  updateTask(id, { [datePicker.field]: null } as never),
                ),
              );
              dispatch({
                type: 'setStatus',
                msg: `cleared ${datePicker.field === 'due_at' ? 'due' : 'start'} · ${ids.length}`,
              });
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

      <div className="tasks__list" role="list" ref={listRef}>
        {empty && (
          <div className="tasks__empty">
            {emptyEver ? (
              <>
                <div className="tasks__empty-glyph">✓</div>
                <div className="tasks__empty-title">No tasks yet</div>
                <div className="tasks__empty-body">
                  Type <kbd>:task</kbd> to add one — or use <b>+ New task</b>.
                </div>
              </>
            ) : (
              <>
                <div className="tasks__empty-glyph">∅</div>
                <div className="tasks__empty-title">Nothing matches.</div>
                <div className="tasks__empty-body">
                  Drop a filter, switch to <b>All</b>, or clear the search.
                </div>
              </>
            )}
          </div>
        )}

        {groups.map(({ key, tasks }) => {
          const groupAllSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
          const groupSomeSelected = tasks.some((t) => selected.has(t.id));
          return (
            <div key={key || '__flat'} className="tasks__group">
              {group !== 'flat' && (
                <div className="tasks__group-head">
                  <label className="tasks__group-check" title="Select all in group">
                    <input
                      type="checkbox"
                      checked={groupAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = groupSomeSelected && !groupAllSelected;
                      }}
                      onChange={() => toggleGroupSelection(tasks.map((t) => t.id))}
                    />
                  </label>
                  <span className="tasks__group-title">
                    {group === 'status' ? STATUS_LABEL[key as TaskStatus] : key}
                  </span>
                  <span className="tasks__group-count">{tasks.length}</span>
                </div>
              )}
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  selected={selected.has(t.id)}
                  cursor={cursorId === t.id}
                  onCheckbox={() => {
                    toggleSelect(t.id);
                    lastSelectedRef.current = t.id;
                    setCursorId(t.id);
                  }}
                  onClick={(e) => rowClick(e, t)}
                  onCycleStatus={() => cycleStatus(t)}
                  onMarkDone={() =>
                    setStatus(
                      t,
                      t.status === 'done' || t.status === 'cancelled'
                        ? 'pending'
                        : 'done',
                    )
                  }
                  onEdit={() => openEdit(t)}
                  onOpenInTab={() => rowOpenInTab(t)}
                  onKebab={(x, y) => setKebabFor({ task: t, x, y })}
                />
              ))}
            </div>
          );
        })}
      </div>

      {kebabFor && (
        <RowKebabMenu
          task={kebabFor.task}
          x={kebabFor.x}
          y={kebabFor.y}
          onClose={() => setKebabFor(null)}
          onAction={(action) => {
            const t = kebabFor.task;
            setKebabFor(null);
            switch (action) {
              case 'edit':
                openEdit(t);
                break;
              case 'open-tab':
                rowOpenInTab(t);
                break;
              case 'open-terminal':
                void rowOpenTerminal(t);
                break;
              case 'mark-pending':
                setStatus(t, 'pending');
                break;
              case 'mark-in-progress':
                setStatus(t, 'in_progress');
                break;
              case 'mark-done':
                setStatus(t, 'done');
                break;
              case 'mark-cancelled':
                setStatus(t, 'cancelled');
                break;
              case 'pin':
                void updateTask(t.id, { pinned: !t.pinned });
                break;
              case 'goto-folder':
                rowGotoFolder(t);
                break;
              case 'due-today':
                rowSetDueQuick(t, todayISO());
                break;
              case 'due-tomorrow': {
                const d = new Date();
                d.setDate(d.getDate() + 1);
                rowSetDueQuick(
                  t,
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                );
                break;
              }
              case 'due-friday': {
                const d = new Date();
                const offset = (5 - d.getDay() + 7) % 7 || 7;
                d.setDate(d.getDate() + offset);
                rowSetDueQuick(
                  t,
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                );
                break;
              }
              case 'due-next-week': {
                const d = new Date();
                d.setDate(d.getDate() + 7);
                rowSetDueQuick(
                  t,
                  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                );
                break;
              }
              case 'due-clear':
                rowSetDueQuick(t, null);
                break;
              case 'delete':
                rowDelete(t);
                break;
            }
          }}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  cursor,
  onCheckbox,
  onClick,
  onCycleStatus,
  onMarkDone,
  onEdit,
  onOpenInTab,
  onKebab,
}: {
  task: Task;
  selected: boolean;
  cursor: boolean;
  onCheckbox: () => void;
  onClick: (e: React.MouseEvent) => void;
  onCycleStatus: () => void;
  onMarkDone: () => void;
  onEdit: () => void;
  onOpenInTab: () => void;
  onKebab: (x: number, y: number) => void;
}) {
  const today = todayISO();
  const overdue =
    !!task.due_at &&
    task.due_at < today &&
    task.status !== 'done' &&
    task.status !== 'cancelled';
  const orphan = isOrphanedLooking(task.folder);
  const isClosed = task.status === 'done' || task.status === 'cancelled';

  return (
    <div
      role="listitem"
      data-task-id={task.id}
      className={[
        'tasks__row',
        selected && 'tasks__row--selected',
        cursor && 'tasks__row--cursor',
        isClosed && 'tasks__row--muted',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
    >
      <label
        className="tasks__row-check"
        onClick={(e) => e.stopPropagation()}
        title={selected ? 'Unselect' : 'Select'}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onCheckbox}
        />
      </label>

      <button
        type="button"
        className={['tasks__pin', task.pinned && 'tasks__pin--on'].filter(Boolean).join(' ')}
        onClick={(e) => {
          e.stopPropagation();
          void updateTask(task.id, { pinned: !task.pinned });
        }}
        title={task.pinned ? 'Unpin' : 'Pin'}
        aria-label={task.pinned ? 'Unpin' : 'Pin'}
      >
        {task.pinned ? '★' : '☆'}
      </button>

      <div className="tasks__row-main">
        <div className="tasks__row-title">
          {task.title}
          {orphan && (
            <span className="tasks__tag tasks__tag--orphan" title="Folder may not exist">
              orphaned
            </span>
          )}
        </div>
        <div className="tasks__row-sub">
          <span className="tasks__row-folder" title={task.folder}>
            {homeRel(task.folder)}
          </span>
          {task.start_at && (
            <span className="tasks__date">start {task.start_at}</span>
          )}
          {task.due_at && (
            <span
              className={['tasks__date', overdue && 'tasks__date--overdue']
                .filter(Boolean)
                .join(' ')}
            >
              due {task.due_at}
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        className={`tasks__status tasks__status--${task.status} tasks__status--button`}
        onClick={(e) => {
          e.stopPropagation();
          onCycleStatus();
        }}
        title="Click to cycle status"
      >
        {STATUS_LABEL[task.status]}
      </button>

      <div
        className="tasks__row-actions"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={[
            'tasks__row-btn',
            isClosed ? 'tasks__row-btn--reopen' : 'tasks__row-btn--done',
          ].join(' ')}
          onClick={onMarkDone}
          title={isClosed ? 'Reopen (back to pending)' : 'Mark done'}
          aria-label={isClosed ? 'Reopen' : 'Mark done'}
        >
          {isClosed ? '↺' : '✓'}
        </button>
        <button
          type="button"
          className="tasks__row-btn"
          onClick={onEdit}
          title="Edit task"
          aria-label="Edit"
        >
          ✎
        </button>
        <button
          type="button"
          className="tasks__row-btn"
          onClick={onOpenInTab}
          title="Open in task tab"
          aria-label="Open in tab"
        >
          ↗
        </button>
        <button
          type="button"
          className="tasks__row-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onKebab(r.right, r.bottom);
          }}
          title="More actions"
          aria-label="More"
          aria-haspopup="menu"
        >
          ⋮
        </button>
      </div>
    </div>
  );
}

// fm-yi85 — per-row "more actions" popover. Mirrors what the verb prompt
// can do, but in pointer-friendly form for users who want a discoverable
// menu without remembering verb names. Each item operates on the single
// row's task — bulk actions go through the chip prompt against the
// selection.
function RowKebabMenu({
  task,
  x,
  y,
  onClose,
  onAction,
}: {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
  onAction: (action: string) => void;
}) {
  // Outside-click + Esc dismiss.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.tasks__kebab')) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp to viewport so the menu doesn't fall off the bottom-right.
  const style = {
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 460),
  };

  const isClosed = task.status === 'done' || task.status === 'cancelled';

  return (
    <div className="tasks__kebab" style={style} role="menu">
      <button className="tasks__kebab-item" onClick={() => onAction('edit')}>
        Edit…
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('open-tab')}>
        Open in task tab
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('open-terminal')}>
        Open terminal
      </button>
      <div className="tasks__kebab-sep" />
      <div className="tasks__kebab-section">Status</div>
      {task.status !== 'pending' && (
        <button className="tasks__kebab-item" onClick={() => onAction('mark-pending')}>
          Pending
        </button>
      )}
      {task.status !== 'in_progress' && (
        <button className="tasks__kebab-item" onClick={() => onAction('mark-in-progress')}>
          In progress
        </button>
      )}
      {!isClosed && (
        <button className="tasks__kebab-item" onClick={() => onAction('mark-done')}>
          Done
        </button>
      )}
      {task.status !== 'cancelled' && (
        <button className="tasks__kebab-item" onClick={() => onAction('mark-cancelled')}>
          Cancelled
        </button>
      )}
      <div className="tasks__kebab-sep" />
      <div className="tasks__kebab-section">Set due</div>
      <button className="tasks__kebab-item" onClick={() => onAction('due-today')}>
        Today
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('due-tomorrow')}>
        Tomorrow
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('due-friday')}>
        Friday
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('due-next-week')}>
        Next week
      </button>
      {task.due_at && (
        <button className="tasks__kebab-item" onClick={() => onAction('due-clear')}>
          Clear due date
        </button>
      )}
      <div className="tasks__kebab-sep" />
      <button className="tasks__kebab-item" onClick={() => onAction('pin')}>
        {task.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button className="tasks__kebab-item" onClick={() => onAction('goto-folder')}>
        Go to folder
      </button>
      <div className="tasks__kebab-sep" />
      <button
        className="tasks__kebab-item tasks__kebab-item--danger"
        onClick={() => onAction('delete')}
      >
        Delete…
      </button>
    </div>
  );
}

