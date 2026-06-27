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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parse } from '../tagDsl.mjs';
import { computeSnapshot, filterEntries } from '../filterEntries.mjs';
import { buildComposePrompt, parseLlmResponse, shapeRows } from '../tagCompose.mjs';
import { TAG_PALETTE, newTagId } from '../tags';
import { useOverlayExit } from '../useOverlayExit';
import { fm } from '../bridge';
import type { Tag as DslTag } from '../tagStore.d.mts';
import type { Entry } from '../types';

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

  // ── fm-2ln / fm-5rk — natural-language tag generation ────────────────────
  // The NL box compiles a description into a selector via the metadata-only LLM
  // (main process). We keep the candidate matches so the user can inspect them,
  // REJECT some, and Refine the selector (fm-5rk) to exclude the rejections.
  const [llmReady, setLlmReady] = useState<boolean | null>(null); // null = checking
  const [nlText, setNlText] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genNote, setGenNote] = useState<string | null>(null);
  // The walked scope is cached so Generate/Refine/preview don't re-walk.
  const [scopeEntries, setScopeEntries] = useState<Entry[] | null>(null);
  // Candidate matches for the CURRENT proposed selector (inspect before apply).
  const [matches, setMatches] = useState<Entry[] | null>(null);

  // Probe whether the LLM frontend is configured (gates the NL box).
  useEffect(() => {
    let cancelled = false;
    fm.llm
      .available()
      .then((ok) => {
        if (!cancelled) setLlmReady(ok);
      })
      .catch(() => {
        if (!cancelled) setLlmReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Walk the scope once (home) and cache the full-metadata entries. Shared by
  // generate, refine, and the live match preview.
  const ensureScope = useCallback(async (): Promise<Entry[]> => {
    if (scopeEntries) return scopeEntries;
    const scope = await fm.homedir();
    const entries = (await fm.walkScope(scope)) as Entry[];
    setScopeEntries(entries);
    return entries;
  }, [scopeEntries]);

  // Apply a proposed selector: validate + recompute the candidate match set so
  // the user can inspect it before saving. Returns the match count.
  const applyProposal = useCallback(
    async (proposed: string): Promise<number> => {
      const entries = await ensureScope();
      const tags = await fm.dslTags.list().catch(() => [] as DslTag[]);
      const matched = filterEntries(entries, proposed, { tags }) as Entry[];
      setMatches(matched);
      return matched.length;
    },
    [ensureScope],
  );

  // Generate: NL description → selector + name + color, then preview the matches.
  async function generate() {
    const desc = nlText.trim();
    if (desc === '' || genBusy) return;
    setGenBusy(true);
    setGenError(null);
    setGenNote(null);
    try {
      const entries = await ensureScope();
      const payload = buildComposePrompt(desc, shapeRows(entries));
      const res = await fm.llm.run(payload);
      if (!res.ok) {
        setGenError(
          res.code === 'no-api-key'
            ? 'No Anthropic API key configured — set ANTHROPIC_API_KEY (or userData/llm.json).'
            : res.error,
        );
        return;
      }
      const suggestion = parseLlmResponse(res.text, { palette: TAG_PALETTE });
      setSelector(suggestion.selector);
      if (!editId && suggestion.name && name.trim() === '') setName(suggestion.name);
      if (suggestion.color) {
        const idx = TAG_PALETTE.findIndex((c) => c.color === suggestion.color);
        if (idx >= 0) setColorIdx(idx);
      }
      const count = await applyProposal(suggestion.selector);
      setGenNote(
        `Proposed selector matches ${count} file${count === 1 ? '' : 's'}` +
          (suggestion.confidence < 0.5 ? ' · low confidence — review before applying' : ''),
      );
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenBusy(false);
    }
  }


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

        {/* fm-2ln — describe-as-tag: an LLM compiles a natural-language
            description into a selector (+ name + color) you inspect before
            applying. Degrades to a disabled box + hint when no API key. */}
        <div className="overlay__label tagform__divider">Describe (AI)</div>
        <textarea
          className="overlay__input dsltag__nl"
          rows={2}
          value={nlText}
          placeholder={
            llmReady === false
              ? 'Set ANTHROPIC_API_KEY to enable AI tag generation'
              : 'e.g. old screenshots taking up space'
          }
          spellCheck
          disabled={llmReady === false || genBusy}
          onChange={(e) => setNlText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              generate();
            } else if (e.key === 'Escape') {
              exit();
            }
          }}
        />
        <div className="tagform__actions">
          <button
            type="button"
            className="overlay__mode"
            onClick={generate}
            disabled={llmReady === false || genBusy || nlText.trim() === ''}
            title={
              llmReady === false
                ? 'No Anthropic API key configured'
                : 'Compile this description into a selector (⌘↵)'
            }
          >
            {genBusy ? 'generating…' : 'Generate selector'}
          </button>
          {llmReady === false && (
            <span className="overlay__hint">
              AI off — set <code>ANTHROPIC_API_KEY</code> or{' '}
              <code>userData/llm.json</code>
            </span>
          )}
        </div>
        {genError && <div className="overlay__error">{genError}</div>}
        {genNote && <div className="overlay__hint">{genNote}</div>}

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

        {/* fm-2ln — preview the proposed selector's matches BEFORE applying, so
            the generated rule can be inspected. Nothing is tagged until save. */}
        {matches && (
          <div className="dsltag__preview">
            <div className="overlay__label tagform__divider">
              Matches ({matches.length})
            </div>
            <ul className="dsltag__matchlist">
              {matches.slice(0, 50).map((m) => (
                <li key={m.path} className="dsltag__matchrow">
                  <span className="dsltag__matchname">{m.name}</span>
                </li>
              ))}
              {matches.length > 50 && (
                <li className="overlay__hint">…and {matches.length - 50} more</li>
              )}
            </ul>
          </div>
        )}

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
