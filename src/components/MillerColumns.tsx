import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { visibleEntries, basename } from '../actions';
import { fm } from '../bridge';
import { FileRow } from './FileRow';
import { FileGrid } from './FileGrid';
import type { Entry } from '../types';
import './MillerColumns.css';

export function MillerColumns() {
  const { state, activeTab, setTab, openPath, dispatch } = useStore();
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll last column into view when trail grows
    const el = scrollerRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [activeTab?.trail.length]);

  if (!activeTab) return null;

  const columns = activeTab.trail.map((p, i) => {
    const entries = visibleEntries(state.entriesByPath[p], activeTab);
    return { path: p, entries, selIdx: activeTab.selected[i] ?? 0, colIdx: i };
  });

  const last = columns[columns.length - 1];
  const lastSel = last.entries[last.selIdx];
  const previewEntries =
    lastSel?.kind === 'dir' && state.entriesByPath[lastSel.path]
      ? visibleEntries(state.entriesByPath[lastSel.path], activeTab)
      : null;

  // Kick off load for preview
  useEffect(() => {
    if (lastSel?.kind === 'dir' && !state.entriesByPath[lastSel.path]) {
      // loadDir via setEntries path cache — trigger by invoking readdir through store.
      // Cheapest: call openPath? No — openPath changes trail. Direct fm invocation.
      fm.readdir(lastSel.path).then((entries) => {
        dispatch({ type: 'setEntries', path: lastSel.path, entries });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSel?.path]);

  const selectAt = (colIdx: number, entry: Entry) => {
    const newTrail = activeTab.trail.slice(0, colIdx + 1);
    const entries = columns[colIdx].entries;
    const rowIdx = entries.findIndex((e) => e.path === entry.path);
    const selected = { ...activeTab.selected, [colIdx]: rowIdx };
    // Truncate selections past this column
    for (const k of Object.keys(selected)) {
      if (Number(k) > colIdx) delete selected[Number(k)];
    }
    setTab({ trail: newTrail, selected });
  };

  const doubleOpen = (entry: Entry) => {
    openPath(entry.path);
  };

  return (
    <div className="miller" ref={scrollerRef}>
      {columns.map((col) => (
        <div
          key={`${col.colIdx}-${col.path}`}
          className="miller__col"
          data-active={col.colIdx === columns.length - 1}
        >
          <div className="miller__col-head">
            <span className="miller__col-name">{basename(col.path) || '/'}</span>
            <span className="miller__col-meta">{col.entries.length}</span>
          </div>
          {activeTab.viewMode === 'grid' && col.colIdx === columns.length - 1 ? (
            <FileGrid
              entries={col.entries}
              selIdx={col.selIdx}
              activeColumn={true}
              marks={activeTab.marks}
              onSelect={(e) => selectAt(col.colIdx, e)}
              onOpen={doubleOpen}
            />
          ) : (
            <ul className="miller__list">
              {col.entries.length === 0 && <li className="miller__empty">empty</li>}
              {col.entries.map((e, j) => (
                <FileRow
                  key={e.path}
                  entry={e}
                  selected={col.selIdx === j}
                  activeColumn={col.colIdx === columns.length - 1}
                  marked={!!activeTab.marks[e.path]}
                  tag={state.tags[e.path]}
                  yanked={state.yank.some((y) => y.path === e.path)}
                  onClick={() => selectAt(col.colIdx, e)}
                  onDoubleClick={() => doubleOpen(e)}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
      {previewEntries && (
        <div className="miller__col miller__col--preview">
          <div className="miller__col-head">
            <span className="miller__col-name">{basename(lastSel!.path)}</span>
            <span className="miller__col-meta">{previewEntries.length}</span>
          </div>
          <ul className="miller__list">
            {previewEntries.slice(0, 200).map((e) => (
              <FileRow
                key={e.path}
                entry={e}
                selected={false}
                activeColumn={false}
                marked={false}
                tag={state.tags[e.path]}
                yanked={false}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
