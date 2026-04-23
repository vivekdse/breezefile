import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { lastCol, visibleEntries } from '../actions';
import { assignTagKey, getAllTags, newTagId } from '../tags';
import { useOverlayExit } from '../useOverlayExit';
import type { TagDef } from '../tags';
import './TagPicker.css';

/**
 * Type-driven tag HUD (fm-60k). One screen, two modes:
 *   apply  — Enter on a tag toggles it on every visible file in the folder.
 *            If the typed text matches no tag, the last option becomes
 *            "Create '<text>'" which spawns a manual tag and applies it.
 *   filter — Enter toggles the tag in the active combination filter.
 *            Mode auto-flips off → all when the first tag joins.
 *
 * Stays open across actions so the user can chord through several tags.
 * Esc closes. No Tab; no chord arguments.
 */
type Props = { mode: 'apply' | 'filter'; onClose: () => void };

type RowItem =
  | { kind: 'tag'; tag: TagDef }
  | { kind: 'create'; name: string };

const TAG_PALETTE_DEFAULT = '#6c8a5b';

export function TagPicker({ mode, onClose }: Props) {
  const { state, activeTab, dispatch, setTab } = useStore();
  const { exit, state: animState } = useOverlayExit(onClose);
  const [input, setInput] = useState('');
  const [hl, setHl] = useState(0);
  const [flash, setFlash] = useState<{ id: string; verb: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tab = activeTab;
  const cwd = tab ? tab.trail[lastCol(tab)] : '';
  const allEntries = useMemo(
    () => (tab ? visibleEntries(state.entriesByPath[cwd], tab) : []),
    [tab, state.entriesByPath, cwd],
  );
  const allTags = useMemo(() => getAllTags(state.customTags), [state.customTags]);

  // Targets for apply: always the entire visible folder.
  const targetPaths = useMemo(() => allEntries.map((e) => e.path), [allEntries]);

  // Per-tag applied state across targetPaths. 'all' / 'some' / 'none'.
  // Combines rule predicate + manual list so the dot reflects what the user
  // actually sees on rows.
  function appliedState(tag: TagDef): 'all' | 'some' | 'none' {
    if (targetPaths.length === 0) return 'none';
    const manual = state.tagPaths[tag.id] ?? [];
    let n = 0;
    for (const e of allEntries) {
      const matches = (tag.predicate?.(e) ?? false) || manual.includes(e.path);
      if (matches) n += 1;
    }
    if (n === 0) return 'none';
    if (n === targetPaths.length) return 'all';
    return 'some';
  }

  // Manual presence is the user-controlled portion. Chips strip + verb
  // hints key off of this (not the combined state) so removing a tag the
  // user manually applied actually clears the chip.
  function manualOnTargets(tag: TagDef): boolean {
    const manual = state.tagPaths[tag.id] ?? [];
    return manual.length > 0 && targetPaths.some((p) => manual.includes(p));
  }

  // Verb that pressing Enter will perform on this tag.
  //   'remove' — there's at least one manual entry on the targets to clear
  //   'rule'   — fully covered by predicate, no manual to clear (no-op)
  //   'add'    — will add the targets to the manual list
  function verbFor(tag: TagDef): 'add' | 'remove' | 'rule' {
    if (manualOnTargets(tag)) return 'remove';
    if (appliedState(tag) === 'all' && tag.predicate) return 'rule';
    return 'add';
  }

  const isInFilter = (id: string) => !!tab?.tagFilter.ids.includes(id);

  // Filter + sort: typed substring across name+key, then sort applied/in-filter
  // tags to the top so the user always sees current state at a glance.
  const q = input.trim().toLowerCase();
  const matched = useMemo(() => {
    const list = q
      ? allTags.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            (t.key && t.key.toLowerCase() === q),
        )
      : allTags;
    return [...list].sort((a, b) => {
      const aOn = mode === 'apply' ? appliedState(a) !== 'none' : isInFilter(a.id);
      const bOn = mode === 'apply' ? appliedState(b) !== 'none' : isInFilter(b.id);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTags, q, mode, state.tagPaths, allEntries, tab?.tagFilter.ids]);

  const exactNameMatch = q && allTags.some((t) => t.name.toLowerCase() === q);
  const showCreate = mode === 'apply' && q.length > 0 && !exactNameMatch;
  const items: RowItem[] = [
    ...matched.map<RowItem>((t) => ({ kind: 'tag', tag: t })),
    ...(showCreate ? [{ kind: 'create' as const, name: input.trim() }] : []),
  ];

  // Clamp highlight when the list shrinks under the user.
  useEffect(() => {
    if (hl >= items.length) setHl(Math.max(0, items.length - 1));
  }, [items.length, hl]);

  // Currently-applied tags shown in the chips strip — only those the USER
  // manually applied. Rule-driven matches stay visible in the list (via
  // the colored dot) but don't crowd the chips, and removing a manual
  // application here actually makes the chip disappear.
  const appliedHere = useMemo(
    () => allTags.filter((t) => manualOnTargets(t)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTags, state.tagPaths, targetPaths],
  );
  const inFilter = useMemo(
    () => allTags.filter((t) => isInFilter(t.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTags, tab?.tagFilter.ids],
  );

  function applyTagAction(tag: TagDef) {
    const verb = verbFor(tag);
    if (verb === 'remove') {
      dispatch({ type: 'untagPaths', id: tag.id, paths: targetPaths });
      setFlash({ id: tag.id, verb: 'removed' });
    } else if (verb === 'rule') {
      // Rule fully covers the targets and there's nothing manual to clear.
      // Surface that fact rather than silently doing nothing.
      dispatch({
        type: 'setStatus',
        msg: `${tag.name}: rule already covers all ${targetPaths.length} files — edit the rule to change matches`,
      });
      setFlash({ id: tag.id, verb: 'rule' });
    } else {
      dispatch({ type: 'applyTag', id: tag.id, paths: targetPaths });
      dispatch({ type: 'addTagViz', id: tag.id });
      setFlash({ id: tag.id, verb: 'added' });
    }
  }

  function filterTagAction(tag: TagDef) {
    if (!tab) return;
    const has = isInFilter(tag.id);
    const ids = has
      ? tab.tagFilter.ids.filter((x) => x !== tag.id)
      : [...tab.tagFilter.ids, tag.id];
    setTab({
      tagFilter: {
        mode: ids.length === 0 ? 'off' : tab.tagFilter.mode === 'off' ? 'all' : tab.tagFilter.mode,
        ids,
      },
      tagViz: Array.from(new Set([...tab.tagViz, tag.id])),
    });
    setFlash({ id: tag.id, verb: has ? 'unfiltered' : 'filtered' });
  }

  function commitCreate(name: string) {
    const taken = new Set<string>();
    for (const t of state.customTags) if (t.key) taken.add(t.key);
    const id = newTagId(name);
    const key = assignTagKey(name, taken);
    dispatch({
      type: 'createCustomTag',
      tag: { id, name: name.trim(), color: TAG_PALETTE_DEFAULT, key, createdAt: Date.now() },
    });
    if (mode === 'apply') {
      dispatch({ type: 'applyTag', id, paths: targetPaths });
    } else if (tab) {
      setTab({
        tagFilter: {
          mode: tab.tagFilter.mode === 'off' ? 'all' : tab.tagFilter.mode,
          ids: [...tab.tagFilter.ids, id],
        },
      });
    }
    dispatch({ type: 'addTagViz', id });
    setFlash({ id, verb: 'created' });
    setInput('');
    setHl(0);
  }

  function activate(item: RowItem) {
    if (item.kind === 'create') {
      commitCreate(item.name);
      return;
    }
    if (mode === 'apply') applyTagAction(item.tag);
    else filterTagAction(item.tag);
    // Keep the picker open and reset the filter so chained actions feel like
    // distinct presses rather than ambiguous typed-state.
    setInput('');
    setHl(0);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exit();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHl((h) => Math.min(items.length - 1, h + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[hl];
      if (item) activate(item);
      return;
    }
  }

  // Auto-focus the input on mount so typing works immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clear flash after a beat.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 700);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!tab) return null;

  const summary =
    mode === 'apply'
      ? `${allEntries.length} files in folder`
      : `${tab.tagFilter.mode === 'off' ? 'Off' : tab.tagFilter.mode === 'all' ? 'Match all' : 'Match any'} · narrows the list`;

  const stripTags = mode === 'apply' ? appliedHere : inFilter;
  const stripLabel = mode === 'apply' ? 'Applied here' : 'In filter';

  return (
    <div className="tagpicker" data-state={animState} onClick={exit}>
      <div className="tagpicker__box" onClick={(e) => e.stopPropagation()}>
        <div className="tagpicker__head">
          <span className="tagpicker__eyebrow">{mode === 'apply' ? 'Tag' : 'Filter'}</span>
          <span className="tagpicker__targets">{summary}</span>
        </div>

        <div className="tagpicker__strip">
          <span className="tagpicker__strip-label">{stripLabel}:</span>
          {stripTags.length === 0 ? (
            <span className="tagpicker__strip-empty">none yet</span>
          ) : (
            stripTags.map((t) => (
              <span key={t.id} className="tagpicker__chip">
                <span className="tagpicker__chip-dot" style={{ background: t.color }} />
                {t.name}
              </span>
            ))
          )}
        </div>

        <div className="tagpicker__inputrow">
          <input
            ref={inputRef}
            className="tagpicker__input"
            value={input}
            placeholder={mode === 'apply' ? 'type to find or create…' : 'type to filter the list…'}
            onChange={(e) => {
              setInput(e.target.value);
              setHl(0);
            }}
            onKeyDown={onKey}
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>

        <ul className="tagpicker__list" role="listbox">
          {items.length === 0 && (
            <li className="tagpicker__empty">no tags · type a name to create one</li>
          )}
          {items.map((item, i) => {
            if (item.kind === 'create') {
              return (
                <li
                  key="create"
                  role="option"
                  aria-selected={i === hl}
                  className={`tagpicker__item tagpicker__item--create${
                    i === hl ? ' tagpicker__item--hl' : ''
                  }`}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => activate(item)}
                >
                  <span className="tagpicker__plus">+</span>
                  <span className="tagpicker__name">
                    Create <em>“{item.name}”</em>
                  </span>
                  <span className="tagpicker__hint-small">↵ to create &amp; apply</span>
                </li>
              );
            }
            const t = item.tag;
            const st = mode === 'apply' ? appliedState(t) : isInFilter(t.id) ? 'all' : 'none';
            const flashing = flash?.id === t.id;
            // Verb hint shown on the right of every row so the user can
            // tell at a glance what Enter will do — add to / remove from /
            // toggle in the filter.
            let verbHint = '';
            let verbClass = '';
            if (mode === 'apply') {
              const v = verbFor(t);
              if (v === 'add') {
                verbHint = '↵ add';
                verbClass = 'tagpicker__verb--add';
              } else if (v === 'remove') {
                verbHint = '↵ remove';
                verbClass = 'tagpicker__verb--remove';
              } else {
                verbHint = 'rule · matches all';
                verbClass = 'tagpicker__verb--rule';
              }
            } else {
              verbHint = isInFilter(t.id) ? '↵ remove from filter' : '↵ add to filter';
              verbClass = isInFilter(t.id) ? 'tagpicker__verb--remove' : 'tagpicker__verb--add';
            }
            return (
              <li
                key={t.id}
                role="option"
                aria-selected={i === hl}
                className={[
                  'tagpicker__item',
                  i === hl && 'tagpicker__item--hl',
                  flashing && 'tagpicker__item--flash',
                ].filter(Boolean).join(' ')}
                onMouseEnter={() => setHl(i)}
                onClick={() => activate(item)}
              >
                <span
                  className={`tagpicker__dot tagpicker__dot--${st}`}
                  style={
                    st === 'all'
                      ? { background: t.color }
                      : st === 'some'
                        ? { background: t.color, opacity: 0.45 }
                        : { boxShadow: `inset 0 0 0 1px ${t.color}` }
                  }
                  aria-hidden
                />
                <span className="tagpicker__name">{t.name}</span>
                <span className={`tagpicker__verb ${verbClass}`}>{verbHint}</span>
              </li>
            );
          })}
        </ul>

        <div className="tagpicker__foot">
          <kbd>↑↓</kbd> nav · <kbd>↵</kbd>{' '}
          {mode === 'apply' ? 'add or remove (or create)' : 'add or remove from filter'} ·{' '}
          <kbd>esc</kbd> done
        </div>
      </div>
    </div>
  );
}
