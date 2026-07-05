// task-b9cdad64ab9c / task-c60ae2a41e71 / task-2fd63b922beb / task-b1fa5098da3e
// / task-a7214605a998 — New Home chain instantiation. This file used to also own
// a per-project TemplateConfig (fields/columns/approval rules/steps/chains/
// repeatables), persisted to localStorage + best-effort synced to a server
// endpoint. Per docs/task-templates-design.md's "Removed/superseded" section,
// that per-project stored template was a wrong abstraction (task-2fd63b922beb)
// and has been stripped entirely (R3, task-b1fa5098da3e). All that remains here
// is `instantiateChain` — the ONE function that turns a chain into real tasks.
//
// task-a7214605a998 (final model) — a CHAIN IS A HIGHER-ORDER TEMPLATE: nothing
// but an ORDERED LIST OF SAVED TEMPLATES. Creating a chain = create a thin parent
// container (the "job") + instantiate each referenced template IN ORDER into a
// real child task, linked to the parent (parent_task_id) and to its predecessor
// (depends_on). The step content is NOT authored inline anymore — it comes from
// the templates the user already saved (via "Make this a template" on a task).
// The old inline-field builder (TaskDef-owns-fields) and its note-block WRITE
// path are gone; the note-block READERS stay so existing chains still render.

// ─── Chain instantiation (rewritten task-a7214605a998, template-picker model) ─
//
// instantiateChain is transport-agnostic: it takes injected async thunks
// (createParent / instantiateTemplate / linkTask) so the ordering + linkage
// logic is unit-tested without Electron/network. The composer wires the thunks
// to the real bridge calls:
//   - createParent      → fm.tasksCreate (a thin { title, projectId } container)
//   - instantiateTemplate → fm.typebuild.templates.instantiate (POST
//                           /chromeext/templates/{id}/instantiate — creates one
//                           real task from the template, inheriting its
//                           output_schema/data_keys/project/agent/flags)
//   - linkTask          → sourceAction('patch') → PATCH /chromeext/{id} with
//                           parent_task_id + depends_on (the instantiate endpoint
//                           itself accepts NEITHER, so linkage is a second pass)

/** One saved-template reference in the ordered chain the builder produces. */
export type ChainTemplateRef = {
  templateId: string;
  /** Display name (for a clearer parent/child title); optional. */
  name?: string;
};

/** Thrown when a step fails partway through. The parent + any children created
 *  before the failing step are NOT rolled back — parentId/childIds let the
 *  caller surface/resume the partially-created job rather than losing it. */
export class InstantiateChainError extends Error {
  parentId: string;
  childIds: string[];
  override cause: unknown;
  constructor(message: string, parentId: string, childIds: string[], cause: unknown) {
    super(message);
    this.name = 'InstantiateChainError';
    this.parentId = parentId;
    this.childIds = childIds;
    this.cause = cause;
  }
}

/** Turn one chain ("job") into a thin meta-parent container + one child task per
 *  referenced template, in order, each instantiated from its template and linked
 *  to the parent + its predecessor. `templates` is the ordered list the builder
 *  produced — refs to SAVED templates, never inline field defs. */
export async function instantiateChain(opts: {
  /** The chain/job title — becomes the thin parent container's title. */
  name: string;
  projectId?: string;
  /** The ordered saved-template references. */
  templates: ChainTemplateRef[];
  /** Create the thin parent container; returns its id. */
  createParent: (input: { title: string; projectId?: string }) => Promise<{ id: string }>;
  /** Instantiate ONE saved template into a real task; returns the new task id.
   *  Called with EMPTY values — creation defines the child's fields (inherited
   *  from the template) but never collects their values here. */
  instantiateTemplate: (
    templateId: string,
    opts: { projectId?: string },
  ) => Promise<{ id: string }>;
  /** Link a just-created child to the parent (parent_task_id) and, when it has a
   *  predecessor, to it (depends_on) — a second pass, since the instantiate
   *  endpoint accepts neither field. */
  linkTask: (
    taskId: string,
    patch: { parentTaskId: string; dependsOn?: string[] },
  ) => Promise<void>;
}): Promise<{ parentId: string; childIds: string[] }> {
  const { name, projectId, templates, createParent, instantiateTemplate, linkTask } = opts;
  const refs = templates ?? [];
  if (refs.length === 0) {
    throw new Error('instantiateChain: a chain needs at least one template');
  }

  const parent = await createParent({ title: name, ...(projectId ? { projectId } : {}) });

  const childIds: string[] = [];
  let predecessorId: string | undefined;
  for (const ref of refs) {
    try {
      const child = await instantiateTemplate(ref.templateId, {
        ...(projectId ? { projectId } : {}),
      });
      await linkTask(child.id, {
        parentTaskId: parent.id,
        ...(predecessorId ? { dependsOn: [predecessorId] } : {}),
      });
      childIds.push(child.id);
      predecessorId = child.id;
    } catch (err) {
      throw new InstantiateChainError(
        `instantiateChain: failed instantiating template "${ref.templateId}" ` +
          `(${childIds.length} of ${refs.length} children created before failure)`,
        parent.id,
        childIds,
        err,
      );
    }
  }

  return { parentId: parent.id, childIds };
}
