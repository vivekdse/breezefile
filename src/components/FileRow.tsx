import { memo, useEffect, useRef } from 'react';
import type { Entry } from '../types';
import { fm } from '../bridge';
import { beginAppDrag, endAppDrag } from '../dragState';
import { formatSize, formatMtime, matchSpan } from '../sort';
import { Icon, type IconName } from './Icon';
import './FileRow.css';

type Props = {
  entry: Entry;
  selected: boolean;
  activeColumn: boolean;
  marked: boolean;
  tag?: string;
  /** fm-uns — colors of active tag rules that match this row. Rendered as
   *  a stacked vertical band in the row's left gutter. Empty/undefined
   *  means no decoration. */
  tagColors?: string[];
  yanked: boolean;
  /** Zero-based row position — wires into the staggered fade-in (fm-z1f). */
  index?: number;
  /** Active text filter — when set, the matched span in `entry.name` is
   *  rendered with a highlight so users can see *why* a row matched. */
  filter?: string;
  onClick?: (entry: Entry) => void;
  onDoubleClick?: (entry: Entry) => void;
  onToggleMark?: (entry: Entry) => void;
  onContextMenu?: (entry: Entry, e: React.MouseEvent) => void;
  /** Returns the full set of paths to drag when this row initiates a drag.
   *  Used so a marked row drags every marked file (not just itself). The
   *  callback should be a stable ref (useCallback in the parent) so memo
   *  on FileRow keeps holding. */
  getDragPaths?: (entry: Entry) => string[];
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
  tagColors,
  yanked,
  index,
  onClick,
  onDoubleClick,
  onToggleMark,
  onContextMenu,
  getDragPaths,
  filter,
}: Props) {
  const ref = useRef<HTMLLIElement>(null);

  // Keep the cursor row in view — covers keyboard nav and programmatic
  // moves like focusEntryByName after mkdir/touch.
  useEffect(() => {
    if (!selected || !activeColumn) return;
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, activeColumn]);

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
        const paths = getDragPaths?.(entry) ?? [entry.path];
        const cwd = entry.path.slice(0, entry.path.lastIndexOf('/'));
        beginAppDrag(paths, cwd);
        fm.dragStart(paths);
        beginDragIndicator(paths, e.currentTarget as HTMLElement, {
          name: entry.name,
          iconName: iconNameFor(kindFor(entry)),
          startX: e.clientX,
          startY: e.clientY,
        });
      }}
      onDragEnd={() => endAppDrag()}
    >
      {tagColors && tagColors.length > 0 && (
        <span className="row__tagband" aria-hidden>
          {tagColors.map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </span>
      )}
      {/* Selection checkbox — single, prominent indicator of marked state.
          Uses a CSS-painted box (not a Unicode glyph) so the filled state can
          read as a real selection chip. The file-type icon is intentionally
          NOT swapped out when marked; row tint + checkbox carry the state,
          and keeping the icon preserves the at-a-glance kind cue. */}
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
      />
      <span className="row__icon" aria-hidden>
        <Icon name={iconNameFor(kindFor(entry))} size={15} />
      </span>
      <span className="row__name">
        {renderHighlightedName(entry.name, filter)}
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

function renderHighlightedName(name: string, filter?: string) {
  const span = matchSpan(name, filter ?? '');
  if (!span) return name;
  const [start, end] = span;
  return (
    <>
      {name.slice(0, start)}
      <mark className="row__match">{name.slice(start, end)}</mark>
      {name.slice(end)}
    </>
  );
}

export const FileRow = memo(FileRowInner);

// --- drag indicator ---
// Keeps a toast + source-row highlight visible for the whole drag session.
// The drag ends when any of: (a) dragend fires on the source element,
// (b) our window regains focus (user clicked back after dropping elsewhere),
// (c) pointerup in our window (drop inside our window), or
// (d) a generous hard-timeout fallback.
//
// fm-cxn — also renders a cursor-following "chip" so the user perceives the
// files being carried. We have to do this manually because the native drag
// handoff (`fm.dragStart`) requires `e.preventDefault()` on dragstart, which
// suppresses the browser's built-in drag-image. The chip is pure DOM (no
// React state) so pointermove stays cheap. `pointer-events: none` keeps it
// out of the way of drop targets.
export type DragChipMeta = {
  name: string;
  iconName?: IconName;
  /** Pointer position at dragstart — used for the chip's first paint so it
   *  appears under the cursor immediately rather than at (0,0). */
  startX?: number;
  startY?: number;
};

export function beginDragIndicator(
  paths: string[],
  sourceEl: HTMLElement,
  meta?: DragChipMeta,
) {
  endDragIndicator(); // clear any prior session

  const count = paths.length;
  const primaryName =
    meta?.name ?? paths[0].split('/').pop() ?? paths[0];
  const iconName: IconName = meta?.iconName ?? 'file';

  // Cursor-following chip. SVG <use href="#i-…"> resolves against the
  // app-wide IconSprite mounted at the React root.
  const chip = document.createElement('div');
  chip.className = 'drag-chip';
  chip.innerHTML = `
    <span class="drag-chip__icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" focusable="false">
        <use href="#i-${iconName}"></use>
      </svg>
    </span>
    <span class="drag-chip__name">${escapeHtml(truncate(primaryName, 28))}</span>
    ${count > 1 ? `<span class="drag-chip__badge">+${count - 1}</span>` : ''}
  `;
  // Initial position — try to use the dragstart pointer so the chip doesn't
  // flash at the top-left corner before the first pointermove.
  const initX = meta?.startX ?? -9999;
  const initY = meta?.startY ?? -9999;
  chip.style.transform = `translate3d(${initX + 12}px, ${initY + 12}px, 0)`;
  document.body.appendChild(chip);

  sourceEl.classList.add('row--dragging');
  sourceEl.classList.add('tile--dragging'); // harmless on non-tile

  // pointermove handler — uses translate3d so it gets a compositor layer.
  const onMove = (ev: PointerEvent) => {
    chip.style.transform = `translate3d(${ev.clientX + 12}px, ${ev.clientY + 12}px, 0)`;
  };
  window.addEventListener('pointermove', onMove);
  // dragover also fires during native drag; pointermove may be paused on
  // some platforms once the OS-native drag is in flight. Using both keeps
  // the chip glued to the cursor on macOS.
  const onDragOver = (ev: DragEvent) => {
    chip.style.transform = `translate3d(${ev.clientX + 12}px, ${ev.clientY + 12}px, 0)`;
  };
  window.addEventListener('dragover', onDragOver);

  currentDrag = {
    chip,
    source: sourceEl,
    cleanup: () => {
      sourceEl.classList.remove('row--dragging');
      sourceEl.classList.remove('tile--dragging');
      chip.classList.add('drag-chip--out');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('dragover', onDragOver);
      window.setTimeout(() => {
        chip.remove();
      }, 200);
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
  chip: HTMLElement;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
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
