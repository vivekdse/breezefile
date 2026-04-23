import { useMemo } from 'react';
import { useStore } from '../store';
import { lastCol, visibleEntries } from '../actions';
import { countMatches, entryMatchesFilter, getAllTags } from '../tags';
import type { TagFilterMode } from '../types';
import './TagInspector.css';

/**
 * Tag view inspector — replaces the Preview pane when tab.viewMode === 'tag'.
 * Lists every available tag rule with a colored swatch, name, description, and
 * match count. Toggling a tag adds it to `tagViz` so matching rows in the
 * file list get a colored side-band. The combination filter at the bottom
 * narrows the visible list to files matching ALL or ANY of the visualized
 * tags — applied transiently, never persisted.
 */
export function TagInspector() {
  const { state, activeTab, setTab, dispatch } = useStore();

  const entries = useMemo(() => {
    if (!activeTab) return [];
    const cwd = activeTab.trail[lastCol(activeTab)];
    return visibleEntries(state.entriesByPath[cwd], activeTab);
  }, [activeTab, state.entriesByPath]);

  if (!activeTab) return null;
  const tab = activeTab;

  const allTags = getAllTags(state.customTags);
  const vizSet = new Set(tab.tagViz);
  const filter = tab.tagFilter;

  function toggleViz(id: string) {
    const next = vizSet.has(id) ? tab.tagViz.filter((x) => x !== id) : [...tab.tagViz, id];
    // If a tag drops out of viz, also drop it from the filter so the two
    // surfaces never disagree about what's "active".
    const filterIds = filter.ids.filter((x) => next.includes(x));
    setTab({ tagViz: next, tagFilter: { ...filter, ids: filterIds } });
  }

  function toggleFilter(id: string) {
    if (!vizSet.has(id)) return;
    const ids = filter.ids.includes(id)
      ? filter.ids.filter((x) => x !== id)
      : [...filter.ids, id];
    const mode: TagFilterMode = ids.length === 0 ? 'off' : filter.mode === 'off' ? 'all' : filter.mode;
    setTab({ tagFilter: { mode, ids } });
  }

  function setMode(mode: TagFilterMode) {
    setTab({ tagFilter: { ...filter, mode, ids: mode === 'off' ? [] : filter.ids } });
  }

  function clearAll() {
    setTab({ tagViz: [], tagFilter: { mode: 'off', ids: [] } });
    dispatch({ type: 'setStatus', msg: 'tags cleared' });
  }

  const visibleAfterFilter = entries.filter((e) =>
    entryMatchesFilter(e, filter, state.customTags, state.tagPaths),
  );
  const filtering = filter.mode !== 'off' && filter.ids.length > 0;

  return (
    <section className="tag-inspector" aria-label="Tag inspector">
      <div className="tag-inspector__head">
        <div className="tag-inspector__eyebrow">Tags</div>
        <h2 className="tag-inspector__title">Color · group · filter</h2>
        <p className="tag-inspector__lede">
          Toggle a tag to color matching files. Combine toggled tags into a filter.
        </p>
      </div>

      <ul className="tag-list">
        {allTags.map((tag) => {
          const manual = state.tagPaths[tag.id];
          const count = countMatches(entries, tag, manual);
          const totalApplied = manual?.length ?? 0;
          const on = vizSet.has(tag.id);
          const inFilter = filter.ids.includes(tag.id);
          const subtitle =
            tag.description ??
            (tag.builtin === false
              ? totalApplied === 0
                ? 'No files yet — apply with the “tag” verb'
                : `${totalApplied} file${totalApplied === 1 ? '' : 's'} applied`
              : '');
          return (
            <li
              key={tag.id}
              className={[
                'tag-list__item',
                on && 'tag-list__item--on',
                count === 0 && 'tag-list__item--empty',
                tag.builtin === false && 'tag-list__item--custom',
              ].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                className="tag-list__row"
                onClick={() => toggleViz(tag.id)}
                title={on ? 'Hide color' : 'Show color on matching rows'}
              >
                {tag.key ? (
                  <kbd className="tag-list__kbd">{tag.key}</kbd>
                ) : (
                  <span className="tag-list__kbd tag-list__kbd--none">·</span>
                )}
                <span
                  className="tag-list__swatch"
                  style={{ background: tag.color, opacity: on ? 1 : 0.35 }}
                  aria-hidden
                />
                <span className="tag-list__name">{tag.name}</span>
                <span className="tag-list__count">{count}</span>
              </button>
              {subtitle && <div className="tag-list__desc">{subtitle}</div>}
              {on && (
                <button
                  type="button"
                  className={[
                    'tag-list__filter-btn',
                    inFilter && 'tag-list__filter-btn--on',
                  ].filter(Boolean).join(' ')}
                  onClick={() => toggleFilter(tag.id)}
                  title={inFilter ? 'Remove from filter' : 'Add to filter'}
                >
                  {inFilter ? '✓ in filter' : '+ filter'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="tag-filter">
        <div className="tag-filter__head">
          <span className="tag-filter__label">Filter</span>
          <div className="tag-filter__modes" role="radiogroup" aria-label="Combination mode">
            {(['off', 'all', 'any'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={filter.mode === m}
                className={[
                  'tag-filter__mode',
                  filter.mode === m && 'tag-filter__mode--on',
                ].filter(Boolean).join(' ')}
                onClick={() => setMode(m)}
                disabled={m !== 'off' && filter.ids.length === 0}
              >
                {m === 'off' ? 'Off' : m === 'all' ? 'Match all' : 'Match any'}
              </button>
            ))}
          </div>
        </div>
        <div className="tag-filter__chips">
          {filter.ids.length === 0 ? (
            <span className="tag-filter__hint">
              Toggle a tag above, then add it to the filter.
            </span>
          ) : (
            filter.ids.map((id) => {
              const tag = allTags.find((t) => t.id === id);
              if (!tag) return null;
              return (
                <span key={id} className="tag-filter__chip">
                  <span className="tag-filter__chip-dot" style={{ background: tag.color }} />
                  {tag.name}
                  <button
                    type="button"
                    className="tag-filter__chip-x"
                    onClick={() => toggleFilter(id)}
                    aria-label={`Remove ${tag.name}`}
                  >
                    ×
                  </button>
                </span>
              );
            })
          )}
        </div>
        <div className="tag-filter__aggregate">
          {filtering
            ? `${visibleAfterFilter.length} of ${entries.length} files`
            : `${entries.length} files in folder`}
        </div>
      </div>

      <div className="tag-inspector__foot">
        <button
          type="button"
          className="tag-inspector__new"
          onClick={() => window.dispatchEvent(new CustomEvent('fm:newTag'))}
          title="Create a new tag"
        >
          + New tag
        </button>
        <button
          type="button"
          className="tag-inspector__clear"
          onClick={clearAll}
          disabled={tab.tagViz.length === 0 && filter.ids.length === 0}
        >
          Clear toggles
        </button>
      </div>
      <div className="tag-inspector__hint">
        <kbd>t</kbd> apply · <kbd>T</kbd> filter · <kbd>wt</kbd> toggle this view
      </div>
    </section>
  );
}
