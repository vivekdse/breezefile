import { memo, useEffect, useRef, useState } from 'react';
import type { Entry } from '../types';
import { fm } from '../bridge';
import { beginDragIndicator, kindFor, iconNameFor } from './FileRow';
import { beginAppDrag, endAppDrag } from '../dragState';
import { Icon } from './Icon';
import './FileGrid.css';

type Props = {
  entries: Entry[];
  selIdx: number;
  activeColumn: boolean;
  marks: Record<string, true>;
  onSelect: (e: Entry) => void;
  onOpen: (e: Entry) => void;
  getDragPaths?: (e: Entry) => string[];
  variant?: 'grid' | 'preview';
};

export function FileGrid({ entries, selIdx, activeColumn, marks, onSelect, onOpen, getDragPaths, variant = 'grid' }: Props) {
  const thumbPx = variant === 'preview' ? 256 : 128;
  return (
    <div className={variant === 'preview' ? 'grid grid--preview' : 'grid'}>
      {entries.map((e, i) => (
        <GridTile
          key={e.path}
          entry={e}
          selected={i === selIdx && activeColumn}
          marked={!!marks[e.path]}
          onSelect={onSelect}
          onOpen={onOpen}
          getDragPaths={getDragPaths}
          thumbPx={thumbPx}
        />
      ))}
    </div>
  );
}

/**
 * fm-l6a — Memoized tile. Props are all primitives or stable refs (parent
 * uses useCallback for onSelect/onOpen), so a selection-only state change
 * only re-renders the two tiles whose `selected` flipped, not all of them.
 * Previously the inline `() => onSelect(e)` arrows churned every render,
 * defeating any downstream memoization; we now pass the stable parent
 * callbacks straight through and call them with the entry internally.
 */
const GridTile = memo(function GridTile({
  entry,
  selected,
  marked,
  onSelect,
  onOpen,
  getDragPaths,
  thumbPx,
}: {
  entry: Entry;
  selected: boolean;
  marked: boolean;
  onSelect: (e: Entry) => void;
  onOpen: (e: Entry) => void;
  getDragPaths?: (e: Entry) => string[];
  thumbPx: number;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (entry.kind === 'file') {
      fm.thumb(entry.path, thumbPx).then((p) => {
        if (!cancelled) setThumb(p);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.kind, thumbPx]);

  // fm-wml — mirror FileRow: keep the cursor tile in view on arrow nav.
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const cls = ['tile', selected && 'tile--selected', marked && 'tile--marked']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={ref}
      className={cls}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onOpen(entry)}
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
      <div className="tile__thumb">
        {thumb ? (
          <img src={fm.fileUrl(thumb)} alt="" />
        ) : (
          <div
            className={`tile__icon tile__icon--${kindFor(entry)}`}
            aria-hidden="true"
          >
            {entry.ext && entry.kind !== 'dir' && (
              <span className="tile__ext">{entry.ext.toUpperCase()}</span>
            )}
            <Icon name={iconNameFor(kindFor(entry))} size={56} />
          </div>
        )}
      </div>
      <div className="tile__name">{entry.name}</div>
    </div>
  );
});
