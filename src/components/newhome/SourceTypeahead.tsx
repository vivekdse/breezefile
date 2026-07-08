// task-e713f307c422 — the typeahead widget for a data-source-backed field (a
// TaskDefField whose `source` binds a SavedQuery). As the user types we
// debounce and call the executor (POST /chromeext/queries/:id/execute) and show
// the returned rows; selecting a row records its opaque `ref` + a display
// snapshot up to the caller, which threads the ref onto the task's `data` bag
// (placeholder keys, per docs/typebuild-data-field-contract.md).
//
// (Reintroduced post-R3 against the CURRENT type: `field` is a `TaskDefField`
// — the self-describing task-def field that now carries `source` — not the
// removed `TemplateField`. Otherwise unchanged from commit 126c0fd.)
//
// PHI: row display fields may carry PHI — held in this component's state and
// rendered in memory only, never logged/persisted. Only ref + snapshot leave.
import { useEffect, useRef, useState } from 'react';
import type { TaskDefField } from './types';
import { executeQuery, rowLabel, type QueryRef, type QueryRow } from '../../copilot/savedQueries';
import './SourceTypeahead.css';

const DEBOUNCE_MS = 250;

export function SourceTypeahead({
  field,
  /** The current display snapshot for this field (what was picked), or ''. */
  display,
  onSelect,
}: {
  field: TaskDefField;
  display: string | undefined;
  onSelect: (label: string, ref: QueryRef) => void;
}) {
  const source = field.source!;
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A monotonically increasing request id so a slow earlier response can't
  // clobber a newer one (last-write-wins on the input the user actually typed).
  const reqSeq = useRef(0);

  useEffect(() => {
    const q = term.trim();
    if (!q) {
      setRows([]);
      setErr(null);
      return;
    }
    const myReq = ++reqSeq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const result = await executeQuery(source.savedQueryId, q, source.version);
        if (myReq !== reqSeq.current) return; // superseded
        setRows(result);
        setErr(null);
      } catch (e) {
        if (myReq !== reqSeq.current) return;
        setRows([]);
        // Keep it terse + value-free — the executor surface is non-PHI.
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (myReq === reqSeq.current) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term, source.savedQueryId, source.version]);

  function pick(row: QueryRow) {
    const label = rowLabel(row);
    onSelect(label, row.ref);
    setOpen(false);
    setTerm('');
    setRows([]);
  }

  return (
    <div className="nh-typeahead">
      {display && (
        <div className="nh-typeahead__selected" title={display}>
          {display}
          <span className="nh-form-field__check">✓</span>
        </div>
      )}
      <input
        className="nh-typeahead__input"
        placeholder={display ? 'Change…' : `Search ${field.label.toLowerCase()}…`}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (term.trim() || busy || err) && (
        <div className="nh-typeahead__menu" role="listbox">
          {busy && <div className="nh-typeahead__hint">Searching…</div>}
          {err && !busy && <div className="nh-typeahead__hint nh-typeahead__hint--err">Lookup failed</div>}
          {!busy && !err && rows.length === 0 && term.trim() && (
            <div className="nh-typeahead__hint">No matches</div>
          )}
          {rows.map((row) => (
            <button
              key={row.ref.externalId}
              type="button"
              role="option"
              className="nh-typeahead__opt"
              onClick={() => pick(row)}
            >
              {rowLabel(row)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
