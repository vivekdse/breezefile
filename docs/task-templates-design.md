# Task Templates — design contract (epic task-bb7665870605)

A **template is a domain-neutral service that chains task-definitions.** Each
task-def owns its **input fields** (human provides at creation) and **output
fields** (agent produces; `required` outputs = the task's **evidence**). The
template holds no fields of its own — forms and table columns are built by
**dynamically aggregating** every task-def's fields. Approved prototype:
claude.ai/code/artifact/5a49e9cf-d833-44ae-8986-c505bf3d5cff.

This doc is the **contract between the epic's parallel workstreams (T1–T8).**
Shapes and block formats here are normative; do not invent variants.

## Vocabulary

| Term | Is | Implemented as |
|---|---|---|
| Template | reusable service: ordered `TaskDef[]` | `TemplateConfig.taskDefs` (per-project, server-backed prefs) |
| Task-def | smallest primitive; owns inputs + outputs | `TaskDef` |
| Job / meta task | one instantiation | parent task (`parent_task_id` on children) |
| Step | one unit of agent/human work | child task, ordered via `depends_on` |
| Evidence | proof of completion | the task-def's `required` **output** fields — no separate system |
| Not-needed | conditional skip | `neededWhen` unmet → child cancelled/annotated, cell renders `n/a` |

## Types (src/components/newhome/types.ts)

```ts
export type TaskDefField = {
  key: string;              // [a-z0-9._-]+, unique within the task-def
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[];       // select only
  required?: boolean;       // OUTPUT fields: required === evidence
};

export type TaskDefCondition = {
  ref: string;              // "<taskDefId>.<outputKey>" of an UPSTREAM task-def
  op: '==' | '!=' | '<' | '>';
  value: string | number;
};

export type TaskDef = {
  id: string;               // slug, unique within the template
  name: string;
  notes?: string;           // base agent prompt for this step
  inputs: TaskDefField[];
  outputs: TaskDefField[];
  neededWhen?: TaskDefCondition | null;  // absent/null = always needed
};
// TemplateConfig gains: taskDefs?: TaskDef[]
// Unification: chains/steps/repeatables semantics fold into taskDefs.
// Back-compat: existing TemplateField/columns keep working; migration is
// additive (a legacy repeatable ≈ a single TaskDef with no fields).
```

**PHI rule:** field *definitions* (keys, labels, types, conditions) are
NON-PHI and may live in prefs/templates/docs. Field *values* are potentially
PHI and ride only in task bodies / result payloads (encrypted channels) —
never in prefs, logs, or notifications.

## Transport blocks (task body)

`TaskCreate` has no structured `data` map yet, so values ride the task body
(the encrypted PHI channel) in fenced blocks — same precedent as the existing
` ```task-fields ` block from NewTaskModal. One JSON object per block, no
comments, parse defensively (malformed → null → feature degrades, never throws).

Child task body, appended after the human/agent notes:

    ```task-fields
    {"templateId":"<id>","taskDefId":"intake","values":{"customer":"...","items":"12"}}
    ```

    ```task-outputs
    {"taskDefId":"intake","fields":[{"key":"has_stains","label":"Stains present?","type":"bool","required":true}]}
    ```

Meta parent body:

    ```task-template
    {"templateId":"<id>","taskDefIds":["intake","stain","wash"]}
    ```

## Result contract (agent → client)

Agents submit outputs via `submit_task_result` with **`type: "fields"`**:

```json
{ "taskDefId": "intake", "fields": { "has_stains": "Yes", "intake_photo": "ph_8831" } }
```

Client side: `mapResult` (electron/sources/typebuild.ts:474) is open dispatch —
`"fields"` passes through untouched. The renderer registry
(src/components/tasks/taskResult.mjs `KNOWN_RESULT_TYPES` + TaskResult.tsx
`RESULT_RENDERERS`) gains a `fields` renderer (T6). All values coerce via
`coerceCell`-style defensive shaping.

## Pure helper module — src/components/newhome/taskSchema.mjs (+ .d.mts)

Plain `.mjs` (mirrors taskResult.mjs; testable under `node --test`). API:

```
fieldRef(taskDefId, key)                      → "id.key"
buildTaskFieldsBlock(templateId, taskDefId, values)   → string (fenced block)
buildTaskOutputsBlock(taskDef)                → string (fenced block)
buildTaskTemplateBlock(templateId, taskDefs)  → string (fenced block)
parseTaskFieldsBlock(body)    → {templateId,taskDefId,values} | null
parseTaskOutputsBlock(body)   → {taskDefId,fields[]} | null
parseTaskTemplateBlock(body)  → {templateId,taskDefIds[]} | null
resultFields(result)          → {taskDefId,fields} | null   // from {type:'fields',payload}
evalCondition(cond, valuesByRef)              → boolean     // unknown upstream value → false
taskDefStatus(taskDef, valuesByRef)           → 'done'|'active'|'pending'|'skip'
    // skip: neededWhen unmet. No required outputs: any output present → done.
    // Else: 0 required filled → pending; some → active; all → done.
metaStatus(taskDefs, valuesByRef)             → 'done'|'active'|'pending'
    // over non-skip defs: all done → done; any done/active → active; else pending
aggregateInputs(taskDefs)                     → [{taskDef, field}]  // form/table order
```

`valuesByRef` is a flat `Record<string,string|number>` keyed by `fieldRef`,
merging parsed input values and result fields across a job's children.

## Workstreams & file ownership (no overlaps within a wave)

| Task | Owns | Depends |
|---|---|---|
| T1 task-8b694714b13c | types.ts, taskSchema.mjs/.d.mts, newHomeTemplateOps.ts, newHomePrefs.ts (types/migration only), tests | — |
| T7 task-5170073890ed | electron/typebuild/operator-instructions.ts, task-context-bundle.ts (+execute.ts) | this doc only |
| T2 task-af3a8fdc8974 | TemplateEditor.tsx | T1 |
| T3 task-04ea172532c0 | TaskComposer.tsx — **extend the canonical composer, same class; no new form** | T1 |
| T4 task-fb31518201da | newHomePrefs.ts instantiateChain → instantiateTemplate | T1, T3 |
| T5 task-a4397184def4 | RosterTable.tsx, useNewHomeData.ts | T1, T4 |
| T6 task-d83c6ada2d18 | TaskDetailDialog.tsx, taskResult.mjs, TaskResult.tsx | T1 |
| T8 task-f17cc309a086 | integration, tests, HelpTour, gates, push | all |

## UX invariants (from the approved prototype)

- New-job form = **TaskComposer extended**: input questions grouped by owning
  task-def; outputs shown read-only ("the agent will produce: …, required").
- Roster: grouped headers per task-def; **inputs editable inline, outputs
  read-only**; conditional-skip cells render hatched `n/a` (distinct from
  empty/pending); **clicking a cell opens that child task**, clicking the job
  cell opens the meta parent rollup.
- Meta rollup: ordered children, status pill each (Done / In progress /
  Pending / Not needed) + one-line outcome, rows click through to the child.
- Evidence log: submitted required outputs appear as first-class entries;
  an unmet requirement reads "awaiting agent — owes N required output(s)".
