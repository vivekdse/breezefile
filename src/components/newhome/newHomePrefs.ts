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

  // task-1b70093cc04e perf — instantiate + link in PARALLEL, not one serial
  // await-chain. The old loop did `1 + 2N` sequential round-trips (instantiate,
  // then link, per template), which made saving a multi-step chain feel like it
  // hung. The templates are independent (each instantiated with empty values),
  // and depends_on is a pure function of the ORDERED child ids — so we can
  // instantiate them all at once, then, once every id is known, link them all at
  // once. Ordering is preserved by array index, not by threading a predecessor
  // through the serial chain. Wall-clock drops to ~2 round-trips regardless of N.
  const created = await Promise.allSettled(
    refs.map((ref) =>
      instantiateTemplate(ref.templateId, { ...(projectId ? { projectId } : {}) }),
    ),
  );

  // Collect every child that WAS created (across the whole parallel batch) so
  // the error carries the full partial-job for cleanup/resume, then surface the
  // first failure. Position i in `created` maps to refs[i].
  const childIds: string[] = [];
  let firstFail = -1;
  for (let i = 0; i < created.length; i++) {
    const outcome = created[i];
    if (outcome.status === 'fulfilled') {
      childIds.push(outcome.value.id);
    } else if (firstFail === -1) {
      firstFail = i;
    }
  }
  if (firstFail !== -1) {
    const bad = created[firstFail] as PromiseRejectedResult;
    throw new InstantiateChainError(
      `instantiateChain: failed instantiating template "${refs[firstFail].templateId}" ` +
        `(${childIds.length} of ${refs.length} children created)`,
      parent.id,
      childIds,
      bad.reason,
    );
  }

  const linked = await Promise.allSettled(
    childIds.map((id, i) =>
      linkTask(id, {
        parentTaskId: parent.id,
        // depends_on = the immediately-preceding child, so the chain runs in
        // order. First child has no predecessor.
        ...(i > 0 ? { dependsOn: [childIds[i - 1]] } : {}),
      }),
    ),
  );
  const linkFail = linked.findIndex((o) => o.status === 'rejected');
  if (linkFail !== -1) {
    throw new InstantiateChainError(
      `instantiateChain: failed linking child ${linkFail + 1} of ${childIds.length} ` +
        `to the chain parent`,
      parent.id,
      childIds,
      (linked[linkFail] as PromiseRejectedResult).reason,
    );
  }

  return { parentId: parent.id, childIds };
}
