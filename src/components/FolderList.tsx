import { useStore } from '../store';
import { visibleEntries, basename, lastCol } from '../actions';
import { FileRow } from './FileRow';
import { FileGrid } from './FileGrid';
import type { Entry } from '../types';
import './FolderList.css';

/**
 * Finder/Explorer-style single-list view of the current folder.
 *
 * Replaces MillerColumns as the v1 default (fm-ehb): the user reviewed the
 * stacked-miller UI and preferred a single big list for the cwd, with a
 * dedicated preview pane on the right (owned by fm-fda). We keep the
 * `trail` array in tab state so back/forward history, `h` → parent, etc.
 * still work — but render only the *last* entry in the trail as one list.
 */
export function FolderList() {
  const { state, activeTab, setTab, openPath } = useStore();

  if (!activeTab) return null;
  const tab = activeTab;
  const col = lastCol(tab);
  const cwd = tab.trail[col];
  const entries = visibleEntries(state.entriesByPath[cwd], tab);
  const selIdx = tab.selected[col] ?? 0;

  const toggleMark = (entry: Entry) => {
    const marks = { ...tab.marks };
    if (marks[entry.path]) delete marks[entry.path];
    else marks[entry.path] = true;
    setTab({ marks });
  };

  const toggleSelectAll = () => {
    const allMarked = entries.length > 0 && entries.every((e) => tab.marks[e.path]);
    const marks = { ...tab.marks };
    if (allMarked) {
      for (const e of entries) delete marks[e.path];
    } else {
      for (const e of entries) marks[e.path] = true;
    }
    setTab({ marks });
  };

  const selectAt = (entry: Entry) => {
    const rowIdx = entries.findIndex((e) => e.path === entry.path);
    if (rowIdx < 0) return;
    setTab({ selected: { ...tab.selected, [col]: rowIdx } });
  };

  const doubleOpen = (entry: Entry) => {
    openPath(entry.path);
  };

  const allMarked = entries.length > 0 && entries.every((e) => tab.marks[e.path]);
  const someMarked = !allMarked && entries.some((e) => tab.marks[e.path]);
  const checkGlyph = allMarked ? '☑' : someMarked ? '◪' : '☐';

  return (
    <div className="folder-list">
      <div className="folder-list__head">
        {entries.length > 0 && (
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
            onClick={toggleSelectAll}
          >
            {checkGlyph}
          </span>
        )}
        <span className="folder-list__name">{basename(cwd) || '/'}</span>
        <span className="folder-list__meta">{entries.length}</span>
      </div>
      {tab.viewMode === 'grid' ? (
        <FileGrid
          entries={entries}
          selIdx={selIdx}
          activeColumn={true}
          marks={tab.marks}
          onSelect={selectAt}
          onOpen={doubleOpen}
        />
      ) : (
        <ul className="folder-list__list">
          {entries.length === 0 && <li className="folder-list__empty">empty</li>}
          {entries.map((e, j) => (
            <FileRow
              key={e.path}
              entry={e}
              selected={selIdx === j}
              activeColumn={true}
              marked={!!tab.marks[e.path]}
              tag={state.tags[e.path]}
              yanked={state.yank.some((y) => y.path === e.path)}
              onClick={() => selectAt(e)}
              onDoubleClick={() => doubleOpen(e)}
              onToggleMark={() => toggleMark(e)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
