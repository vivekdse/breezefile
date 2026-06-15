import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import { basename } from '../actions';
import {
  currentDragSourceCwd,
  dragHasAnyPaths,
  dropIntoFolder,
  endAppDrag,
  isExternalDrop,
  resolveDropPaths,
} from '../dragState';
import { Icon, type IconName } from './Icon';
import {
  deleteTask,
  dueTone,
  formatDueLabel,
  runTaskNow,
  shiftISO,
  todayISO,
  updateTask,
  useLastRun,
  useTaskSources,
  useTasks,
  useTypebuildAuth,
  useTypebuildReadiness,
} from '../tasks';
import type { Task } from '../types';
import { primaryActionFor } from './tasks/primaryAction.mjs';
import { deriveRunState } from './TaskIndicators';
import { formatOpError } from '../errorMessages';
import { useOpenResumeInTab } from '../openResumeInTab';
import { useSources } from '../sources';
import './Sidebar.css';

const MAX_VISIBLE_TASKS = 5;

/**
 * Left sidebar — port of themes.html `.sidebar`:
 *   - Favorites: 7 non-removable seeds (Home/Desktop/...) + user-pinned folders
 *   - Locations (boot volume, /Volumes externals, cloud providers, iCloud
 *     Drive — enumerated via fm.listLocations, refreshed on window focus)
 *   - Tags (derived from state.tags — one colored dot per unique char)
 *   - Crest (solitary fleuron anchoring the column)
 *
 * Users add pins via the "Pin" verb in ChipPrompt, or by dragging a folder
 * onto the Favorites section. Non-folder drops surface a toast.
 */

interface Favorite {
  label: string;
  icon: IconName;
  /** Path suffix appended to home. '' = home itself. */
  rel: string;
}

const FAVORITES: Favorite[] = [
  { label: 'Home',      icon: 'home',     rel: '' },
  { label: 'Desktop',   icon: 'desktop',  rel: '/Desktop' },
  { label: 'Documents', icon: 'docs',     rel: '/Documents' },
  { label: 'Downloads', icon: 'download', rel: '/Downloads' },
  { label: 'Pictures',  icon: 'picture',  rel: '/Pictures' },
  { label: 'Music',     icon: 'music',    rel: '/Music' },
  { label: 'Movies',    icon: 'movie',    rel: '/Movies' },
];

/** Palette roles the tag dots cycle through. */
const TAG_DOT_COLORS = [
  'var(--accent)',
  'var(--hero-tint)',
  'var(--accent-2)',
] as const;

type Location = {
  id: string;
  label: string;
  path: string;
  icon: 'drive' | 'usb' | 'folder';
  kind: 'boot' | 'external' | 'cloud' | 'icloud';
  usedPct?: number;
  caption: string;
};

export function Sidebar() {
  const { state, activeTab, navigateTo, dispatch, refreshActive } = useStore();
  const [home, setHome] = useState<string>('');
  const [dropHover, setDropHover] = useState(false);
  const [rowDrop, setRowDrop] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);

  // Resolve home once. bridge.fm.homedir is async to cover Windows/Linux later.
  useEffect(() => {
    fm.homedir().then(setHome).catch(() => setHome(''));
  }, []);

  // Enumerate mountable locations (boot volume, /Volumes externals, cloud
  // providers, iCloud). Refresh on window focus so plugging a drive or
  // mounting a DMG while Breeze is in the background picks up on return.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fm.listLocations()
        .then((l) => { if (!cancelled) setLocations(l); })
        .catch(() => { if (!cancelled) setLocations([]); });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, []);

  const cwd = useMemo<string>(() => {
    if (!activeTab) return '';
    return activeTab.trail[activeTab.trail.length - 1] ?? '';
  }, [activeTab]);

  const favoritesWithPath = useMemo(() => {
    if (!home) return [] as Array<Favorite & { path: string }>;
    return FAVORITES.map((f) => ({ ...f, path: home + f.rel }));
  }, [home]);

  const uniqueTags = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const t of Object.values(state.tags)) {
      if (t) set.add(t);
    }
    return Array.from(set).sort();
  }, [state.tags]);

  const onNavigate = (p: string) => {
    void navigateTo(p);
  };

  // Drop onto a specific favorite row → move/copy files into that folder
  // (⌥ toggles copy). stopPropagation prevents the section-level pin handler
  // from also firing.
  const onRowDragOver = (targetPath: string) => (e: React.DragEvent) => {
    if (!dragHasAnyPaths(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // External drops always copy (we can't move out of Finder/web).
    e.dataTransfer.dropEffect = isExternalDrop() ? 'copy' : e.altKey ? 'copy' : 'move';
    setRowDrop(targetPath);
    setDropHover(false);
  };
  const onRowDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setRowDrop(null);
  };
  const onRowDrop = (targetPath: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRowDrop(null);
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
    if (paths.length === 0) return;
    const copy = external || e.altKey;
    const msg = await dropIntoFolder(paths, targetPath, srcCwd, copy, fm).catch(
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[drop] fs:paste failed', { err, paths, dst: targetPath, copy });
        return formatOpError('drop', err);
      },
    );
    if (msg) dispatch({ type: 'setStatus', msg });
    await refreshActive();
  };

  // Drag-drop onto Favorites: pin folders, toast for files.
  // FileRow/FileGrid strip dataTransfer via preventDefault during OS drag-out,
  // so we read the payload from the shared dragState module instead.
  const onFavoritesDragOver = (e: React.DragEvent) => {
    if (!dragHasAnyPaths(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    setDropHover(true);
  };
  const onFavoritesDragLeave = () => setDropHover(false);
  const onFavoritesDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
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
    endAppDrag();
    if (paths.length === 0) return;

    // Check which are folders.
    const stats = await Promise.all(paths.map((p) => fm.stat(p).catch(() => null)));
    const folders = paths.filter((_, i) => stats[i]?.isDir);
    const files = paths.filter((_, i) => stats[i] && !stats[i]?.isDir);

    for (const p of folders) dispatch({ type: 'pinFolder', path: p });

    if (folders.length > 0 && files.length === 0) {
      dispatch({
        type: 'setStatus',
        msg: `pinned ${folders.length} folder${folders.length === 1 ? '' : 's'}`,
      });
    } else if (folders.length === 0 && files.length > 0) {
      dispatch({ type: 'setStatus', msg: 'only folders can be pinned' });
    } else if (folders.length > 0 && files.length > 0) {
      dispatch({
        type: 'setStatus',
        msg: `pinned ${folders.length} folder${folders.length === 1 ? '' : 's'} · ${files.length} file${files.length === 1 ? '' : 's'} skipped (only folders can be pinned)`,
      });
    }
  };

  const pinned = state.pinned ?? [];
  const remoteSources = useSources().filter((s) => s.kind === 'remote');
  // Transient "just connected" set: a host pulses for ~3s on the
  // connecting→connected transition, then settles to a static dot.
  // Disconnects (explicit × OR tunnel drop) emit a brief status line.
  const [justConnected, setJustConnected] = useState<Set<string>>(new Set());
  // Hosts that just disconnected: kept mounted ~1.2s with a red
  // fade-out so the removal is visible (sidebar × OR verb OR drop).
  const [leaving, setLeaving] = useState<string[]>([]);
  const prevConnRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(
      remoteSources.filter((s) => s.status === 'connected').map((s) => s.id),
    );
    const prev = prevConnRef.current;
    for (const id of now) {
      if (!prev.has(id)) {
        setJustConnected((p) => new Set(p).add(id));
        dispatch({ type: 'setStatus', msg: `connected ${id}` });
        setTimeout(
          () =>
            setJustConnected((p) => {
              const n = new Set(p);
              n.delete(id);
              return n;
            }),
          3200,
        );
      }
    }
    for (const id of prev) {
      if (!now.has(id) && !remoteSources.some((s) => s.id === id)) {
        dispatch({ type: 'setStatus', msg: `disconnected ${id}` });
        setLeaving((p) => (p.includes(id) ? p : [...p, id]));
        setTimeout(
          () => setLeaving((p) => p.filter((x) => x !== id)),
          1200,
        );
      }
    }
    prevConnRef.current = now;
  }, [remoteSources, dispatch]);
  // fm-22o — gate the entire task subsystem behind the opt-in flag.
  const tasksEnabled = state.taskManagementEnabled;
  // TypeBuild sign-in visibility: the dedicated nav row only appears when
  // TypeBuild is enabled AND the user is signed out, so a dropped/expired
  // session is impossible to miss. (The persistent status badge lives on the
  // Active Tasks header below.)
  const tbEnabled = state.typebuildEnabled;
  const { signedIn: tbSignedIn } = useTypebuildAuth();
  const openTypebuildSettings = () =>
    window.dispatchEvent(
      new CustomEvent('fm:openSettings', { detail: { section: 'typebuild' } }),
    );

  return (
    <aside className="sidebar" aria-label="Sidebar">
      {tbEnabled && !tbSignedIn && (
        <button
          type="button"
          className="sidebar__tb-signin"
          onClick={openTypebuildSettings}
          title="You're signed out of TypeBuild — click to sign in"
        >
          <span className="sidebar__tb-signin-dot" aria-hidden="true" />
          <span className="sidebar__tb-signin-label">
            TypeBuild · signed out
          </span>
          <span className="sidebar__tb-signin-action">Sign in</span>
        </button>
      )}

      {tasksEnabled && <ActiveTasksSection cwd={cwd} />}

      <h4 className="sidebar__section-title">Favorites</h4>
      {favoritesWithPath.map((f) => (
        <button
          key={f.rel || 'home'}
          type="button"
          className={`${linkClass(cwd === f.path)} ${rowDrop === f.path ? 'sidebar__link--drop' : ''}`}
          onClick={() => onNavigate(f.path)}
          onDragOver={onRowDragOver(f.path)}
          onDragLeave={onRowDragLeave}
          onDrop={onRowDrop(f.path)}
          title={f.path}
        >
          <span className="sidebar__ico">
            <Icon name={f.icon} size={18} />
          </span>
          {f.label}
        </button>
      ))}

      <h4 className="sidebar__section-title">Pinned folders</h4>
      <div
        className={`sidebar__drop ${dropHover ? 'sidebar__drop--hover' : ''}`}
        onDragOver={onFavoritesDragOver}
        onDragLeave={onFavoritesDragLeave}
        onDrop={onFavoritesDrop}
      >
        {pinned.length === 0 && (
          <div className="sidebar__empty" title="Open the chip prompt and type 'pin' to add a folder">
            Drop a folder here, or type <kbd>pin</kbd> to add one.
          </div>
        )}
        {pinned.map((p) => (
          <button
            key={`pin:${p}`}
            type="button"
            className={`${linkClass(cwd === p)} ${rowDrop === p ? 'sidebar__link--drop' : ''}`}
            onClick={() => onNavigate(p)}
            onDragOver={onRowDragOver(p)}
            onDragLeave={onRowDragLeave}
            onDrop={onRowDrop(p)}
            title={p}
          >
            <span className="sidebar__ico">
              <Icon name="pin" size={18} />
            </span>
            <span className="sidebar__pin-label">{basename(p) || p}</span>
            <span
              className="sidebar__unpin"
              role="button"
              aria-label={`Unpin ${basename(p) || p}`}
              title={`Unpin ${basename(p) || p}`}
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'unpinFolder', path: p });
                dispatch({
                  type: 'setStatus',
                  msg: `unpinned ${basename(p) || p}`,
                });
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>

      {(remoteSources.length > 0 ||
        leaving.some((id) => !remoteSources.some((s) => s.id === id))) && (
        <>
          <h4 className="sidebar__section-title">Connected hosts</h4>
          {remoteSources.map((s) => (
            <button
              key={`src:${s.id}`}
              type="button"
              className={`${linkClass(false)}${
                s.status === 'connecting'
                  ? ' sidebar__src--connecting'
                  : justConnected.has(s.id)
                    ? ' sidebar__src--flash'
                    : ''
              }`}
              title={
                s.status === 'connecting'
                  ? `Connecting to ${s.id}…`
                  : `${s.id} — its tasks show in their own section`
              }
            >
              <span className="sidebar__ico">
                <Icon name="link" size={18} />
              </span>
              <span className="sidebar__pin-label">
                <span
                  className={`sidebar__src-dot ${
                    s.status === 'connecting'
                      ? 'sidebar__src-dot--connecting'
                      : 'sidebar__src-dot--live'
                  }`}
                  aria-hidden="true"
                />
                {s.id}
                {s.status === 'connecting' ? ' (connecting…)' : ''}
              </span>
              <span
                className="sidebar__unpin"
                role="button"
                aria-label={`Disconnect ${s.id}`}
                title={`Disconnect ${s.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // The sources effect emits the "disconnected X" status
                  // (covers tunnel-drop too) — don't double-message here.
                  void fm.sourcesDisconnect(s.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
          {leaving
            .filter((id) => !remoteSources.some((s) => s.id === id))
            .map((id) => (
              <button
                key={`src-leaving:${id}`}
                type="button"
                disabled
                className={`${linkClass(false)} sidebar__src--leaving`}
                title={`${id} disconnected`}
                aria-hidden="true"
              >
                <span className="sidebar__ico">
                  <Icon name="link" size={18} />
                </span>
                <span className="sidebar__pin-label">
                  <span
                    className="sidebar__src-dot sidebar__src-dot--gone"
                    aria-hidden="true"
                  />
                  {id} (disconnected)
                </span>
              </button>
            ))}
        </>
      )}

      <h4 className="sidebar__section-title">Locations</h4>
      {locations.map((loc) => (
        <DriveRow
          key={loc.id}
          label={loc.label}
          icon={loc.icon}
          usedPct={loc.usedPct}
          caption={loc.caption}
          active={cwd === loc.path}
          onClick={() => onNavigate(loc.path)}
          onDragOver={onRowDragOver(loc.path)}
          onDragLeave={onRowDragLeave}
          onDrop={onRowDrop(loc.path)}
          isDropTarget={rowDrop === loc.path}
          title={loc.path}
        />
      ))}

      {uniqueTags.length > 0 && (
        <>
          <h4 className="sidebar__section-title">Tags</h4>
          {uniqueTags.map((t, i) => (
            <div key={t} className="sidebar__link" role="listitem">
              <span
                className="sidebar__dot"
                style={{ background: TAG_DOT_COLORS[i % TAG_DOT_COLORS.length] }}
              />
              {tagLabel(t)}
            </div>
          ))}
        </>
      )}

      <div className="sidebar__crest">❦</div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

interface DriveRowProps {
  label: string;
  icon: IconName;
  /** 0–100; omit for cloud providers where no quota is known. */
  usedPct?: number;
  caption: string;
  active?: boolean;
  isDropTarget?: boolean;
  onClick?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  title?: string;
}

function DriveRow({
  label,
  icon,
  usedPct,
  caption,
  active,
  isDropTarget,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  title,
}: DriveRowProps) {
  const pct = usedPct == null ? null : Math.max(0, Math.min(100, usedPct));
  const cls = [
    'sidebar__drive',
    active ? 'sidebar__drive--active' : '',
    isDropTarget ? 'sidebar__drive--drop' : '',
    onClick ? 'sidebar__drive--clickable' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={title}
      disabled={!onClick}
    >
      <span className="sidebar__ico sidebar__drive-ico">
        <Icon name={icon} size={18} />
      </span>
      <span className="sidebar__drive-label">{label}</span>
      {pct !== null ? (
        <div className="sidebar__drive-bar" aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div className="sidebar__drive-bar sidebar__drive-bar--empty" aria-hidden />
      )}
      <div className="sidebar__drive-sub">{caption}</div>
    </button>
  );
}

function linkClass(active: boolean): string {
  return active ? 'sidebar__link sidebar__link--active' : 'sidebar__link';
}

// ---------------------------------------------------------------------------
// fm-6pk — Active Tasks section.
//
// Lives above Favorites because the file manager doubles as a project hub:
// users want to see what's on their plate without switching tools, and a
// click should jump them to the folder where that work lives.

interface ActiveTasksSectionProps {
  cwd: string;
}

// fm-zf3m — auto-completion window. After an auto task succeeds and
// flips to status='done' it would normally vanish from this section
// immediately. Keep it visible for a short grace period so the user
// sees the success indicator transition from running → succeeded
// before the row drops off. 5min covers the "I went to grab a coffee"
// case without polluting the active list long-term.
const AUTO_DONE_VISIBLE_MS = 5 * 60_000;

function ActiveTasksSection({ cwd }: ActiveTasksSectionProps) {
  const { state, dispatch } = useStore();
  // Persistent TypeBuild sign-in status chip (both states), shown only when
  // TypeBuild is enabled. Click routes to Settings → TypeBuild.
  const { signedIn: tbSignedIn } = useTypebuildAuth();
  const tbEnabled = state.typebuildEnabled;
  // Pull all tasks (not activeOnly) so we can include recently-completed
  // auto tasks; filter client-side. The list is small in practice.
  const { tasks: all } = useTasks({});
  const [menuFor, setMenuFor] = useState<{ task: Task; x: number; y: number } | null>(null);
  // Re-render every 30s so the "5min ago" cutoff actually drops stale
  // completions off the list without waiting on an unrelated event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const today = todayISO();
  const tasks = useMemo(() => {
    const now = Date.now();
    return all.filter((t) => {
      // Active per the existing rule: not done/cancelled, and start_at
      // hasn't deferred it past today.
      const active =
        t.status !== 'done' &&
        t.status !== 'cancelled' &&
        (!t.start_at || t.start_at <= today);
      if (active) return true;
      // Grace window for auto tasks that just completed.
      if (
        t.auto_mode &&
        t.status === 'done' &&
        t.completed_at &&
        now - t.completed_at < AUTO_DONE_VISIBLE_MS
      ) {
        return true;
      }
      return false;
    });
  }, [all, today]);

  const visible = tasks.slice(0, MAX_VISIBLE_TASKS);
  const overflow = Math.max(0, tasks.length - MAX_VISIBLE_TASKS);

  // fm-csg — map taskId → 1-based tab number when an open task tab is
  // bound to it. Used to render the "active in tab N" indicator and to
  // make clicks idempotent (focus existing instead of double-creating).
  const taskTabIndex = useMemo(() => {
    const m = new Map<string, number>();
    state.tabs.forEach((t, i) => {
      if (t.kind === 'task' && t.taskId) m.set(t.taskId, i + 1);
    });
    return m;
  }, [state.tabs]);

  const openCreate = () => {
    window.dispatchEvent(
      new CustomEvent('fm:openTask', {
        detail: { mode: 'create', defaultFolder: cwd },
      }),
    );
  };
  const openAllTasks = () => {
    window.dispatchEvent(new CustomEvent('fm:openTasksPage'));
  };

  return (
    <>
      <h4 className="sidebar__section-title sidebar__section-title--with-action">
        <span className="sidebar__section-title-text">
          Active Tasks
          {tasks.length > 0 && (
            <span className="sidebar__section-count" aria-label={`${tasks.length} active`}>
              {tasks.length}
            </span>
          )}
          {/* fm-h8g7 — unseen task-notification badge (run completions +
              remote TypeBuild transitions seen while the Tasks page wasn't
              active). Clears when the user opens/activates the Tasks page. */}
          {state.tasksBadgeCount > 0 && (
            <span
              className="tasks__badge"
              aria-label={`${state.tasksBadgeCount} unseen task updates`}
              title="Unseen task updates — open Tasks to review"
            >
              {state.tasksBadgeCount > 99 ? '99+' : state.tasksBadgeCount}
            </span>
          )}
        </span>
        {tbEnabled && (
          <button
            type="button"
            className={`sidebar__tb-chip ${
              tbSignedIn ? 'sidebar__tb-chip--on' : 'sidebar__tb-chip--off'
            }`}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('fm:openSettings', {
                  detail: { section: 'typebuild' },
                }),
              )
            }
            title={
              tbSignedIn
                ? 'TypeBuild: signed in — click to manage'
                : 'TypeBuild: signed out — click to sign in'
            }
            aria-label={tbSignedIn ? 'TypeBuild signed in' : 'TypeBuild signed out'}
          >
            <span className="sidebar__tb-chip-dot" aria-hidden="true" />
            TB
          </button>
        )}
        <button
          type="button"
          className="sidebar__section-action"
          onClick={openCreate}
          title="Add task in current folder"
          aria-label="Add task"
        >
          +
        </button>
      </h4>

      {tasks.length === 0 && (
        <div className="sidebar__empty" title="Open the chip prompt and type 'task' to add one">
          No active tasks. Type <kbd>task</kbd> to add one.
        </div>
      )}

      {visible.map((t) => {
        const tabNumber = taskTabIndex.get(t.id) ?? null;
        return (
          <TaskRow
            key={t.id}
            task={t}
            // fm-csg — "active" now means an open task tab exists for
            // this task somewhere, not "this is the cwd". The cwd-match
            // signal isn't useful anymore: clicking a task always
            // opens it in a dedicated task tab.
            active={tabNumber !== null}
            tabNumber={tabNumber}
            onClick={() => {
              // fm-7909 — TypeBuild (remote, folderless, PHI) tasks have no
              // local folder to open a task tab against. Route the click to
              // the Tasks page focused on this row instead of spawning a
              // folderless task tab.
              if (t.source === 'typebuild') {
                window.dispatchEvent(new CustomEvent('fm:openTasksPage'));
                window.dispatchEvent(
                  new CustomEvent('fm:tasks:focus', { detail: { taskId: t.id } }),
                );
                return;
              }
              dispatch({
                type: 'openTaskTab',
                taskId: t.id,
                folder: t.folder,
              });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor({ task: t, x: e.clientX, y: e.clientY });
            }}
          />
        );
      })}

      {overflow > 0 && (
        <button
          type="button"
          className="sidebar__see-all"
          onClick={openAllTasks}
        >
          See all ({tasks.length})
        </button>
      )}

      {menuFor && (
        <TaskContextMenu
          task={menuFor.task}
          x={menuFor.x}
          y={menuFor.y}
          onClose={() => setMenuFor(null)}
        />
      )}
    </>
  );
}

interface TaskRowProps {
  task: Task;
  active: boolean;
  /** fm-csg — 1-based tab index of the open task tab bound to this task,
   *  or null when no task tab exists. Drives the "active in tab N" badge. */
  tabNumber: number | null;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function TaskRow({ task, active, tabNumber, onClick, onContextMenu }: TaskRowProps) {
  const today = todayISO();
  const tone = dueTone(task.due_at, today);
  // Live-poll the last run only for auto tasks. Drives the green concentric
  // pulse on the lead icon while the run is in flight.
  const lastRun = useLastRun(task.auto_mode ? task.id : null);
  const running = task.auto_mode && deriveRunState(task, lastRun).kind === 'running';
  // Brief glow when this task was just created. TaskComposer fires the
  // `fm:taskFlash` event AND stashes the id on window for the typical
  // case where this row mounts after the event fires (the new task only
  // shows up here on the next render tick).
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    const w = window as unknown as { __fmFlashTaskId?: string; __fmFlashTs?: number };
    function trigger() {
      setFlashing(true);
      window.setTimeout(() => setFlashing(false), 2000);
    }
    if (
      w.__fmFlashTaskId === task.id &&
      w.__fmFlashTs &&
      Date.now() - w.__fmFlashTs < 4000
    ) {
      // Clear the stash so a re-mount doesn't re-flash the same row.
      w.__fmFlashTaskId = undefined;
      trigger();
    }
    function onFlash(e: Event) {
      const ce = e as CustomEvent<{ taskId?: string }>;
      if (ce.detail?.taskId === task.id) trigger();
    }
    window.addEventListener('fm:taskFlash', onFlash);
    return () => window.removeEventListener('fm:taskFlash', onFlash);
  }, [task.id]);
  // fm-7909 — TypeBuild rows get a distinct lead glyph (link = remote source)
  // so they're visually separable from local manual/auto tasks at a glance.
  const isTypebuild = task.source === 'typebuild';
  const leadIcon = isTypebuild ? 'link' : task.auto_mode ? 'bolt' : 'circle';
  const cls = [
    'sidebar__task',
    active ? 'sidebar__task--active' : '',
    task.pinned ? 'sidebar__task--pinned' : '',
    `sidebar__task--${tone}`,
    task.auto_mode ? 'sidebar__task--auto' : '',
    isTypebuild ? 'sidebar__task--remote' : '',
    flashing ? 'sidebar__task--flash' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Single-line layout: lead glyph (⚡ auto / ● manual, colored by status)
  // + title + optional tab badge. Folder + due info move to the tooltip
  // since the second meta line was making the column feel crowded.
  const folderLabel = basename(task.folder) || task.folder;
  const dueLabel = task.due_at ? formatDueLabel(task.due_at, today) : '';
  const autoLabel = task.auto_mode ? 'auto' : 'manual';
  const tipParts = [
    `${task.title} · ${autoLabel}`,
    folderLabel,
    dueLabel,
    tabNumber !== null ? `open in tab ${tabNumber}` : '',
  ].filter(Boolean);

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={tipParts.join(' · ')}
    >
      <span className="sidebar__task-main">
        <span className="sidebar__task-title-row">
          <span
            className={`sidebar__ico sidebar__task-lead${running ? ' sidebar__task-lead--running' : ''}`}
            aria-label={
              isTypebuild ? 'TypeBuild task' : task.auto_mode ? 'Auto task' : 'Manual task'
            }
          >
            <Icon name={leadIcon} size={18} />
          </span>
          {task.pinned && (
            <span className="sidebar__task-pin" aria-label="Pinned" title="Pinned">
              ★
            </span>
          )}
          <span className="sidebar__task-title">{task.title}</span>
          {tabNumber !== null && (
            <span
              className="sidebar__task-tab-badge"
              aria-label={`Open in tab ${tabNumber}`}
            >
              {tabNumber}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

interface TaskContextMenuProps {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
}

function TaskContextMenu({ task, x, y, onClose }: TaskContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // fm-7909 — capability gating + primary action for the top item. Mutations
  // route through task.source so TypeBuild rows don't silently no-op against
  // the local store.
  const { byId } = useTaskSources();
  const caps = byId[task.source ?? 'local']?.capabilities;
  const canEdit = caps ? caps.canEdit : true;
  const canDelete = caps ? caps.canDelete : true;
  const tbReady = useTypebuildReadiness();
  const myEmail = (tbReady as { email?: string | null }).email ?? null;
  const primary = primaryActionFor(task, { caps, tbReady, myEmail });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const act = (fn: () => void | Promise<unknown>) => () => {
    void Promise.resolve(fn()).finally(onClose);
  };

  const onEdit = act(() => {
    window.dispatchEvent(
      new CustomEvent('fm:openTask', { detail: { mode: 'edit', task } }),
    );
  });
  const onDone = act(() => updateTask(task.id, { status: 'done' }, task.source));
  const onTogglePin = act(() =>
    updateTask(task.id, { pinned: !task.pinned }, task.source),
  );
  const onSnooze = act(() => {
    const base = task.due_at && task.due_at >= todayISO() ? task.due_at : todayISO();
    return updateTask(task.id, { due_at: shiftISO(base, 1) }, task.source);
  });
  const onDelete = act(() => deleteTask(task.id, task.source));
  // fm-zf3m — auto-execute actions. "Run now" uses the same path the
  // scheduler uses (executeTaskRun via IPC) so it inherits agent
  // selection, retry classification, and history rows.
  const onRunNow = act(() => runTaskNow(task.id, task.source));
  // fm-7909 — the top item mirrors the page's primary action.
  const onPrimary = act(() => {
    if (primary.kind === 'start' || primary.kind === 'run-now') {
      if (primary.kind === 'start' && !primary.enabled) return;
      return runTaskNow(task.id, task.source);
    }
    if (primary.kind === 'open-session') {
      window.dispatchEvent(new CustomEvent('fm:openTasksPage'));
      window.dispatchEvent(
        new CustomEvent('fm:tasks:focus', { detail: { taskId: task.id } }),
      );
      return;
    }
    if (primary.kind === 'done-toggle') {
      return updateTask(task.id, { status: 'done' }, task.source);
    }
    if (primary.kind === 'reopen') {
      return updateTask(task.id, { status: 'pending' }, task.source);
    }
    if (primary.kind === 'view-run') {
      window.dispatchEvent(
        new CustomEvent('fm:openRunHistory', { detail: { taskId: task.id } }),
      );
    }
  });
  const primaryLabel =
    primary.kind === 'start'
      ? '▸ Start'
      : primary.kind === 'run-now'
        ? '▸ Run now'
        : primary.kind === 'open-session'
          ? '⧉ Open session'
          : primary.kind === 'done-toggle'
            ? '✓ Mark done'
            : primary.kind === 'reopen'
              ? '↺ Reopen'
              : primary.kind === 'view-run'
                ? '◷ View run'
                : null;
  const onViewRuns = act(() => {
    window.dispatchEvent(
      new CustomEvent('fm:openRunHistory', { detail: { taskId: task.id } }),
    );
  });
  // The trace opener relies on the last run's session_id. We fetch it
  // lazily when clicked so we don't make a second IPC call per row.
  const openResumeInTab = useOpenResumeInTab();
  const onOpenTrace = act(async () => {
    const run = await fm.tasksLastRun(task.id);
    const session = run?.conversation_id;
    if (!session) {
      window.dispatchEvent(
        new CustomEvent('fm:setStatus', { detail: { msg: 'no session id on last run' } }),
      );
      return;
    }
    await openResumeInTab(task.folder, session, task.title);
  });

  // Clamp to viewport so the menu doesn't disappear off the right/bottom edge.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 220),
  };

  return (
    <div ref={ref} className="sidebar__ctxmenu" style={style} role="menu">
      {primaryLabel && primary.kind !== 'none' && (
        <>
          <button
            type="button"
            className="sidebar__ctxmenu-item sidebar__ctxmenu-item--primary"
            onClick={onPrimary}
            disabled={primary.kind === 'start' && !primary.enabled}
            title={primary.kind === 'start' ? primary.tooltip : undefined}
          >
            {primaryLabel}
          </button>
          <div className="sidebar__ctxmenu-sep" />
        </>
      )}
      {canEdit && (
        <button type="button" className="sidebar__ctxmenu-item" onClick={onEdit}>
          Edit
        </button>
      )}
      {canEdit && (
        <button type="button" className="sidebar__ctxmenu-item" onClick={onDone}>
          Mark done
        </button>
      )}
      {canEdit && (
        <button type="button" className="sidebar__ctxmenu-item" onClick={onTogglePin}>
          {task.pinned ? 'Unpin' : 'Pin'}
        </button>
      )}
      {canEdit && (
        <button type="button" className="sidebar__ctxmenu-item" onClick={onSnooze}>
          Snooze (+1 day)
        </button>
      )}
      {task.auto_mode && (
        <>
          <div className="sidebar__ctxmenu-sep" />
          <button type="button" className="sidebar__ctxmenu-item" onClick={onRunNow}>
            Run now
          </button>
          <button type="button" className="sidebar__ctxmenu-item" onClick={onViewRuns}>
            View run history
          </button>
          <button type="button" className="sidebar__ctxmenu-item" onClick={onOpenTrace}>
            Open last run in new tab
          </button>
        </>
      )}
      {canDelete && (
        <>
          <div className="sidebar__ctxmenu-sep" />
          <button
            type="button"
            className="sidebar__ctxmenu-item sidebar__ctxmenu-item--danger"
            onClick={onDelete}
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function tagLabel(t: string): string {
  // Single-char tags come from the ranger-compatible tag store. Show a
  // couple of common aliases readably; otherwise echo the char.
  if (t === '*' || t === 'f') return 'favorite';
  if (t === '!') return 'urgent';
  if (t === '?') return 'review';
  if (t === 'a') return 'archive';
  return `tag · ${t}`;
}
