// task-4a8d2c98f667 — the drawer's Inputs section: LIST the task's `data` bag
// key names (non-PHI), RESOLVE a value on demand for display (memory-only,
// masked-with-reveal for sensitive-looking keys), EDIT a value / ADD a new
// key (merged via a resolve-merge-replace PATCH — see electron/typebuild/
// task-data.ts patchTaskData), and gate all of it on claim-holder / creator /
// group-admin, surfacing a CLEAR message instead of a silent empty state when
// the viewer lacks rights.
//
// Self-contained by design (task-198447cfe26e reuses this same component in
// the composer's edit flow) — it takes only primitive props (taskId + auth
// context + the known key list) and owns its own resolve/edit/save state.
//
// PHI: a resolved or drafted value lives ONLY in this component's React
// state. It is never persisted to disk/logs, never cached in the task store,
// and is dropped whenever the key collapses (reveal toggled off) or the
// component unmounts / taskId changes.
//
// LEGACY (spec item 4): a task whose body carries a ```task-fields block
// (parseTaskFieldsBlock, ../newhome/taskSchema.mjs) already has its data
// VALUES inline in the decrypted body (no separate resolve hop needed) — the
// values prop threads those in and a save rewrites the block via
// onLegacyBlockChange instead of hitting the typebuild:data:patch IPC.

import { useEffect, useMemo, useState } from 'react';
import { fm } from '../../bridge';
import { SourceTypeahead } from '../newhome/SourceTypeahead';
import type { ConnectionLookupRow, ConnectionRef, QueryRef } from '../../copilot/savedQueries';
// task-8f27d842f14d — the Connection-form field-source snapshot: fan a picked
// row's bundle into `<fieldKey>.*` sibling values (+ provenance) the exact
// same way TaskComposer's onSelectSource does, so this drawer's Inputs editor
// (edit-mode on an already-created task) stays consistent with create-time.
import { connectionBundleKeys, snapshotConnectionRow } from '../newhome/fieldCatalog.mjs';
import {
  normalizeDataKey,
  isValidDataKey,
  looksSensitive,
  effectiveDataKeys,
  canEditTaskData,
  dataAuthDeniedMessage,
  buildDataPatchPayload,
  hasPendingDataChanges,
  siblingKeysForPatch,
} from './taskDataInputs.mjs';

type LegacyFields = { templateId: string; taskDefId: string; values: Record<string, unknown> } | null;

export function TaskDataInputs({
  taskId,
  dataKeys,
  claimedBy,
  createdBy,
  viewerEmail,
  legacyFields,
  fieldDefs,
  onLegacyFieldsSave,
  onSaved,
}: {
  taskId: string;
  /** Server-declared `data_keys` (non-PHI names), when the server sends them. */
  dataKeys?: string[];
  /** task-e713f307c422 — optional map of data-key → its TaskDefField definition,
   *  so a source-backed input renders as a live-query typeahead instead of a
   *  plain text field. Absent → every key renders as plain text (unchanged
   *  behavior). Definitions are NON-PHI; only the VALUE a user selects (display
   *  snapshot + opaque ref) is written to the data bag. */
  fieldDefs?: Record<string, import('../newhome/types').TaskDefField>;
  claimedBy?: string | null;
  createdBy?: string | null;
  viewerEmail?: string | null;
  /** Parsed ```task-fields block, when this is a LEGACY task carrying values
   *  inline in the body rather than the server `data` bag. */
  legacyFields?: LegacyFields;
  /** Legacy save path: rewrite the ```task-fields block with the given
   *  values. Only called when `legacyFields` is present. */
  onLegacyFieldsSave?: (values: Record<string, unknown>) => Promise<void> | void;
  /** Called after a successful server-side save so the caller can refresh
   *  the detail (picks up the server's updated data_keys). */
  onSaved?: () => void;
}) {
  const isLegacy = !!legacyFields;

  // Session-known keys: keys we've resolved or added THIS session, folded in
  // so a server without data_keys still shows what the user has touched.
  const [sessionKnownKeys, setSessionKnownKeys] = useState<string[]>([]);
  useEffect(() => {
    setSessionKnownKeys([]);
  }, [taskId]);

  const keys = useMemo(
    () =>
      isLegacy
        ? Object.keys(legacyFields?.values ?? {}).sort()
        : effectiveDataKeys(dataKeys, sessionKnownKeys),
    [isLegacy, legacyFields, dataKeys, sessionKnownKeys],
  );

  const canEdit = isLegacy || canEditTaskData({ claimedBy, createdBy, viewerEmail });

  // Resolved/drafted values, keyed by data key. `undefined` = not yet
  // resolved (or legacy value, seeded directly since it's already in-hand).
  const [values, setValues] = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [droppedWarning, setDroppedWarning] = useState<string | null>(null);

  // New-key composer row.
  const [newKeyDraft, setNewKeyDraft] = useState('');
  const [newValueDraft, setNewValueDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // Reset all in-memory value/draft state on task change (never carry a
  // resolved value from one task into another) — same discipline as the
  // drawer's own `body` PHI state.
  useEffect(() => {
    setValues({});
    setOriginals({});
    setRevealed({});
    setResolving({});
    setRemovedKeys([]);
    setSaveError(null);
    setDroppedWarning(null);
    setNewKeyDraft('');
    setNewValueDraft('');
    setAddError(null);
  }, [taskId]);

  // Legacy values are already decrypted (they're part of the body we already
  // hold) — seed them directly rather than issuing a resolve hop.
  useEffect(() => {
    if (!isLegacy || !legacyFields) return;
    const seeded: Record<string, string> = {};
    for (const [k, v] of Object.entries(legacyFields.values)) {
      seeded[k] = typeof v === 'string' ? v : v == null ? '' : String(v);
    }
    setValues(seeded);
    setOriginals(seeded);
    // Legacy values are inline text, not sensitive-masked PHI-on-demand —
    // show them plainly (spec item 4 treats legacy as "same editor", and the
    // value is already in memory regardless of reveal state).
    const allRevealed: Record<string, boolean> = {};
    for (const k of Object.keys(seeded)) allRevealed[k] = true;
    setRevealed(allRevealed);
  }, [isLegacy, legacyFields]);

  // task-e713f307c422 — eagerly resolve the CURRENT display snapshot of each
  // source-backed key so the typeahead can show what was previously picked
  // (a plain key resolves only on explicit reveal; a typeahead has no reveal
  // affordance). Only when the viewer may edit (a read-only viewer keeps the
  // reveal-on-demand path). The value stays in component state only.
  useEffect(() => {
    if (isLegacy || !fieldDefs) return;
    for (const key of keys) {
      if (fieldDefs[key]?.source && values[key] === undefined && !resolving[key]) {
        void resolveKey(key);
      }
    }
    // resolveKey/values/resolving are intentionally omitted — this fires on the
    // key set / fieldDefs changing; resolveKey guards against double-resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, fieldDefs, isLegacy]);

  const resolveKey = async (key: string) => {
    if (isLegacy) return; // legacy values are already in hand
    if (resolving[key] || values[key] !== undefined) return;
    setResolving((r) => ({ ...r, [key]: true }));
    try {
      const value = await fm.typebuild.taskData.resolve(taskId, key);
      setValues((v) => ({ ...v, [key]: value ?? '' }));
      setOriginals((o) => ({ ...o, [key]: value ?? '' }));
    } finally {
      setResolving((r) => ({ ...r, [key]: false }));
    }
  };

  const toggleReveal = (key: string) => {
    const next = !revealed[key];
    setRevealed((r) => ({ ...r, [key]: next }));
    if (next && values[key] === undefined) void resolveKey(key);
  };

  const editValue = (key: string, next: string) => {
    setValues((v) => ({ ...v, [key]: next }));
  };

  // task-e713f307c422 — a source-backed field's selection: record the row's
  // display label as the key's own value AND JSON-stringify its opaque ref into
  // a sibling `<key>.ref` key, mirroring the placeholder-key convention the
  // original NewTaskModal used (`field.<k>.display` / `field.<k>.ref`). The
  // sibling key is folded into sessionKnownKeys so it renders and, more
  // importantly, is included in the save's known-key set. The ref is NON-PHI;
  // the label is a short display snapshot (memory-only, never logged).
  const selectSource = (
    key: string,
    label: string,
    ref: QueryRef | ConnectionRef,
    source?: import('../newhome/types').TaskDefField['source'],
    row?: ConnectionLookupRow,
  ) => {
    editValue(key, label);
    if (row && source && 'connectionId' in source) {
      // task-8f27d842f14d — Connection form: fan the WHOLE picked row's
      // bundle into `<key>.*` sibling values (+ provenance). Clear any stale
      // sibling from a PRIOR pick first (a re-pick can change which fields
      // get written, e.g. a different bundle or a row missing a field the
      // last pick had) so a changed selection never leaves an orphan.
      const stale = connectionBundleKeys(key, [...Object.keys(values), ...keys]);
      for (const k of stale) editValue(k, '');
      const { upsert, keys: newKeys } = snapshotConnectionRow(key, source, row);
      for (const [k, v] of Object.entries(upsert)) editValue(k, v);
      setSessionKnownKeys((prev) => {
        const merged = new Set(prev);
        for (const k of [...stale, ...newKeys]) merged.add(k);
        return Array.from(merged);
      });
    } else {
      const refKey = `${key}.ref`;
      editValue(refKey, JSON.stringify(ref));
      setSessionKnownKeys((k) => (k.includes(refKey) ? k : [...k, refKey]));
    }
  };

  const removeKey = (key: string) => {
    setRemovedKeys((r) => (r.includes(key) ? r : [...r, key]));
  };

  const undoRemove = (key: string) => {
    setRemovedKeys((r) => r.filter((k) => k !== key));
  };

  const addKey = () => {
    setAddError(null);
    const key = normalizeDataKey(newKeyDraft);
    if (!isValidDataKey(key)) {
      setAddError('Key must be lowercase letters, numbers, ".", "_", "-" only (e.g. "source").');
      return;
    }
    if (keys.includes(key) && !removedKeys.includes(key)) {
      setAddError(`"${key}" already exists.`);
      return;
    }
    setSessionKnownKeys((k) => (k.includes(key) ? k : [...k, key]));
    setValues((v) => ({ ...v, [key]: newValueDraft }));
    setOriginals((o) => ({ ...o, [key]: '' })); // new key — always "changed"
    setRevealed((r) => ({ ...r, [key]: true }));
    setRemovedKeys((r) => r.filter((k) => k !== key));
    setNewKeyDraft('');
    setNewValueDraft('');
  };

  const payload = useMemo(
    () => buildDataPatchPayload({ drafts: values, originals, removedKeys }),
    [values, originals, removedKeys],
  );
  const dirty = hasPendingDataChanges(payload);

  const save = async () => {
    setSaveError(null);
    setDroppedWarning(null);
    if (!dirty) return;

    if (isLegacy) {
      if (!onLegacyFieldsSave) return;
      setSaving(true);
      try {
        const nextValues: Record<string, unknown> = { ...(legacyFields?.values ?? {}) };
        for (const key of Object.keys(payload.upsert)) nextValues[key] = payload.upsert[key];
        for (const key of payload.delete) delete nextValues[key];
        await onLegacyFieldsSave(nextValues);
        setOriginals({ ...values });
        setRemovedKeys([]);
        onSaved?.();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Save failed.');
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const siblings = siblingKeysForPatch(keys, payload);
      const res = await fm.typebuild.taskData.patch(
        taskId,
        payload.upsert,
        payload.delete,
        siblings,
      );
      if (res.ok) {
        setOriginals({ ...values });
        setRemovedKeys([]);
        if (res.droppedKeys.length > 0) {
          setDroppedWarning(
            `Saved, but couldn't preserve: ${res.droppedKeys.join(', ')} (resolve failed — check those keys).`,
          );
        }
        onSaved?.();
      } else if (res.status === 403) {
        setSaveError(dataAuthDeniedMessage('write'));
      } else {
        setSaveError(res.error || 'Save failed.');
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (keys.length === 0 && !canEdit) {
    // Nothing to show and no rights to add — the clear message spec item 5
    // requires, not a bare empty state.
    return (
      <section className="tdd__sect tdd__inputs-sect">
        <div className="tdd__sect-h">Inputs</div>
        <p className="tdd__muted">{dataAuthDeniedMessage('read')}</p>
      </section>
    );
  }

  if (keys.length === 0 && !isLegacy) {
    return (
      <section className="tdd__sect tdd__inputs-sect">
        <div className="tdd__sect-h">Inputs</div>
        <p className="tdd__muted">No inputs on this task yet.</p>
        {canEdit && (
          <AddKeyRow
            newKeyDraft={newKeyDraft}
            newValueDraft={newValueDraft}
            addError={addError}
            onKeyChange={setNewKeyDraft}
            onValueChange={setNewValueDraft}
            onAdd={addKey}
          />
        )}
        {dirty && (
          <SaveBar saving={saving} saveError={saveError} droppedWarning={droppedWarning} onSave={() => void save()} />
        )}
      </section>
    );
  }

  return (
    <section className="tdd__sect tdd__inputs-sect">
      <div className="tdd__sect-h">Inputs</div>
      {!canEdit && (
        <p className="tdd__muted tdd__inputs-readonly-note">
          Read-only — {dataAuthDeniedMessage('write').toLowerCase()}
        </p>
      )}
      <div className="tdd__inputs-list">
        {keys.map((key) => {
          const isRemoved = removedKeys.includes(key);
          const isRevealed = !!revealed[key] || !looksSensitive(key);
          const isResolving = !!resolving[key];
          const value = values[key];
          // task-e713f307c422 — a source-backed input renders as a live-query
          // typeahead instead of a plain text field. The current picked value
          // (key's own value) is the display snapshot; selecting a new row
          // rewrites it and the sibling `<key>.ref`.
          const sourceDef = fieldDefs?.[key]?.source ? fieldDefs![key] : null;
          return (
            <div
              key={key}
              className={`tdd__input-item${isRemoved ? ' tdd__input-item--removed' : ''}`}
            >
              <div className="tdd__input-k tdd__mono">{key}</div>
              {isRemoved ? (
                <div className="tdd__input-removed-row">
                  <span className="tdd__muted">marked for removal</span>
                  {canEdit && (
                    <button type="button" className="tdd__input-undo" onClick={() => undoRemove(key)}>
                      Undo
                    </button>
                  )}
                </div>
              ) : (
                <div className="tdd__input-v-row">
                  {sourceDef ? (
                    // Resolve the existing display snapshot lazily so the
                    // typeahead can show what was previously picked. The ref
                    // sibling (`<key>.ref`) is written on select, not shown.
                    canEdit ? (
                      <SourceTypeahead
                        field={sourceDef}
                        display={value ?? ''}
                        onSelect={(label, ref, row) => selectSource(key, label, ref, sourceDef.source, row)}
                      />
                    ) : value === undefined ? (
                      <button
                        type="button"
                        className="tdd__input-reveal"
                        onClick={() => void resolveKey(key)}
                      >
                        Show value
                      </button>
                    ) : (
                      <input type="text" className="tdd__input-value" value={value} disabled readOnly />
                    )
                  ) : !isRevealed ? (
                    <>
                      <span className="tdd__input-masked">••••••••</span>
                      <button type="button" className="tdd__input-reveal" onClick={() => toggleReveal(key)}>
                        Reveal
                      </button>
                    </>
                  ) : isResolving ? (
                    <span className="tdd__muted">Resolving…</span>
                  ) : value === undefined ? (
                    <button
                      type="button"
                      className="tdd__input-reveal"
                      onClick={() => void resolveKey(key)}
                    >
                      Show value
                    </button>
                  ) : (
                    <input
                      type="text"
                      className="tdd__input-value"
                      value={value}
                      disabled={!canEdit}
                      onChange={(e) => editValue(key, e.target.value)}
                    />
                  )}
                  {canEdit && !isRemoved && (
                    <button
                      type="button"
                      className="tdd__input-remove"
                      title="Remove this input"
                      aria-label={`Remove ${key}`}
                      onClick={() => removeKey(key)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <AddKeyRow
          newKeyDraft={newKeyDraft}
          newValueDraft={newValueDraft}
          addError={addError}
          onKeyChange={setNewKeyDraft}
          onValueChange={setNewValueDraft}
          onAdd={addKey}
        />
      )}
      {dirty && (
        <SaveBar saving={saving} saveError={saveError} droppedWarning={droppedWarning} onSave={() => void save()} />
      )}
    </section>
  );
}

function AddKeyRow({
  newKeyDraft,
  newValueDraft,
  addError,
  onKeyChange,
  onValueChange,
  onAdd,
}: {
  newKeyDraft: string;
  newValueDraft: string;
  addError: string | null;
  onKeyChange: (v: string) => void;
  onValueChange: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="tdd__input-add">
      <input
        type="text"
        className="tdd__input-add-key"
        placeholder="key (e.g. source)"
        value={newKeyDraft}
        onChange={(e) => onKeyChange(e.target.value)}
      />
      <input
        type="text"
        className="tdd__input-add-value"
        placeholder="value"
        value={newValueDraft}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onAdd();
          }
        }}
      />
      <button type="button" className="tdd__input-add-btn" onClick={onAdd}>
        Add
      </button>
      {addError && (
        <div className="tdd__input-add-error" role="alert">
          {addError}
        </div>
      )}
    </div>
  );
}

function SaveBar({
  saving,
  saveError,
  droppedWarning,
  onSave,
}: {
  saving: boolean;
  saveError: string | null;
  droppedWarning: string | null;
  onSave: () => void;
}) {
  return (
    <div className="tdd__inputs-savebar">
      <button type="button" className="tdd__inputs-save" disabled={saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save inputs'}
      </button>
      {saveError && (
        <div className="tdd__input-add-error" role="alert">
          {saveError}
        </div>
      )}
      {droppedWarning && !saveError && <div className="tdd__muted">{droppedWarning}</div>}
    </div>
  );
}

export default TaskDataInputs;
