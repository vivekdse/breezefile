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

import type { TemplateConfig } from './types';
import type { Task, TaskCreate } from '../../types';

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
};

/** A reusable, named, ordered sequence of step templates. */
export type ChainDef = {
  id: string;
  name: string;
  entries: ChainStepTemplate[];
};

/** Local extension of the shared `TemplateConfig` — additive only. Keep
 *  `types.ts` untouched; this is the seam for New Home-editor-local config
 *  that hasn't earned a place in the shared contract yet. */
export type TemplateConfigExt = TemplateConfig & {
  chains?: ChainDef[];
};

// Sensible default: no custom fields, just the built-in roster columns every
// New Home project starts with.
const DEFAULT_TEMPLATE: TemplateConfigExt = {
  fields: [],
  columns: ['title', 'status', 'who', 'lastAction'],
  approvalRules: [],
  steps: [],
  chains: [],
};

function keyFor(projectId: string | null | undefined): string {
  return projectId ? `${KEY_PREFIX}${projectId}` : UNSCOPED_KEY;
}

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

function sanitizeChain(v: unknown): ChainDef | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.name !== 'string') return null;
  const entries = Array.isArray(c.entries) ? c.entries.filter(isChainStepTemplate) : [];
  return { id: c.id, name: c.name, entries };
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
  return { fields, columns, approvalRules, steps, chains };
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
 *  only know the shared type keep type-checking unmodified. */
export function setTemplateConfig(
  projectId: string | null | undefined,
  cfg: TemplateConfigExt,
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(sanitize(cfg)));
  } catch {
    /* ignore quota / unavailable storage */
  }
}

// ─── Chain instantiation ────────────────────────────────────────────────
//
// Turns a ChainDef into real tasks: one "container" task representing the
// chain run, then one task per entry, in order.
//
// BRIDGE LIMITATIONS (read before touching this): the server's
// /chromeext/tasks create endpoint reportedly accepts `parent_task_id` and
// `depends_on` (see electron/sources/typebuild.ts createTask() comment,
// "v2 adds priority, due_at, defer_until, parent_task_id, depends_on"), but
// neither the client-side `TaskCreate` type (src/types.ts) nor
// TypebuildSource.createTask()'s payload builder actually surface those two
// fields today — createTask() only forwards title/task/due_at/defer_until/
// priority/project_id/agent_id. Since this file may not edit types.ts or
// electron/sources/typebuild.ts, real parent/dependency linking can't be
// wired from here yet. Until that lands, this function encodes the
// relationship as human-readable text in each task's `notes` (container id +
// predecessor id + step position) so the chain is still legible on the
// task, and leaves TODOs at the exact two spots that should switch to
// structured fields.
export function instantiateChain(
  chain: ChainDef,
  projectId: string | null | undefined,
  createFn: (input: TaskCreate) => Promise<Task>,
): Promise<Task[]> {
  return instantiateChainImpl(chain, projectId, createFn);
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
): Promise<Task[]> {
  if (!chain.entries.length) return [];

  const projectFields = projectId ? { projectId } : {};

  // TODO(bridge): once TaskCreate exposes `parentTaskId`, create the
  // container first and pass `{ parentTaskId: container.id }` to every step
  // create below instead of only mentioning it in `notes`.
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
    const title = renderChainTitle(entry.titleTemplate, { index: i + 1, chainName: chain.name });
    const noteParts = [`Step ${i + 1} of ${chain.entries.length} in chain "${chain.name}".`];
    noteParts.push(`Chain container: ${container.id}.`);
    // TODO(bridge): once TaskCreate exposes `dependsOn`, pass
    // `dependsOn: predecessor ? [predecessor.id] : []` instead of noting the
    // predecessor id in text.
    if (predecessor) noteParts.push(`Depends on: ${predecessor.id} ("${predecessor.title}").`);
    if (entry.description) noteParts.push(entry.description);
    if (entry.humanGate) noteParts.push('Requires human approval before proceeding.');

    const task = await createFn({
      title,
      folder: '',
      notes: noteParts.join(' '),
      ...projectFields,
    });
    created.push(task);
    predecessor = task;
  }

  return [container, ...created];
}
