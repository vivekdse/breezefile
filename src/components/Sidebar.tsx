import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import { basename } from '../actions';
import {
  currentDragPaths,
  currentDragSourceCwd,
  dropIntoFolder,
  endAppDrag,
  hasAppDrag,
} from '../dragState';
import { Icon, type IconName } from './Icon';
import { deleteTask, shiftISO, todayISO, updateTask, useTasks } from '../tasks';
import type { Task } from '../types';
import './Sidebar.css';

const MAX_VISIBLE_TASKS = 10;

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
    if (!hasAppDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
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
    const paths = currentDragPaths();
    const srcCwd = currentDragSourceCwd();
    endAppDrag();
    if (paths.length === 0) return;
    const msg = await dropIntoFolder(paths, targetPath, srcCwd, e.altKey, fm).catch(
      (err) => `drop failed: ${(err as Error).message}`,
    );
    if (msg) dispatch({ type: 'setStatus', msg });
    await refreshActive();
  };

  // Drag-drop onto Favorites: pin folders, toast for files.
  // FileRow/FileGrid strip dataTransfer via preventDefault during OS drag-out,
  // so we read the payload from the shared dragState module instead.
  const onFavoritesDragOver = (e: React.DragEvent) => {
    if (!hasAppDrag()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    setDropHover(true);
  };
  const onFavoritesDragLeave = () => setDropHover(false);
  const onFavoritesDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const paths = currentDragPaths();
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
  // fm-22o — gate the entire task subsystem behind the opt-in flag.
  const tasksEnabled = state.taskManagementEnabled;

  return (
    <aside className="sidebar" aria-label="Sidebar">
      {tasksEnabled && <ActiveTasksSection cwd={cwd} onNavigate={onNavigate} />}

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
  onNavigate: (p: string) => void;
}

function ActiveTasksSection({ cwd, onNavigate }: ActiveTasksSectionProps) {
  const { tasks } = useTasks({ activeOnly: true });
  const [menuFor, setMenuFor] = useState<{ task: Task; x: number; y: number } | null>(null);

  const visible = tasks.slice(0, MAX_VISIBLE_TASKS);
  const overflow = Math.max(0, tasks.length - MAX_VISIBLE_TASKS);

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
        <span>Active Tasks</span>
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

      {visible.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          active={cwd === t.folder}
          onClick={() => onNavigate(t.folder)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuFor({ task: t, x: e.clientX, y: e.clientY });
          }}
        />
      ))}

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
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function TaskRow({ task, active, onClick, onContextMenu }: TaskRowProps) {
  const today = todayISO();
  const tone = dueTone(task.due_at, today);
  const cls = [
    'sidebar__task',
    active ? 'sidebar__task--active' : '',
    task.pinned ? 'sidebar__task--pinned' : '',
    `sidebar__task--${tone}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={task.title}
    >
      <span className="sidebar__task-rail" aria-hidden="true" />
      <span className="sidebar__task-main">
        <span className="sidebar__task-title-row">
          {task.pinned && (
            <span className="sidebar__task-pin" aria-label="Pinned" title="Pinned">
              ★
            </span>
          )}
          <span className="sidebar__task-title">{task.title}</span>
        </span>
        <span className="sidebar__task-meta">
          <span className="sidebar__task-folder">
            {basename(task.folder) || task.folder}
          </span>
          {task.due_at && (
            <>
              <span className="sidebar__task-meta-sep" aria-hidden="true">
                ·
              </span>
              <span className={`sidebar__task-due sidebar__task-due--${tone}`}>
                {formatDueLabel(task.due_at, today)}
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

type DueTone = 'overdue' | 'today' | 'soon' | 'future' | 'none';

function dueTone(due: string | null, today: string): DueTone {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  // "soon" = within the next 3 days
  const diffDays = daysBetween(today, due);
  if (diffDays <= 3) return 'soon';
  return 'future';
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

function formatDueLabel(due: string, today: string): string {
  if (due < today) {
    const days = daysBetween(due, today);
    return days === 1 ? '1d overdue' : `${days}d overdue`;
  }
  if (due === today) return 'today';
  const days = daysBetween(today, due);
  if (days === 1) return 'tomorrow';
  if (days < 7) {
    // Day-of-week label for proximate dates feels more human than a date.
    const [y, m, d] = due.split('-').map(Number);
    const dow = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
    return dow.toLowerCase();
  }
  // 'YYYY-MM-DD' → 'Apr 30' for distant dates.
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

interface TaskContextMenuProps {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
}

function TaskContextMenu({ task, x, y, onClose }: TaskContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

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
  const onDone = act(() => updateTask(task.id, { status: 'done' }));
  const onTogglePin = act(() => updateTask(task.id, { pinned: !task.pinned }));
  const onSnooze = act(() => {
    const base = task.due_at && task.due_at >= todayISO() ? task.due_at : todayISO();
    return updateTask(task.id, { due_at: shiftISO(base, 1) });
  });
  const onDelete = act(() => deleteTask(task.id));

  // Clamp to viewport so the menu doesn't disappear off the right/bottom edge.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 220),
  };

  return (
    <div ref={ref} className="sidebar__ctxmenu" style={style} role="menu">
      <button type="button" className="sidebar__ctxmenu-item" onClick={onEdit}>
        Edit
      </button>
      <button type="button" className="sidebar__ctxmenu-item" onClick={onDone}>
        Mark done
      </button>
      <button type="button" className="sidebar__ctxmenu-item" onClick={onTogglePin}>
        {task.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button type="button" className="sidebar__ctxmenu-item" onClick={onSnooze}>
        Snooze (+1 day)
      </button>
      <div className="sidebar__ctxmenu-sep" />
      <button
        type="button"
        className="sidebar__ctxmenu-item sidebar__ctxmenu-item--danger"
        onClick={onDelete}
      >
        Delete
      </button>
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
