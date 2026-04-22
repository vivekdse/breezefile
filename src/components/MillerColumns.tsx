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

  const toggleMark = (entry: Entry) => {
    const marks = { ...activeTab.marks };
    if (marks[entry.path]) delete marks[entry.path];
    else marks[entry.path] = true;
    setTab({ marks });
  };

  // Master select-all for the active (last) column: if any entry in that
  // column is unmarked, mark everything; otherwise clear all marks.
  const toggleSelectAll = (colEntries: Entry[]) => {
    const allMarked = colEntries.length > 0 && colEntries.every((e) => activeTab.marks[e.path]);
    const marks = { ...activeTab.marks };
    if (allMarked) {
      for (const e of colEntries) delete marks[e.path];
    } else {
      for (const e of colEntries) marks[e.path] = true;
    }
    setTab({ marks });
  };

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
            {col.colIdx === columns.length - 1 && col.entries.length > 0 && (() => {
              const allMarked = col.entries.every((e) => activeTab.marks[e.path]);
              const someMarked = !allMarked && col.entries.some((e) => activeTab.marks[e.path]);
              const glyph = allMarked ? '☑' : someMarked ? '◪' : '☐';
              return (
                <span
                  className={[
                    'col-head__checkbox',
                    allMarked && 'col-head__checkbox--checked',
                    someMarked && 'col-head__checkbox--indeterminate',
                  ].filter(Boolean).join(' ')}
                  role="checkbox"
                  aria-checked={allMarked ? true : someMarked ? 'mixed' : false}
                  tabIndex={-1}
                  title="Press shift+space to select all"
                  onClick={() => toggleSelectAll(col.entries)}
                >
                  {glyph}
                </span>
              );
            })()}
            <span className="miller__col-name">{basename(col.path) || '/'}</span>
            <span className="miller__col-meta">{col.entries.length}</span>
          </div>
          {(activeTab.viewMode === 'grid' || activeTab.viewMode === 'preview') && col.colIdx === columns.length - 1 ? (
            <FileGrid
              entries={col.entries}
              selIdx={col.selIdx}
              activeColumn={true}
              marks={activeTab.marks}
              onSelect={(e) => selectAt(col.colIdx, e)}
              onOpen={doubleOpen}
              variant={activeTab.viewMode === 'preview' ? 'preview' : 'grid'}
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
                  onToggleMark={col.colIdx === columns.length - 1 ? () => toggleMark(e) : undefined}
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
