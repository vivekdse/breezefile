// task-317c7fe41f90 — DSL-tag create/edit modal.  ·  fm-mp1 / fm-xr0 extensions.
//
// The authoring surface for the selector-based tag store (src/tagStore.mjs,
// owned by main, reached via window.fm.dslTags.*). A DSL tag is a NAME + COLOR +
// a free-form tagDsl SELECTOR string, validated LIVE via parse() (src/tagDsl.mjs)
// so a malformed query surfaces inline before save.
//
// fm-xr0 adds a live ↔ frozen MODE toggle. A frozen tag pins a SNAPSHOT of the
// paths matching its selector AT SAVE TIME; later visualization uses that
// snapshot, not re-evaluation ("the 247 files I tagged at 3pm yesterday"). The
// snapshot is computed here by walking a scope (fm.walkScope) and filtering with
// the shared pure helper (computeSnapshot). A "re-snapshot" action recaptures it
// against the current filesystem. When editing an existing tag, the modal loads
// its current name/selector/color/mode/snapshot so all of this round-trips.
//
// fm-mp1 — "Open as tab" turns the selector into a live filter-tab (smart
// folder) via the fm:openFilterTab event, without leaving the modal's flow.
//
// Additive: this does NOT replace :newtag. Reachable via the :dsltag verb (new)
// and the fm:editDslTag event (edit). Visual style mirrors CreateTagOverlay.

import { useEffect, useMemo, useState } from 'react';
import { parse } from '../tagDsl.mjs';
import { computeSnapshot } from '../filterEntries.mjs';
import { TAG_PALETTE, newTagId } from '../tags';
import { useOverlayExit } from '../useOverlayExit';
import { fm } from '../bridge';
import type { Tag as DslTag } from '../tagStore.d.mts';

export function DslTagOverlay({
  onClose,
  onSaved,
  editId,
}: {
  onClose: () => void;
  /** Fired after a successful create/update with a human-readable status. */
  onSaved?: (msg: string) => void;
  /** fm-xr0 — when set, edit this existing DSL tag instead of creating one. */
  editId?: string | null;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const [name, setName] = useState('');
  const [selector, setSelector] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const [mode, setMode] = useState<'live' | 'frozen'>('live');
  const [snapshot, setSnapshot] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editId);

  // fm-xr0 — when editing, hydrate the form from the stored record so the
  // mode toggle / snapshot count / selector all reflect the saved tag.
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    fm.dslTags
      .get(editId)
      .then((t: DslTag | null) => {
        if (cancelled || !t) {
          if (!cancelled) setLoaded(true);
          return;
        }
        setName(t.name);
        setSelector(t.selector);
        setMode(t.mode === 'frozen' ? 'frozen' : 'live');
        setSnapshot(Array.isArray(t.snapshot) ? t.snapshot : null);
        const idx = TAG_PALETTE.findIndex((c) => c.color === t.color);
        if (idx >= 0) setColorIdx(idx);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [editId]);

  // Live parse of the selector. Empty → no error shown yet (neutral), but the
  // tag still can't be saved (we require a parseable selector).
  const parseError = useMemo<string | null>(() => {
    const s = selector.trim();
    if (s === '') return null;
    try {
      parse(s);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [selector]);

  // Kebab-case the typed name (reuses newTagId's slug rule). When editing an
  // existing tag we keep its stored name verbatim (it's already a valid key).
  const derivedName = useMemo(() => {
    const slug = newTagId(name)
      .replace(/^c-/, '')
      .replace(/-[a-z0-9]{4}$/, '');
    return slug || '';
  }, [name]);
  const tagName = editId ? name.trim() : derivedName;

  const canSave =
    !busy &&
    loaded &&
    name.trim() !== '' &&
    selector.trim() !== '' &&
    parseError === null &&
    tagName !== '';

  // fm-xr0 — evaluate the selector across the scope (home) and capture the set
  // of matching paths. Shared with the filter-tab walk: fm.walkScope + the pure
  // computeSnapshot helper. Returns the path set (also used for the live count).
  async function captureSnapshot(): Promise<string[]> {
    const scope = await fm.homedir();
    const entries = await fm.walkScope(scope);
    const tags = await fm.dslTags.list().catch(() => []);
    return computeSnapshot(entries, selector.trim(), { tags });
  }

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      // For a frozen tag, capture the snapshot at save time (fm-xr0).
      let snap: string[] | null = null;
      if (mode === 'frozen') {
        snap = await captureSnapshot();
        setSnapshot(snap);
      }
      const color = TAG_PALETTE[colorIdx].color;
      if (editId) {
        // Edit: patch the record. Clear the snapshot when switching back to
        // live (the store treats snapshot:null as "remove it").
        await fm.dslTags.update(editId, {
          name: tagName,
          selector: selector.trim(),
          color,
          mode,
          snapshot: mode === 'frozen' ? snap ?? [] : null,
        });
        onSaved?.(
          mode === 'frozen'
            ? `DSL tag updated: ${tagName} (frozen, ${snap?.length ?? 0} paths)`
            : `DSL tag updated: ${tagName}`,
        );
      } else {
        await fm.dslTags.create({
          name: tagName,
          selector: selector.trim(),
          color,
          mode,
          ...(mode === 'frozen' ? { snapshot: snap ?? [] } : {}),
        });
        onSaved?.(
          mode === 'frozen'
            ? `DSL tag created: ${tagName} (frozen, ${snap?.length ?? 0} paths)`
            : `DSL tag created: ${tagName}`,
        );
      }
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  // fm-xr0 — re-snapshot: recompute the frozen path set against the current
  // filesystem and persist it (only meaningful for an existing frozen tag).
  async function reSnapshot() {
    if (busy || parseError !== null || selector.trim() === '') return;
    setBusy(true);
    setSaveError(null);
    try {
      const snap = await captureSnapshot();
      setSnapshot(snap);
      if (editId) {
        await fm.dslTags.update(editId, { mode: 'frozen', snapshot: snap });
      }
      setMode('frozen');
      onSaved?.(`re-snapshot ${tagName || selector.trim()}: ${snap.length} paths`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // fm-mp1 — open the selector as a live filter-tab (smart folder).
  function openAsTab() {
    const s = selector.trim();
    if (s === '' || parseError !== null) return;
    window.dispatchEvent(
      new CustomEvent('fm:openFilterTab', { detail: { selector: s } }),
    );
    onClose();
  }

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div
        className="overlay__box overlay__box--tag"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="overlay__label">{editId ? 'Edit DSL tag' : 'New DSL tag'}</div>
        <input
          autoFocus
          className="overlay__input"
          value={name}
          placeholder="e.g. big-pdfs, recent-images"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') exit();
          }}
        />
        {name.trim() !== '' && tagName !== '' && !editId && (
          <div className="overlay__hint">
            stored as <code>{tagName}</code>
          </div>
        )}

        <div className="overlay__palette" role="radiogroup" aria-label="Tag color">
          {TAG_PALETTE.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={colorIdx === i}
              aria-label={c.name}
              className={['overlay__swatch', colorIdx === i && 'overlay__swatch--on']
                .filter(Boolean)
                .join(' ')}
              style={{ background: c.color }}
              onClick={() => setColorIdx(i)}
              title={c.name}
            />
          ))}
        </div>

        <div className="overlay__label tagform__divider">Selector</div>
        <input
          className="overlay__input"
          value={selector}
          placeholder="ext = pdf and size > 4MB"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setSelector(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') exit();
          }}
        />
        {parseError && <div className="overlay__error">{parseError}</div>}
        {saveError && <div className="overlay__error">save failed: {saveError}</div>}

        {/* fm-xr0 — live ↔ frozen mode. Frozen pins the matching paths at save
            time; the re-snapshot button recaptures them on demand. */}
        <div className="overlay__label tagform__divider">Mode</div>
        <div className="overlay__palette" role="radiogroup" aria-label="Tag mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'live'}
            className={['overlay__mode', mode === 'live' && 'overlay__mode--on']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setMode('live')}
            title="Re-evaluate the selector each time"
          >
            Live
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'frozen'}
            className={['overlay__mode', mode === 'frozen' && 'overlay__mode--on']
              .filter(Boolean)
              .join(' ')}
            onClick={() => setMode('frozen')}
            title="Pin the matching paths as a snapshot"
          >
            Frozen
          </button>
          {mode === 'frozen' && (
            <button
              type="button"
              className="overlay__mode"
              onClick={reSnapshot}
              disabled={busy || parseError !== null || selector.trim() === ''}
              title="Recompute the snapshot against the current filesystem"
            >
              {busy ? 'snapshotting…' : 're-snapshot'}
            </button>
          )}
        </div>
        {mode === 'frozen' && (
          <div className="overlay__hint">
            {snapshot == null
              ? 'A snapshot of matching paths is captured when you save.'
              : `Snapshot: ${snapshot.length} path${snapshot.length === 1 ? '' : 's'} pinned.`}
          </div>
        )}

        <div className="overlay__hint">
          A tagDsl query over file metadata —{' '}
          <code>and / or / not</code>, comparisons (<code>= != &gt; &lt; ~</code>),
          fields like <code>ext name size mtime</code>, and{' '}
          <code>tag:other</code> to reference another tag.
        </div>

        <div className="tagform__actions">
          <button
            type="button"
            className="overlay__mode"
            onClick={openAsTab}
            disabled={selector.trim() === '' || parseError !== null}
            title="Open this selector as a live smart-folder tab"
          >
            Open as tab
          </button>
          <button
            type="button"
            className="overlay__mode overlay__mode--primary"
            onClick={submit}
            disabled={!canSave}
          >
            {editId ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
