// task-e713f307c422 — renderer-side helpers for SavedQuery selectors.
//
// SavedQueries let a TemplateField be backed by a live external-API query
// (see docs/saved-queries-design.md, "Consumers → Form selectors"). The
// executor lives server-side in the task API (TypeBuild); the client reaches
// it over the SAME Firebase-token-authed `/chromeext/*` path every other task
// call uses, through the main process:
//
//   renderer  →  fm.typebuild.queries.{execute,list}   (src/bridge.ts)
//             →  ipcRenderer.invoke('typebuild:queries:*')   (electron/preload.ts)
//             →  ipcMain.handle(...)                    (electron/ipc.ts)
//             →  TypeBuildTaskSource.{executeQuery,listQueries}  (electron/sources/typebuild.ts)
//             →  this.request('POST', '/chromeext/queries/:id/execute' | 'GET', '/chromeext/queries')
//
// PHI: `execute` returns live rows whose DISPLAY fields may carry PHI. They are
// held in component state and rendered in memory only — never persisted/logged
// (docs/typebuild-data-field-contract.md). Only the row's `ref` (opaque
// {sourceId, entityType, externalId} — non-PHI) and a short display SNAPSHOT are
// threaded onto a created task, as placeholder KEYS in the task `data` bag.

import { fm } from '../bridge';

/** The durable pointer to an external resource a selected row carries. Opaque
 *  ids only — NON-PHI, safe to persist as a task `data` value (JSON-encoded). */
export type QueryRef = {
  sourceId: string;
  entityType: string;
  externalId: string;
};

/** One row returned by the executor: a `ref` plus arbitrary display fields
 *  (name/dob/…). The non-`ref` fields MAY carry PHI — treat as memory-only. */
export type QueryRow = {
  ref: QueryRef;
  [field: string]: unknown;
};

/** A SavedQuery as the client sees it (public projection — no code/auth). Used
 *  by SavedQuery-selector consumers (e.g. the FormExtension authoring flow). */
export type SavedQuerySummary = {
  id: string;
  name: string;
  version: number;
  status: string;
  /** Declared resource type the query's rows point at (outputSchema.ref). */
  entityType?: string;
};

/** Run a SavedQuery selector for the typed term. `q` is the free-text search
 *  input; extra bound inputs may be added later. Returns the executor's rows.
 *  Throws on transport / signed-out errors — callers debounce and swallow. */
export async function executeQuery(
  savedQueryId: string,
  q: string,
  version?: number,
): Promise<QueryRow[]> {
  return fm.typebuild.queries.execute(savedQueryId, { q }, version);
}

/** List approved SavedQueries visible to the signed-in principal, for the
 *  SavedQuery-selector consumers. Returns [] when signed out / on parse miss so
 *  the picker degrades to "none". */
export async function listApprovedQueries(): Promise<SavedQuerySummary[]> {
  return fm.typebuild.queries.list('approved');
}

/** A registered DataSource as the client sees it (public projection — NO
 *  creds). This is the "API spec" grounding context the authoring LLM writes
 *  query code against: name + base_url + entity_types. (task-d8a0b081eb93) */
export type DataSourceSummary = {
  id: string;
  name: string;
  baseUrl: string;
  entityTypes: string[];
};

/** List the DataSources visible to the signed-in principal, to ground the
 *  authoring copilot. NON-PHI (no patient data, no creds). Throws on transport
 *  / signed-out errors — the authoring component surfaces the message. */
export async function listDataSources(): Promise<DataSourceSummary[]> {
  return fm.typebuild.datasources.list();
}

/** Create a DRAFT SavedQuery (v1) authored by the copilot. Returns the new
 *  draft's id + version. Draft is author-only until approved. NON-PHI. */
export async function createDraftQuery(input: {
  name: string;
  sourceId: string;
  code: string;
  outputSchema: unknown;
  inputs?: unknown;
  limits?: unknown;
  projectId?: string;
}): Promise<{ id: string; name: string; version: number; status: string }> {
  return fm.typebuild.queries.create(input);
}

/** Read a SavedQuery back (code + outputSchema + status) — used to show the
 *  human exactly what they are approving in the approve card. NON-PHI. */
export async function getQuery(savedQueryId: string): Promise<{
  id: string;
  name: string;
  version: number;
  status: string;
  sourceId: string;
  code: string;
  outputSchema: unknown;
}> {
  return fm.typebuild.queries.get(savedQueryId);
}

/** Approve a draft (draft→approved). THE design-time human gate; approval also
 *  publishes the version org-wide (Addendum §1). Called only from the mandatory
 *  confirmedAction card, never auto. */
export async function approveQuery(savedQueryId: string): Promise<{
  id: string;
  name: string;
  version: number;
  status: string;
  approvedBy?: string;
}> {
  return fm.typebuild.queries.approve(savedQueryId);
}

/** Clone the current version to a new DRAFT (v+1) for iterate-in-chat. */
export async function newQueryVersion(
  savedQueryId: string,
  patch?: { code?: string; outputSchema?: unknown; inputs?: unknown; limits?: unknown },
): Promise<{ id: string; name: string; version: number; status: string }> {
  return fm.typebuild.queries.version(savedQueryId, patch);
}

/** Pick the best human-readable label for a row: prefer the SavedQuery's
 *  declared `display` field order when known, else the first string field, else
 *  the externalId. Kept here so the typeahead and the `lookup_record` copilot
 *  action render rows identically (one lookup, two UIs). */
export function rowLabel(row: QueryRow, displayFields?: string[]): string {
  const fields = displayFields?.length
    ? displayFields
    : Object.keys(row).filter((k) => k !== 'ref');
  const parts: string[] = [];
  for (const f of fields) {
    const v = row[f];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else if (typeof v === 'number') parts.push(String(v));
  }
  if (parts.length) return parts.join(' · ');
  return row.ref?.externalId ?? '(no label)';
}
