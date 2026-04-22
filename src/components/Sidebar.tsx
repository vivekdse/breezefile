import { useEffect, useMemo, useState } from 'react';
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
import './Sidebar.css';

/**
 * Left sidebar — port of themes.html `.sidebar`:
 *   - Favorites: 7 non-removable seeds (Home/Desktop/...) + user-pinned folders
 *   - Locations (drives with usage progress bars — v1 placeholder, real
 *     hot-plug detection deferred to a follow-up bead)
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

export function Sidebar() {
  const { state, activeTab, navigateTo, dispatch, refreshActive } = useStore();
  const [home, setHome] = useState<string>('');
  const [dropHover, setDropHover] = useState(false);
  const [rowDrop, setRowDrop] = useState<string | null>(null);

  // Resolve home once. bridge.fm.homedir is async to cover Windows/Linux later.
  useEffect(() => {
    fm.homedir().then(setHome).catch(() => setHome(''));
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

  return (
    <aside className="sidebar" aria-label="Sidebar">
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
      {/* TODO(fm-followup): real drive detection + hot-plug. For v1 we
          render a placeholder so the visual anchor exists. */}
      <DriveRow label="Macintosh HD" icon="drive" usedPct={62} caption="312 GB of 500 GB used" />

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
  /** 0–100 */
  usedPct: number;
  caption: string;
}

function DriveRow({ label, icon, usedPct, caption }: DriveRowProps) {
  const pct = Math.max(0, Math.min(100, usedPct));
  return (
    <div className="sidebar__drive">
      <span className="sidebar__ico sidebar__drive-ico">
        <Icon name={icon} size={18} />
      </span>
      <span className="sidebar__drive-label">{label}</span>
      <div className="sidebar__drive-bar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sidebar__drive-sub">{caption}</div>
    </div>
  );
}

function linkClass(active: boolean): string {
  return active ? 'sidebar__link sidebar__link--active' : 'sidebar__link';
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
