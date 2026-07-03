// task-7bdb94445321 — ONE implementation of every New Home template mutation,
// shared by the inline Customize editor (TemplateEditor.tsx) AND the CopilotKit
// actions (src/copilot/*). The editor and the copilot must never hand-mirror
// each other: both call these pure functions, then persist via
// newHomePrefs.setTemplateConfig. (See the user's "unify, don't mirror" rule.)
//
// Every op is PURE: takes a config, returns a NEW config (never mutates). All
// addressing is by stable id/key (not array index) so a copilot action can
// target "the step named X" or "entry <id>" without knowing positions. Reorder
// is the one position-ish op — expressed as (id, dir) so callers still don't
// pass raw indices.
//
// NON-PHI: field keys/labels/types, step names, approval-rule text, chain names
// and title templates are all CONFIGURATION, not patient data (see the
// newHomePrefs header). Safe to build/return here and to surface to the LLM.

import type { TemplateConfigExt, ChainDef, ChainStepTemplate } from './newHomePrefs';
import type { TemplateField } from './types';

let uidCounter = 0;
export function uid(prefix: string): string {
  uidCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}-${rand}`;
}

export function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  );
}

/** Move the element with the given id up (-1) or down (+1) by one slot. No-op
 *  at the ends or when the id isn't found. */
function moveById<T extends { id: string }>(arr: T[], id: string, dir: -1 | 1): T[] {
  const index = arr.findIndex((x) => x.id === id);
  if (index < 0) return arr;
  const target = index + dir;
  if (target < 0 || target >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

// ─── Fields ────────────────────────────────────────────────────────────────

export function addField(cfg: TemplateConfigExt, field: TemplateField): TemplateConfigExt {
  return { ...cfg, fields: [...cfg.fields, field] };
}

export function updateField(
  cfg: TemplateConfigExt,
  key: string,
  patch: Partial<TemplateField>,
): TemplateConfigExt {
  return {
    ...cfg,
    fields: cfg.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)),
  };
}

/** Remove a field and drop it from the column list too (a column can't point
 *  at a field that no longer exists). */
export function removeField(cfg: TemplateConfigExt, key: string): TemplateConfigExt {
  return {
    ...cfg,
    fields: cfg.fields.filter((f) => f.key !== key),
    columns: cfg.columns.filter((c) => c !== key),
  };
}

// ─── Columns ─────────────────────────────────────────────────────────────────

export function setColumns(cfg: TemplateConfigExt, columns: string[]): TemplateConfigExt {
  return { ...cfg, columns };
}

export function toggleColumn(cfg: TemplateConfigExt, id: string, on: boolean): TemplateConfigExt {
  return {
    ...cfg,
    columns: on
      ? cfg.columns.includes(id)
        ? cfg.columns
        : [...cfg.columns, id]
      : cfg.columns.filter((c) => c !== id),
  };
}

export function moveColumn(cfg: TemplateConfigExt, index: number, dir: -1 | 1): TemplateConfigExt {
  const target = index + dir;
  if (target < 0 || target >= cfg.columns.length) return cfg;
  const columns = cfg.columns.slice();
  const [item] = columns.splice(index, 1);
  columns.splice(target, 0, item);
  return { ...cfg, columns };
}

// ─── Approval rules ──────────────────────────────────────────────────────────

export function addApprovalRule(cfg: TemplateConfigExt, description = ''): TemplateConfigExt {
  return { ...cfg, approvalRules: [...cfg.approvalRules, { id: uid('rule'), description }] };
}

export function updateApprovalRule(
  cfg: TemplateConfigExt,
  id: string,
  description: string,
): TemplateConfigExt {
  return {
    ...cfg,
    approvalRules: cfg.approvalRules.map((r) => (r.id === id ? { ...r, description } : r)),
  };
}

export function removeApprovalRule(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, approvalRules: cfg.approvalRules.filter((r) => r.id !== id) };
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = TemplateConfigExt['steps'][number];

export function addStep(cfg: TemplateConfigExt, patch: Partial<Step> = {}): TemplateConfigExt {
  const step: Step = {
    id: uid('step'),
    name: 'New step',
    description: '',
    humanGate: false,
    ...patch,
  };
  return { ...cfg, steps: [...cfg.steps, step] };
}

export function updateStep(
  cfg: TemplateConfigExt,
  id: string,
  patch: Partial<Step>,
): TemplateConfigExt {
  return {
    ...cfg,
    steps: cfg.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

export function removeStep(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, steps: cfg.steps.filter((s) => s.id !== id) };
}

export function moveStep(cfg: TemplateConfigExt, id: string, dir: -1 | 1): TemplateConfigExt {
  return { ...cfg, steps: moveById(cfg.steps, id, dir) };
}

// ─── Chains ──────────────────────────────────────────────────────────────────

function chainList(cfg: TemplateConfigExt): ChainDef[] {
  return cfg.chains ?? [];
}

/** Add a chain and return the new config plus the new chain's id (callers that
 *  select the freshly-added chain need it). */
export function addChain(cfg: TemplateConfigExt, name = 'New chain'): { cfg: TemplateConfigExt; chainId: string } {
  const chain: ChainDef = { id: uid('chain'), name, entries: [] };
  return { cfg: { ...cfg, chains: [...chainList(cfg), chain] }, chainId: chain.id };
}

export function removeChain(cfg: TemplateConfigExt, id: string): TemplateConfigExt {
  return { ...cfg, chains: chainList(cfg).filter((c) => c.id !== id) };
}

export function renameChain(cfg: TemplateConfigExt, id: string, name: string): TemplateConfigExt {
  return { ...cfg, chains: chainList(cfg).map((c) => (c.id === id ? { ...c, name } : c)) };
}

export function addChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  patch: Partial<ChainStepTemplate> = {},
): TemplateConfigExt {
  const entry: ChainStepTemplate = {
    id: uid('entry'),
    titleTemplate: 'Step {{n}} of {{chain}}',
    ...patch,
  };
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: [...c.entries, entry] } : c,
    ),
  };
}

export function updateChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
  patch: Partial<ChainStepTemplate>,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId
        ? { ...c, entries: c.entries.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) }
        : c,
    ),
  };
}

export function removeChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: c.entries.filter((e) => e.id !== entryId) } : c,
    ),
  };
}

export function moveChainEntry(
  cfg: TemplateConfigExt,
  chainId: string,
  entryId: string,
  dir: -1 | 1,
): TemplateConfigExt {
  return {
    ...cfg,
    chains: chainList(cfg).map((c) =>
      c.id === chainId ? { ...c, entries: moveById(c.entries, entryId, dir) } : c,
    ),
  };
}
