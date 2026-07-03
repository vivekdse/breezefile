// task-b9cdad64ab9c / task-c60ae2a41e71 / task-2fd63b922beb / task-b1fa5098da3e
// (R3) — New Home chain instantiation. This file used to also own a
// per-project TemplateConfig (fields/columns/approval rules/steps/chains/
// repeatables), persisted to localStorage + best-effort synced to a server
// endpoint. Per docs/task-templates-design.md's "Removed/superseded" section,
// that per-project stored template was a wrong abstraction (task-2fd63b922beb)
// and has been stripped entirely (R3, task-b1fa5098da3e): a project is now
// just a category + a derived view. All that remains here is
// `instantiateTemplate` — the ONE function that turns a chain (`TaskDef[]`,
// given directly by the caller — never read off a project pref) into real
// tasks, whose parent carries the chain in full via a v2 `task-template`
// block. See docs/task-templates-design.md for the full contract.

import type { TaskDef } from './types';
import { buildTaskFieldsBlock, buildTaskOutputsBlock, buildTaskTemplateBlock } from './taskSchema.mjs';

// ─── Template instantiation (task-fb31518201da, corrected task-2fd63b922beb) ─
//
// instantiateTemplate turns a chain of TaskDefs — given directly by the
// caller, NOT read off a project's TemplateConfig — into real tasks: one META
// PARENT task (the "job") carrying the chain's name and every task-def IN
// FULL in a v2 ```task-template block (buildTaskTemplateBlock), then one
// CHILD task per task-def, in order, linked via `parentTaskId` + a linear
// `dependsOn` chain. ALL task-defs get a child, including conditional
// (`neededWhen`) ones: the condition is evaluated client-side later from
// `taskDefStatus` (taskSchema.mjs), not at instantiation time, so the linear
// chain ordering holds regardless of which steps end up "not needed".
//
// task-2fd63b922beb abstraction correction: the chain definition rides the
// chained task itself (the parent's v2 block is fully self-describing), not a
// project-level TemplateConfig — so this function takes `defs: TaskDef[]`
// directly rather than a `template`/`templateId` pointing at project prefs.
// Any surface can reconstruct the whole chain later from the parent task
// alone (parseTaskTemplateBlock), no project config lookup required.

/** Join notes parts with blank-line separators, dropping empty/whitespace-only
 *  parts and trimming each — shared by instantiateTemplate's parent/child
 *  notes assembly below. */
function joinNotesParts(parts: (string | undefined | null)[]): string {
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join('\n\n');
}

/** Split a flat `values` map — keyed by `fieldRef(taskDefId, key)` per the
 *  TaskComposer/task-templates-design.md contract — into one bare-keyed map
 *  scoped to a single task-def, so each child's ```task-fields block only
 *  ever carries that task-def's own values. PHI: `values` flows through
 *  in-memory only, never logged. */
function valuesForTaskDef(
  values: Record<string, string> | null | undefined,
  taskDefId: string,
): Record<string, string> {
  const prefix = `${taskDefId}.`;
  const out: Record<string, string> = {};
  for (const [ref, v] of Object.entries(values ?? {})) {
    if (ref.startsWith(prefix)) out[ref.slice(prefix.length)] = v;
  }
  return out;
}

/** Thrown by instantiateTemplate when a child create fails partway through.
 *  The meta parent (and any children created before the failing one) are
 *  NOT rolled back — `parentId`/`childIds` let the caller surface/resume the
 *  partially-created job instead of silently losing it. */
export class InstantiateTemplateError extends Error {
  parentId: string;
  childIds: string[];
  override cause: unknown;
  constructor(message: string, parentId: string, childIds: string[], cause: unknown) {
    super(message);
    this.name = 'InstantiateTemplateError';
    this.parentId = parentId;
    this.childIds = childIds;
    this.cause = cause;
  }
}

/** Turn one chain instantiation ("job") into a meta parent task + one
 *  linearly-chained child task per task-def. `defs` is the chain itself —
 *  given directly by the caller (composer form state, or a chain copied from
 *  an existing chained task), never read off a project's TemplateConfig. See
 *  the module comment above and docs/task-templates-design.md for the
 *  contract. */
export async function instantiateTemplate(opts: {
  /** The chain/job title — also becomes the v2 ```task-template block's
   *  `name`. */
  name: string;
  projectId?: string;
  /** The chain definition itself: full TaskDef objects, in order. Serialized
   *  in full into the parent's v2 ```task-template block so the chain is
   *  self-describing from the parent task alone. */
  defs: TaskDef[];
  /** Flat map keyed by `fieldRef(taskDefId, fieldKey)` — INPUT values only.
   *  PHI: shaped in memory only, never logged. */
  values: Record<string, string>;
  createTask: (input: {
    title: string;
    notes: string;
    projectId?: string;
    parentTaskId?: string;
    dependsOn?: string[];
  }) => Promise<{ id: string }>;
}): Promise<{ parentId: string; childIds: string[] }> {
  const { name, projectId, defs, values, createTask } = opts;
  const taskDefs = defs ?? [];
  const projectFields = projectId ? { projectId } : {};

  const parentNotes = joinNotesParts([
    `Job created from chain "${name}": ${taskDefs.length} task${taskDefs.length === 1 ? '' : 's'}.`,
    buildTaskTemplateBlock(name, taskDefs),
  ]);
  const parent = await createTask({
    title: name,
    notes: parentNotes,
    ...projectFields,
  });

  const childIds: string[] = [];
  let predecessorId: string | undefined;
  for (const def of taskDefs) {
    const defValues = valuesForTaskDef(values, def.id);
    const notes = joinNotesParts([
      def.notes,
      buildTaskFieldsBlock(name, def.id, defValues),
      buildTaskOutputsBlock(def),
    ]);
    let child: { id: string };
    try {
      child = await createTask({
        title: `${name} — ${def.name}`,
        notes,
        parentTaskId: parent.id,
        dependsOn: predecessorId ? [predecessorId] : undefined,
        ...projectFields,
      });
    } catch (err) {
      throw new InstantiateTemplateError(
        `instantiateTemplate: failed creating child for task-def "${def.id}" ` +
          `(${childIds.length} of ${taskDefs.length} children created before failure)`,
        parent.id,
        childIds,
        err,
      );
    }
    childIds.push(child.id);
    predecessorId = child.id;
  }

  return { parentId: parent.id, childIds };
}
