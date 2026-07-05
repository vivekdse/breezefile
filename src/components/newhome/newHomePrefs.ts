// task-b9cdad64ab9c / task-c60ae2a41e71 / task-2fd63b922beb / task-b1fa5098da3e
// / task-a7214605a998 — New Home chain instantiation. This file used to also own
// a per-project TemplateConfig (fields/columns/approval rules/steps/chains/
// repeatables), persisted to localStorage + best-effort synced to a server
// endpoint. Per docs/task-templates-design.md's "Removed/superseded" section,
// that per-project stored template was a wrong abstraction (task-2fd63b922beb)
// and has been stripped entirely (R3, task-b1fa5098da3e): a project is now
// just a category + a derived view. All that remains here is
// `instantiateTemplate` — the ONE function that turns a chain (`TaskDef[]`,
// given directly by the caller — never read off a project pref) into real tasks.
//
// task-a7214605a998 (create pass) — a chain is now nothing but an ORDERED LIST
// OF NORMAL TASKS. Each step becomes a REAL child task that owns its own title,
// instructions (body), input fields (first-class `data`/`data_keys`) and output
// fields (first-class `output_schema`). The chain is created ATOMICALLY via the
// server bulk endpoint (POST /chromeext/tasks/bulk, reached through the injected
// `bulkCreateTasks` thunk) — NOT the old N+1 loop that embedded the whole chain
// as ```task-template / ```task-outputs / ```task-fields markdown note-blocks.
// The note-block READERS stay (existing chains still parse) — only the WRITE
// path changed here.

import type { TaskDef, TaskDefField } from './types';
import { effectiveFieldKey } from './taskSchema.mjs';

// ─── Template instantiation (task-fb31518201da, rewritten task-a7214605a998) ─
//
// instantiateTemplate turns a chain of TaskDefs — given directly by the caller,
// NOT read off a project's TemplateConfig — into real tasks: one thin META
// PARENT container (title = the chain/job name) plus one CHILD task per
// task-def, in order, linked via the bulk endpoint's parent linkage + a linear
// `dependsOnIndexes` ordering. ALL task-defs get a child, including conditional
// (`neededWhen`) ones: the condition is evaluated client-side later from
// `taskDefStatus` (taskSchema.mjs), not at instantiation time, so the linear
// chain ordering holds regardless of which steps end up "not needed".
//
// Each child carries its step's fields as FIRST-CLASS task schema:
//   - output fields → `outputSchema` (the server's output_schema)
//   - input fields  → `data` keys with (usually empty) values (the server
//     derives data_keys from the bag keys). Creation DEFINES the fields; it
//     never asks the human for their VALUES (task-0d63c7b0ebdb) — so the values
//     are empty unless a caller (the from-template flow) passes collected ones.

/** Split a flat `values` map — keyed by `<taskDefId>.<key>` per the
 *  TaskComposer/task-templates-design.md contract — into one bare-keyed map
 *  scoped to a single task-def, so each child's `data` bag only ever carries
 *  that task-def's own values. PHI: `values` flows through in-memory only,
 *  never logged. */
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

/** One create payload for a chain step, as the `bulkCreateTasks` thunk consumes
 *  it. A step's fields are FIRST-CLASS task schema (outputSchema/data), not
 *  note-blocks. `dependsOnIndexes` encodes ordering as positions in the tasks
 *  array (resolved to real ids by the source after the bulk create returns). */
export type ChainTaskInput = {
  title: string;
  notes?: string;
  projectId?: string;
  outputSchema?: TaskDefField[];
  data?: Record<string, string>;
  dependsOnIndexes?: number[];
};

/** Turn one chain instantiation ("job") into a thin meta-parent container + one
 *  linearly-ordered child task per task-def, created ATOMICALLY via the injected
 *  `bulkCreateTasks` thunk (POST /chromeext/tasks/bulk). `defs` is the chain
 *  itself — given directly by the caller (composer form state, or a chain copied
 *  from an existing chained task), never read off a project's TemplateConfig.
 *  See docs/task-templates-design.md for the contract. */
export async function instantiateTemplate(opts: {
  /** The chain/job title — becomes the thin parent container's title. */
  name: string;
  projectId?: string;
  /** The chain definition itself: full TaskDef objects, in order. Each maps to
   *  a real child task owning its own first-class output_schema/data_keys. */
  defs: TaskDef[];
  /** Flat map keyed by `<taskDefId>.<fieldKey>` — INPUT values only. Usually
   *  EMPTY at plain-create time (creation defines fields, collects no values);
   *  the from-template flow passes collected values here. PHI: in memory only. */
  values: Record<string, string>;
  /** Injected transport: create the parent container + ordered children in one
   *  bulk round-trip and return their ids ([parentId, child0, child1, ...]). */
  bulkCreateTasks: (input: {
    parent: { title: string; projectId?: string };
    tasks: ChainTaskInput[];
  }) => Promise<{ parentId: string | null; ids: string[] }>;
}): Promise<{ parentId: string; childIds: string[] }> {
  const { name, projectId, defs, values, bulkCreateTasks } = opts;
  const taskDefs = defs ?? [];
  if (taskDefs.length === 0) {
    // A chain is an ordered list of tasks — an empty chain has nothing to
    // create. The composer guards this (chainDefsValid) before ever calling in,
    // so this is a defensive guard, not a real path.
    throw new Error('instantiateTemplate: a chain needs at least one step');
  }

  const tasks: ChainTaskInput[] = taskDefs.map((def, i) => {
    // Input fields → a `data` bag. effectiveFieldKey normalizes each field's key
    // (falling back to a slug of the label when the key was left blank) so a
    // value never silently drops — the same normalization the single-task path
    // uses. Values come from `values` when the caller collected them; otherwise
    // empty (creation defines the fields/data_keys, never asks the values).
    const defValues = valuesForTaskDef(values, def.id);
    const data: Record<string, string> = {};
    for (const f of def.inputs ?? []) {
      const key = effectiveFieldKey(f);
      if (!key) continue;
      data[key] = defValues[f.key] ?? '';
    }
    const outputs = def.outputs ?? [];
    return {
      title: def.name,
      ...(def.notes ? { notes: def.notes } : {}),
      ...(projectId ? { projectId } : {}),
      ...(outputs.length > 0 ? { outputSchema: outputs } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {}),
      // Linear ordering: every step but the first waits on its predecessor.
      ...(i > 0 ? { dependsOnIndexes: [i - 1] } : {}),
    };
  });

  const result = await bulkCreateTasks({
    parent: { title: name, ...(projectId ? { projectId } : {}) },
    tasks,
  });

  const ids = Array.isArray(result.ids) ? result.ids : [];
  // The bulk endpoint returns ids = [parentId, child0, child1, ...] (parent
  // first because a parent container is always created here). childIds are the
  // rest, in step order.
  const parentId = result.parentId ?? ids[0] ?? '';
  const childIds = ids.slice(1);
  return { parentId, childIds };
}
