// fm-kaa — Full-screen Tasks page.
//
// Why: the sidebar's task slot caps at ~10 entries, which is fine for a
// glanceable "what's next here" view but useless for cross-folder triage,
// digging through completed work, or doing anything in bulk. This page is
// the escape hatch — full filter set, search across title+notes, sort,
// bulk operations. Opened by the `tasks` verb or (eventually) the
// sidebar's "See all" link.
//
// Wiring: mounted in App.tsx behind an fm:openTasksPage event, sits at
// z-index just under --z-overlay so the bulk-delete ConfirmDialog still
// renders on top of us. SQL filtering for the easy slice (status, folder
// substring, pinned, search), JS filtering for the derived predicates
// (overdue, has-due-this-week, scheduled, orphaned).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverlayExit } from '../useOverlayExit';
import { useStore } from '../store';
import {
  createTask as _createTask,
  deleteTask,
  shiftISO,
  todayISO,
  updateTask,
  useTasks,
} from '../tasks';
import type { ConfirmRequest } from './ConfirmDialog';
import type { Task, TaskStatus } from '../types';
import './TasksPage.css';

void _createTask; // referenced in JSDoc above; keep import live
void shiftISO;

type SortKey = 'due' | 'start' | 'created' | 'alpha';
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
  // basename fallback
  const trimmed = p.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) || '/' : trimmed;
}

function isOrphanedLooking(folder: string): boolean {
  // v1: cheap heuristic — fm-7fu will replace this with a real fs.access.
  if (!folder) return true;
  if (folder.includes('/..')) return true;
  if (!folder.startsWith('/') && !folder.startsWith('~')) return true;
  return false;
}

/** Compare two ISO date strings, with nulls sorting last. */
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

export function TasksPage({ onClose }: { onClose: () => void }) {
  const { exit, state } = useOverlayExit(onClose);
  const { navigateTo, dispatch } = useStore();

  // Filter state
  const [statuses, setStatuses] = useState<Set<TaskStatus>>(
    () => new Set<TaskStatus>(['pending', 'in_progress']),
  );
  const [folder, setFolder] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [derived, setDerived] = useState<DerivedFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('due');
  const [showCompleted, setShowCompleted] = useState(false);

  // Bulk-select state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSelectedRef = useRef<string | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);

  // Inline bulk-due picker
  const [bulkDueOpen, setBulkDueOpen] = useState(false);
  const [bulkDueValue, setBulkDueValue] = useState('');

  // Debounce search input → search (150ms)
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 150);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // SQL slice — leave the derived filters off here; we apply them in-memory.
  const effectiveStatuses = useMemo<TaskStatus[] | undefined>(() => {
    if (statuses.size === 0) return undefined;
    if (showCompleted) return Array.from(statuses);
    // Strip done/cancelled when "show completed" is off, regardless of
    // what the user chip-toggled — the dedicated toggle wins.
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
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    })();

    const out = rawTasks.filter((t) => {
      // showCompleted gate — defensive; effectiveStatuses already excludes
      // when off, but a status set of {} returning everything could leak.
      if (!showCompleted && (t.status === 'done' || t.status === 'cancelled')) return false;
      if (statuses.size > 0 && !statuses.has(t.status)) return false;
      switch (derived) {
        case 'this_week':
          if (!t.due_at) return false;
          if (t.due_at > week) return false;
          return true;
        case 'overdue':
          if (!t.due_at) return false;
          if (t.due_at >= today) return false;
          if (t.status === 'done' || t.status === 'cancelled') return false;
          return true;
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

  // Drop selection ids that fell out of view so bulk actions stay sane.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((t) => t.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  // Esc closes (only if no menu open)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (ctxMenu) {
          setCtxMenu(null);
          e.preventDefault();
          return;
        }
        if (bulkDueOpen) {
          setBulkDueOpen(false);
          e.preventDefault();
          return;
        }
        e.preventDefault();
        exit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit, ctxMenu, bulkDueOpen]);

  // Dismiss the context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    function onDoc() {
      setCtxMenu(null);
    }
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [ctxMenu]);

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

  function gotoFolder(task: Task) {
    navigateTo(task.folder);
    exit();
  }

  // ---- selection helpers ----
  function rowClick(e: React.MouseEvent, task: Task) {
    // shift-click range; cmd/ctrl-click toggle. Plain click = open edit.
    if (e.shiftKey && lastSelectedRef.current) {
      e.preventDefault();
      const ids = filtered.map((t) => t.id);
      const a = ids.indexOf(lastSelectedRef.current);
      const b = ids.indexOf(task.id);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(ids[i]);
        return next;
      });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(task.id)) next.delete(task.id);
        else next.add(task.id);
        return next;
      });
      lastSelectedRef.current = task.id;
      return;
    }
    lastSelectedRef.current = task.id;
    openEdit(task);
  }

  function selectAllVisible() {
    setSelected(new Set(filtered.map((t) => t.id)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // ---- bulk actions ----
  async function bulkMarkDone() {
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => updateTask(id, { status: 'done' })));
    dispatch({ type: 'setStatus', msg: `marked ${ids.length} done` });
    clearSelection();
  }
  async function bulkApplyDue() {
    if (!bulkDueValue) return;
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => updateTask(id, { due_at: bulkDueValue })));
    dispatch({ type: 'setStatus', msg: `set due ${bulkDueValue} on ${ids.length} tasks` });
    setBulkDueOpen(false);
    setBulkDueValue('');
    clearSelection();
  }
  async function bulkPin(pinned: boolean) {
    const ids = Array.from(selected);
    await Promise.all(ids.map((id) => updateTask(id, { pinned })));
    dispatch({
      type: 'setStatus',
      msg: `${pinned ? 'pinned' : 'unpinned'} ${ids.length} tasks`,
    });
    clearSelection();
  }
  function bulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const req: ConfirmRequest = {
      title: `Delete ${ids.length} task${ids.length === 1 ? '' : 's'}?`,
      body: 'This cannot be undone. The folders themselves are not touched.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await Promise.all(ids.map((id) => deleteTask(id)));
        dispatch({ type: 'setStatus', msg: `deleted ${ids.length} tasks` });
        clearSelection();
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }

  function togglePinSingle(task: Task) {
    void updateTask(task.id, { pinned: !task.pinned });
  }
  function statusCycleSingle(task: Task) {
    const order: TaskStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];
    const next = order[(order.indexOf(task.status) + 1) % order.length];
    void updateTask(task.id, { status: next });
  }
  function deleteSingle(task: Task) {
    const req: ConfirmRequest = {
      title: `Delete "${task.title}"?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await deleteTask(task.id);
        dispatch({ type: 'setStatus', msg: 'task deleted' });
      },
    };
    window.dispatchEvent(new CustomEvent('fm:confirm', { detail: req }));
  }

  // ---- render ----
  const allVisibleSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.id));
  const someSelected = selected.size > 0;
  const empty = !loading && filtered.length === 0;
  const emptyEver = !loading && rawTasks.length === 0 && empty;

  return (
    <div
      className="tasks-overlay"
      data-state={state}
      onClick={(e) => {
        // Click on backdrop closes; clicks bubbling from the panel are
        // stopped below.
        if (e.target === e.currentTarget) exit();
      }}
    >
      <div
        className="tasks"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tasks-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tasks__head">
          <h1 id="tasks-title" className="tasks__title">
            Tasks
            <span className="tasks__count">{filtered.length}</span>
          </h1>
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
            <button
              type="button"
              className="tasks__close"
              onClick={exit}
              aria-label="Close"
              title="Close (Esc)"
            >
              ×
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
              type="text"
              className="tasks__input"
              placeholder="Title or notes…"
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

        {someSelected && (
          <div className="tasks__bulkbar" role="toolbar" aria-label="Bulk actions">
            <span className="tasks__bulkbar-count">
              {selected.size} selected
            </span>
            <button type="button" className="tasks__btn" onClick={() => void bulkMarkDone()}>
              Mark done
            </button>
            <div className="tasks__bulkbar-due">
              {bulkDueOpen ? (
                <>
                  <input
                    type="date"
                    className="tasks__input tasks__input--inline"
                    value={bulkDueValue}
                    onChange={(e) => setBulkDueValue(e.target.value)}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="tasks__btn"
                    onClick={() => void bulkApplyDue()}
                    disabled={!bulkDueValue}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="tasks__btn tasks__btn--ghost"
                    onClick={() => {
                      setBulkDueOpen(false);
                      setBulkDueValue('');
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="tasks__btn"
                  onClick={() => {
                    setBulkDueValue(todayISO());
                    setBulkDueOpen(true);
                  }}
                >
                  Change due…
                </button>
              )}
            </div>
            <button type="button" className="tasks__btn" onClick={() => void bulkPin(true)}>
              Pin
            </button>
            <button type="button" className="tasks__btn" onClick={() => void bulkPin(false)}>
              Unpin
            </button>
            <button
              type="button"
              className="tasks__btn tasks__btn--danger"
              onClick={bulkDelete}
            >
              Delete
            </button>
            <span className="tasks__filter-spacer" />
            <button
              type="button"
              className="tasks__btn tasks__btn--ghost"
              onClick={clearSelection}
            >
              Clear
            </button>
          </div>
        )}

        {!someSelected && filtered.length > 0 && (
          <div className="tasks__bulkbar tasks__bulkbar--quiet">
            <button
              type="button"
              className="tasks__btn tasks__btn--ghost"
              onClick={selectAllVisible}
              disabled={allVisibleSelected}
            >
              Select all visible
            </button>
          </div>
        )}

        <div className="tasks__list" role="list">
          {empty && (
            <div className="tasks__empty">
              {emptyEver ? (
                <>
                  <div className="tasks__empty-glyph">✓</div>
                  <div className="tasks__empty-title">No tasks yet</div>
                  <div className="tasks__empty-body">
                    Press the <b>+ New task</b> button or run <kbd>:task</kbd> from
                    the prompt to create your first one.
                  </div>
                </>
              ) : (
                <>
                  <div className="tasks__empty-glyph">∅</div>
                  <div className="tasks__empty-title">No tasks match these filters</div>
                  <div className="tasks__empty-body">
                    Loosen the status chips, clear the search box, or switch to
                    the <b>All</b> view above.
                  </div>
                </>
              )}
            </div>
          )}

          {filtered.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              selected={selected.has(t.id)}
              onClick={(e) => rowClick(e, t)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({ x: e.clientX, y: e.clientY, task: t });
              }}
              onGoto={() => gotoFolder(t)}
              onPin={() => togglePinSingle(t)}
            />
          ))}
        </div>
      </div>

      {ctxMenu && (
        <div
          className="tasks__ctx"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            className="tasks__ctx-item"
            onClick={() => {
              openEdit(ctxMenu.task);
              setCtxMenu(null);
            }}
          >
            Edit…
          </button>
          <button
            type="button"
            className="tasks__ctx-item"
            onClick={() => {
              gotoFolder(ctxMenu.task);
              setCtxMenu(null);
            }}
          >
            Go to folder
          </button>
          <button
            type="button"
            className="tasks__ctx-item"
            onClick={() => {
              statusCycleSingle(ctxMenu.task);
              setCtxMenu(null);
            }}
          >
            Cycle status →
          </button>
          <button
            type="button"
            className="tasks__ctx-item"
            onClick={() => {
              togglePinSingle(ctxMenu.task);
              setCtxMenu(null);
            }}
          >
            {ctxMenu.task.pinned ? 'Unpin' : 'Pin'}
          </button>
          <div className="tasks__ctx-sep" />
          <button
            type="button"
            className="tasks__ctx-item tasks__ctx-item--danger"
            onClick={() => {
              const task = ctxMenu.task;
              setCtxMenu(null);
              deleteSingle(task);
            }}
          >
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onClick,
  onContextMenu,
  onGoto,
  onPin,
}: {
  task: Task;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onGoto: () => void;
  onPin: () => void;
}) {
  const today = todayISO();
  const overdue = !!task.due_at && task.due_at < today && task.status !== 'done' && task.status !== 'cancelled';
  const orphan = isOrphanedLooking(task.folder);

  return (
    <div
      role="listitem"
      className={[
        'tasks__row',
        selected && 'tasks__row--selected',
        (task.status === 'done' || task.status === 'cancelled') && 'tasks__row--muted',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className={['tasks__pin', task.pinned && 'tasks__pin--on'].filter(Boolean).join(' ')}
        onClick={(e) => {
          e.stopPropagation();
          onPin();
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

      <span className={`tasks__status tasks__status--${task.status}`}>
        {STATUS_LABEL[task.status]}
      </span>

      <button
        type="button"
        className="tasks__btn tasks__btn--ghost tasks__row-goto"
        onClick={(e) => {
          e.stopPropagation();
          onGoto();
        }}
        title="Navigate to this folder"
      >
        Go to folder
      </button>
    </div>
  );
}
