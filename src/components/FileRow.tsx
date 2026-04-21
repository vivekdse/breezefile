import { useRef } from 'react';
import type { Entry } from '../types';
import { fm } from '../bridge';
import { formatSize, formatMtime } from '../sort';
import { useStore } from '../store';
import { useOverlays } from '../overlays';
import { Icon, type IconName } from './Icon';
import './FileRow.css';

type Props = {
  entry: Entry;
  selected: boolean;
  activeColumn: boolean;
  marked: boolean;
  tag?: string;
  yanked: boolean;
  /** Zero-based row position — wires into the staggered fade-in (fm-z1f). */
  index?: number;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onToggleMark?: () => void;
};

/**
 * Single source of truth for an entry's visual "kind" — used to pick both
 * the row tint class and the sprite icon. Extension groupings mirror the
 * categories used by Finder's column view so the left-gutter glyph gives
 * the same at-a-glance signal users expect.
 */
type Kind =
  | 'folder'
  | 'link'
  | 'app'
  | 'image'
  | 'film'
  | 'music'
  | 'archive'
  | 'code'
  | 'document'
  | 'exec'
  | 'file';

function kindFor(e: Entry): Kind {
  if (e.kind === 'dir') return 'folder';
  if (e.kind === 'link') return 'link';
  const ext = (e.ext ?? '').toLowerCase();
  if (ext === 'app') return 'app';
  switch (ext) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'svg':
    case 'heic':
    case 'ico':
      return 'image';
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'webm':
    case 'mkv':
      return 'film';
    case 'mp3':
    case 'm4a':
    case 'wav':
    case 'flac':
    case 'ogg':
      return 'music';
    case 'zip':
    case 'tar':
    case 'gz':
    case 'tgz':
    case '7z':
    case 'rar':
    case 'bz2':
      return 'archive';
    case 'js':
    case 'ts':
    case 'tsx':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'rb':
    case 'sh':
    case 'java':
    case 'c':
    case 'cpp':
    case 'h':
    case 'swift':
    case 'kt':
      return 'code';
    case 'md':
    case 'txt':
    case 'pdf':
    case 'doc':
    case 'docx':
    case 'csv':
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return 'document';
    default:
      return e.kind === 'exec' ? 'exec' : 'file';
  }
}

/**
 * Per-type row modifier class — drives the icon tint in FileRow.css.
 * Editorial: different hues for dir / image / film / code / link / exec /
 * archive / music / document / app, with plain files left at muted ink.
 */
function typeClassFor(e: Entry): string {
  const k = kindFor(e);
  if (k === 'file') return '';
  return `row--${k}`;
}

/** Map a kind to its sprite icon name (see src/components/icons.tsx). */
function iconNameFor(k: Kind): IconName {
  switch (k) {
    case 'folder':
      return 'folder';
    case 'link':
      return 'link';
    case 'app':
      return 'app';
    case 'image':
      return 'image';
    case 'film':
      return 'film';
    case 'music':
      return 'music';
    case 'archive':
      return 'archive';
    case 'code':
      return 'code';
    case 'document':
      return 'text';
    case 'exec':
      return 'app';
    default:
      return 'file';
  }
}

export function FileRow({
  entry,
  selected,
  activeColumn,
  marked,
  tag,
  yanked,
  index,
  onClick,
  onDoubleClick,
  onToggleMark,
}: Props) {
  const ref = useRef<HTMLLIElement>(null);
  const { state, activeTab, dispatch, refreshActive } = useStore();
  const overlays = useOverlays();

  const cls = [
    'row',
    typeClassFor(entry),
    selected && (activeColumn ? 'row--selected' : 'row--selected-inactive'),
    marked && 'row--marked',
    yanked && 'row--yanked',
  ]
    .filter(Boolean)
    .join(' ');

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();

    const parentDir = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
    const baseName = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const hasClipboard = state.yank.length > 0;
    const cwd = activeTab?.trail[activeTab.trail.length - 1] ?? parentDir;

    async function doPasteInto(dst: string) {
      if (state.yank.length === 0) return;
      try {
        await fm.paste(
          state.yank.map((y) => ({ src: y.path, dst, mode: y.mode })),
        );
        if (state.yank[0].mode === 'move') dispatch({ type: 'setYank', yank: [] });
        await refreshActive();
        dispatch({ type: 'setStatus', msg: `pasted ${state.yank.length} into ${dst.split('/').pop() || '/'}` });
      } catch (err) {
        dispatch({ type: 'setStatus', msg: `paste failed: ${(err as Error).message}` });
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
        dispatch({ type: 'setStatus', msg: `duplicate failed: ${(err as Error).message}` });
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
                    trail: [entry.path],
                    selected: { 0: 0 },
                    marks: {},
                    sortKey: 'name',
                    sortReverse: false,
                    showHidden: false,
                    viewMode: 'list',
                    filter: '',
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
            action: () => {
              if (appName === 'QuickLook') fm.runCommand(cwd, `qlmanage -p "${entry.path.replace(/"/g, '\\"')}" >/dev/null 2>&1 &`);
              else if (appName === 'Finder') fm.openWith(entry.path, 'Finder');
              else fm.openWith(entry.path, appName);
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
      { label: 'Copy Path', action: () => fm.clipboardWrite(entry.path) },
      { label: 'Copy Name', action: () => fm.clipboardWrite(entry.name) },
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
          await fm.trash([entry.path]);
          await refreshActive();
        },
      },
    ];

    showContextMenu(e.clientX, e.clientY, items);
  }

  function onDragStart(e: React.DragEvent) {
    e.preventDefault();
    fm.dragStart([entry.path]);
    beginDragIndicator([entry.path], e.currentTarget as HTMLElement);
  }

  return (
    <li
      ref={ref}
      className={cls}
      /* --row-i feeds the staggered fade-in keyframe (FileRow.css → fm-z1f). */
      style={index != null ? ({ ['--row-i' as string]: index } as React.CSSProperties) : undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
    >
      {/* Checkbox affordance for selection. Neutral styling — the design-system
          teammate will own real tokens/visuals via the row__checkbox class. */}
      <span
        className={['row__checkbox', marked && 'row__checkbox--checked'].filter(Boolean).join(' ')}
        role="checkbox"
        aria-checked={marked}
        tabIndex={-1}
        title="Press space to select"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMark?.();
        }}
      >
        {marked ? '☑' : '☐'}
      </span>
      <span className="row__icon" aria-hidden>
        {marked ? (
          <span className="row__icon-mark">✓</span>
        ) : (
          <Icon name={iconNameFor(kindFor(entry))} size={15} />
        )}
      </span>
      <span className="row__name">
        {entry.name}
        {tag && <span className="row__tag">•{tag}</span>}
      </span>
      <span className="row__meta">
        {entry.kind !== 'dir' && formatSize(entry.size)}
        <span className="row__mtime">{formatMtime(entry.mtimeMs)}</span>
      </span>
      {entry.kind === 'dir' && (
        <span className="row__chev" aria-hidden>
          ›
        </span>
      )}
    </li>
  );
}

// --- drag indicator ---
// Keeps a toast + source-row highlight visible for the whole drag session.
// The drag ends when any of: (a) dragend fires on the source element,
// (b) our window regains focus (user clicked back after dropping elsewhere),
// (c) pointerup in our window (drop inside our window), or
// (d) a generous hard-timeout fallback.
export function beginDragIndicator(paths: string[], sourceEl: HTMLElement) {
  endDragIndicator(); // clear any prior session

  const el = document.createElement('div');
  el.className = 'drag-toast';
  const count = paths.length;
  const name = paths[0].split('/').pop() ?? paths[0];
  el.innerHTML = `
    <span class="drag-toast__glyph">⇣</span>
    <span class="drag-toast__text">dragging ${
      count === 1 ? name : `${count} items`
    } — drop on Slack, Gmail, Finder…</span>
  `;
  document.body.appendChild(el);
  sourceEl.classList.add('row--dragging');
  sourceEl.classList.add('tile--dragging'); // harmless on non-tile

  currentDrag = {
    toast: el,
    source: sourceEl,
    cleanup: () => {
      sourceEl.classList.remove('row--dragging');
      sourceEl.classList.remove('tile--dragging');
      el.classList.add('drag-toast--out');
      window.setTimeout(() => el.remove(), 200);
    },
  };

  const onEnd = () => endDragIndicator();
  sourceEl.addEventListener('dragend', onEnd, { once: true });
  window.addEventListener('focus', onEnd, { once: true });
  window.addEventListener('pointerup', onEnd, { once: true });
  // Hard fallback — 60s is longer than any reasonable drag.
  currentDrag.timer = window.setTimeout(onEnd, 60_000);
}

type DragSession = {
  toast: HTMLElement;
  source: HTMLElement;
  cleanup: () => void;
  timer?: number;
};
let currentDrag: DragSession | null = null;

function endDragIndicator() {
  if (!currentDrag) return;
  if (currentDrag.timer != null) window.clearTimeout(currentDrag.timer);
  currentDrag.cleanup();
  currentDrag = null;
}

// --- lightweight context menu impl ---
type MenuItem =
  | { label: string; action: () => void | Promise<void> }
  | { label: string; submenu: MenuItem[] }
  | { separator: true };

function showContextMenu(x: number, y: number, items: MenuItem[]) {
  const existing = document.querySelector('.ctx-menu');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  /* fm-74p — transform-origin pinned to the cursor so the menu scales
     out from where you clicked (gpPopIn handles the actual anim). The
     cursor is in viewport coords; the menu is positioned with the same
     coords so `left top` of the element IS the click point. */
  el.style.transformOrigin = 'left top';
  for (const item of items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu__sep';
      el.appendChild(sep);
    } else {
      const btn = document.createElement('div');
      btn.className = 'ctx-menu__item';
      btn.textContent = item.label;
      if ('submenu' in item) {
        btn.classList.add('ctx-menu__item--has-submenu');
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        arrow.className = 'ctx-menu__arrow';
        btn.appendChild(arrow);
        let sub: HTMLElement | null = null;
        btn.addEventListener('mouseenter', () => {
          if (sub) return;
          sub = document.createElement('div');
          sub.className = 'ctx-menu';
          sub.style.left = `${btn.getBoundingClientRect().right}px`;
          sub.style.top = `${btn.getBoundingClientRect().top}px`;
          for (const si of item.submenu) {
            if ('separator' in si) continue;
            const sb = document.createElement('div');
            sb.className = 'ctx-menu__item';
            sb.textContent = si.label;
            sb.addEventListener('click', () => {
              if ('action' in si) si.action();
              close();
            });
            sub.appendChild(sb);
          }
          document.body.appendChild(sub);
        });
        btn.addEventListener('mouseleave', (e) => {
          const related = e.relatedTarget as Node | null;
          if (sub && related && sub.contains(related)) return;
          setTimeout(() => {
            if (sub && !sub.matches(':hover')) {
              sub.remove();
              sub = null;
            }
          }, 100);
        });
      } else {
        btn.addEventListener('click', () => {
          item.action();
          close();
        });
      }
      el.appendChild(btn);
    }
  }
  document.body.appendChild(el);
  function close() {
    el.remove();
    document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') close();
  }
  setTimeout(() => document.addEventListener('click', close), 0);
  document.addEventListener('keydown', onKey);
}
