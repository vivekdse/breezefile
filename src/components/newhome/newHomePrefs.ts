// task-b9cdad64ab9c — New Home per-project template configuration,
// persisted to localStorage. Mirrors the pattern in
// src/projectsViewPrefs.ts: a small self-contained pref store rather than
// threaded through the core reducer, since this is local UI config, not
// synced task data. NON-PHI: field keys/labels/types are configuration, not
// patient data (the VALUES entered against a field later, on a task, can be
// PHI — that lives on the task, never here).

import type { TemplateConfig } from './types';

const KEY_PREFIX = 'fm.newHome.template.v1.';
const UNSCOPED_KEY = `${KEY_PREFIX}__none__`;

// Sensible default: no custom fields, just the built-in roster columns every
// New Home project starts with.
const DEFAULT_TEMPLATE: TemplateConfig = {
  fields: [],
  columns: ['title', 'status', 'who', 'lastAction'],
  approvalRules: [],
  steps: [],
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

function sanitize(parsed: unknown): TemplateConfig {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_TEMPLATE };
  const p = parsed as Partial<TemplateConfig>;
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
  return { fields, columns, approvalRules, steps };
}

/** Read the template config for a project (or the unscoped default when
 *  `projectId` is null/undefined). Falls back to DEFAULT_TEMPLATE on any
 *  parse failure or missing storage. */
export function getTemplateConfig(projectId: string | null | undefined): TemplateConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TEMPLATE };
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...DEFAULT_TEMPLATE };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TEMPLATE };
  }
}

/** Persist the template config for a project (or the unscoped default). */
export function setTemplateConfig(
  projectId: string | null | undefined,
  cfg: TemplateConfig,
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(sanitize(cfg)));
  } catch {
    /* ignore quota / unavailable storage */
  }
}
