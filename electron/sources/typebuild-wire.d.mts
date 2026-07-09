// task-3ac8cbe60758 — type surface for the pure typebuild-wire.mjs module
// (runtime is plain ESM so the node test runner imports it without a
// transpile step). Mirrors src/components/newhome/taskSchema.d.mts's
// pattern for the same TS-consumer-of-.mjs seam.

import type { TaskStatus, TaskCreate } from '../tasks';

// ─── Shared field-def shape (mirrors OutputSchemaField in typebuild.ts) ───
export type WireOutputSchemaField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'bool';
  options?: string[];
  required?: boolean;
  // task-73f6304ffb94 — an INPUT def may bind a SavedQuery, so the field fills
  // via the live typeahead instead of a text box. Rides template `variables`
  // (mapOutputSchema filters, never rebuilds, so the binding survives the wire).
  // Absent on output defs. NON-PHI: ids only.
  source?: { savedQueryId: string; version?: number; entityType?: string };
};

export type WireAgent = {
  id: string;
  name: string;
  group: string | null;
  tools: string[];
  launchMode: string;
};

export type WireAgentRow = {
  id?: string;
  name?: string;
  group?: string | null;
  tools?: unknown;
  launch_mode?: string | null;
};

export type WireChainDefField = {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
};
export type WireChainDefFieldRow = {
  key?: string;
  label?: string;
  type?: string;
  required?: boolean;
};
export type WireChainDefStep = {
  titleTemplate: string;
  bodyTemplate?: string;
  humanGate?: boolean;
  inputs?: WireChainDefField[];
  outputs?: WireChainDefField[];
  neededWhen?: unknown;
};
export type WireChainDefStepRow = {
  title_template?: string;
  body_template?: string;
  human_gate?: boolean;
  inputs?: unknown;
  outputs?: unknown;
  needed_when?: unknown;
};
export type WireChainDef = {
  id: string;
  name: string;
  steps: WireChainDefStep[];
  projectId: string | null;
  groupId?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};
export type WireChainDefRow = {
  id?: string;
  name?: string;
  steps?: unknown;
  project_id?: string | null;
  group_id?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/** A row from GET /chromeext/tasks?titles=1 — the fields mapListRow reads.
 *  Mirrors typebuild.ts's private `ListRow` (kept in sync manually; this
 *  module has no import access to that non-exported type). */
export type WireListRow = {
  id: string;
  status?: string;
  raw_status?: string;
  blocked?: boolean;
  priority?: number;
  attempts?: number;
  max_attempts?: number;
  claimed_by?: string | null;
  group_id?: string | null;
  assigned_to?: string | null;
  start_url?: string | null;
  flags?: string[] | null;
  title?: string;
  url?: string | null;
  due_at?: string | null;
  defer_until?: string | null;
  parent_task_id?: string | null;
  project_id?: string | null;
  template_id?: string | null;
  agent_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  pending_question?: {
    text?: unknown;
    options?: unknown;
    asked_by?: unknown;
    asked_at?: unknown;
  } | null;
};

export type WireMappedListRow = {
  id: string;
  title: string;
  notes: null;
  status: TaskStatus;
  folder: undefined;
  start_at: null;
  due_at: string | null;
  pinned: false;
  cron: null;
  next_run_at: null;
  auto_mode: false;
  auto_agent: null;
  auto_prompt: null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  createdAtIso: string | null;
  updatedAtIso: string | null;
  source: 'typebuild';
  rawStatus: string;
  priority: number | undefined;
  claimedBy: string | null;
  assignedTo: string | null;
  attempts: number | undefined;
  maxAttempts: number | undefined;
  flags: string[];
  deferUntil: string | null;
  parentTaskId: string | null;
  projectId: string | null;
  templateId: string | undefined;
  agentId: string | null;
  pending_question: WirePendingQuestion | undefined;
};

export type WirePendingQuestion = {
  text: string;
  options?: string[];
  asked_by?: string;
  asked_at?: string;
};

export type WireMessage = { text: string; by: string; at: string };

export type WireResult = { type: string; payload: unknown };

export type WireTemplatePatch = {
  name?: string;
  variables?: unknown[];
  outputSchema?: unknown[];
  notes?: string;
  agentId?: string | null;
  flags?: string[];
  projectId?: string | null;
  groupId?: string | null;
};

export function mapStatus(raw: string | undefined): TaskStatus;
export function rawStatusOf(row: { blocked?: boolean; raw_status?: string; status?: string }): string;
export function dateOnly(iso: string | null | undefined): string | null;
export function toIso(v: string | number | null | undefined): string | null;
export function isoToMs(v: string | null | undefined): number | null;

export function mapResult(
  r: { type?: unknown; payload?: unknown } | null | undefined,
): WireResult | undefined;

export function mapOutputSchema(raw: unknown): WireOutputSchemaField[] | undefined;
export function mapDataKeys(raw: unknown): string[] | undefined;
export function mapMessages(messages: unknown): WireMessage[] | undefined;
export function mapPendingQuestion(q: unknown): WirePendingQuestion | undefined;

export function mapAgentRow(raw: WireAgentRow | null | undefined): WireAgent | null;
export function mapResolvedAgent(raw: unknown): WireAgent | null;

export function mapChainFields(raw: unknown): WireChainDefField[] | undefined;
export function mapChainStep(raw: WireChainDefStepRow | null | undefined): WireChainDefStep | null;
export function mapChainRow(raw: WireChainDefRow | null | undefined): WireChainDef | null;

export function mapListRow(row: WireListRow, now?: number): WireMappedListRow;

export function buildCreatePayload(input: TaskCreate): Record<string, unknown>;

export function buildTemplatePatchPayload(patch: WireTemplatePatch): Record<string, unknown>;
