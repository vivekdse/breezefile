// task-a9841cfc0e1b — Project CRUD dialog: CREATE (name/description/
// instructions/parent) and EDIT (same fields + attached-folder management) in
// one component, mode-driven — the simplified model (a project = name/
// description/instructions/parent + folders; a CATEGORY + derived view, no
// customization creep) means create and edit share the exact same field set,
// so one dialog covers both rather than two near-duplicate forms.
//
// Reuses the nh-dialog/nh-dialog-backdrop shell (TaskDetailDialog.css) for
// visual consistency with the rest of New Home's overlays; form-specific bits
// (labeled inputs, the parent <select>, the folder list) get their own small
// stylesheet (ProjectDialog.css).
//
// Mutations go straight through the SAME fm.typebuild.projects.* bridge the
// copilot's create_project/update_project/etc. actions call (see
// src/copilot/actions.tsx) — one path, not a parallel implementation. The
// caller (NewHomePage) is responsible for refreshing the project list
// (refreshProjects) and picking the right next selection afterward; this
// dialog only performs the mutation and reports success/failure.
import { useEffect, useMemo, useState } from 'react';
import { fm } from '../../bridge';
import type { Project } from '../../types';
import { validParentOptions } from './projectCrud.mjs';
import './ProjectDialog.css';

type Props = {
  /** Present → editing that project. Absent → creating a new one. */
  project?: Project | null;
  /** Every known project (for the parent picker + cycle-prevention). */
  projects: Project[];
  onClose: () => void;
  /** Called after a successful create/update so the caller can refresh the
   *  list and (for create) select the new project. */
  onSaved: (project: Project) => void;
};

export function ProjectDialog({ project, projects, onClose, onSaved }: Props) {
  const isEdit = !!project;
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [parentProjectId, setParentProjectId] = useState(project?.parentProjectId ?? '');
  const [folders, setFolders] = useState<string[]>(project?.folders ?? []);
  const [newFolder, setNewFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parentOptions = useMemo(
    () =>
      validParentOptions(
        projects.map((p) => ({ id: p.id, parentProjectId: p.parentProjectId })),
        project?.id ?? null,
      ),
    [projects, project?.id],
  );
  const parentById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A project name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit && project) {
        const res = await fm.typebuild.projects.patch(project.id, {
          name: trimmed,
          description: description.trim() || undefined,
          instructions: instructions.trim() || undefined,
        });
        if (!res.ok) {
          setError(formatPatchReason(res.reason));
          setSaving(false);
          return;
        }
        onSaved(res.project);
        onClose();
      } else {
        const created = await fm.typebuild.projects.create({
          name: trimmed,
          description: description.trim() || undefined,
          instructions: instructions.trim() || undefined,
          parentProjectId: parentProjectId || undefined,
          folders: folders.length ? folders : undefined,
        });
        onSaved(created);
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function handleAddFolder() {
    const folder = newFolder.trim();
    if (!folder) return;
    if (isEdit && project) {
      setFolderBusy(true);
      setError(null);
      try {
        const updated = await fm.typebuild.projects.addFolder(project.id, folder);
        setFolders(updated.folders);
        setNewFolder('');
        onSaved(updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setFolderBusy(false);
      }
    } else {
      // Not yet created — just accumulate locally; sent as `folders` on create.
      if (!folders.includes(folder)) setFolders([...folders, folder]);
      setNewFolder('');
    }
  }

  async function handleRemoveFolder(folder: string) {
    if (isEdit && project) {
      setFolderBusy(true);
      setError(null);
      try {
        const updated = await fm.typebuild.projects.removeFolder(project.id, folder);
        setFolders(updated.folders);
        onSaved(updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setFolderBusy(false);
      }
    } else {
      setFolders(folders.filter((f) => f !== folder));
    }
  }

  return (
    <div className="nh-dialog-backdrop" onClick={onClose}>
      <div
        className="nh-dialog nh-pdlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nh-pdlg-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nh-dialog__head">
          <div>
            <div id="nh-pdlg-title" className="nh-dialog__title">
              {isEdit ? `Edit ${project?.name}` : 'New project'}
            </div>
            <div className="nh-dialog__sub">
              A project is a category — name, description, agent instructions, and
              attached folders. No per-project customization beyond this.
            </div>
          </div>
          <button type="button" className="nh-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="nh-dialog__body">
          <div className="nh-dialog__section">
            <label className="nh-pdlg__label" htmlFor="nh-pdlg-name">
              Name
            </label>
            <input
              id="nh-pdlg-name"
              className="nh-pdlg__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Aetna HMO Authorizations"
              autoFocus
            />
          </div>

          <div className="nh-dialog__section">
            <label className="nh-pdlg__label" htmlFor="nh-pdlg-desc">
              Description <span className="nh-pdlg__optional">(optional)</span>
            </label>
            <textarea
              id="nh-pdlg-desc"
              className="nh-dialog__textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown as the New Home subtitle when this project is selected."
            />
          </div>

          <div className="nh-dialog__section">
            <label className="nh-pdlg__label" htmlFor="nh-pdlg-instr">
              Agent instructions <span className="nh-pdlg__optional">(optional)</span>
            </label>
            <div className="nh-pdlg__hint">
              Guidance an agent reads before working a task in this project — teaching
              context, not a task template.
            </div>
            <textarea
              id="nh-pdlg-instr"
              className="nh-dialog__textarea"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Always verify the member ID against the portal before submitting."
            />
          </div>

          {!isEdit && (
            <div className="nh-dialog__section">
              <label className="nh-pdlg__label" htmlFor="nh-pdlg-parent">
                Parent project <span className="nh-pdlg__optional">(optional)</span>
              </label>
              <select
                id="nh-pdlg-parent"
                className="nh-pdlg__select"
                value={parentProjectId}
                onChange={(e) => setParentProjectId(e.target.value)}
              >
                <option value="">(none — top level)</option>
                {parentOptions.map((id) => (
                  <option key={id} value={id}>
                    {parentById.get(id)?.name ?? id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="nh-dialog__section">
            <label className="nh-pdlg__label">
              Folders <span className="nh-pdlg__optional">(optional)</span>
            </label>
            {folders.length > 0 && (
              <ul className="nh-pdlg__folder-list">
                {folders.map((f) => (
                  <li key={f} className="nh-pdlg__folder-item">
                    <span className="nh-pdlg__folder-path">{f}</span>
                    <button
                      type="button"
                      className="nh-pdlg__folder-remove"
                      onClick={() => void handleRemoveFolder(f)}
                      disabled={folderBusy}
                      aria-label={`Remove folder ${f}`}
                      title="Remove this folder"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="nh-pdlg__folder-add">
              <input
                className="nh-pdlg__input"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddFolder();
                  }
                }}
                placeholder="/path/to/folder"
                disabled={folderBusy}
              />
              <button
                type="button"
                className="nh__btn"
                onClick={() => void handleAddFolder()}
                disabled={folderBusy || !newFolder.trim()}
              >
                Add
              </button>
            </div>
          </div>

          {error && <div className="nh-dialog__error">{error}</div>}
        </div>

        <div className="nh-pdlg__foot">
          <button type="button" className="nh__btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="nh__btn nh__btn--primary"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatPatchReason(reason: string): string {
  if (reason === 'not_owner') return "You don't own this project.";
  if (reason === 'phi_rejected') {
    return 'That text looks like it may contain patient information — rephrase and try again.';
  }
  if (reason === 'not_visible') return 'This project is no longer visible.';
  return `Failed: ${reason}`;
}
