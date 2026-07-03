// task-b9cdad64ab9c / task-c60ae2a41e71 — New Home per-project template
// configuration, persisted to localStorage. Mirrors the pattern in
// src/projectsViewPrefs.ts: a small self-contained pref store rather than
// threaded through the core reducer, since this is local UI config, not
// synced task data. NON-PHI: field keys/labels/types are configuration, not
// patient data (the VALUES entered against a field later, on a task, can be
// PHI — that lives on the task, never here).
//
// task-c60ae2a41e71 adds "chains" (reusable ordered step sequences a project
// can instantiate as linked tasks). `TemplateConfig` itself (types.ts) is
// owned by another file/task and stays untouched — chains ride as an
// *additive, optional* extension (`TemplateConfigExt`) defined here, so every
// existing consumer that only knows about `TemplateConfig` keeps working
// unmodified (an object with `chains` still structurally satisfies
// `TemplateConfig`, and a plain `TemplateConfig` without `chains` still
// satisfies `TemplateConfigExt` since the field is optional).

import type { TemplateConfig, TaskDef, TaskDefField, TaskDefCondition } from './types';
import type { Task, TaskCreate } from '../../types';
import { fm } from '../../bridge';
import { buildTaskFieldsBlock, buildTaskOutputsBlock, buildTaskTemplateBlock } from './taskSchema.mjs';

const KEY_PREFIX = 'fm.newHome.template.v1.';
const UNSCOPED_KEY = `${KEY_PREFIX}__none__`;

/** One entry in a chain: a step-like template that becomes one task when the
 *  chain is instantiated. `titleTemplate` may reference `{{n}}` (1-based step
 *  index) and `{{chain}}` (the chain's name); both are substituted verbatim
 *  at instantiation time — no PHI, these are configuration strings. */
export type ChainStepTemplate = {
  id: string;
  titleTemplate: string;
  description?: string;
  /** Rendered as a gate icon in ChainStrip; also copied into the created
   *  task's notes today since TaskCreate has no human-gate concept yet. */
  humanGate?: boolean;
  /** task-7bdb94445321 — when set, this entry IS a Repeatable Task (picked
   *  from the "Add task" dropdown) rather than a free-form title. On
   *  instantiation the entry's title/notes/recurrence come from the referenced
   *  RepeatableTaskDef; `titleTemplate` is kept as a display fallback for when
   *  the repeatable has since been deleted. */
  repeatableId?: string;
};

/** A reusable, named, ordered sequence of step templates. */
export type ChainDef = {
  id: string;
  name: string;
  entries: ChainStepTemplate[];
};

/** task-7bdb94445321 — a REPEATABLE TASK: a reusable task template a project
 *  can spawn on demand ("Run now") or on a schedule. `recurrence` is a NON-PHI
 *  RRULE-lite string ('<n><unit>', unit d|w|m — '' / undefined = one-shot);
 *  when set, the created task carries it so the server auto-spawns the next
 *  occurrence after each completion. `title`/`notes` are configuration strings
 *  (NON-PHI) — the PHI values a user/agent fills in later live on the spawned
 *  TASK, never here. */
export type RepeatableTaskDef = {
  id: string;
  title: string;
  notes?: string;
  /** RRULE-lite '<n><unit>' (unit d|w|m), or '' for run-on-demand only. */
  recurrence?: string;
};

/** Local extension of the shared `TemplateConfig` — additive only. Keep
 *  `types.ts` untouched; this is the seam for New Home-editor-local config
 *  that hasn't earned a place in the shared contract yet. */
export type TemplateConfigExt = TemplateConfig & {
  chains?: ChainDef[];
  repeatables?: RepeatableTaskDef[];
};

// Sensible default: no custom fields, just the built-in roster columns every
// New Home project starts with.
const DEFAULT_TEMPLATE: TemplateConfigExt = {
  fields: [],
  columns: ['title', 'status', 'who', 'lastAction'],
  approvalRules: [],
  steps: [],
  chains: [],
  repeatables: [],
  taskDefs: [],
};

function keyFor(projectId: string | null | undefined): string {
  return projectId ? `${KEY_PREFIX}${projectId}` : UNSCOPED_KEY;
}

// Server-side id for the unscoped/no-project default (reserved by the
// project-templates endpoint contract; see typebuild:project-template:*).
const SERVER_DEFAULT_ID = '_default';

function serverIdFor(projectId: string | null | undefined): string {
  return projectId ?? SERVER_DEFAULT_ID;
}

// task-a067636e599b — projects whose cache has already been hydrated from the
// server this session, so repeated mounts (project switch back-and-forth,
// re-renders) don't re-fetch. Cleared for nothing — a fresh server value only
// ever needs fetching once per project per app session; setTemplateConfig
// keeps the cache authoritative after that via its own PUT.
const hydrated = new Set<string>();

function isTemplateField(v: unknown): v is TemplateConfig['fields'][number] {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.key === 'string' &&
    typeof f.label === 'string' &&
    (f.type === 'text' || f.type === 'date' || f.type === 'select' || f.type === 'number') &&
    typeof f.required === 'boolean' &&
    typeof f.agentFetchable === 'boolean'
  );
}

function isChainStepTemplate(v: unknown): v is ChainStepTemplate {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === 'string' && typeof s.titleTemplate === 'string';
}

function sanitizeChainEntry(v: unknown): ChainStepTemplate | null {
  if (!isChainStepTemplate(v)) return null;
  const s = v as Record<string, unknown>;
  const out: ChainStepTemplate = { id: s.id as string, titleTemplate: s.titleTemplate as string };
  if (typeof s.description === 'string') out.description = s.description;
  if (typeof s.humanGate === 'boolean') out.humanGate = s.humanGate;
  if (typeof s.repeatableId === 'string') out.repeatableId = s.repeatableId;
  return out;
}

function sanitizeChain(v: unknown): ChainDef | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.name !== 'string') return null;
  const entries = Array.isArray(c.entries)
    ? (c.entries.map(sanitizeChainEntry).filter(Boolean) as ChainStepTemplate[])
    : [];
  return { id: c.id, name: c.name, entries };
}

// task-8b694714b13c — TaskDef round-trip. Definitions only (non-PHI); see
// types.ts / taskSchema.mjs for the PHI split (values never live here).

function isTaskDefFieldShape(v: unknown): v is TaskDefField {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  if (typeof f.key !== 'string' || typeof f.label !== 'string') return false;
  if (!['text', 'number', 'date', 'select', 'bool'].includes(f.type as string)) return false;
  if (f.options !== undefined && !Array.isArray(f.options)) return false;
  if (f.required !== undefined && typeof f.required !== 'boolean') return false;
  return true;
}

function sanitizeTaskDefField(v: unknown): TaskDefField | null {
  if (!isTaskDefFieldShape(v)) return null;
  const out: TaskDefField = { key: v.key, label: v.label, type: v.type };
  if (Array.isArray(v.options)) out.options = v.options.filter((o): o is string => typeof o === 'string');
  if (typeof v.required === 'boolean') out.required = v.required;
  return out;
}

function sanitizeTaskDefCondition(v: unknown): TaskDefCondition | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.ref !== 'string') return null;
  if (!['==', '!=', '<', '>'].includes(c.op as string)) return null;
  if (typeof c.value !== 'string' && typeof c.value !== 'number') return null;
  return { ref: c.ref, op: c.op as TaskDefCondition['op'], value: c.value as string | number };
}

function sanitizeTaskDef(v: unknown): TaskDef | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.name !== 'string') return null;
  const inputs = Array.isArray(d.inputs)
    ? (d.inputs.map(sanitizeTaskDefField).filter(Boolean) as TaskDefField[])
    : [];
  const outputs = Array.isArray(d.outputs)
    ? (d.outputs.map(sanitizeTaskDefField).filter(Boolean) as TaskDefField[])
    : [];
  const out: TaskDef = { id: d.id, name: d.name, inputs, outputs };
  if (typeof d.notes === 'string') out.notes = d.notes;
  if (d.neededWhen === null) out.neededWhen = null;
  else if (d.neededWhen !== undefined) {
    const cond = sanitizeTaskDefCondition(d.neededWhen);
    if (cond) out.neededWhen = cond;
  }
  return out;
}

/** task-8b694714b13c — a legacy repeatable maps conceptually to a single
 *  TaskDef with no fields (a one-step, field-less template entry). NOT wired
 *  into instantiateChain/instantiateTemplate here — that migration path is
 *  T4's (task-fb31518201da); this is just the pure, additive conversion T4
 *  can reach for a low-risk "coexistence" migration without T1 owning any of
 *  the instantiation logic. */
export function repeatableToTaskDef(rep: RepeatableTaskDef): TaskDef {
  return { id: rep.id, name: rep.title, notes: rep.notes, inputs: [], outputs: [] };
}

function sanitizeRepeatable(v: unknown): RepeatableTaskDef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  const out: RepeatableTaskDef = { id: r.id, title: r.title };
  if (typeof r.notes === 'string') out.notes = r.notes;
  if (typeof r.recurrence === 'string') out.recurrence = r.recurrence;
  return out;
}

function sanitize(parsed: unknown): TemplateConfigExt {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TEMPLATE };
  const p = parsed as Partial<TemplateConfigExt>;
  const fields = Array.isArray(p.fields) ? p.fields.filter(isTemplateField) : [];
  const columns = Array.isArray(p.columns)
    ? p.columns.filter((c): c is string => typeof c === 'string')
    : DEFAULT_TEMPLATE.columns;
  const approvalRules = Array.isArray(p.approvalRules)
    ? p.approvalRules.filter(
        (r): r is { id: string; description: string } =>
          !!r && typeof r === 'object' && typeof (r as any).id === 'string' && typeof (r as any).description === 'string',
      )
    : [];
  const steps = Array.isArray(p.steps)
    ? p.steps.filter(
        (s): s is { id: string; name: string; description: string; humanGate: boolean } =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as any).id === 'string' &&
          typeof (s as any).name === 'string' &&
          typeof (s as any).description === 'string' &&
          typeof (s as any).humanGate === 'boolean',
      )
    : [];
  const chains = Array.isArray(p.chains)
    ? (p.chains.map(sanitizeChain).filter(Boolean) as ChainDef[])
    : [];
  const repeatables = Array.isArray(p.repeatables)
    ? (p.repeatables.map(sanitizeRepeatable).filter(Boolean) as RepeatableTaskDef[])
    : [];
  // Additive/non-regression: a template with no `taskDefs` (every template
  // saved before task-8b694714b13c) sanitizes to an empty array here, so
  // every existing consumer that doesn't know about TaskDef sees the exact
  // same shape it always has.
  const taskDefs = Array.isArray(p.taskDefs)
    ? (p.taskDefs.map(sanitizeTaskDef).filter(Boolean) as TaskDef[])
    : [];
  return { fields, columns, approvalRules, steps, chains, repeatables, taskDefs };
}

/** Read the template config for a project (or the unscoped default when
 *  `projectId` is null/undefined). Falls back to DEFAULT_TEMPLATE on any
 *  parse failure or missing storage. The returned value carries `chains` as
 *  an additive extra field — callers that only know `TemplateConfig` keep
 *  working unchanged; TemplateEditor reads `chains` off it directly. */
export function getTemplateConfig(projectId: string | null | undefined): TemplateConfigExt {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TEMPLATE };
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...DEFAULT_TEMPLATE };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TEMPLATE };
  }
}

/** Persist the template config for a project (or the unscoped default).
 *  Accepts a plain `TemplateConfig` too (chains is optional) so callers that
 *  only know the shared type keep type-checking unmodified.
 *
 *  task-a067636e599b — server-authoritative with a localStorage
 *  write-through cache: the localStorage write happens synchronously first
 *  (so the edit is never lost and every existing sync caller keeps working
 *  unmodified), THEN a best-effort PUT to the server is fired off
 *  fire-and-forget. A server failure (signed out, offline, transient error)
 *  never loses the local edit — localStorage remains the durable record and
 *  callers don't need to await anything. */
export function setTemplateConfig(
  projectId: string | null | undefined,
  cfg: TemplateConfigExt,
): void {
  const clean = sanitize(cfg);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(keyFor(projectId), JSON.stringify(clean));
    } catch {
      /* ignore quota / unavailable storage */
    }
  }
  // Best-effort server persist. Swallow all errors (signed out / offline /
  // transient) — the localStorage write above already happened, so there is
  // nothing left to protect here.
  void fm.typebuild.projectTemplate.set(serverIdFor(projectId), clean).catch(() => {
    /* offline / signed out — localStorage is the durable record */
  });
}

/** task-a067636e599b — hydrate the localStorage cache for `projectId` from
 *  the server, once per project per app session. Call this once from a
 *  higher-level place that loads a project (New Home mounts / project
 *  switch) — NOT from every `getTemplateConfig` read, so reads stay
 *  synchronous and cheap. Silently no-ops on any failure (signed out,
 *  offline, no server template yet) and leaves the existing localStorage
 *  cache / DEFAULT_TEMPLATE in place; never throws. Returns true if the
 *  cache was updated from a server value, so callers can re-read + re-render
 *  if they want to (NewHomePage does, via its templateVersion bump). */
export async function syncTemplateConfigFromServer(
  projectId: string | null | undefined,
): Promise<boolean> {
  const serverId = serverIdFor(projectId);
  if (hydrated.has(serverId)) return false;
  hydrated.add(serverId);
  try {
    const template = await fm.typebuild.projectTemplate.get(serverId);
    if (!template) return false;
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(keyFor(projectId), JSON.stringify(sanitize(template)));
    return true;
  } catch {
    // Signed out / offline / server error — keep using the localStorage
    // cache (or DEFAULT_TEMPLATE) unmodified. Don't block UI, don't throw.
    return false;
  }
}

// ─── Chain instantiation ────────────────────────────────────────────────
//
// Turns a ChainDef into real tasks: one "container" task representing the
// chain run, then one task per entry, in order.
//
// task-83a30b3c8804 — BRIDGE LANDED: `TaskCreate.parentTaskId`/`dependsOn`
// (src/types.ts) now forward to the server's `parent_task_id`/`depends_on`
// via TypebuildSource.createTask() (electron/sources/typebuild.ts). This
// function passes them structurally below; the human-readable `notes` text
// is kept too (container id / predecessor id / step position) as a
// belt-and-suspenders legibility aid for surfaces that don't yet render the
// structural links, not as the source of truth.
export function instantiateChain(
  chain: ChainDef,
  projectId: string | null | undefined,
  createFn: (input: TaskCreate) => Promise<Task>,
  /** task-7bdb94445321 — repeatable-task defs used to resolve entries that
   *  reference one (repeatableId). A chain step is a single instance, so the
   *  repeatable's title/notes are used but its recurrence is NOT carried in. */
  repeatables: RepeatableTaskDef[] = [],
): Promise<Task[]> {
  return instantiateChainImpl(chain, projectId, createFn, repeatables);
}

// task-7bdb94445321 — spawn one real task from a RepeatableTaskDef. Shared by
// the editor's "Run now" button and the copilot's run_repeatable_task action
// (one implementation, no mirroring). When the def carries a `recurrence`, it
// rides onto the created task so the server auto-spawns the next occurrence
// after each completion; otherwise it's a plain one-shot create.
export function runRepeatable(
  def: RepeatableTaskDef,
  projectId: string | null | undefined,
  createFn: (input: TaskCreate) => Promise<Task>,
): Promise<Task> {
  const recurrence = (def.recurrence ?? '').trim();
  return createFn({
    title: def.title,
    folder: '',
    notes: def.notes ?? '',
    ...(recurrence ? { recurrence } : {}),
    ...(projectId ? { projectId } : {}),
  });
}

function renderChainTitle(template: string, ctx: { index: number; chainName: string }): string {
  return template
    .replace(/\{\{\s*n\s*\}\}/gi, String(ctx.index))
    .replace(/\{\{\s*chain\s*\}\}/gi, ctx.chainName);
}

async function instantiateChainImpl(
  chain: ChainDef,
  projectId: string | null | undefined,
  createFn: (input: TaskCreate) => Promise<Task>,
  repeatables: RepeatableTaskDef[],
): Promise<Task[]> {
  if (!chain.entries.length) return [];

  const projectFields = projectId ? { projectId } : {};

  const container = await createFn({
    title: `${chain.name} (chain)`,
    folder: '',
    notes: `Chain container for "${chain.name}" — ${chain.entries.length} step(s).`,
    ...projectFields,
  });

  const created: Task[] = [];
  let predecessor: Task | null = null;
  for (let i = 0; i < chain.entries.length; i++) {
    const entry = chain.entries[i];
    // An entry that references a Repeatable Task takes its title/notes from
    // that definition (falling back to the stored template if it was since
    // deleted); a free-form entry renders {{n}}/{{chain}} in its template.
    const ref = entry.repeatableId ? repeatables.find((r) => r.id === entry.repeatableId) : undefined;
    const title = ref
      ? ref.title
      : renderChainTitle(entry.titleTemplate, { index: i + 1, chainName: chain.name });
    const noteParts = [`Step ${i + 1} of ${chain.entries.length} in chain "${chain.name}".`];
    noteParts.push(`Chain container: ${container.id}.`);
    if (predecessor) noteParts.push(`Depends on: ${predecessor.id} ("${predecessor.title}").`);
    if (ref?.notes) noteParts.push(ref.notes);
    else if (entry.description) noteParts.push(entry.description);
    if (entry.humanGate) noteParts.push('Requires human approval before proceeding.');

    const task = await createFn({
      title,
      folder: '',
      notes: noteParts.join(' '),
      parentTaskId: container.id,
      dependsOn: predecessor ? [predecessor.id] : undefined,
      ...projectFields,
    });
    created.push(task);
    predecessor = task;
  }

  return [container, ...created];
}

// ─── Template instantiation (task-fb31518201da) ────────────────────────────
//
// instantiateTemplate turns a TemplateConfig's `taskDefs` (the docs/
// task-templates-design.md model — see that doc's "Vocabulary" and
// "Transport blocks" sections) into real tasks: one META PARENT task (the
// "job") carrying the ordered task-def id list in a ```task-template block,
// then one CHILD task per task-def, in order, linked via `parentTaskId` +
// a linear `dependsOn` chain (mirrors instantiateChainImpl's container/step
// linking above — same structural pattern, values-driven instead of
// title-template-driven). ALL task-defs get a child, including conditional
// (`neededWhen`) ones: the condition is evaluated client-side later from
// `taskDefStatus` (taskSchema.mjs), not at instantiation time, so the linear
// chain ordering holds regardless of which steps end up "not needed".
//
// Supersedes instantiateChain for the taskDefs model. instantiateChain stays
// in place, unmodified, for the legacy ChainDef model (Repeatable Tasks /
// free-form chains); the two share the small notes-joining helper below
// rather than one copy-pasting the other (unify, don't mirror).

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
 *  partially-created job instead of silently losing it. Mirrors
 *  instantiateChainImpl's behavior today: a throw from `createFn` propagates
 *  as-is and whatever was already created stays created. */
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

/** Turn one template instantiation ("job") into a meta parent task + one
 *  linearly-chained child task per task-def. See the module comment above
 *  and docs/task-templates-design.md for the contract. */
export async function instantiateTemplate(opts: {
  templateId: string;
  template: TemplateConfig;
  jobTitle: string;
  projectId?: string;
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
  const { templateId, template, jobTitle, projectId, values, createTask } = opts;
  const taskDefs = template.taskDefs ?? [];
  const projectFields = projectId ? { projectId } : {};

  const parentNotes = joinNotesParts([
    `Job created from template ${templateId}: ${taskDefs.length} task${taskDefs.length === 1 ? '' : 's'}.`,
    buildTaskTemplateBlock(templateId, taskDefs),
  ]);
  const parent = await createTask({
    title: jobTitle,
    notes: parentNotes,
    ...projectFields,
  });

  const childIds: string[] = [];
  let predecessorId: string | undefined;
  for (const def of taskDefs) {
    const defValues = valuesForTaskDef(values, def.id);
    const notes = joinNotesParts([
      def.notes,
      buildTaskFieldsBlock(templateId, def.id, defValues),
      buildTaskOutputsBlock(def),
    ]);
    let child: { id: string };
    try {
      child = await createTask({
        title: `${jobTitle} — ${def.name}`,
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
