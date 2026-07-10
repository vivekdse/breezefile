// TemplateEditPanel — edit a single TEMPLATE's DEFINITION from the Level-2
// instances view (task-57e1470fad6f). Rename, edit the input variables + output
// schema, and the prompt/notes body; save via fm.typebuild.templates.update
// (server PATCH /chromeext/templates/{id}, owner-only).
//
// Editing a template does NOT retro-mutate already-instantiated tasks — they're
// independent snapshots. Only NEW instances pick up the edited definition; the
// panel says so.
//
// PHI: `notes` (the prompt body) MAY carry PHI — held in memory only, never
// logged/persisted to disk. `name` is PHI-guarded server-side (422). Field
// key/label DEFINITIONS are NON-PHI structure.
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { fm } from '../../bridge';
import type { Template } from '../../bridge';
import type { TaskDefField } from './types';
import { FieldKeyPicker, SourceBadge } from './FieldKeyPicker';
import './TemplateEditPanel.css';

type FieldType = TaskDefField['type'];
const FIELD_TYPES: FieldType[] = ['text', 'number', 'date', 'select', 'bool'];

// A local, editable copy of one field row (keeps the same shape as TaskDefField
// so it saves straight through).
function blankField(): TaskDefField {
  return { key: '', label: '', type: 'text' };
}

function FieldRows({
  io,
  fields,
  onChange,
}: {
  io: 'in' | 'out';
  fields: TaskDefField[];
  onChange: (next: TaskDefField[]) => void;
}): JSX.Element {
  const set = (i: number, patch: Partial<TaskDefField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const add = () => onChange([...fields, blankField()]);
  // task-73f6304ffb94 — clear a field's SavedQuery binding, leaving key/label/
  // type untouched (turns a source-backed row into a plain key).
  const clearSource = (i: number) =>
    onChange(
      fields.map((f, j) => {
        if (j !== i) return f;
        const { source: _drop, ...rest } = f;
        return rest;
      }),
    );
  const existingKeys = fields.map((f) => f.key).filter(Boolean);
  return (
    <div className="tep-fields">
      <div className="tep-fields__head">
        <span className="tep-fields__title">{io === 'in' ? 'Inputs' : 'Outputs'}</span>
        {io === 'in' ? (
          // task-73f6304ffb94 — inputs use the source-aware picker (API fields +
          // "Other (custom key)"); outputs keep the plain add.
          <FieldKeyPicker
            existingKeys={existingKeys}
            onPick={(f) => onChange([...fields, f])}
            buttonLabel="+ Add input"
            buttonClassName="tep-fields__add"
            buttonTitle="Add an input field (from an API, or a custom key)"
          />
        ) : (
          <button type="button" className="tep-fields__add" onClick={add}>
            + Add output
          </button>
        )}
      </div>
      {fields.length === 0 && <div className="tep-fields__empty">No {io === 'in' ? 'inputs' : 'outputs'} yet.</div>}
      {fields.map((f, i) => (
        <div className="tep-field" key={i}>
          {io === 'in' && f.source && (
            <SourceBadge source={f.source} onClear={() => clearSource(i)} />
          )}
          <input
            className="tep-field__key"
            placeholder="key"
            value={f.key}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <input
            className="tep-field__label"
            placeholder="label"
            value={f.label}
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <select
            className="tep-field__type"
            value={f.type}
            onChange={(e) => set(i, { type: e.target.value as FieldType })}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {io === 'out' && (
            <label className="tep-field__req" title="Required output (evidence)">
              <input
                type="checkbox"
                checked={!!f.required}
                onChange={(e) => set(i, { required: e.target.checked })}
              />
              req
            </label>
          )}
          <button
            type="button"
            className="tep-field__del"
            title="Remove this field"
            onClick={() => remove(i)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function TemplateEditPanel({
  templateId,
  onClose,
  onSaved,
}: {
  templateId: string;
  onClose: () => void;
  /** Called with the updated template after a successful save. */
  onSaved?: (t: Template) => void;
}): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [variables, setVariables] = useState<TaskDefField[]>([]);
  const [outputs, setOutputs] = useState<TaskDefField[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed from the full template (get decrypts `notes`). Memory-only.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fm.typebuild.templates
      .get(templateId)
      .then((t) => {
        if (cancelled) return;
        if (!t) {
          setLoadError('Template not found.');
          setLoading(false);
          return;
        }
        setName(t.name ?? '');
        setNotes(t.notes ?? '');
        setVariables((t.variables ?? []) as TaskDefField[]);
        setOutputs((t.outputSchema ?? []) as TaskDefField[]);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Failed to load template.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const cleanFields = (fields: TaskDefField[]): TaskDefField[] =>
    // Drop rows with no key; a template field needs a key to be meaningful.
    fields.filter((f) => f.key.trim() !== '').map((f) => ({ ...f, key: f.key.trim() }));

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await fm.typebuild.templates.update(templateId, {
        name: name.trim(),
        notes,
        variables: cleanFields(variables),
        outputSchema: cleanFields(outputs),
      });
      setSaving(false);
      onSaved?.(updated);
      onClose();
    } catch (e) {
      setSaving(false);
      // Surface the server's reason (PHI name → 422, non-owner → 403) verbatim.
      setSaveError(e instanceof Error ? e.message : 'Save failed.');
    }
  }

  return (
    <div className="tep" role="dialog" aria-label="Edit template">
      <div className="tep__head">
        <span className="tep__title">Edit template</span>
        <button type="button" className="tep__close" onClick={onClose} title="Close without saving">
          ✕
        </button>
      </div>

      {loading ? (
        <div className="tep__loading">Loading…</div>
      ) : loadError ? (
        <div className="tep__error">{loadError}</div>
      ) : (
        <div className="tep__body">
          <label className="tep__row">
            <span className="tep__label">Name</span>
            <input
              className="tep__name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
            />
          </label>

          <FieldRows io="in" fields={variables} onChange={setVariables} />
          <FieldRows io="out" fields={outputs} onChange={setOutputs} />

          <label className="tep__row tep__row--col">
            <span className="tep__label">Prompt / notes</span>
            <textarea
              className="tep__notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What the agent should do (this is the template body)."
              rows={6}
            />
          </label>

          <p className="tep__note">
            Editing this template does not change tasks already created from it —
            they keep their own values. Only new runs use the updated definition.
          </p>

          {saveError && <div className="tep__error">{saveError}</div>}

          <div className="tep__actions">
            <button type="button" className="btn btn--secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
