import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { fm } from '../bridge';
import { Icon, type IconName } from './Icon';
import './Sidebar.css';

/**
 * Left sidebar — port of themes.html `.sidebar`:
 *   - Favorites (Home / Desktop / Documents / Downloads / Pictures / Music / Movies)
 *   - Locations (drives with usage progress bars — v1 placeholder, real
 *     hot-plug detection deferred to a follow-up bead)
 *   - Tags (derived from state.tags — one colored dot per unique char)
 *   - Crest (solitary fleuron anchoring the column)
 *
 * Active detection compares the current tab's cwd to each favorite's path so
 * the selection ring follows navigation (including keyboard moves handled by
 * useKeyboard). Clicking a link calls navigateTo — the existing store helper
 * reused by the ChipPrompt/quickfind flow.
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
  const { state, activeTab, navigateTo } = useStore();
  const [home, setHome] = useState<string>('');

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

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <h4 className="sidebar__section-title">Favorites</h4>
      {favoritesWithPath.map((f) => (
        <button
          key={f.rel || 'home'}
          type="button"
          className={linkClass(cwd === f.path)}
          onClick={() => onNavigate(f.path)}
          title={f.path}
        >
          <span className="sidebar__ico">
            <Icon name={f.icon} size={18} />
          </span>
          {f.label}
        </button>
      ))}

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
