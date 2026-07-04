# Task Templates — design contract (epic task-e7a5cf2ca6cc)

A **chain is a self-describing sequence of task-defs that rides on the
chained task itself.** Each task-def owns its **input fields** (human
provides at creation) and **output fields** (agent produces; `required`
outputs = the task's **evidence**). Forms and table columns are built by
**dynamically aggregating** every task-def's fields — never from a separate
stored template object.

> **Corrected abstraction (task-2fd63b922beb).** The first pass of this work
> (epic task-bb7665870605, R0) wrongly hung the chain definition on the
> **project** (`TemplateConfig.taskDefs`, a per-project pref). That made a
> project a prerequisite for a chain and made "the chain" a thing that lived
> somewhere other than the tasks it produced. The corrected model: **the
> chain definition rides the parent (meta) task's `task-template` block, in
> full.** Any surface — roster, task detail, a future mobile client, an
> agent reading the task body — can reconstruct the whole chain from the
> parent task alone. **A project is just a category + a dynamically derived
> view** over the chained tasks that happen to carry that `projectId`; it is
> not where chains are defined or stored.

This doc is the **contract between this epic's parallel workstreams
(R1–R4).** Shapes and block formats here are normative; do not invent
variants.

## Vocabulary

| Term | Is | Implemented as |
|---|---|---|
| Chain | ordered `TaskDef[]` + a name, self-describing | the parent task's v2 `task-template` block (`{v:2, name, defs}`) — **not** stored anywhere else |
| Task-def | smallest primitive; owns inputs + outputs | `TaskDef` |
| Job / meta task | one instantiation of a chain | parent task (`parent_task_id` on children), carries the v2 block |
| Step | one unit of agent/human work | child task, ordered via `depends_on` |
| Evidence | proof of completion | the task-def's `required` **output** fields — no separate system |
| Not-needed | conditional skip | `neededWhen` unmet → child cancelled/annotated, cell renders `n/a` |
| Project | category + derived view | `projectId` on chained tasks; the roster groups/filters by it, it defines nothing |

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
  id: string;               // slug, unique within the chain
  name: string;
  notes?: string;           // base agent prompt for this step
  inputs: TaskDefField[];
  outputs: TaskDefField[];
  neededWhen?: TaskDefCondition | null;  // absent/null = always needed
};
```

**No stored template object anywhere.** `TaskDef[]` is either (a) held
transiently in a composer's in-memory form state while a human is defining a
new chain, or (b) parsed back out of a parent task's `task-template` block.
There is no third place it lives. (R0's `TemplateConfig.taskDefs` /
`TemplateEditor.tsx` / "customize template" flow are **removed/superseded**
by this correction — see "Removed/superseded" below.)

**PHI rule:** field *definitions* (keys, labels, types, conditions) are
NON-PHI and may live in task bodies, prefs, docs. Field *values* are
potentially PHI and ride only in task bodies / result payloads (encrypted
channels) — never in prefs, logs, or notifications.

## Transport blocks (task body)

`TaskCreate` has no structured `data` map yet, so values ride the task body
(the encrypted PHI channel) in fenced blocks — same precedent as the existing
` ```task-fields ` block from NewTaskModal. One JSON object per block, no
comments, parse defensively (malformed → null/fail-soft, never throws).

> These client-side notes blocks are an **interim transport**. The server
> epic task-3f0b7e41aed4 (`task_manager_api` project) already ships an
> encrypted per-key data bag (`PATCH /chromeext/{id}/data`, per-key merge)
> and a `Chain` primitive (`POST /chromeext/chains`) that will eventually
> replace these fenced blocks with structured fields. Until a workstream
> migrates the client onto that API, the blocks below are normative.

Child task body, appended after the human/agent notes:

    ```task-fields
    {"templateId":"<chain name>","taskDefId":"intake","values":{"customer":"...","items":"12"}}
    ```

    ```task-outputs
    {"taskDefId":"intake","fields":[{"key":"has_stains","label":"Stains present?","type":"bool","required":true}]}
    ```

(`templateId` here is a legacy field name kept for the transport shape;
today it carries the chain's `name`, not a lookup id — there is no id to look
up. `task-fields`/`task-outputs` are otherwise unchanged from R0.)

Meta parent body — **v2, self-describing** (task-2fd63b922beb):

    ```task-template
    {"v":2,"name":"Order pipeline","defs":[
      {"id":"intake","name":"Intake","inputs":[...],"outputs":[...]},
      {"id":"stain","name":"Stain treatment","neededWhen":{"ref":"intake.has_stains","op":"==","value":"Yes"},"inputs":[...],"outputs":[...]},
      {"id":"wash","name":"Wash","inputs":[...],"outputs":[...]}
    ]}
    ```

`defs` are full `TaskDef` objects — id, name, optional notes, inputs,
outputs, optional neededWhen. No `templateId`, no project lookup. A reader
with only this block and nothing else can render the whole chain.

**v1 (legacy, pre-correction)** bodies — `{"templateId":"<id>","taskDefIds":[...]}` —
are still parsed, fail-soft, but surfaced as a distinct shape
(`{name: null, defs: null, legacy: {templateId, taskDefIds}}`) so a caller
must explicitly choose how to resolve them (e.g. TaskDetailDialog falls back
to looking the ids up against a project's now-legacy `TemplateConfig.taskDefs`
if that still exists locally) rather than silently misreading them as v2.

## Result contract (agent → client)

task-2638eeedd9ef: the server (task-d66c71c0ca38) adopted **FLAT as
canonical**. Agents submit outputs via `submit_task_result` with
**`type: "fields"`** and a flat payload — one key per output field, no
wrapper:

```json
{ "has_stains": "Yes", "intake_photo": "ph_8831" }
```

This is the exact shape both the server's own agent instructions
(`_output_schema_instruction` in task_manager_api's mcp_server.py, and the S3
operator instructions) and the client's `renderTaskOutputsInstructions`
(electron/typebuild/task-outputs-instructions.mjs) tell agents to submit —
headless and interactive agents get the identical directive, so a schema'd
task can always satisfy the server's `missing_required_outputs` gate
regardless of which surface the agent used.

**Legacy nested** (pre task-2638eeedd9ef) — still READ, never written:

```json
{ "taskDefId": "intake", "fields": { "has_stains": "Yes", "intake_photo": "ph_8831" } }
```

Existing results stored this way (e.g. task-7d65e61fb581) must keep
rendering, so every reader on both client and server accepts nested as a
fallback shape — unwrap `payload.fields` when `payload.taskDefId` is a string
and `payload.fields` is an object; otherwise treat `payload` itself as the
flat field map. New results are always written flat.

Client side: `mapResult` (electron/sources/typebuild.ts:474) is open dispatch —
`"fields"` passes through untouched. The renderer registry
(src/components/tasks/taskResult.mjs `KNOWN_RESULT_TYPES` + TaskResult.tsx
`RESULT_RENDERERS`) has a `fields` renderer; `normalizeFieldsPayload` accepts
both flat and legacy-nested shapes. `src/components/newhome/taskSchema.mjs`
`resultFields()` likewise accepts both — `taskDefId` comes back `null` for a
flat payload (it carries no def id of its own); callers that need the owning
task-def (pipelineRoster.mjs `buildJobValuesByRef`) fall back to the def id
already known from the child's own `task-fields`/`task-outputs` blocks. All
values coerce via `coerceCell`-style defensive shaping.

## Pure helper module — src/components/newhome/taskSchema.mjs (+ .d.mts)

Plain `.mjs` (mirrors taskResult.mjs; testable under `node --test`). API:

```
fieldRef(taskDefId, key)                      → "id.key"
buildTaskFieldsBlock(templateId, taskDefId, values)   → string (fenced block)
buildTaskOutputsBlock(taskDef)                → string (fenced block)
buildTaskTemplateBlock(name, defs)            → string (fenced block, v2: {v:2,name,defs})
parseTaskFieldsBlock(body)    → {templateId,taskDefId,values} | null
parseTaskOutputsBlock(body)   → {taskDefId,fields[]} | null
parseTaskTemplateBlock(body)  → {name,defs} | {name:null,defs:null,legacy:{templateId,taskDefIds}} | null
resultFields(result)          → {taskDefId,fields} | null   // from {type:'fields',payload}
    // payload FLAT {k:v} (canonical) → taskDefId:null; LEGACY NESTED
    // {taskDefId,fields:{k:v}} still read → taskDefId from payload.
evalCondition(cond, valuesByRef)              → boolean     // unknown upstream value → false
taskDefStatus(taskDef, valuesByRef)           → 'done'|'active'|'pending'|'skip'
    // skip: neededWhen unmet. No required outputs: any output present → done.
    // Else: 0 required filled → pending; some → active; all → done.
metaStatus(taskDefs, valuesByRef)             → 'done'|'active'|'pending'
    // over non-skip defs: all done → done; any done/active → active; else pending
aggregateInputs(taskDefs)                     → [{taskDef, field}]  // form/table order
```

`parseTaskTemplateBlock`'s v2 path sanitizes `defs` defensively — malformed
fields/conditions/defs are dropped, never rejecting the whole block (same
fail-soft convention as `parseTaskOutputsBlock`).

`valuesByRef` is a flat `Record<string,string|number>` keyed by `fieldRef`,
merging parsed input values and result fields across a job's children.

## Chain instantiation — src/components/newhome/newHomePrefs.ts

```ts
instantiateTemplate(opts: {
  name: string;                              // chain/job title
  projectId?: string;
  defs: TaskDef[];                           // the chain, given directly
  values: Record<string, string>;            // fieldRef-keyed input values
  createTask: (input: {
    title: string; notes: string; projectId?: string;
    parentTaskId?: string; dependsOn?: string[];
  }) => Promise<{ id: string }>;
}): Promise<{ parentId: string; childIds: string[] }>
```

`instantiateTemplate` takes the chain (`defs`) **directly from the caller** —
never reads it off a project pref. It creates one meta parent (notes = a
human-readable line + the v2 `task-template` block built from `defs`), then
one linearly `dependsOn`-chained child per def (notes = the def's own
`notes`, plus its `task-fields`/`task-outputs` blocks scoped to that def).
Throws `InstantiateTemplateError` (carrying `parentId`/`childIds` already
created) if a child create fails partway through — nothing is rolled back.

## New Home composer — "New Chained Task"

`TaskComposer.tsx` gets a **"New Chained Task"** entry point (not a separate
form — the canonical composer, extended, same as R0's design). Defining a
chain has two paths, and there is no third:

1. **Inline definition** — the human adds task-defs (name, inputs, outputs,
   optional `neededWhen`) directly in the composer, right before submitting.
   Submitting calls `instantiateTemplate` with those `defs` in memory; the
   chain is born already self-describing on the parent task, never touching
   a project pref.
2. **Copy from an existing chained task** — pick an existing parent task
   that already carries a `task-template` v2 block, `parseTaskTemplateBlock`
   it, and pre-fill the composer's in-memory `defs` from `parsed.defs`
   (editable before submit — this is a copy, not a live link). This is how
   "reuse a chain" works now: there is no saved template registry to browse,
   only past chained tasks.

New-job form = the chain-definition builder (steps, their input/output field
DEFINITIONS, optional `neededWhen`); outputs shown read-only ("the agent will
produce: …, required").

**Creation defines fields; it does NOT ask for their VALUES**
(task-0d63c7b0ebdb). The composer is where a task/chain's input FIELDS are
*defined* (keys/labels/types — non-PHI). It never walks the human through
value questions at create time. Values are supplied later, by exactly three
surfaces:

1. the **from-template flow** (instantiating a saved/copied chain with values),
2. the **drawer's Inputs editor** (`TaskDataInputs`, the per-key data-bag
   `fm.typebuild.taskData.patch` path) / the roster's inline input cells, and
3. the composer's **"Create & fill now" escape hatch** — a one-keystroke
   convenience offered on the success flash of a plain create that defined
   inputs ("Press F to fill inputs now"). F opens a values-only walk over just
   those fields and writes them onto the already-created task through the SAME
   data-bag path the drawer uses. It is *not* a fourth write path and it is not
   part of the creation walk — it operates on a task that already exists.

Transport of the DEFINITIONS at create time: a plain task writes each defined
input KEY into its `data` map with an **empty-string value**, so the task's
`data_keys` carries the definition names for (1)–(3) to populate. A chained job
instantiates with an **empty values map** — each step's inputs are filled later.

The parallel workstream reworking `TaskComposer.tsx` properly (chain-def
UI, copy-from-existing picker) lands right after this doc's R1; R1 itself
only changes `instantiateTemplate`'s signature and mechanically threads the
composer's existing `taskDefs` local through the new call shape so typecheck
stays green — it does not build the new UI.

## Removed / superseded (do not reintroduce)

These were part of R0's project-hung model and are corrected by this epic.
**Not deleted yet in R1** (that's R3) — flagged here so no new code depends
on them:

- `TemplateConfig.taskDefs` (project-level stored chain) — superseded by the
  parent task's v2 block. A project no longer "has" a chain.
- `TemplateEditor.tsx`'s task-def/chain editing UI — superseded by "New
  Chained Task"'s inline-definition / copy-from-existing paths in the
  composer.
- Any "customize template" / "save as template" flow — there is no template
  object to save; a chain is either being defined right now or already lives
  on a past chained task you can copy from.
- v1 `task-template` bodies (`{templateId, taskDefIds}`) — still parsed
  fail-soft (`legacy` shape) for tasks created before this correction, never
  produced by new code.

## Roster / project view

Unchanged in spirit from R0, reframed as a **derived view, not a stored
config**: grouped headers per task-def (aggregated dynamically from whatever
chained tasks exist under a project, by parsing each parent's v2 block —
not from a project pref); inputs editable inline, outputs read-only;
conditional-skip cells render hatched `n/a`; clicking a cell opens that
child task, clicking the job cell opens the meta parent rollup.

Meta rollup: ordered children, status pill each (Done / In progress /
Pending / Not needed) + one-line outcome, rows click through to the child.

Evidence log: submitted required outputs appear as first-class entries; an
unmet requirement reads "awaiting agent — owes N required output(s)".

## Workstreams & file ownership (no overlaps within a wave)

| Task | Owns | Depends |
|---|---|---|
| R1 task-2fd63b922beb | taskSchema.mjs/.d.mts (v2 block), newHomePrefs.ts `instantiateTemplate` signature, TaskComposer.tsx call site (mechanical only), tests, this doc | — |
| R2 task-? (TBD) | TaskComposer.tsx — "New Chained Task": inline chain-def UI + copy-from-existing-chain picker (the real UI rework, not the mechanical R1 call-site patch) | R1 |
| R3 task-? (TBD) | Remove `TemplateConfig.taskDefs`, `TemplateEditor.tsx`'s chain/task-def UI, any "save as template" flow; strip the v1-legacy parse path's callers down to display-only (no new v1 production) | R2 |
| R4 task-? (TBD) | Roster/project-view rework to derive its grouped view from chained tasks' v2 blocks directly (no project pref read for chain shape); integration, HelpTour, gates, push | R1–R3 |

## UX invariants (from the approved prototype, unchanged by the correction)

- New-job form = **TaskComposer extended**: the chain/field DEFINITION builder,
  grouped by owning task-def; outputs shown read-only ("the agent will produce:
  …, required"). Creation defines fields only — input VALUES are filled later
  (from-template flow, the drawer's Inputs editor, or the composer's "Create &
  fill now" escape hatch), never during the creation walk (task-0d63c7b0ebdb).
- Roster: grouped headers per task-def; **inputs editable inline, outputs
  read-only**; conditional-skip cells render hatched `n/a` (distinct from
  empty/pending); **clicking a cell opens that child task**, clicking the
  job cell opens the meta parent rollup.
- Meta rollup: ordered children, status pill each (Done / In progress /
  Pending / Not needed) + one-line outcome, rows click through to the child.
- Evidence log: submitted required outputs appear as first-class entries;
  an unmet requirement reads "awaiting agent — owes N required output(s)".
