// task-ae0ec0348930 — renderer-side helpers + the effect-application REDUCER for
// the FormExtension CLIENT interpreter.
//
// A FormExtension is an approved, versioned bundle of extra form FIELDS (widget
// descriptors the client renders with its OWN trusted widgets) plus a PURE
// server-side LOGIC function. On any field change the client calls run-logic;
// the server runs the logic and returns a small ALLOWLISTED `effects` object; the
// client APPLIES it declaratively. This is the whole security point: the client
// NEVER eval's the logic and NEVER injects markup — it only switches on a fixed
// set of four effect keys (setValue / setVisible / setOptions / validate).
//
// Plumbing mirrors the SavedQuery selectors (task-e713f307c422):
//   renderer  →  fm.typebuild.formext.{list,create,get,approve,version,runLogic}
//             →  ipcRenderer.invoke('typebuild:formext:*')   (electron/preload.ts)
//             →  ipcMain.handle(...)                          (electron/ipc.ts)
//             →  TypeBuildTaskSource.{listFormExtensions,…}   (electron/sources/typebuild.ts)
//
// PHI: form field VALUES the human/agent fills may carry PHI. They cross the
// run-logic hop (the server needs them to compute effects) and are held in
// renderer state only — never persisted/logged. The FormExtension config itself
// (fields / logic / applies_to) is NON-PHI author config.

import { fm } from '../bridge';
// The PURE effect reducer lives in a dependency-free .mjs so it can be unit-
// tested under `node --test` (formEffects.mjs / .d.mts). We re-export it here so
// the interpreter and its tests share one implementation.
import {
  resolveApplicableExtension as resolveApplicableExtensionImpl,
  sanitizeEffects,
} from './formEffects.mjs';
import type { FormEffects } from './formEffects.d.mts';

export type { FormEffects, InterpreterState } from './formEffects.d.mts';
export {
  applyEffectsToState,
  emptyInterpreterState,
  sanitizeEffects,
  valueWritesFromEffects,
} from './formEffects.mjs';

/** One widget descriptor the interpreter renders. `widget` selects a TRUSTED
 *  app widget; `source` (camelCase inside, mirroring TemplateField.source) binds
 *  a SavedQuery for a `typeahead`; `options` seeds a `select` (a `setOptions`
 *  effect can replace them live). */
export type FormExtensionField = {
  key: string;
  label: string;
  widget: 'typeahead' | 'select' | 'text' | 'date' | 'number';
  source?: { savedQueryId: string; version?: number; entityType?: string };
  options?: string[];
};

/** A FormExtension as the client interpreter sees it (public projection). Top
 *  level is camelCase (the source maps the snake_case wire); `fields[]` elements
 *  keep the wire's `widget`/`source`/`options` shape. NON-PHI config. */
export type FormExtension = {
  id: string;
  familyId: string | null;
  name: string;
  version: number;
  status: 'draft' | 'approved' | 'disabled' | string;
  approvedBy: string | null;
  /** e.g. { template: 'intake' } — how the modal resolves WHICH extension applies. */
  appliesTo: Record<string, unknown>;
  fields: FormExtensionField[];
  logic: string;
  limits: Record<string, unknown>;
  projectId: string | null;
  groupId: string | null;
};

// The pure effect reducer (FormEffects/InterpreterState + sanitizeEffects /
// applyEffectsToState / valueWritesFromEffects / emptyInterpreterState) lives in
// formEffects.mjs and is re-exported at the top of this file.

// ─── typed IPC wrappers ────────────────────────────────────────────────────

/** List FormExtensions (optionally by status). Returns [] signed-out / on a
 *  parse miss so the interpreter degrades to "no extension". */
export async function listFormExtensions(status?: string): Promise<FormExtension[]> {
  return fm.typebuild.formext.list(status) as Promise<FormExtension[]>;
}

/** List only APPROVED extensions — what the interpreter is allowed to render. */
export async function listApprovedFormExtensions(): Promise<FormExtension[]> {
  return listFormExtensions('approved');
}

/** Create a DRAFT FormExtension authored by the copilot. */
export async function createFormExtension(input: {
  name: string;
  appliesTo: Record<string, unknown>;
  fields: Array<Record<string, unknown>>;
  logic: string;
  limits?: Record<string, unknown>;
  projectId?: string;
  groupId?: string;
}): Promise<FormExtension> {
  return fm.typebuild.formext.create(input) as Promise<FormExtension>;
}

/** Read a FormExtension back (fields + logic + status) — for the approve card. */
export async function getFormExtension(id: string): Promise<FormExtension> {
  return fm.typebuild.formext.get(id) as Promise<FormExtension>;
}

/** Approve a draft (draft→approved). THE design-time human gate; called only
 *  from the mandatory confirmedAction card, never auto. */
export async function approveFormExtension(id: string): Promise<FormExtension> {
  return fm.typebuild.formext.approve(id) as Promise<FormExtension>;
}

/** Clone the current version to a new DRAFT (v+1) for iterate-in-chat. */
export async function newFormExtensionVersion(
  id: string,
  patch?: {
    fields?: Array<Record<string, unknown>>;
    logic?: string;
    appliesTo?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  },
): Promise<FormExtension> {
  return fm.typebuild.formext.version(id, patch) as Promise<FormExtension>;
}

/** Run the PURE server-side logic for the current values (the `changed` key is
 *  what just changed, or null on an initial pass) and return the allowlisted
 *  effects + the version that produced them. Throws on transport / signed-out. */
export async function runFormLogic(
  id: string,
  values: Record<string, unknown>,
  changed: string | null,
): Promise<{ effects: FormEffects; version: number }> {
  const res = await fm.typebuild.formext.runLogic(id, values, changed);
  return { effects: sanitizeEffects(res.effects), version: res.version };
}

/** Resolve which approved extension applies to a given template/project, by
 *  matching `appliesTo.template`. Simple v1 lookup; returns the first match or
 *  null. Delegates to the pure formEffects.mjs impl (shared with the tests). See
 *  the interpreter's applies_to TODO for the fuller resolution story. */
export function resolveApplicableExtension(
  extensions: FormExtension[],
  templateKey: string | null | undefined,
  projectId: string | null | undefined,
): FormExtension | null {
  return resolveApplicableExtensionImpl(extensions, templateKey, projectId);
}
