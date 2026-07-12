// task-342f3e151d99 (builds on task-73f6304ffb94) — the source-aware key
// picker: the ONE "+ input" affordance shared by BOTH authoring surfaces
// (TaskComposer's FieldEditors and TemplateEditPanel's FieldRows). Template
// authoring is key-centric — instead of only adding a blank row, the user
// gets a menu of FIELDS EXPOSED BY APPROVED EXTERNAL APIs (SavedQueries) plus
// a freeform "Custom" key.
//
// Redesigned keyboard-first (task-342f3e151d99) to mirror the composer's
// OPTION QUESTION idiom (see TaskComposer.tsx's project/who/agent questions):
// a `<ul role="listbox">` of `<button>` options, each with a digit `<kbd>`
// hint, ↑/↓ to move a highlight, Enter to pick, and typing to filter — see
// FieldSourcePicker below, which renders INLINE so a caller (the composer)
// can drop it straight into a question section instead of behind a mouse
// popup. FieldKeyPicker (the original button+popup affordance) is now a thin
// wrapper: it opens a floating menu and renders FieldSourcePicker inside it,
// so existing call sites (TemplateEditPanel.tsx) keep working unmodified.
//
//   - Picking an API field adds a field row bound to that SavedQuery: `key` =
//     the field name (normalized + deduped, still user-editable), `label` =
//     humanized name, `type` mapped from the catalog type, and a `source`
//     binding — all computed by the PURE fieldCatalog.mjs (testable under node).
//   - Picking "Custom" adds a blank row, exactly like today.
//
// Degrade-gracefully: the catalog is fetched ONCE per app run (module cache,
// swallows errors → []). If it's empty (signed out / offline / no approved
// queries), the picker's option list collapses to just "Custom" — the editor
// stays fully usable.
//
// NON-PHI: the catalog is field NAMES + TYPES only; safe to hold in state. No
// task VALUES ever pass through here.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { TaskDefField } from './types';
import { describeQueries, lookupConnection, type QueryCatalogEntry } from '../../copilot/savedQueries';
import { fm } from '../../bridge';
import {
  blankCustomField,
  catalogPickerGroups,
  catalogTypeToFieldType,
  fieldFromCatalog,
  fieldFromConnection,
  fieldOptionsForSource,
  pickerOptions,
  sourceOptions,
  type PickerOption,
} from './fieldCatalog.mjs';
import {
  firstPartyTemplateFor,
  FIRST_PARTY_CONNECTION_VERSION,
  type FirstPartyTemplate,
} from './firstPartyLookups.mjs';
import './FieldKeyPicker.css';

// Module-level single-flight cache: the catalog is the same for every picker on
// screen and rarely changes within a session, so fetch it at most once and
// share the promise. Errors resolve to [] (never reject) so the hook always
// settles and the picker degrades to "Custom".
//
// task-c978d7d7bafc — that "once per app run" cache went stale across auth
// changes: a user signing IN after launch, or a mid-session SavedQuery
// approval, never showed up in the picker until restart, even on remount
// (the cache is module-scoped, not component-scoped). Fix: clear both
// module caches whenever fm.typebuild.onAuthChanged fires, and bump
// `catalogVersion` so mounted useQueryCatalog/pickers actually re-fetch
// instead of silently keeping their already-resolved empty/stale state.
let catalogPromise: Promise<QueryCatalogEntry[]> | null = null;
export function loadQueryCatalog(): Promise<QueryCatalogEntry[]> {
  if (!catalogPromise) catalogPromise = describeQueries();
  return catalogPromise;
}

let catalogVersion = 0;
const catalogVersionListeners = new Set<(v: number) => void>();

function invalidateQueryCatalog(): void {
  catalogPromise = null;
  connectionSourcesPromise = null;
  catalogVersion += 1;
  for (const cb of catalogVersionListeners) cb(catalogVersion);
}

// Subscribe once at module init, following the same fm.typebuild.onAuthChanged
// pattern used elsewhere (e.g. src/tasks.ts's sign-in status hook) — no new
// IPC channel, just reuse the existing auth-change signal from the bridge.
// Any sign-in/sign-out/account switch invalidates the shared catalog so the
// next read re-fetches against the current session.
fm.typebuild.onAuthChanged(() => {
  invalidateQueryCatalog();
});

// docs/connections-design.md §J.5 — CONNECTED first-party catalog tiles this
// client has a lookup template for (firstPartyLookups.mjs), projected into
// the SAME QueryCatalogEntry shape the pure picker fns consume, so a
// first-party service ("Scheduler · Patient Name") lists beside SavedQuery
// fields with zero special-casing until pick time. `__connection` is the
// pick-time marker: those options build a Connection-form source binding
// (fieldFromConnection) instead of a SavedQuery one. Same fetch-once/degrade-
// to-[] discipline as loadQueryCatalog above.
type ConnectionFieldEntry = QueryCatalogEntry & {
  __connection: { entryId: string; template: FirstPartyTemplate };
};
let connectionSourcesPromise: Promise<ConnectionFieldEntry[]> | null = null;
function loadConnectionFieldSources(): Promise<ConnectionFieldEntry[]> {
  if (!connectionSourcesPromise) {
    connectionSourcesPromise = fm.typebuild.connections.catalog
      .list()
      .then((entries) =>
        entries
          .filter((e) => e.kind === 'rest' && e.status === 'connected' && !!e.serviceUrl)
          .flatMap((e) => {
            const template = firstPartyTemplateFor(e.toolkit);
            if (!template) return [];
            return [
              {
                id: e.id,
                name: template.sourceLabel,
                version: 0,
                status: 'connection',
                entityType: template.fields[0]?.entityType,
                fields: template.fields.map((f) => ({ name: f.name, type: f.type })),
                __connection: { entryId: e.id, template },
              } satisfies ConnectionFieldEntry,
            ];
          }),
      )
      .catch(() => []);
  }
  return connectionSourcesPromise;
}

/** Fetch-once-per-catalog-version hook over the SavedQuery catalog.
 *  `{ catalog: [], loading }` until it settles; `catalog` is [] on any
 *  failure so callers never special-case errors — an empty catalog just
 *  means "Custom" is the only option.
 *
 *  task-c978d7d7bafc — re-runs whenever `catalogVersion` bumps (auth
 *  change invalidates the module cache above), so a picker already mounted
 *  when the user signs in — or when a SavedQuery gets approved mid-session —
 *  picks up the fresh catalog without an app restart. */
export function useQueryCatalog(): { catalog: QueryCatalogEntry[]; loading: boolean } {
  const [catalog, setCatalog] = useState<QueryCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(catalogVersion);

  useEffect(() => {
    const onVersion = (v: number) => setVersion(v);
    catalogVersionListeners.add(onVersion);
    return () => {
      catalogVersionListeners.delete(onVersion);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Both legs degrade to [] independently, so a signed-out / catalog-less
    // session still gets the other's entries (or just "Custom").
    Promise.all([loadQueryCatalog(), loadConnectionFieldSources()]).then(([queries, conns]) => {
      if (cancelled) return;
      setCatalog([...queries, ...conns]);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return { catalog, loading };
}

type Step = 'top' | 'browse-source' | 'browse-field';

function optionKey(o: PickerOption): string {
  switch (o.kind) {
    case 'custom':
      return 'custom';
    case 'browse':
      return 'browse';
    case 'source':
      return `src:${o.entry.id}`;
    case 'field':
      return `field:${o.entry.id}:${o.field.name}`;
  }
}

function optionLabel(o: PickerOption): string {
  switch (o.kind) {
    case 'custom':
      return 'Custom (name your own key)';
    case 'browse':
      return 'Browse all…';
    case 'source':
    case 'field':
      return o.label;
  }
}

/** task-342f3e151d99 — the inline, keyboard-first field-source picker. Renders
 *  a `role="listbox"` option list (NOT a floating popup) so a caller can
 *  embed it directly inside a question section, matching how the composer's
 *  other option questions (project/who/agent) render.
 *
 *  Top step: `{kind:'custom'}` first (always option 1), then the top
 *  source-backed fields (pure logic in fieldCatalog.mjs's `pickerOptions`),
 *  then `{kind:'browse'}` when the catalog was truncated (>6 fields or >1
 *  source). Picking `browse` drills into a two-step SOURCE → FIELD walk
 *  (`sourceOptions` / `fieldOptionsForSource`), each step the same idiom.
 *
 *  Keyboard: ↑/↓ move the highlight, Enter picks it, digits 1-9 jump straight
 *  to that option, typing any other printable character appends to a live
 *  search buffer that filters the CURRENT step's list (re-numbering the digit
 *  hints) — Backspace edits that buffer, and once it's empty, Backspace (like
 *  Esc) steps back: browse-field → browse-source → top → `onCancel()`.
 *
 *  `onPick` receives a fully-formed source-bound TaskDefField built by the
 *  pure `fieldFromCatalog`. `onCustom` signals the "Custom" pick — the caller
 *  (composer) then walks key/label/type itself, exactly like today's blank
 *  add. Digits are reserved for option-select, not the search buffer — field
 *  names are rarely numeric-only, so this trade-off keeps single-keystroke
 *  jumps working even mid-search.
 *
 *  The option list itself renders with the composer's shared
 *  `composer__options`/`composer__option` classes (TaskComposer.css) — the
 *  same ones the who/template/type steps use — so this step reads as the
 *  SAME form, not a bespoke dark popup. Only the wrapper chrome (`.fsp`,
 *  the breadcrumb, the live search buffer) keeps its own minimal styling. */
export function FieldSourcePicker({
  existingKeys,
  onPick,
  onCustom,
  onCancel,
  autoFocus,
}: {
  existingKeys: string[];
  onPick: (field: TaskDefField) => void;
  onCustom: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}): JSX.Element {
  const { catalog, loading } = useQueryCatalog();
  const [step, setStep] = useState<Step>('top');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [browseEntry, setBrowseEntry] = useState<QueryCatalogEntry | null>(null);
  // task-9fdd9acee736 — pick-time failure (e.g. the scope lookup 401s/times
  // out) must be VISIBLE, not silently degraded to an unbound blank field.
  // Cleared on every fresh pick attempt; the picker stays open so the user
  // consciously retries or falls back to Custom.
  const [pickError, setPickError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);

  const options: PickerOption[] =
    step === 'top'
      ? pickerOptions(catalog, { query })
      : step === 'browse-source'
        ? sourceOptions(catalog, { query })
        : fieldOptionsForSource(browseEntry, { query });
  const clampedHighlight = Math.min(highlight, Math.max(0, options.length - 1));

  const toTop = () => {
    setStep('top');
    setQuery('');
    setHighlight(0);
    setBrowseEntry(null);
    setPickError(null);
  };
  const toSourceStep = () => {
    setStep('browse-source');
    setQuery('');
    setHighlight(0);
    setBrowseEntry(null);
    setPickError(null);
  };

  const pickIndex = (i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.kind === 'custom') {
      setPickError(null);
      onCustom();
      return;
    }
    if (o.kind === 'browse') {
      setPickError(null);
      toSourceStep();
      return;
    }
    if (o.kind === 'source') {
      setPickError(null);
      setBrowseEntry(o.entry);
      setStep('browse-field');
      setQuery('');
      setHighlight(0);
      return;
    }
    // o.kind === 'field'
    setPickError(null);
    const conn = (o.entry as Partial<ConnectionFieldEntry>).__connection;
    if (conn) {
      void pickConnectionField(conn, o.field.name);
      return;
    }
    const built = fieldFromCatalog(o.entry, o.field, existingKeys);
    // fieldFromCatalog only returns null on a malformed entry/field the list
    // wouldn't have surfaced; fall back to a blank row so a pick never no-ops.
    onPick(built ?? blankCustomField());
  };

  // §J.5 — build a Connection-form field from a first-party template pick.
  // The lookup paths are scope-parameterized (e.g. business-scoped), so
  // resolve the caller's scope rows once at pick time and bind the FIRST one
  // (single-tenant is today's shape; a multi-scope chooser can slot in here
  // when a caller actually has several).
  //
  // task-9fdd9acee736 — a failed/empty scope lookup used to silently degrade
  // to blankCustomField(), shipping a normal-looking text field with NO
  // binding and no sign anything went wrong. Instead: surface an inline error
  // and keep the picker open at THIS step so the user can retry the same pick
  // or consciously fall back to Custom — a pick never no-ops, but it also
  // never silently downgrades.
  const pickConnectionField = async (
    conn: ConnectionFieldEntry['__connection'],
    fieldName: string,
  ) => {
    const tplField = conn.template.fields.find((f) => f.name === fieldName);
    if (!tplField) {
      setPickError(`Couldn't bind "${fieldName}" — try again or add a custom field.`);
      return;
    }
    let scopeId = '';
    if (conn.template.scopeLookup) {
      const rows = await lookupConnection(conn.entryId, conn.template.scopeLookup, '').catch(
        () => [],
      );
      scopeId = rows[0]?.ref?.externalId ?? '';
      if (!scopeId) {
        setPickError(
          `Couldn't reach ${conn.template.sourceLabel} — field not bound; try again or add a custom field.`,
        );
        return;
      }
    }
    const built = fieldFromConnection(
      tplField.name,
      tplField.label,
      tplField.type,
      conn.entryId,
      FIRST_PARTY_CONNECTION_VERSION,
      tplField.buildLookup(scopeId),
      { entityType: tplField.entityType, existingKeys },
    );
    if (!built) {
      setPickError(`Couldn't bind "${fieldName}" — try again or add a custom field.`);
      return;
    }
    onPick(built);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pickIndex(clampedHighlight);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (step === 'browse-field') {
        toSourceStep();
      } else if (step === 'browse-source') {
        toTop();
      } else {
        onCancel();
      }
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (query) {
        setQuery((q) => q.slice(0, -1));
        setHighlight(0);
        return;
      }
      // Empty buffer: Backspace steps back too (spec: "Esc / Backspace at
      // step 2 returns to step 1").
      if (step === 'browse-field') toSourceStep();
      else if (step === 'browse-source') toTop();
      return;
    }
    if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && n <= options.length) {
        e.preventDefault();
        pickIndex(n - 1);
      }
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Any other printable character — letters, punctuation, space —
      // extends the live search buffer.
      e.preventDefault();
      setQuery((q) => q + e.key);
      setHighlight(0);
    }
  };

  return (
    <div
      className="fsp"
      ref={rootRef}
      tabIndex={0}
      role="listbox"
      aria-label="Pick an input source"
      onKeyDown={onKeyDown}
    >
      {step !== 'top' && (
        <div className="fsp__crumb">
          {step === 'browse-source' ? 'Browse sources' : (browseEntry?.name ?? browseEntry?.id ?? '')}
        </div>
      )}
      {(query || loading) && (
        <div className="fsp__query">
          {query ? (
            <>
              Search: {query}
              <span className="fsp__query-caret" aria-hidden="true">▍</span>
            </>
          ) : (
            'Loading fields…'
          )}
        </div>
      )}
      {/* task-9fdd9acee736 — a failed connection-source pick (e.g. the scope
          lookup 401s/times out) surfaces HERE instead of silently downgrading
          to an unbound custom field. The picker stays open on the same step
          so the same option is still one Enter away to retry. */}
      {pickError && (
        <div className="fsp__error" role="alert">
          {pickError}
        </div>
      )}
      {/* task-… (composer visual grammar unification) — the source picker's
          option rows now reuse the SAME composer__options/composer__option
          classes the who/template/type steps render, instead of a bespoke
          `.fsp__option*` box — so this step reads as part of the same form,
          not a different product (numbered kbd chip on the left, hover/active
          treatment, typography all shared with TaskComposer.css). */}
      <ul className="composer__options" role="listbox">
        {options.map((o, i) => (
          <li key={optionKey(o)}>
            <button
              type="button"
              role="option"
              aria-selected={i === clampedHighlight}
              className={
                'composer__option' +
                (i === clampedHighlight ? ' composer__option--active' : '') +
                (o.kind === 'custom' ? ' composer__option--other' : '') +
                (o.kind === 'browse' ? ' composer__option--browse' : '')
              }
              onMouseEnter={() => setHighlight(i)}
              onClick={(e) => {
                e.stopPropagation();
                pickIndex(i);
              }}
            >
              {i < 9 ? (
                <kbd className="composer__option-key">{i + 1}</kbd>
              ) : (
                <span className="composer__option-key" aria-hidden="true" />
              )}
              <span className="composer__option-label">{optionLabel(o)}</span>
              {o.kind === 'field' && (
                <span className="composer__option-hint">{catalogTypeToFieldType(o.field.type)}</span>
              )}
            </button>
          </li>
        ))}
        {options.length === 0 && <li className="fsp__empty">No matches</li>}
      </ul>
    </div>
  );
}

/** The add-input affordance (button + floating menu). Clicking it opens a
 *  menu — the keyboard-first FieldSourcePicker rendered inside a positioned
 *  popup — unless the catalog is empty and settled, in which case the button
 *  adds a blank row directly (today's behavior). `onPick` receives the
 *  fully-formed new field (a `source`-bound field for a catalog pick, a blank
 *  field for "Custom"); the caller simply appends it. `existingKeys` is
 *  deduped against. */
export function FieldKeyPicker({
  existingKeys,
  onPick,
  buttonLabel = '+ input',
  buttonClassName,
  buttonTitle,
}: {
  existingKeys: string[];
  onPick: (field: TaskDefField) => void;
  buttonLabel?: string;
  buttonClassName?: string;
  buttonTitle?: string;
}): JSX.Element {
  const { catalog, loading } = useQueryCatalog();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasCatalog = catalogPickerGroups(catalog).length > 0;

  // Close on outside click / Escape (FieldSourcePicker also handles Escape
  // internally via onCancel when it's already at the top step — this is the
  // backstop for the popup shell itself).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickCustom = () => {
    onPick(blankCustomField());
    setOpen(false);
  };

  const onButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Degrade: no catalog and done loading → behave like today's plain add.
    if (!hasCatalog && !loading) {
      pickCustom();
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <div className="fkp" ref={rootRef}>
      <button
        type="button"
        className={buttonClassName}
        title={buttonTitle ?? 'Add an input field'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={onButtonClick}
      >
        {buttonLabel}
      </button>
      {open && (
        <div className="fkp__menu">
          <FieldSourcePicker
            existingKeys={existingKeys}
            onPick={(field) => {
              onPick(field);
              setOpen(false);
            }}
            onCustom={pickCustom}
            onCancel={() => setOpen(false)}
            autoFocus
          />
        </div>
      )}
    </div>
  );
}

/** The badge shown on a source-backed field row: the bound query's name + an ✕
 *  to CLEAR the binding (turning the row into a plain key — the key/label/type
 *  are untouched; only `source` is removed). Resolves the query name from the
 *  shared catalog; falls back to the entityType or a generic label when the
 *  query isn't in the catalog (e.g. no longer approved). */
export function SourceBadge({
  source,
  onClear,
}: {
  source: NonNullable<TaskDefField['source']>;
  onClear: () => void;
}): JSX.Element {
  const { catalog } = useQueryCatalog();
  // task-8f27d842f14d — `source` is now additive over two binding forms (see
  // TaskDefField.source in newhome/types.ts); only the SavedQuery form has a
  // catalog entry to resolve a friendly name from. The Connection form has no
  // browsing catalog yet (separate task) — fall back to entityType/a generic
  // label, same degrade fieldFromCatalog's callers already tolerate.
  const isConnection = 'connectionId' in source;
  const entry = isConnection ? undefined : catalog.find((c) => c.id === source.savedQueryId);
  const name = entry?.name ?? source.entityType ?? (isConnection ? 'Connection field' : 'API field');
  return (
    <span className="fkp-badge" title={`Bound to ${name} — click ✕ to unbind`}>
      <span className="fkp-badge__name">↪ {name}</span>
      <button
        type="button"
        className="fkp-badge__clear"
        title="Clear the API binding (keep the key as a plain field)"
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
      >
        ✕
      </button>
    </span>
  );
}
