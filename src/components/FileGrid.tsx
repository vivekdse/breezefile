import { useEffect, useState } from 'react';
import type { Entry } from '../types';
import { fm } from '../bridge';
import { beginDragIndicator } from './FileRow';
import './FileGrid.css';

type Props = {
  entries: Entry[];
  selIdx: number;
  activeColumn: boolean;
  marks: Record<string, true>;
  onSelect: (e: Entry) => void;
  onOpen: (e: Entry) => void;
};

export function FileGrid({ entries, selIdx, activeColumn, marks, onSelect, onOpen }: Props) {
  return (
    <div className="grid">
      {entries.map((e, i) => (
        <GridTile
          key={e.path}
          entry={e}
          selected={i === selIdx && activeColumn}
          marked={!!marks[e.path]}
          onClick={() => onSelect(e)}
          onDoubleClick={() => onOpen(e)}
        />
      ))}
    </div>
  );
}

function GridTile({
  entry,
  selected,
  marked,
  onClick,
  onDoubleClick,
}: {
  entry: Entry;
  selected: boolean;
  marked: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (entry.kind === 'file') {
      fm.thumb(entry.path, 128).then((p) => {
        if (!cancelled) setThumb(p);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.kind]);

  const cls = ['tile', selected && 'tile--selected', marked && 'tile--marked']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        fm.dragStart([entry.path]);
        beginDragIndicator([entry.path], e.currentTarget as HTMLElement);
      }}
    >
      <div className="tile__thumb">
        {thumb ? (
          <img src={`file://${thumb}`} alt="" />
        ) : (
          <div className="tile__icon" data-kind={entry.kind}>
            {entry.kind === 'dir' ? '▸' : entry.ext?.toUpperCase().slice(0, 3) || '·'}
          </div>
        )}
      </div>
      <div className="tile__name">{entry.name}</div>
    </div>
  );
}
