// task-ae0ec0348930 — the FormExtension CLIENT INTERPRETER (the core).
//
// Given an APPROVED FormExtension, this renders its `fields[]` using the app's
// OWN TRUSTED widgets and applies the server logic's ALLOWLISTED effects
// declaratively. The whole security point: this component NEVER eval's the
// extension's logic and NEVER injects markup — it renders known widgets and
// switches on exactly four effect keys (setValue / setVisible / setOptions /
// validate). The logic runs SERVER-side (run-logic); the client just applies the
// data it returns.
//
// Widget rendering:
//   • typeahead → SourceTypeahead (reuses the SavedQuery selector; binds
//     field.source.savedQueryId). Selecting a row writes the display label into
//     the shared value store (the ref is threaded by the parent's onSelectRef).
//   • select    → a <select> whose options come from a live setOptions effect
//     if present, else the field's declared options.
//   • text/number/date → the matching <input>.
//
// Effect application (per-field interpreter state, plus value writes):
//   • setValue:{k:v}    → writes v into the shared value store (submit sees it).
//   • setVisible:{k:b}  → hides/shows field k.
//   • setOptions:{k:[]} → replaces k's option list.
//   • validate:{k:msg}  → shows an inline error under k (null clears).
// On any field change we debounce, call runFormLogic(fxId, values, changedKey),
// then apply the (sanitized) effects. sanitizeEffects + applyEffectsToState are
// PURE (unit-tested) and drop any non-allowlisted key.
//
// PHI: field values may carry PHI — held in the shared value store (parent) and
// this component's memory only; never logged. Extension config is NON-PHI.

import { useEffect, useRef, useState } from 'react';
import { SourceTypeahead } from './SourceTypeahead';
import type { TemplateField } from './types';
import type { QueryRef } from '../../copilot/savedQueries';
import {
  applyEffectsToState,
  emptyInterpreterState,
  runFormLogic,
  valueWritesFromEffects,
  type FormExtension,
  type FormExtensionField,
  type InterpreterState,
} from '../../copilot/formExtensions';

const DEBOUNCE_MS = 300;

export function FormExtensionFields({
  extension,
  /** The SHARED form value store the parent modal owns (so submit + required
   *  checks see these values). Keyed by field key → string. */
  values,
  /** Write a single field value into the shared store (used by every widget +
   *  by setValue effects). */
  onSetValue,
  /** Display snapshots for typeahead fields (what was picked), keyed by field
   *  key. */
  refDisplays,
  /** A typeahead selection: records the opaque ref + display up to the parent
   *  (mirrors NewTaskModal.selectFieldRef). */
  onSelectRef,
}: {
  extension: FormExtension;
  values: Record<string, string>;
  onSetValue: (key: string, value: string) => void;
  refDisplays?: Record<string, string>;
  onSelectRef: (fieldKey: string, label: string, ref: QueryRef) => void;
}) {
  // Per-field interpreter state (hidden / dynamic options / errors). Value
  // writes go to the shared store via onSetValue, not here.
  const [state, setState] = useState<InterpreterState>(emptyInterpreterState);
  const [logicError, setLogicError] = useState<string | null>(null);

  // Latest values in a ref so the debounced run-logic call reads the current
  // store, not a stale render snapshot.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // A monotonically increasing request id so a slow earlier run-logic response
  // can't clobber a newer one (last-write-wins on the field the user touched).
  const reqSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run the extension's logic for the current values and apply the returned
  // effects. `changed` is the field key that just changed (null on the initial
  // pass). Debounced by the caller.
  const runLogic = (changed: string | null) => {
    const myReq = ++reqSeq.current;
    void (async () => {
      try {
        const { effects } = await runFormLogic(extension.id, valuesRef.current, changed);
        if (myReq !== reqSeq.current) return; // superseded
        // Apply the interpreter-state effects (hidden/options/errors)…
        setState((prev) => applyEffectsToState(prev, effects));
        // …and the value writes into the SHARED store (so submit sees them). We
        // don't overwrite the field the user is actively editing with itself.
        const writes = valueWritesFromEffects(effects);
        for (const [k, v] of Object.entries(writes)) {
          if (valuesRef.current[k] !== v) onSetValue(k, v);
        }
        setLogicError(null);
      } catch (e) {
        if (myReq !== reqSeq.current) return;
        // Keep it terse + value-free — run-logic surface may reference field
        // values indirectly; never echo them.
        setLogicError(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  // Initial pass once on mount / when the extension changes: compute the opening
  // effects (default visibility/options/validation) for the starting values.
  useEffect(() => {
    runLogic(null);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extension.id]);

  // A field changed: write it to the shared store immediately (so typing feels
  // instant), then debounce a run-logic call.
  const changeField = (key: string, value: string) => {
    onSetValue(key, value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runLogic(key), DEBOUNCE_MS);
  };

  return (
    <div className="nh-formext" data-formext-id={extension.id}>
      <div className="nh-form-panel__head nh-formext__head">
        {extension.name}
        <span className="nh-form-field__badge" title="Custom form behavior">🧩</span>
      </div>
      {logicError && (
        <p className="nh-formext__logic-err" role="status">
          Couldn’t update form logic.
        </p>
      )}
      {extension.fields.map((f) => {
        if (state.hidden[f.key]) return null; // setVisible:{k:false}
        const value = values[f.key] ?? '';
        const error = state.errors[f.key];
        // A live setOptions effect replaces the field's declared options.
        const options = state.options[f.key] ?? f.options ?? [];
        return (
          <div
            key={f.key}
            className={`nh-form-field nh-formext__field${
              error ? ' nh-form-field--error' : ''
            }`}
          >
            <div className="nh-form-field__k">{f.label}</div>
            <div className="nh-form-field__v">
              <FieldWidget
                field={f}
                value={value}
                options={options}
                display={refDisplays?.[f.key]}
                onChange={(v) => changeField(f.key, v)}
                onSelectRef={(label, ref) => {
                  // A typeahead pick lands its label in the shared store AND
                  // records the ref; then we re-run logic keyed on this field.
                  onSelectRef(f.key, label, ref);
                  onSetValue(f.key, label);
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  debounceRef.current = setTimeout(() => runLogic(f.key), DEBOUNCE_MS);
                }}
              />
            </div>
            {error && <div className="nh-formext__field-err">{error}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Render ONE field with a TRUSTED widget selected by `field.widget`. This is
 *  the allowlist: an unknown widget falls back to a plain text input (never
 *  anything eval'd or markup-injected). */
function FieldWidget({
  field,
  value,
  options,
  display,
  onChange,
  onSelectRef,
}: {
  field: FormExtensionField;
  value: string;
  options: string[];
  display: string | undefined;
  onChange: (value: string) => void;
  onSelectRef: (label: string, ref: QueryRef) => void;
}) {
  if (field.widget === 'typeahead' && field.source) {
    // Reuse the SavedQuery typeahead. It takes a TemplateField-shaped object; a
    // FormExtensionField's source is the same {savedQueryId, version?} shape.
    const asTemplateField: TemplateField = {
      key: field.key,
      label: field.label,
      type: 'text',
      required: false,
      agentFetchable: false,
      source: field.source,
    };
    return (
      <SourceTypeahead field={asTemplateField} display={display ?? value} onSelect={onSelectRef} />
    );
  }
  if (field.widget === 'select') {
    return (
      <select
        className="nh-formext__select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  const inputType = field.widget === 'number' ? 'number' : field.widget === 'date' ? 'date' : 'text';
  return (
    <input
      className="nh-formext__input"
      type={inputType}
      value={value}
      placeholder={`Enter ${field.label.toLowerCase()}…`}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
