// task-317c7fe41f90 — DSL-tag create/edit modal.
//
// The minimal authoring surface for the new selector-based tag store
// (src/tagStore.mjs, owned by main, reached via window.fm.dslTags.*). Distinct
// from the criterion-based CreateTagOverlay (src/App.tsx): a DSL tag is a NAME +
// COLOR + a free-form tagDsl SELECTOR string. The selector is validated LIVE via
// parse() (src/tagDsl.mjs) so a malformed query surfaces inline before save.
//
// Additive: this does NOT replace :newtag. Reachable via the :dsltag verb.
// Visual style mirrors CreateTagOverlay (overlay__* classes, TAG_PALETTE).

import { useMemo, useState } from 'react';
import { parse } from '../tagDsl.mjs';
import { TAG_PALETTE, newTagId } from '../tags';
import { useOverlayExit } from '../useOverlayExit';
import { fm } from '../bridge';

export function DslTagOverlay({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  /** Fired after a successful create/update with a human-readable status. */
  onSaved?: (msg: string) => void;
}) {
  const { exit, state } = useOverlayExit(onClose);
  const [name, setName] = useState('');
  const [selector, setSelector] = useState('');
  const [colorIdx, setColorIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  // Kebab-case the name into the store's tag name (reuses newTagId's slug rule,
  // then strips its c-/random suffix to a clean kebab name). assignTagKey is for
  // the criterion store's single-letter picker, which the DSL store has no slot
  // for — so we only borrow the slug shape here.
  const tagName = useMemo(() => {
    const slug = newTagId(name) // -> c-<kebab>-<rand>
      .replace(/^c-/, '')
      .replace(/-[a-z0-9]{4}$/, '');
    return slug || '';
  }, [name]);

  const canSave =
    !busy &&
    name.trim() !== '' &&
    selector.trim() !== '' &&
    parseError === null &&
    tagName !== '';

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      await fm.dslTags.create({
        name: tagName,
        selector: selector.trim(),
        color: TAG_PALETTE[colorIdx].color,
        mode: 'live',
      });
      onSaved?.(`DSL tag created: ${tagName}`);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" data-state={state} onClick={exit}>
      <div
        className="overlay__box overlay__box--tag"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="overlay__label">New DSL tag</div>
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
        {name.trim() !== '' && tagName !== '' && (
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

        <div className="overlay__hint">
          A tagDsl query over file metadata —{' '}
          <code>and / or / not</code>, comparisons (<code>= != &gt; &lt; ~</code>),
          fields like <code>ext name size mtime</code>, and{' '}
          <code>tag:other</code> to reference another tag. Enter to create · Esc to
          cancel.
        </div>
      </div>
    </div>
  );
}
