// task-b9cdad64ab9c — STUB. Final prop contract; a follow-up task builds the
// real split modal (left: conversational chat log driving field extraction;
// right: live form-field preview, per template.fields) per the V11 design
// reference. This stub creates a plain task via createTask so the "+ New
// Task" affordance is at least functionally wired end-to-end.
import { useState } from 'react';
import { createTask } from '../../tasks';
import type { TemplateConfig } from './types';
import './NewTaskModal.css';

export function NewTaskModal({
  projectId,
  template,
  onClose,
  onCreated,
}: {
  projectId: string;
  template: TemplateConfig;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // TODO(New Home follow-up) — thread projectId through TaskCreate once
      // the create-task bridge accepts a project scope directly here; for now
      // this stub creates an unscoped task so the affordance is functional.
      const t = await createTask({ title: title.trim(), folder: '' });
      onCreated(t.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nh-modal-overlay" onClick={onClose}>
      <div className="nh-modal nh-stub" onClick={(e) => e.stopPropagation()}>
        <div className="nh-modal__head">
          <div className="nh-stub__label">NewTaskModal (stub) · project: {projectId || 'unscoped'}</div>
          <button type="button" className="nh-modal__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="nh-modal__body">
          <p>Fields this project's template declares: {template.fields.length}</p>
          <input
            className="nh-modal__input"
            autoFocus
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {err && <p className="nh-modal__error">{err}</p>}
        </div>
        <div className="nh-modal__footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !title.trim()} onClick={() => void submit()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
