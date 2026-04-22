import { memo, useRef } from 'react';
import type { Entry } from '../types';
import { fm } from '../bridge';
import { formatSize, formatMtime } from '../sort';
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
  onClick?: (entry: Entry) => void;
  onDoubleClick?: (entry: Entry) => void;
  onToggleMark?: (entry: Entry) => void;
  onContextMenu?: (entry: Entry, e: React.MouseEvent) => void;
};

/**
 * Single source of truth for an entry's visual "kind" — used to pick both
 * the row tint class and the sprite icon. Extension groupings mirror the
 * categories used by Finder's column view so the left-gutter glyph gives
 * the same at-a-glance signal users expect.
 */
export type Kind =
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

export function kindFor(e: Entry): Kind {
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
export function iconNameFor(k: Kind): IconName {
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

/**
 * fm-l6a — Dumb, memoizable row. Does NOT subscribe to the store.
 *
 * Previously this component called `useStore()` inside render, so every
 * reducer dispatch (including selection-moves) re-rendered every visible
 * row. On large folders (Downloads with hundreds of items) that made
 * arrow-key navigation visibly laggy. The context-menu handler — the
 * only reason we needed the store down here — is now built in FolderList
 * and passed in as a stable prop. Combined with React.memo below, a
 * selection change now only re-renders the two rows whose `selected`
 * prop actually flipped.
 */
function FileRowInner({
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
  onContextMenu,
}: Props) {
  const ref = useRef<HTMLLIElement>(null);

  const cls = [
    'row',
    typeClassFor(entry),
    selected && (activeColumn ? 'row--selected' : 'row--selected-inactive'),
    marked && 'row--marked',
    yanked && 'row--yanked',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li
      ref={ref}
      className={cls}
      /* fm-33l — data-path lets celebratePaths() find a row by its fs path
         and add .row--celebrated for the bulk-op completion pulse. */
      data-path={entry.path}
      /* --row-i feeds the staggered fade-in keyframe (FileRow.css → fm-z1f). */
      style={index != null ? ({ ['--row-i' as string]: index } as React.CSSProperties) : undefined}
      onClick={onClick ? () => onClick(entry) : undefined}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(entry) : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(entry, e);
      }}
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        fm.dragStart([entry.path]);
        beginDragIndicator([entry.path], e.currentTarget as HTMLElement);
      }}
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
          onToggleMark?.(entry);
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

export const FileRow = memo(FileRowInner);

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
export type MenuItem =
  | { label: string; action: () => void | Promise<void> }
  | { label: string; submenu: MenuItem[] }
  | { separator: true };

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
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
