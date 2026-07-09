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
import type { Group, Project } from '../../types';
import { validParentOptions } from './projectCrud.mjs';
import './ProjectDialog.css';

type Props = {
  /** Present → editing that project. Absent → creating a new one. */
  project?: Project | null;
  /** Every known project (for the parent picker + cycle-prevention). */
  projects: Project[];
  /** task-group-select-dialog — the group currently scoped in New Home, used
   *  to PRESELECT the group for a new project (highest-priority default). Null
   *  when the caller is on "All groups"; then the first available group (or a
   *  selected parent's group) is preselected instead. */
  defaultGroupId?: string | null;
  onClose: () => void;
  /** Called after a successful create/update so the caller can refresh the
   *  list and (for create) select the new project. */
  onSaved: (project: Project) => void;
};

export function ProjectDialog({ project, projects, defaultGroupId, onClose, onSaved }: Props) {
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
  // task-group-select-dialog — the caller's groups (id + name), loaded on mount
  // the same way the parent options are derived. `groupsLoaded` distinguishes
  // "still loading" from "genuinely belongs to zero groups" so the zero-group
  // hint doesn't flash before the list lands.
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [groupId, setGroupId] = useState('');

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

  // task-group-select-dialog — load the caller's groups on mount. Create mode
  // uses them to populate the select; edit mode uses them only to resolve the
  // read-only group NAME (falls back to the opaque id if the fetch is empty).
  useEffect(() => {
    let cancelled = false;
    void fm.typebuild.groups
      .list()
      .then((list) => {
        if (cancelled) return;
        setGroups(list);
        setGroupsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setGroupsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // task-group-select-dialog — the group inherited from a selected parent
  // project: when a parent is chosen the child MUST live in the parent's group
  // (mirroring the server), so the select locks to this value.
  const inheritedGroupId = parentProjectId
    ? parentById.get(parentProjectId)?.groupId ?? null
    : null;
  const groupLocked = !!inheritedGroupId;

  // task-group-select-dialog — EDIT read-only label: resolve the project's
  // group id to its real name from the loaded registry; fall back to the id
  // (never blocks on the fetch). null when the project has no group.
  const editGroupName = useMemo(() => {
    if (!project?.groupId) return null;
    return groups.find((g) => g.id === project.groupId)?.name ?? project.groupId;
  }, [project?.groupId, groups]);

  // Preselect once groups have loaded (create only), in priority order:
  //   (a) the caller's scoped group (defaultGroupId), else
  //   (b) a selected parent's group, else
  //   (c) the first group in the list.
  // Runs only while `groupId` is still empty so it never fights the user's own
  // pick. The inheritance effect below handles later parent changes.
  useEffect(() => {
    if (isEdit || !groupsLoaded || groupId) return;
    const has = (id: string | null | undefined): id is string =>
      !!id && groups.some((g) => g.id === id);
    if (has(defaultGroupId)) setGroupId(defaultGroupId);
    else if (has(inheritedGroupId)) setGroupId(inheritedGroupId);
    else if (groups.length) setGroupId(groups[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupsLoaded, groups, defaultGroupId, inheritedGroupId, isEdit]);

  // Inheritance rule: whenever a parent IS selected, force the group to the
  // parent's group (the select is rendered disabled). Clearing the parent
  // leaves the last value in place and re-enables the select.
  useEffect(() => {
    if (isEdit) return;
    if (inheritedGroupId) setGroupId(inheritedGroupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inheritedGroupId, isEdit]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A project name is required.');
      return;
    }
    // task-group-select-dialog — group is REQUIRED on create when the user
    // belongs to any groups (mirrors the `name` required-ness above). Zero
    // groups is a separate blocked state handled by the submit button + hint.
    if (!isEdit && groups.length > 0 && !groupId) {
      setError('Select a group for this project.');
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
          // task-group-select-dialog — explicit group so the project lands where
          // the user chose, not the server's silent auto-resolution. Maps to
          // `group_id` at the source (parentProjectId → parent_project_id idiom).
          groupId: groupId || undefined,
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

          {/* task-group-select-dialog — CREATE: the group is an EXPLICIT,
              required choice (the server would otherwise auto-resolve one the
              user never saw). Disabled + inherited when a parent is selected
              (the child must live in the parent's group). Read-only in edit
              mode (below) — patch_project can't move groups. */}
          {!isEdit && (
            <div className="nh-dialog__section">
              <label className="nh-pdlg__label" htmlFor="nh-pdlg-group">
                Group
              </label>
              <div className="nh-pdlg__hint">
                {groupLocked
                  ? 'Inherited from the parent project — a subproject lives in its parent’s group.'
                  : 'Who can see this project.'}
              </div>
              <select
                id="nh-pdlg-group"
                className="nh-pdlg__select"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                disabled={groupLocked || groups.length === 0}
              >
                {groups.length === 0 && <option value="">(no groups)</option>}
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              {groupsLoaded && groups.length === 0 && (
                <div className="nh-pdlg__hint">
                  You need a group before you can create a project.
                </div>
              )}
            </div>
          )}

          {/* task-group-select-dialog — EDIT: group is READ-ONLY. The server's
              patch_project doesn't move a project between groups, so we show
              it (never send group_id on patch) rather than offer an edit that
              would silently no-op. */}
          {isEdit && (
            <div className="nh-dialog__section">
              <label className="nh-pdlg__label">Group</label>
              <div className="nh-pdlg__readonly">
                {editGroupName ?? '(none)'}
              </div>
              <div className="nh-pdlg__hint">
                Changing a project’s group isn’t supported.
              </div>
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
            disabled={saving || !name.trim() || (!isEdit && !groupId)}
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
