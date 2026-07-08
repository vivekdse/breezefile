// task-73f6304ffb94 — the source-aware key picker: the ONE "+ input"
// affordance shared by BOTH authoring surfaces (TaskComposer's FieldEditors and
// TemplateEditPanel's FieldRows). Template authoring is key-centric — instead
// of only adding a blank row, the user gets a menu of FIELDS EXPOSED BY APPROVED
// EXTERNAL APIs (SavedQueries, grouped per query) plus "Other (custom key)".
//
//   - Picking an API field adds a field row bound to that SavedQuery: `key` =
//     the field name (normalized + deduped, still user-editable), `label` =
//     humanized name, `type` mapped from the catalog type, and a `source`
//     binding — all computed by the PURE fieldCatalog.mjs (testable under node).
//   - Picking "Other" adds a blank row, exactly like today.
//
// Degrade-gracefully: the catalog is fetched ONCE per app run (module cache,
// swallows errors → []). If it's empty (signed out / offline / no approved
// queries), the button is a plain blank-add — the editor stays fully usable.
//
// NON-PHI: the catalog is field NAMES + TYPES only; safe to hold in state. No
// task VALUES ever pass through here.
import { useEffect, useRef, useState } from 'react';
import type { TaskDefField } from './types';
import { describeQueries, type QueryCatalogEntry } from '../../copilot/savedQueries';
import {
  blankCustomField,
  catalogPickerGroups,
  fieldFromCatalog,
} from './fieldCatalog.mjs';
import './FieldKeyPicker.css';

// Module-level single-flight cache: the catalog is the same for every picker on
// screen and rarely changes within a session, so fetch it at most once and
// share the promise. Errors resolve to [] (never reject) so the hook always
// settles and the picker degrades to "Other".
let catalogPromise: Promise<QueryCatalogEntry[]> | null = null;
export function loadQueryCatalog(): Promise<QueryCatalogEntry[]> {
  if (!catalogPromise) catalogPromise = describeQueries();
  return catalogPromise;
}

/** Fetch-once hook over the SavedQuery catalog. `{ catalog: [], loading }`
 *  until it settles; `catalog` is [] on any failure so callers never special-
 *  case errors — an empty catalog just means "Other" is the only option. */
export function useQueryCatalog(): { catalog: QueryCatalogEntry[]; loading: boolean } {
  const [catalog, setCatalog] = useState<QueryCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    loadQueryCatalog().then((c) => {
      if (cancelled) return;
      setCatalog(c);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { catalog, loading };
}

/** The add-input affordance. Renders a button; clicking it opens a menu of
 *  catalog fields (grouped per query) + "Other (custom key)" — unless the
 *  catalog is empty and settled, in which case the button adds a blank row
 *  directly (today's behavior). `onPick` receives the fully-formed new field
 *  (a `source`-bound field for a catalog pick, a blank field for "Other"); the
 *  caller simply appends it. `existingKeys` is deduped against. */
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
}) {
  const { catalog, loading } = useQueryCatalog();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const groups = catalogPickerGroups(catalog);
  const hasCatalog = groups.length > 0;

  // Close on outside click / Escape.
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
  const pickCatalog = (entry: QueryCatalogEntry, field: { name: string; type: string }) => {
    const built = fieldFromCatalog(entry, field, existingKeys);
    // fieldFromCatalog only returns null on a malformed entry/field the menu
    // wouldn't have surfaced; fall back to a blank row so a click never no-ops.
    onPick(built ?? blankCustomField());
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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onButtonClick}
      >
        {buttonLabel}
      </button>
      {open && (
        <div className="fkp__menu" role="menu">
          {loading && !hasCatalog && <div className="fkp__hint">Loading fields…</div>}
          {groups.map((g) => (
            <div className="fkp__group" key={g.id}>
              <div className="fkp__group-head">{g.name}</div>
              {g.fields.map((f) => {
                // Preview the key/label the pick will produce.
                const preview = fieldFromCatalog(
                  catalog.find((c) => c.id === g.id),
                  f,
                  existingKeys,
                );
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className="fkp__opt"
                    key={f.name}
                    onClick={() =>
                      pickCatalog(
                        catalog.find((c) => c.id === g.id) as QueryCatalogEntry,
                        f,
                      )
                    }
                  >
                    <span className="fkp__opt-label">{preview?.label ?? f.name}</span>
                    <span className="fkp__opt-type">{preview?.type ?? 'text'}</span>
                  </button>
                );
              })}
            </div>
          ))}
          <button type="button" role="menuitem" className="fkp__opt fkp__opt--other" onClick={pickCustom}>
            Other (custom key)
          </button>
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
}) {
  const { catalog } = useQueryCatalog();
  const entry = catalog.find((c) => c.id === source.savedQueryId);
  const name = entry?.name ?? source.entityType ?? 'API field';
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
