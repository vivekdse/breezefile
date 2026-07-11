// task-e713f307c422 — the typeahead widget for a data-source-backed field (a
// TaskDefField whose `source` binds a SavedQuery OR, as of task-8f27d842f14d,
// a Connection — docs/connections-design.md §D.2). As the user types we
// debounce and call the executor — SavedQuery: POST
// /chromeext/queries/:id/execute (server-executed); Connection: a
// CLIENT-DIRECT declarative `lookup` CallSpec (fm.typebuild.connections.lookup,
// never round-tripping through general.typebuild.com, §A) — and show the
// returned rows. Selecting a row hands the CALLER the WHOLE row (ref + every
// declared field), memory-only until TaskComposer's save path writes the
// bundle it needs into the task `data` bag (placeholder keys, per
// docs/typebuild-data-field-contract.md).
//
// (Reintroduced post-R3 against the CURRENT type: `field` is a `TaskDefField`
// — the self-describing task-def field that now carries `source` — not the
// removed `TemplateField`. Otherwise unchanged from commit 126c0fd.)
//
// PHI: row display fields may carry PHI — held in this component's state and
// rendered in memory only, never logged/persisted. Only what the caller's
// onSelect threads onward leaves this component.
import { useEffect, useRef, useState } from 'react';
import type { TaskDefField } from './types';
import {
  executeQuery,
  lookupConnection,
  rowLabel,
  type ConnectionLookupRow,
  type ConnectionRef,
  type QueryRef,
  type QueryRow,
} from '../../copilot/savedQueries';
import './SourceTypeahead.css';

const DEBOUNCE_MS = 250;

// A row from EITHER executor, normalized to what this component needs to
// render + hand back: a label-able row plus its ref, tagged by which form
// produced it so the caller (TaskComposer) knows whether to snapshot a
// bundle (Connection) or just the ref (SavedQuery, unchanged behavior).
type AnyRow =
  | { kind: 'query'; row: QueryRow }
  | { kind: 'connection'; row: ConnectionLookupRow };

export function SourceTypeahead({
  field,
  /** The current display snapshot for this field (what was picked), or ''. */
  display,
  onSelect,
}: {
  field: TaskDefField;
  display: string | undefined;
  /** `row` is the WHOLE selected row (ref + every declared field) for a
   *  Connection-bound field, so the caller can fan `field.source.bundle`
   *  into `<fieldKey>.*` sibling keys — undefined for the SavedQuery form
   *  (whose only durable payload is `ref`, unchanged since task-73f6304ffb94). */
  onSelect: (label: string, ref: QueryRef | ConnectionRef, row?: ConnectionLookupRow) => void;
}) {
  const source = field.source!;
  const isConnection = 'connectionId' in source;
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<AnyRow[]>([]);
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
        const result = isConnection
          ? (await lookupConnection(source.connectionId, source.lookup, q)).map(
              (row): AnyRow => ({ kind: 'connection', row }),
            )
          : (await executeQuery(source.savedQueryId, q, source.version)).map(
              (row): AnyRow => ({ kind: 'query', row }),
            );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- source is a union; narrow fields read below
  }, [term, isConnection, isConnection ? undefined : source.savedQueryId, isConnection ? undefined : source.version, isConnection ? source.connectionId : undefined]);

  function pick(item: AnyRow) {
    const label = rowLabel(item.row);
    if (item.kind === 'connection') onSelect(label, item.row.ref, item.row);
    else onSelect(label, item.row.ref);
    setOpen(false);
    setTerm('');
    setRows([]);
  }

  function rowKey(item: AnyRow): string {
    return item.row.ref.externalId;
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
          {rows.map((item) => (
            <button
              key={rowKey(item)}
              type="button"
              role="option"
              className="nh-typeahead__opt"
              onClick={() => pick(item)}
            >
              {rowLabel(item.row)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
